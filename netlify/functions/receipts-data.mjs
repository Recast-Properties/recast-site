// Receipts queue API (auth required, shares ADMIN_PASSWORD with /admin).
// Queue items live entirely in Netlify Blobs (store "receipts-data", key
// "queue.json" = an array of item objects). No database.
//
// An item: { id, vendor, date, item, amount, category, status, source,
//            sourceMsgId, receivedAt, approvedAt }
//   status: "pending" | "approved" | "dismissed"
//
// POST JSON (header x-admin-token == ADMIN_PASSWORD):
//   { action:"list" }                       -> { ok, rows }
//   { action:"seed", force? }               -> { ok, count }  (fake test items)
//   { action:"update", id, patch:{...} }    -> { ok }         (edit fields)
//   { action:"approve", id, patch?:{...} }  -> { ok }         (requires category)
//   { action:"dismiss", id }                -> { ok }
//   { action:"clear" }                      -> { ok }         (wipe the queue)
import { getStore } from "@netlify/blobs";

const STORE = "receipts-data";
const KEY = "queue.json";
const STATUSES = ["pending", "approved", "dismissed"];
// State sales tax (8.25%) applied per-item when an item is marked taxable.
const TAX_RATE = 0.0825;
// String fields the UI is allowed to edit on an item. (taxable is a boolean,
// handled separately in applyPatch.)
const EDITABLE = ["vendor", "date", "item", "amount", "category", "sourceUrl"];

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}
const clean = (v) => (v == null ? "" : String(v).trim());
const asBool = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : (v === true || v === "true" || v === 1 || v === "1"));
const newId = () => (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2));

async function readAll(store) {
  const raw = await store.get(KEY, { type: "json" });
  return Array.isArray(raw) ? raw : [];
}
async function writeAll(store, arr) {
  await store.set(KEY, JSON.stringify(arr), { metadata: { contentType: "application/json" } });
}

function normalize(it) {
  return {
    id: clean(it.id) || newId(),
    vendor: clean(it.vendor),
    date: clean(it.date),
    item: clean(it.item),
    amount: clean(it.amount),
    category: clean(it.category),
    // Item subtotal is stored PRE-tax (as read from the receipt line). When
    // taxable, the sheet receives amount * (1 + TAX_RATE) — see TAX_RATE below.
    taxable: asBool(it.taxable, true),
    sourceUrl: clean(it.sourceUrl),
    status: STATUSES.includes(it.status) ? it.status : "pending",
    source: clean(it.source) || "manual",
    sourceMsgId: clean(it.sourceMsgId),
    receivedAt: clean(it.receivedAt) || new Date().toISOString(),
    approvedAt: clean(it.approvedAt),
  };
}

// Apply only the whitelisted editable fields from a patch onto an item.
function applyPatch(item, patch) {
  if (!patch || typeof patch !== "object") return item;
  for (const f of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, f)) item[f] = clean(patch[f]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "taxable")) item.taxable = asBool(patch.taxable, true);
  return item;
}

// The amount that will be written to the sheet for an item: subtotal plus tax
// when taxable. (Used by the Task-2 sheet append.)
function sheetAmount(item) {
  const n = parseFloat(String(item.amount).replace(/[^0-9.\-]/g, "")) || 0;
  const v = item.taxable ? n * (1 + TAX_RATE) : n;
  return v.toFixed(2);
}

// Fake receipt line items so the queue/Approve flow can be tested before Gmail
// is wired in (Task 1). Spans several categories on purpose.
const SEED = [
  { vendor: "Home Depot", date: "06/24/26", item: "Cordless Drill", amount: "129.00" },
  { vendor: "Home Depot", date: "06/24/26", item: "Drill Bit Set", amount: "24.97" },
  { vendor: "Shell", date: "06/23/26", item: "Gas", amount: "61.40" },
  { vendor: "Uber Eats", date: "06/22/26", item: "Crew meal", amount: "48.13" },
  { vendor: "Amazon", date: "06/21/26", item: "Label Maker", amount: "37.99" },
  { vendor: "Adobe", date: "06/20/26", item: "Acrobat subscription", amount: "19.99" },
  { vendor: "Lowe's", date: "06/20/26", item: "Tape Measure", amount: "18.97" },
];

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!authed(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  // Strong consistency: an edit/approve then an immediate re-list must reflect it.
  const store = getStore({ name: STORE, consistency: "strong" });

  try {
    if (body.action === "list") {
      return Response.json({ ok: true, rows: await readAll(store) });
    }

    if (body.action === "seed") {
      const existing = await readAll(store);
      if (existing.length && !body.force) {
        return Response.json({ ok: true, count: existing.length, note: "already has items" });
      }
      const out = SEED.map((s) => normalize({ ...s, source: "seed", sourceMsgId: "seed", status: "pending", sourceUrl: "https://mail.google.com/" }));
      await writeAll(store, out);
      return Response.json({ ok: true, count: out.length });
    }

    if (body.action === "update") {
      const id = clean(body.id);
      const arr = await readAll(store);
      const item = arr.find((r) => clean(r.id) === id);
      if (!item) return Response.json({ ok: false, error: "Item not found" }, { status: 404 });
      applyPatch(item, body.patch);
      await writeAll(store, arr);
      return Response.json({ ok: true });
    }

    if (body.action === "approve") {
      const id = clean(body.id);
      const arr = await readAll(store);
      const item = arr.find((r) => clean(r.id) === id);
      if (!item) return Response.json({ ok: false, error: "Item not found" }, { status: 404 });
      applyPatch(item, body.patch);
      if (!item.category) return Response.json({ ok: false, error: "Pick a category before approving." }, { status: 400 });

      // Append into the matching block on the sheet via the receipts-sheet Apps
      // Script. Only mark approved once the write succeeds. Until the webhook is
      // configured (RECEIPTS_SHEET_URL), approving just moves it in the queue.
      const sheetUrl = process.env.RECEIPTS_SHEET_URL || "";
      if (sheetUrl) {
        let res2, j2 = {};
        try {
          res2 = await fetch(sheetUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token: process.env.RECEIPTS_SHEET_TOKEN || "",
              action: "append",
              category: item.category,
              vendor: item.vendor,
              date: item.date,
              item: item.item,
              amount: sheetAmount(item),   // tax-inclusive when taxable
              subtotal: item.amount,
              taxable: item.taxable,
            }),
          });
          try { j2 = await res2.json(); } catch (_) {}
        } catch (e2) {
          return Response.json({ ok: false, error: "Sheet write failed: " + String((e2 && e2.message) || e2) }, { status: 502 });
        }
        if (!res2.ok || j2.ok === false) {
          return Response.json({ ok: false, error: "Sheet: " + (j2.error || ("HTTP " + res2.status)) }, { status: 502 });
        }
        item.sheetCell = j2.wrote || "";
      }

      item.status = "approved";
      item.approvedAt = new Date().toISOString();
      await writeAll(store, arr);
      return Response.json({ ok: true, wrote: item.sheetCell || null });
    }

    if (body.action === "dismiss") {
      const id = clean(body.id);
      const arr = await readAll(store);
      const item = arr.find((r) => clean(r.id) === id);
      if (!item) return Response.json({ ok: false, error: "Item not found" }, { status: 404 });
      item.status = "dismissed";
      await writeAll(store, arr);
      return Response.json({ ok: true });
    }

    if (body.action === "delete") {
      const ids = Array.isArray(body.ids) ? body.ids.map(clean) : (body.id ? [clean(body.id)] : []);
      const arr = await readAll(store);
      const next = arr.filter((r) => !ids.includes(clean(r.id)));
      await writeAll(store, next);
      return Response.json({ ok: true, removed: arr.length - next.length });
    }

    if (body.action === "clear") {
      await writeAll(store, []);
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
