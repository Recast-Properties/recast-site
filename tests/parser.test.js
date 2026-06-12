// Parser tests for netlify/functions/appointment-action.js
//
// Run from the project root with:
//   node --test tests/parser.test.js
//
// Reference "now" is fixed so results never depend on when you run the tests:
//   Wednesday, June 10, 2026, 10:00 AM Central
//
// Tests marked [BUG] reproduce known defects and are EXPECTED TO FAIL
// until the Step 4 parser fix. Everything else must pass before and
// after any parser change. If a non-[BUG] test breaks, the change
// caused a regression.

const test = require("node:test");
const assert = require("node:assert");

const { _internals } = require("../netlify/functions/appointment-action.js");
const { parseRequestedWindow } = _internals;

const NOW = new Date("2026-06-10T10:00:00-05:00"); // Wed 10:00 AM Central

function centralString(date) {
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function windowOf(text) {
  const w = parseRequestedWindow(text, NOW);
  if (!w) return null;
  return { start: centralString(w.start), end: centralString(w.end) };
}

// ---------------------------------------------------------------
// Locked-in correct behavior. These must always pass.
// ---------------------------------------------------------------

test("clear weekday + time with meridiem: 'Monday at 3 PM'", () => {
  assert.deepStrictEqual(windowOf("Monday at 3 PM"), {
    start: "Mon, 6/15, 3:00 PM",
    end: "Mon, 6/15, 4:00 PM"
  });
});

test("clear weekday + morning time: 'Monday at 11 AM'", () => {
  assert.deepStrictEqual(windowOf("Monday at 11 AM"), {
    start: "Mon, 6/15, 11:00 AM",
    end: "Mon, 6/15, 12:00 PM"
  });
});

test("'today at 4' infers PM and stays on today", () => {
  assert.deepStrictEqual(windowOf("today at 4"), {
    start: "Wed, 6/10, 4:00 PM",
    end: "Wed, 6/10, 5:00 PM"
  });
});

test("spoken numbers: 'tomorrow at three thirty' infers PM", () => {
  assert.deepStrictEqual(windowOf("tomorrow at three thirty"), {
    start: "Thu, 6/11, 3:30 PM",
    end: "Thu, 6/11, 4:30 PM"
  });
});

test("range: 'tomorrow 10 to 11'", () => {
  assert.deepStrictEqual(windowOf("tomorrow 10 to 11"), {
    start: "Thu, 6/11, 10:00 AM",
    end: "Thu, 6/11, 11:00 AM"
  });
});

test("'tomorrow morning' maps to 9-12 window", () => {
  assert.deepStrictEqual(windowOf("tomorrow morning"), {
    start: "Thu, 6/11, 9:00 AM",
    end: "Thu, 6/11, 12:00 PM"
  });
});

test("vague 'sometime' is rejected (returns null)", () => {
  assert.strictEqual(parseRequestedWindow("sometime", NOW), null);
});

test("vague 'whenever works' is rejected (returns null)", () => {
  assert.strictEqual(parseRequestedWindow("whenever works", NOW), null);
});

test("empty input is rejected (returns null)", () => {
  assert.strictEqual(parseRequestedWindow("", NOW), null);
});

// ---------------------------------------------------------------
// [BUG] reproductions. Expected to FAIL until the Step 4 fix.
// ---------------------------------------------------------------

test("[BUG] 'four o clock same day' must mean today 4 PM", () => {
  // Live failure from the June 12 Jennifer test.
  // Defect 1: inferBusinessHour uses text.includes("am"), and the
  //   word "sAMe" contains "am", so 4 is not bumped to 16 (4 PM).
  // Defect 2: the business-hours clamp then silently turns 4 AM
  //   into 9 AM instead of rejecting.
  // Defect 3: "same day" is not a recognized date phrase, so the
  //   date falls through to next business day instead of today.
  // Current wrong output: Mon 6/15, 9:00 AM.
  assert.deepStrictEqual(windowOf("four o clock same day"), {
    start: "Wed, 6/10, 4:00 PM",
    end: "Wed, 6/10, 5:00 PM"
  });
});

test("[BUG] out-of-hours time '4 am tomorrow' must be rejected, not moved to 9 AM", () => {
  // The clamp invents a time the caller never said. The backend
  // must return null so the caller gets a clarifying question.
  assert.strictEqual(parseRequestedWindow("4 am tomorrow", NOW), null);
});

test("[BUG] bare time with no date must not silently pick a date: '3 pm'", () => {
  // Caller gave a time but no day. Current behavior silently books
  // next business day. The parser must not invent the date; it
  // should return null so the assistant asks which day.
  assert.strictEqual(parseRequestedWindow("3 pm", NOW), null);
});
