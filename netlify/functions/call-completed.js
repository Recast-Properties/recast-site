"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// call-completed.js
//
// Receives Telnyx AI Assistant post-call Insights webhooks (event_type
// "call.conversation.ended"), fired once when a conversation ends. This is the
// end-of-call trigger; it is the ONLY thing that fires this function.
//
// Auth: Telnyx signs every Insights webhook with an Ed25519 signature
//   (telnyx-signature-ed25519 + telnyx-timestamp headers). The Insights group
//   webhook is URL-only — it cannot send a custom x-api-key header — so this
//   handler verifies the signature against TELNYX_PUBLIC_KEY instead. Fail closed.
//
// Scope (backlog item 1): stand up the trigger + assemble the call-end row and
//   log it. Gated by CALL_LOG_ENABLED (default OFF) — while off there is no send
//   path. NO calendar writes, NO SMS, NO email here. The summary email (item 2)
//   and the real log sink are separate tickets. appointment-action.js owns
//   booking during the call and is untouched.
// ---------------------------------------------------------------------------

// DER SubjectPublicKeyInfo prefix for an Ed25519 public key (RFC 8410).
// Telnyx exposes the public key as a base64 32-byte raw key; prepend this to
// build a KeyObject without any external dependency.
const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Reject webhooks whose timestamp is older than this (replay guard).
const MAX_TIMESTAMP_AGE_SECONDS = 5 * 60;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// Exact bytes Telnyx signed. Netlify may base64-encode the body; decode if so.
function getRawBody(event) {
  if (!event.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return event.body;
}

// Verify the Telnyx Ed25519 signature over `${timestamp}|${rawBody}`.
// Returns { ok: true } or { ok: false, reason } — never throws.
function verifyTelnyxSignature(event, rawBody) {
  const publicKeyB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKeyB64) {
    return { ok: false, reason: "TELNYX_PUBLIC_KEY not configured" };
  }

  const signatureB64 = getHeader(event.headers, "telnyx-signature-ed25519");
  const timestamp = getHeader(event.headers, "telnyx-timestamp");
  if (!signatureB64 || !timestamp) {
    return { ok: false, reason: "missing signature or timestamp header" };
  }

  // Replay guard: timestamp must be recent (Unix seconds).
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) {
    return { ok: false, reason: "non-numeric timestamp" };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsSeconds);
  if (ageSeconds > MAX_TIMESTAMP_AGE_SECONDS) {
    return { ok: false, reason: `stale timestamp (${ageSeconds}s old)` };
  }

  try {
    const rawKey = Buffer.from(publicKeyB64, "base64");
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_DER_PREFIX, rawKey]),
      format: "der",
      type: "spki"
    });

    const signedPayload = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
    const signature = Buffer.from(signatureB64, "base64");

    // Ed25519 verify: algorithm must be null.
    const valid = crypto.verify(null, signedPayload, keyObject, signature);
    return valid ? { ok: true } : { ok: false, reason: "signature mismatch" };
  } catch (error) {
    return { ok: false, reason: `verify error: ${error.message}` };
  }
}

// Pull the call-end fields we care about out of the Telnyx envelope.
// This is the row that item 2 (summary email) and the real log sink will use.
//
// Real Insights webhook shape (verified against a live call):
//   { record_type, event_type: "conversation_insight_result",
//     payload: { request_id, conversation_id, status, insight_group_id,
//                results: [{ result, insight_id }],
//                metadata: { from, to, call_control_id, call_session_id,
//                            call_leg_id, assistant_id,
//                            telnyx_conversation_channel, ... } } }
// Note: NO top-level `data` wrapper, and no duration/occurred_at fields.
function assembleCallEndRow(parsed, receivedAt) {
  const root = parsed || {};
  const payload = root.payload || {};
  const meta = payload.metadata || {};

  return {
    source: "telnyx",
    eventType: root.event_type || null,
    status: payload.status || null,
    conversationId: payload.conversation_id || null,
    requestId: payload.request_id || null,
    insightGroupId: payload.insight_group_id || null,
    callControlId: meta.call_control_id || null,
    callSessionId: meta.call_session_id || null,
    callLegId: meta.call_leg_id || null,
    assistantId: meta.assistant_id || null,
    from: meta.from || null,
    to: meta.to || null,
    channel: meta.telnyx_conversation_channel || null,
    // The configured insights (incl. the Summary text) — used by item 2's email.
    results: Array.isArray(payload.results) ? payload.results : [],
    receivedAt
  };
}

// Find the Nylas calendar event for this call so the summary carries the real
// structured lead fields (name/address/owed/scheduled time) the booking wrote.
// The join key: appointment-action stores metadata.call_id = the Telnyx
// call_control_id, which is exactly row.callControlId here. Best-effort; returns
// null (never throws) if nothing is found or env is missing.
async function lookupBookingForCall(callId) {
  const apiKey = process.env.NYLAS_API_KEY;
  const grantId = process.env.NYLAS_GRANT_ID;
  const calendarId = process.env.CALENDAR_ID || "primary";
  if (!callId || !apiKey || !grantId) return null;

  const now = Date.now();
  const startUnix = Math.floor((now - 24 * 60 * 60 * 1000) / 1000);
  const endUnix = Math.floor((now + 120 * 24 * 60 * 60 * 1000) / 1000);

  const matches = [];
  let pageToken = "";

  try {
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({
        calendar_id: calendarId,
        start: String(startUnix),
        end: String(endUnix),
        limit: "50",
        select: "id,title,when,metadata,status"
      });
      if (pageToken) params.set("page_token", pageToken);

      const url =
        `https://api.us.nylas.com/v3/grants/${encodeURIComponent(grantId)}/events?` +
        params.toString();

      const resp = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` }
      });
      const body = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        console.log("CALL-SUMMARY: Nylas event lookup failed", resp.status);
        return null;
      }

      const events = Array.isArray(body.data) ? body.data : [];
      for (const ev of events) {
        const md = ev.metadata || {};
        if (md.call_id && md.call_id === callId) matches.push(ev);
      }

      pageToken = body.next_cursor || "";
      if (!pageToken) break;
    }
  } catch (error) {
    console.log("CALL-SUMMARY: Nylas lookup error", error.message);
    return null;
  }

  if (!matches.length) return null;

  // Prefer a live (non-cancelled) booking; if several, the most recently updated.
  const active = matches.filter(
    (ev) => String((ev.metadata || {}).status || "").toLowerCase() !== "cancelled"
  );
  return (active.length ? active : matches).sort((a, b) => {
    const au = Number((a.metadata || {}).last_updated_at_unix || 0);
    const bu = Number((b.metadata || {}).last_updated_at_unix || 0);
    return bu - au;
  })[0];
}

// Assemble the Sheet/email payload (columns aligned to the "Call Intake" tab),
// combining the booking event's structured metadata with the Insights Summary.
function buildCallSummary(row, bookingEvent) {
  const md = bookingEvent && bookingEvent.metadata ? bookingEvent.metadata : {};
  const summaryText =
    row.results && row.results[0] && row.results[0].result ? row.results[0].result : "";

  return {
    timestamp: row.occurredAt || row.receivedAt,
    inboundCallerId: row.from || md.inbound_caller_id || "",
    callbackNumber: md.callback_number || "",
    callerName: md.caller_name || "",
    propertyAddress: md.property_address || "",
    reasonForSelling: md.reason_situation || "",
    timeline: md.timeline_deadline || "",
    bestCallbackTime: md.scheduled_callback_time || "",
    owedAmount: md.amount_owed || "",
    lienDetails: md.liens_issues || "",
    smsConsent: md.sms_consent || "not_asked",
    notes: summaryText,
    // Context (lands in Raw Payload + the email; not its own Sheet column):
    callStatus: bookingEvent ? md.status || "booked" : "no_booking",
    conversationId: row.conversationId || "",
    callId: row.callControlId || "",
    durationSec: typeof row.durationSec === "number" ? row.durationSec : ""
  };
}

// Gated delivery. OFF (default) = log the exact payload it would send. ON = POST
// to the Apps Script web app (Sheet append + email). Never throws into the call.
async function deliverCallSummary(row) {
  try {
    const booking = await lookupBookingForCall(row.callControlId);
    const summary = buildCallSummary(row, booking);
    const enabled = process.env.CALL_LOG_ENABLED === "true";
    const url = process.env.CALL_SUMMARY_WEBHOOK_URL;

    console.log(
      "CALL-SUMMARY payload (gate " + (enabled ? "ON" : "OFF") + "):",
      JSON.stringify(summary)
    );

    if (!enabled) return;
    if (!url) {
      console.log("CALL-SUMMARY: CALL_LOG_ENABLED on but CALL_SUMMARY_WEBHOOK_URL unset; not sending.");
      return;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: process.env.CALL_SUMMARY_TOKEN || "", ...summary })
    });
    const text = await resp.text().catch(() => "");
    console.log("CALL-SUMMARY sent:", resp.status, text.slice(0, 200));
  } catch (error) {
    console.log("CALL-SUMMARY deliver error (swallowed):", error.message);
  }
}

exports.handler = async function (event) {
  console.log("==================== START: CALL-COMPLETED ====================");

  try {
    if (event.httpMethod !== "POST") {
      console.log("Rejected non-POST request:", event.httpMethod);
      console.log("==================== END: CALL-COMPLETED ====================");
      return jsonResponse(405, {
        status: "error",
        message: "Method not allowed. Use POST."
      });
    }

    const rawBody = getRawBody(event);

    const verification = verifyTelnyxSignature(event, rawBody);
    if (!verification.ok) {
      console.log("Rejected unverified call-completed request:", verification.reason);
      console.log("==================== END: CALL-COMPLETED ====================");
      return jsonResponse(401, {
        status: "error",
        message: "Unauthorized."
      });
    }

    let parsed = {};
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch (parseError) {
      // Signature already verified, so a parse failure is a malformed-but-signed
      // body — log it and still return 200 so Telnyx does not retry-storm.
      console.log("JSON parse error after verification:", parseError.message);
      console.log("Raw body:", rawBody);
      console.log("==================== END: CALL-COMPLETED ====================");
      return jsonResponse(200, {
        status: "received",
        message: "Call-completed payload received (unparseable)."
      });
    }

    // Diagnostic: log the exact verified payload so we can confirm/correct the
    // field mapping in assembleCallEndRow against the real Telnyx envelope shape.
    console.log("CALL-COMPLETED raw payload:", rawBody);

    const receivedAt = new Date().toISOString();
    const row = assembleCallEndRow(parsed, receivedAt);
    await deliverCallSummary(row);

    console.log("==================== END: CALL-COMPLETED ====================");
    return jsonResponse(200, {
      status: "received",
      message: "Call-completed payload received."
    });
  } catch (error) {
    console.log("Unhandled call-completed error:", error);
    console.log("==================== END: CALL-COMPLETED ====================");
    return jsonResponse(500, {
      status: "error",
      message: "Internal server error."
    });
  }
};

// Test-only exports. Netlify uses only exports.handler above.
exports._internals = {
  verifyTelnyxSignature,
  assembleCallEndRow,
  buildCallSummary,
  getRawBody,
  getHeader
};
