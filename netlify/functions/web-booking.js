"use strict";

// ---------------------------------------------------------------------------
// web-booking.js
//
// Public endpoint for the website intake modal (OfferModal.jsx). Same-origin
// (recast-properties.com), so no shared secret is possible in the browser —
// guarded instead by a honeypot field + server-side validation. Mirrors the
// phone flow's calendar rules via appointment-action's shared helpers.
//
// Actions (POST JSON { action }):
//   availability -> open weekday 30-min slots (9-6 Central) from Nylas free/busy
//   book         -> creates a Nylas seller_callback event (source: website),
//                   then posts a summary to the call-summary Apps Script
//                   (Website Leads tab + email). Best-effort summary; the
//                   booking is the source of truth.
// ---------------------------------------------------------------------------

const A = require("./appointment-action.js")._internals;

const CENTRAL_TIME_ZONE = "America/Chicago";
const BUSINESS_START_HOUR = 9;   // first slot 9:00
const BUSINESS_END_HOUR = 18;    // last slot ends by 18:00 (so last start 17:30)
const SLOT_MINUTES = 30;
const LEAD_MS = 2 * 60 * 60 * 1000; // earliest bookable = now + 2h (matches old form)
const DAYS_TO_OFFER = 5;            // up to 5 weekdays with open slots
const WINDOW_DAYS = 16;            // free/busy lookahead window

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function centralLabel(date, opts) {
  return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: CENTRAL_TIME_ZONE }, opts)).format(date);
}

function timeLabel(date) {
  return centralLabel(date, { hour: "numeric", minute: "2-digit", hour12: true }); // "9:30 AM"
}

function dayLabel(date) {
  return centralLabel(date, { weekday: "short", month: "short", day: "numeric" }); // "Mon, Jun 16"
}

// Build every weekday 30-min slot in the window that is open (not busy, not past,
// >= now+2h), grouped into up to DAYS_TO_OFFER days that have at least one slot.
function buildOpenDays(now, busySlots) {
  const earliestMs = now.getTime() + LEAD_MS;
  const days = [];

  for (let offset = 0; offset < WINDOW_DAYS && days.length < DAYS_TO_OFFER; offset++) {
    const parts = A.addDaysCentral(now, offset); // {year, month, day}
    const weekday = A.weekdayIndexFromCentralDate(parts.year, parts.month, parts.day);
    if (weekday < 1 || weekday > 5) continue; // weekdays only

    const slots = [];
    for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
      for (const minute of [0, 30]) {
        const start = A.centralDateToUtcDate(parts.year, parts.month, parts.day, hour, minute);
        const end = new Date(start.getTime() + SLOT_MINUTES * 60 * 1000);
        if (start.getTime() < earliestMs) continue;

        const busy = busySlots.some((b) =>
          A.rangesOverlap(start.getTime(), end.getTime(), b.startMs, b.endMs)
        );
        if (busy) continue;

        slots.push({ start_time: A.formatCentralIso(start), label: timeLabel(start) });
      }
    }

    if (slots.length) {
      const dayStart = A.centralDateToUtcDate(parts.year, parts.month, parts.day, 12, 0);
      days.push({ date_label: dayLabel(dayStart), slots });
    }
  }

  return days;
}

async function handleAvailability() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const freeBusy = await A.callNylasFreeBusy(now, windowEnd);
  if (!freeBusy.ok) {
    console.error("web-booking availability free/busy failed", { statusCode: freeBusy.statusCode });
    return jsonResponse(502, { ok: false, error: "availability_unavailable" });
  }

  const busySlots = A.extractBusySlots(freeBusy.body);
  const days = buildOpenDays(now, busySlots);

  return jsonResponse(200, { ok: true, days });
}

// ---- validation ----------------------------------------------------------
function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isValidSlot(start, now) {
  if (!start || Number.isNaN(start.getTime())) return false;
  if (start.getTime() <= now.getTime()) return false;
  const p = A.getCentralDateParts(start);
  const weekday = A.weekdayIndexFromCentralDate(p.year, p.month, p.day);
  if (weekday < 1 || weekday > 5) return false;
  if (p.hour < BUSINESS_START_HOUR || p.hour >= BUSINESS_END_HOUR) return false;
  if (p.minute !== 0 && p.minute !== 30) return false;
  return true;
}

async function createWebEvent(payload, start, end) {
  const nylasApiKey = process.env.NYLAS_API_KEY;
  const nylasGrantId = process.env.NYLAS_GRANT_ID;
  const calendarId = process.env.CALENDAR_ID || "primary";
  const scheduledStartIso = A.formatCentralIso(start);
  const scheduledEndIso = A.formatCentralIso(end);

  const title = A.buildCalendarTitle({
    callerName: payload.name,
    propertyAddress: payload.propertyAddress
  });

  const description = [
    "RECAST SELLER CALLBACK (website)",
    "",
    "CALLER",
    `Name: ${clean(payload.name)}`,
    `Phone: ${clean(payload.phone)}`,
    `Email: ${clean(payload.email)}`,
    "",
    "PROPERTY",
    `Address / Location: ${clean(payload.propertyAddress)}`,
    `Owner Relationship: ${clean(payload.ownerRel)}`,
    "",
    "SITUATION",
    `Reason: ${clean(payload.reason)}`,
    `Timeline: ${clean(payload.timeline)}`,
    `Mortgage / Owed: ${clean(payload.mortgage)}`,
    `Other Liens: ${clean(payload.liens)}`,
    "",
    "CALLBACK",
    `Scheduled: ${scheduledStartIso}`,
    "Source: Website form"
  ].join("\n");

  const body = {
    title,
    description,
    busy: true,
    when: {
      start_time: Math.floor(start.getTime() / 1000),
      end_time: Math.floor(end.getTime() / 1000),
      start_timezone: CENTRAL_TIME_ZONE,
      end_timezone: CENTRAL_TIME_ZONE
    },
    metadata: {
      recast_booking: "1",
      appointment_type: "seller_callback",
      source: "website",
      intent: "new_appointment",
      status: "booked",
      caller_name: clean(payload.name),
      callback_number: clean(payload.phone),
      caller_email: clean(payload.email),
      property_address: clean(payload.propertyAddress),
      ownership: clean(payload.ownerRel),
      reason_situation: clean(payload.reason),
      timeline_deadline: clean(payload.timeline),
      amount_owed: clean(payload.mortgage),
      liens_issues: clean(payload.liens),
      scheduled_callback_time: scheduledStartIso,
      sms_consent: "not_asked",
      last_updated_by: "recast_web",
      last_updated_at_unix: String(Math.floor(Date.now() / 1000))
    }
  };

  const url =
    `https://api.us.nylas.com/v3/grants/${encodeURIComponent(nylasGrantId)}/events` +
    `?calendar_id=${encodeURIComponent(calendarId)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${nylasApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, statusCode: response.status, body: responseBody };
  }
  return { ok: true, body: responseBody, scheduledStartIso, scheduledEndIso };
}

// Best-effort: post a Website-Leads summary to the call-summary Apps Script.
async function postWebsiteSummary(payload, start) {
  try {
    const url = process.env.CALL_SUMMARY_WEBHOOK_URL;
    if (!url) {
      console.log("web-booking: CALL_SUMMARY_WEBHOOK_URL unset; skipping summary.");
      return;
    }
    const summary = {
      token: process.env.CALL_SUMMARY_TOKEN || "",
      type: "website_lead",
      timestamp: new Date().toISOString(),
      name: clean(payload.name),
      phone: clean(payload.phone),
      email: clean(payload.email),
      propertyAddress: clean(payload.propertyAddress),
      ownerRelationship: clean(payload.ownerRel),
      reason: clean(payload.reason),
      timeline: clean(payload.timeline),
      mortgageBalance: clean(payload.mortgage),
      otherLiens: clean(payload.liens),
      scheduledCallback: A.formatCentralIso(start)
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary)
    });
    const text = await resp.text().catch(() => "");
    console.log("web-booking summary posted:", resp.status, text.slice(0, 120));
  } catch (error) {
    console.log("web-booking summary error (swallowed):", error.message);
  }
}

async function handleBook(payload) {
  // Honeypot: real users never fill `company`. Bots do — silently accept, do nothing.
  if (clean(payload.company)) {
    console.log("web-booking: honeypot tripped; dropping submission.");
    return jsonResponse(200, { ok: true, status: "received" });
  }

  const name = clean(payload.name);
  const phone = clean(payload.phone);
  if (!name || !phone) {
    return jsonResponse(200, { ok: false, status: "needs_more_info", error: "name_and_phone_required" });
  }

  const now = new Date();
  const start = new Date(clean(payload.start_time));
  if (!isValidSlot(start, now)) {
    return jsonResponse(200, { ok: false, status: "invalid_slot", error: "invalid_or_past_slot" });
  }
  const end = new Date(start.getTime() + SLOT_MINUTES * 60 * 1000);

  // Re-check the exact slot is still open at booking time.
  const freeBusy = await A.callNylasFreeBusy(start, end);
  if (!freeBusy.ok) {
    console.error("web-booking book free/busy failed", { statusCode: freeBusy.statusCode });
    return jsonResponse(502, { ok: false, status: "error", error: "free_busy_failed" });
  }
  const busy = A.extractBusySlots(freeBusy.body).some((b) =>
    A.rangesOverlap(start.getTime(), end.getTime(), b.startMs, b.endMs)
  );
  if (busy) {
    return jsonResponse(200, { ok: false, status: "slot_taken", error: "slot_taken" });
  }

  const created = await createWebEvent(payload, start, end);
  if (!created.ok) {
    console.error("web-booking event creation failed", { statusCode: created.statusCode, body: created.body });
    return jsonResponse(502, { ok: false, status: "error", error: "event_creation_failed" });
  }

  await postWebsiteSummary(payload, start);

  return jsonResponse(200, {
    ok: true,
    status: "booked",
    scheduledStartTime: created.scheduledStartIso,
    scheduledLabel: `${dayLabel(start)} at ${timeLabel(start)} Central`
  });
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" });
    }

    let payload = {};
    try {
      payload = event.body ? JSON.parse(event.body) : {};
    } catch (parseError) {
      return jsonResponse(400, { ok: false, error: "invalid_json" });
    }

    const action = payload.action;
    if (action === "availability") return await handleAvailability();
    if (action === "book") return await handleBook(payload);

    return jsonResponse(400, { ok: false, error: "unknown_action" });
  } catch (error) {
    console.error("web-booking error", { message: error.message, stack: error.stack });
    return jsonResponse(500, { ok: false, error: "internal_error" });
  }
};

exports._internals = { buildOpenDays, isValidSlot };
