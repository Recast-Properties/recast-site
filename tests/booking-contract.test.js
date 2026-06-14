"use strict";

// Phase 1 contract tests for appointment-action.js:
//  - assistantControl carries NO speakable prose (only machine flags) — this is
//    what stops the voice model narrating backend instructions.
//  - the slot offer lives inside messageForAssistant (self-sufficient speech).
//
// Run: node tests/booking-contract.test.js

const assert = require("assert");
const { _internals } = require("../netlify/functions/appointment-action.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("booking contract tests:");

const STATUSES = [
  "needs_more_info", "needs_slot_selection", "conflict", "possible_duplicate",
  "single_match_found", "multiple_matches_found", "not_found",
  "booked", "rescheduled", "cancelled", "error", "anything_unknown"
];

test("assistantControl has no speakable 'instruction' field, for every status", () => {
  for (const status of STATUSES) {
    const ctrl = _internals.buildAssistantControl(status);
    assert.ok(!("instruction" in ctrl), `status ${status} still has an instruction field`);
    assert.strictEqual(typeof ctrl.mayConfirmSuccess, "boolean");
    assert.strictEqual(typeof ctrl.nextStep, "string");
  }
});

test("assistantControl values are short machine tokens, not prose (no spaces)", () => {
  for (const status of STATUSES) {
    const ctrl = _internals.buildAssistantControl(status);
    assert.ok(!/\s/.test(ctrl.nextStep), `nextStep for ${status} looks like prose: ${ctrl.nextStep}`);
  }
});

test("only booked/rescheduled/cancelled may confirm success", () => {
  const successy = STATUSES.filter((s) => _internals.buildAssistantControl(s).mayConfirmSuccess);
  assert.deepStrictEqual(successy.sort(), ["booked", "cancelled", "rescheduled"]);
});

test("slot offer is built into the message (single slot)", () => {
  const msg = _internals.buildSlotOfferMessage([{ spoken_time: "Wednesday, 9 in the morning Central" }]);
  assert.ok(msg.includes("Wednesday, 9 in the morning Central"));
  assert.ok(/work/i.test(msg));
});

test("slot offer is built into the message (multiple slots offers first two)", () => {
  const msg = _internals.buildSlotOfferMessage([
    { spoken_time: "Wednesday, 9 in the morning Central" },
    { spoken_time: "Wednesday, 10 in the morning Central" },
    { spoken_time: "Wednesday, 11 in the morning Central" }
  ]);
  assert.ok(msg.includes("9 in the morning"));
  assert.ok(msg.includes("10 in the morning"));
  assert.ok(!msg.includes("11 in the morning")); // only first two offered aloud
});

test("spokenCentralTime reads as 'Day at H AM/PM' (no 'in the morning')", () => {
  // 2026-06-15 11:00 Central = 16:00 UTC (CDT, -05:00).
  const elevenAmMon = new Date("2026-06-15T16:00:00Z");
  const spoken = _internals.spokenCentralTime(elevenAmMon);
  assert.strictEqual(spoken, "Monday at 11 AM");
  assert.ok(!/in the morning|in the afternoon/.test(spoken));

  // 2026-06-15 14:30 Central = 19:30 UTC -> "Monday at 2:30 PM"
  const twoThirtyPm = new Date("2026-06-15T19:30:00Z");
  assert.strictEqual(_internals.spokenCentralTime(twoThirtyPm), "Monday at 2:30 PM");
});

console.log(`\n${passed} passed`);
