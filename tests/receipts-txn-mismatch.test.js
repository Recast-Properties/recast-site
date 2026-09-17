// The split-forward seatbelt (2026-09-16): the same transaction number recorded at a
// different amount by another email holds the item instead of filing money twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { txnAmountMismatch } from "../netlify/functions/receipts-ingest-background.mjs";

const known = new Map([
  ["corelogic inc|1520-7474", [{ amount: "435.00", cell: "AR69:AV69", status: "filed" }]],
  ["uber|abc123", [{ amount: "38.51", cell: "Z70:AD70", status: "filed" }]],
]);

test("same number, different amount, other email -> the other record", () => {
  const hit = txnAmountMismatch(known, { vendor: "CoreLogic Inc", txnId: "1520-7474", amount: "235" });
  assert.equal(hit.cell, "AR69:AV69");
  assert.equal(hit.amount, "435.00");
});

test("same number, same amount -> null (that is the TXN-SAME path's job)", () => {
  assert.equal(txnAmountMismatch(known, { vendor: "CoreLogic Inc", txnId: "1520-7474", amount: "435.00" }), null);
});

test("no number, unknown number, other vendor, or rideshare -> null", () => {
  assert.equal(txnAmountMismatch(known, { vendor: "CoreLogic Inc", txnId: "", amount: "235" }), null);
  assert.equal(txnAmountMismatch(known, { vendor: "CoreLogic Inc", txnId: "9999", amount: "235" }), null);
  assert.equal(txnAmountMismatch(known, { vendor: "Cotality", txnId: "1520-7474", amount: "235" }), null);
  assert.equal(txnAmountMismatch(known, { vendor: "Uber", txnId: "abc123", amount: "46.98" }), null);
});
