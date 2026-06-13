"use strict";

// Pre-deploy test for call-completed.js Ed25519 verification + row assembly.
//
// We can't produce a real Telnyx signature (no private key), so we generate a
// throwaway Ed25519 keypair, set TELNYX_PUBLIC_KEY to its public half, and sign
// sample payloads with its private half — exercising the exact same verify path
// the real Telnyx public key will hit in production.
//
// Run: node tests/call-completed.test.js

const assert = require("assert");
const crypto = require("crypto");

// --- throwaway keypair -> TELNYX_PUBLIC_KEY -------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
// Raw 32-byte public key = last 32 bytes of the DER SPKI encoding.
const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(12);
process.env.TELNYX_PUBLIC_KEY = rawPublic.toString("base64");
process.env.CALL_LOG_ENABLED = "false"; // gate OFF for tests

// Require AFTER env is set so the module reads our test key.
const { handler, _internals } = require("../netlify/functions/call-completed.js");

function sign(timestamp, body) {
  return crypto
    .sign(null, Buffer.from(`${timestamp}|${body}`, "utf8"), privateKey)
    .toString("base64");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Real Telnyx Insights webhook envelope (captured from a live call).
const SAMPLE_BODY = JSON.stringify({
  record_type: "event",
  event_type: "conversation_insight_result",
  payload: {
    request_id: "28388188-a310-49ec-a93e-0145011e4902",
    conversation_id: "c7bb52d3-c352-47c8-a81a-289ae58c2550",
    status: "completed",
    insight_group_id: "37f7f0c4-4684-49a2-99f2-50e62e1826c7",
    results: [
      { result: "Summary of the call goes here.", insight_id: "cfcc865c" }
    ],
    metadata: {
      to: "+14695487253",
      from: "+15032015250",
      call_leg_id: "b99a8962-676f-11f1-8e94-02420aef2520",
      assistant_id: "assistant-88709965-12ee-4d0b-9202-d5dccb16589e",
      call_control_id: "v3:FDA8jVeV3YajxcYfi-PwQ2G_IBVHtcsE4idWmU0O8Xngnm2iMz1lJA",
      call_session_id: "b99a7f3a-676f-11f1-82fe-02420aef2520",
      telnyx_conversation_channel: "phone_call"
    }
  }
});

function makeEvent({ method = "POST", headers, body = SAMPLE_BODY } = {}) {
  return { httpMethod: method, headers, body, isBase64Encoded: false };
}

function signedHeaders(body = SAMPLE_BODY, ts = nowSeconds()) {
  return {
    "telnyx-timestamp": String(ts),
    "telnyx-signature-ed25519": sign(String(ts), body)
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

(async () => {
  console.log("call-completed.js tests:");

  await test("valid signature -> 200 received", async () => {
    const res = await handler(makeEvent({ headers: signedHeaders() }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).status, "received");
  });

  await test("non-POST -> 405", async () => {
    const res = await handler(makeEvent({ method: "GET", headers: signedHeaders() }));
    assert.strictEqual(res.statusCode, 405);
  });

  await test("missing signature headers -> 401", async () => {
    const res = await handler(makeEvent({ headers: {} }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("tampered body (signature mismatch) -> 401", async () => {
    const headers = signedHeaders(); // signed over SAMPLE_BODY
    const res = await handler(makeEvent({ headers, body: SAMPLE_BODY + " " }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("wrong key (forged signature) -> 401", async () => {
    const other = crypto.generateKeyPairSync("ed25519").privateKey;
    const ts = String(nowSeconds());
    const headers = {
      "telnyx-timestamp": ts,
      "telnyx-signature-ed25519": crypto
        .sign(null, Buffer.from(`${ts}|${SAMPLE_BODY}`), other)
        .toString("base64")
    };
    const res = await handler(makeEvent({ headers }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("stale timestamp -> 401", async () => {
    const ts = nowSeconds() - 600; // 10 min old
    const res = await handler(makeEvent({ headers: signedHeaders(SAMPLE_BODY, ts) }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("unset TELNYX_PUBLIC_KEY -> 401 (fail closed)", async () => {
    const saved = process.env.TELNYX_PUBLIC_KEY;
    delete process.env.TELNYX_PUBLIC_KEY;
    const res = await handler(makeEvent({ headers: signedHeaders() }));
    process.env.TELNYX_PUBLIC_KEY = saved;
    assert.strictEqual(res.statusCode, 401);
  });

  await test("base64-encoded body verifies and parses", async () => {
    const ts = String(nowSeconds());
    const event = {
      httpMethod: "POST",
      isBase64Encoded: true,
      body: Buffer.from(SAMPLE_BODY, "utf8").toString("base64"),
      headers: {
        "telnyx-timestamp": ts,
        "telnyx-signature-ed25519": sign(ts, SAMPLE_BODY)
      }
    };
    const res = await handler(event);
    assert.strictEqual(res.statusCode, 200);
  });

  await test("assembleCallEndRow extracts the right fields", async () => {
    const row = _internals.assembleCallEndRow(JSON.parse(SAMPLE_BODY), "2026-06-13T00:00:00Z");
    assert.strictEqual(row.eventType, "conversation_insight_result");
    assert.strictEqual(row.status, "completed");
    assert.strictEqual(row.conversationId, "c7bb52d3-c352-47c8-a81a-289ae58c2550");
    assert.strictEqual(row.callControlId, "v3:FDA8jVeV3YajxcYfi-PwQ2G_IBVHtcsE4idWmU0O8Xngnm2iMz1lJA");
    assert.strictEqual(row.callSessionId, "b99a7f3a-676f-11f1-82fe-02420aef2520");
    assert.strictEqual(row.from, "+15032015250");
    assert.strictEqual(row.to, "+14695487253");
    assert.strictEqual(row.assistantId, "assistant-88709965-12ee-4d0b-9202-d5dccb16589e");
    assert.strictEqual(row.source, "telnyx");
    assert.strictEqual(row.results.length, 1);
    assert.strictEqual(row.results[0].result, "Summary of the call goes here.");
  });

  console.log(`\n${passed} passed`);
})().catch((error) => {
  console.error("\nTEST FAILED:", error.message);
  process.exit(1);
});
