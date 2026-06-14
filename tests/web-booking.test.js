"use strict";

// Tests for web-booking.js pure helpers (slot validity + open-day generation).
// June 2026 is CDT (-05:00), so Central HH:MM == UTC (HH+5):MM.
//
// Run: node tests/web-booking.test.js

const assert = require("assert");
const { _internals } = require("../netlify/functions/web-booking.js");
const { isValidSlot, buildOpenDays } = _internals;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("web-booking tests:");

const now = new Date("2026-06-15T12:00:00Z"); // Monday

test("isValidSlot: future weekday 9:30 Central is valid", () => {
  assert.strictEqual(isValidSlot(new Date("2026-06-16T14:30:00Z"), now), true); // Tue 9:30 CT
});

test("isValidSlot: weekend is invalid", () => {
  assert.strictEqual(isValidSlot(new Date("2026-06-20T15:00:00Z"), now), false); // Sat 10:00 CT
});

test("isValidSlot: past slot is invalid", () => {
  assert.strictEqual(isValidSlot(new Date("2026-06-12T15:00:00Z"), now), false); // last Fri
});

test("isValidSlot: outside business hours (7 PM CT) is invalid", () => {
  assert.strictEqual(isValidSlot(new Date("2026-06-17T00:00:00Z"), now), false); // Tue 19:00 CT
});

test("isValidSlot: non-:00/:30 minute is invalid", () => {
  assert.strictEqual(isValidSlot(new Date("2026-06-16T14:15:00Z"), now), false); // Tue 9:15 CT
});

test("buildOpenDays: empty calendar -> weekday days with 30-min slots", () => {
  const days = buildOpenDays(now, []);
  assert.ok(days.length >= 1 && days.length <= 5, `got ${days.length} days`);
  for (const d of days) {
    assert.ok(!/^(Sat|Sun)/.test(d.date_label), `weekend leaked: ${d.date_label}`);
    assert.ok(d.slots.length > 0);
    for (const s of d.slots) {
      assert.ok(s.start_time && s.label);
      assert.ok(/:00:00|:30:00/.test(s.start_time), `slot not 30-min aligned: ${s.start_time}`);
    }
  }
});

test("buildOpenDays: a fully-busy window yields no slots", () => {
  const busy = [{ startMs: now.getTime(), endMs: now.getTime() + 30 * 24 * 60 * 60 * 1000 }];
  assert.deepStrictEqual(buildOpenDays(now, busy), []);
});

test("buildOpenDays: a busy block removes overlapping slots", () => {
  const all = buildOpenDays(now, []);
  const firstDayCount = all[0].slots.length;
  // Block the first day's first slot.
  const firstSlotStart = new Date(all[0].slots[0].start_time);
  const busy = [{ startMs: firstSlotStart.getTime(), endMs: firstSlotStart.getTime() + 30 * 60 * 1000 }];
  const after = buildOpenDays(now, busy);
  assert.ok(after[0].slots.length === firstDayCount - 1, "expected one fewer slot on day 1");
});

console.log(`\n${passed} passed`);
