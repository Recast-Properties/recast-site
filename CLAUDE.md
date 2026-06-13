# Recast Scheduler — Project Context

## What this is
Voice-assistant-driven callback scheduling for Recast Properties. A Telnyx AI voice
assistant ("Jennifer") and the website form both call the same Netlify Functions
backend. Google Calendar (via Nylas v3) is the single source of truth — bookings live
as calendar events with metadata; there is no separate database.

## Stack & deploy
- Netlify Functions (Node, native fetch). Functions live in `netlify/functions/`.
- Nylas v3 -> Google Calendar (paul@recast-properties.com primary calendar).
- Telnyx voice assistant calls `appointment-action` as a tool.
- Deploy: `netlify deploy --prod` from the repo root (`/Users/paulbjork/Desktop/recast-site`).
  There is no package.json at the root.
- Tests: `node tests/parser.test.js` (12/12 green; parser-only) and
  `node tests/call-completed.test.js` (9/9 green; Telnyx Ed25519 verify + row assembly).
- Business hours: Mon-Fri 09:00-18:00 Central, 60-min slots. Weekday-only is hard-coded
  in `nextBusinessDayCentral` and the out-of-hours rejection logic.

## Current state (commit a0a2628, deployed)
- Caller-language pass is live: assistant-facing `messageForAssistant` strings reworded;
  false "conflict" wording removed from error paths; "will follow up" grammar fixed;
  the inline routing note stripped from the row-10 spoken line. Parser untouched; 12/12 green.
- Rollback point: `0cc0640` (parser fix).

## Key architecture facts (read before touching the backlog)
- `appointment-action.js` is invoked PER ACTION (availability, book, reschedule, cancel)
  and can fire MULTIPLE times in a single call. Anything that must happen once per call
  (summary email, confirmation SMS) does NOT belong in this file.
- SMS consent is ALREADY captured: on a successful book/reschedule, `sms_consent`,
  `sms_consent_method: "voice"`, and a timestamp are written to the Nylas event metadata.
  Nothing reads that consent to actually send yet — the send is the missing piece.
- `call-completed.js` is the intended home for the call-ended work (logging +
  email + later SMS), firing once per call.
- THE POST-CALL TRIGGER WAS UNSOLVED. In the prior build Telnyx never successfully
  triggered anything on hangup — `call-completed.js` had likely never been invoked
  by a real call end, and the existing "Call Intake" Sheet rows came from a mid-call
  tool POST / manual tests, not an end-of-call webhook. Do NOT treat the trigger as
  a working flow being replaced.
- The trigger is the Telnyx AI Assistant **Insights** webhook: Mission Control ->
  Insights -> the "Default" insight group -> Webhook URL field, pointed at
  `/.netlify/functions/call-completed`. It fires once on `call.conversation.ended`.
  That group webhook is URL-ONLY (no custom-header field), so it cannot send our
  `x-api-key`. Auth is therefore Telnyx's **Ed25519 signature**
  (`telnyx-signature-ed25519` + `telnyx-timestamp`), verified against
  `TELNYX_PUBLIC_KEY` (Portal -> Keys & Credentials -> Public Key). Signed message
  is `${timestamp}|${rawBody}`; 5-min replay window; Node native `crypto`, no deps.
- Env for call-completed: `TELNYX_PUBLIC_KEY` (required, fail-closed) and
  `CALL_LOG_ENABLED` (gate, default OFF). `API_SHARED_SECRET` is NOT used by
  call-completed (it stays for appointment-action).
- REAL Insights webhook shape (verified live 2026-06-13, NOT the Call Control docs
  shape): top-level `{ record_type, event_type: "conversation_insight_result",
  payload }` with NO `data` wrapper. `payload` has `conversation_id`, `request_id`,
  `status`, `insight_group_id`, `results: [{ result, insight_id }]` (the configured
  insights, incl. the Summary narrative), and `metadata: { from, to, call_control_id,
  call_session_id, call_leg_id, assistant_id, called_tools, telnyx_conversation_channel,
  ... }`. No duration/occurred_at. `assembleCallEndRow` maps to THIS shape.
- JOIN KEY DOES NOT EXIST YET (verified live): on a booking call, `appointment-action`
  receives `callId: null` and `inboundCallerId: null` — the assistant defines `callId`
  but never populates it, so nothing ties the in-call tool requests to the post-call
  webhook. ITEM-2 PREREQUISITE (Telnyx-side, not code): in the assistant's
  `appointment_action` tool config, map the `callId` param to a dynamic variable that
  also appears in the webhook metadata — `call_control_id` is the best fit (present on
  both sides, per-call). Then re-verify on a booking call before item 2 joins on it.
- Payload carries: `callId`, `callbackNumber`, `inboundCallerId`, `callerName`,
  `callerEmail`, `propertyAddress`, full lead intake fields, and `smsConsent`.

## Backlog (in order — build ONE at a time)
1. DONE — proven live 2026-06-13. The Telnyx Insights webhook
   (`conversation_insight_result`) -> `call-completed.js` trigger works end to end:
   real call end -> Ed25519-verified -> fully-populated row logged under the
   `CALL_LOG_ENABLED` gate (default OFF = log only, no send path). No calendar/SMS/email;
   `appointment-action.js` untouched. Env live in Netlify: `TELNYX_PUBLIC_KEY` set,
   `CALL_LOG_ENABLED` unset (OFF). The in-call `recordCallEvent` feed (emitted from
   `appointment-action.js` terminal branches) is still DEFERRED.
2. Summary email. Reads the events for a `callId` from `call-completed.js`; once per call.
3. SMS dry-run. Gated stub: assemble and log the exact payload, never send.
4. Live SMS. Only after A2P 10DLC clears.

### Design decisions for the above (agreed, not yet built)
- Per-channel gates (one for log/email, one for SMS), default OFF. The gate is the
  "won't go live until built" guarantee — while off, there is no code path that sends.
- Stubs are side-effects only: they never change the spoken response or status, and are
  wrapped so a stub failure can never throw into a live call.
- Stubs capture the exact payload they will eventually send (diagnostic-first), so the
  real build is a swap, not a rewrite.
- `recordCallEvent` (the logging feed) is the only new piece that belongs in
  `appointment-action.js`. SMS send + summary email live in `call-completed.js`.

## NEXT PRIORITY — booking reliability (ahead of items 2-4)
Surfaced live 2026-06-13 while verifying item 1. Booking is broken in production and
takes priority over the summary email. Observed on a real booking call:
- `inboundCallerId: null` on every `appointment-action` request — the carrier caller-ID
  is never captured, so the callback number is only ever the SPOKEN `callbackNumber`
  (caller said `214-555-1234`). This is the "wrong number" symptom.
- A single call fired 1x `availability` then 3x `book` for the same slot
  (`2026-06-17T09:00:00-05:00`), and NO calendar event was created — with no
  error/Nylas/conflict/status line logged. The assistant never got a clean "booked"
  back and kept retrying. Root cause unknown; `appointment-action.js` logs the inbound
  payload but NOT its own response, so the book outcome isn't visible in logs yet.
- First diagnostic step next session: surface the `handleBook` response/Nylas outcome
  (it returns via `jsonResponse` without logging) to see why a valid `requestedStartTime`
  produced no event + 3 retries. Investigate before changing code.
- Related: the `callId` join key (item-2 prereq) stays blocked until booking is healthy.
  The Telnyx tool edit to inject `{{call_control_id}}` must go in the tool's request
  BODY as a templated value, NOT as a model-filled parameter (a parameter edit broke
  booking once already and was reverted).

## Deferred (separate tickets — NOT in current scope)
- Item 1 is CLOSED (commit 962d681 on branch `call-completed-trigger`; proven live).
- Live proof of the call-completed trigger: real test hangup + join-key verification.
- Ed25519 hardening already covers auth; no x-api-key/URL-token path on call-completed.
- The legacy Apps Script (`apps-script/Code.gs`) is FROZEN — website form only. Do not
  touch or reuse it; it retires when the website form moves to Nylas.
- Reschedule parsing refactor.
- Row 1: weekend availability (requires a slot-generation change, not a wording change).
- Row 4: singular/plural slot wording (drive off `slots.length`).
- Row 6: step-through lookup (inbound number -> name+time -> address) — a decision tree,
  backend work, not a string.
- Row 10: routing "yes" into a new booking (a control change to that branch's instruction).
- Row 24 (possible_duplicate): currently HELD on prior wording; offering "keep or make new"
  requires the book flow to handle intentional duplicate creation cleanly first.
- `handleBook` free/busy-fail string (~line 1796): doc-missed; still the old wording and
  now inconsistent with its sibling error strings.

## Working agreements
- Confirm the plan before writing code.
- Test before deploy; commit a clean checkpoint that matches exactly what ships.
- One task at a time. Flag side roads instead of taking them. Keep changes minimal,
  predictable, and robust.
