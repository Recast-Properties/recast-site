// Receipts queue API (auth required, shares ADMIN_PASSWORD with /admin).
//
// Storage: Netlify Blobs store "receipts-data", ONE BLOB PER RECEIPT EMAIL at
// key "msg/<gmailMessageId>" (manual/seed items live under "msg/manual-...").
// Each blob is an envelope written by receipts-ingest-background.mjs:
//   { msgId, channel, gmailUrl, subject, from, receivedAt,
//     status: "processing"|"done"|"error", startedAt, processedAt, error,
//     items: [ <item>, ... ] }
// An item:
//   { id, vendor, date, item, amount (PRE-tax), category, taxable, confidence,
//     notes, channel, sourceUrl, status, autoFiled, sheetCell, source,
//     sourceMsgId, receivedAt, approvedAt }
//   item status: "pending" | "filed" (auto-filed by the bookkeeper)
//              | "approved" (manually) | "dismissed"
//
// The per-message layout exists because background ingests run CONCURRENTLY —
// each ingest writes only its own key, so there is no read-modify-write race.
// This API mutates one envelope at a time, located via the item's sourceMsgId.
//
// POST JSON (header x-admin-token == ADMIN_PASSWORD):
//   { action:"list" }                                   -> { ok, rows }
//   { action:"seed", force? }                           -> { ok, count }
//   { action:"update", id, sourceMsgId, patch:{...} }   -> { ok }
//   { action:"approve", id, sourceMsgId, patch?:{...} } -> { ok } (requires category)
//   { action:"dismiss", id, sourceMsgId }               -> { ok }
//   { action:"delete", ids?|id, sourceMsgId? }          -> { ok, removed }
//   { action:"clear" }                                  -> { ok }
//   { action:"migrate" }  one-time: split legacy queue.json into msg/* blobs
import { getStore } from "@netlify/blobs";

const PREFIX = "msg/";
const LEGACY_KEY = "queue.json";
const STATUSES = ["pending", "filed", "approved", "dismissed"];
// State sales tax (8.25%) applied per-item when an item is marked taxable.
const TAX_RATE = 0.0825;
// String fields the UI is allowed to edit on an item. (taxable is a boolean,
// handled separately in applyPatch.)
const EDITABLE = ["vendor", "date", "item", "amount", "category", "sourceUrl", "notes"];

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}
const clean = (v) => (v == null ? "" : String(v).trim());
const asBool = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : (v === true || v === "true" || v === 1 || v === "1"));
const newId = () => (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2));

function normalize(it) {
  return {
    id: clean(it.id) || newId(),
    vendor: clean(it.vendor),
    date: clean(it.date),
    item: clean(it.item),
    amount: clean(it.amount),
    category: clean(it.category),
    // Item subtotal is stored PRE-tax (as read from the receipt line). When
    // taxable, the sheet receives amount * (1 + TAX_RATE).
    taxable: asBool(it.taxable, true),
    confidence: clean(it.confidence),
    duplicate: clean(it.duplicate),
    notes: clean(it.notes),
    channel: clean(it.channel) || "receipts",
    sourceUrl: clean(it.sourceUrl),
    status: STATUSES.includes(it.status) ? it.status : "pending",
    autoFiled: !!it.autoFiled,
    sheetCell: clean(it.sheetCell),
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
// when taxable.
function sheetAmount(item) {
  const n = parseFloat(String(item.amount).replace(/[^0-9.\-]/g, "")) || 0;
  const v = item.taxable ? n * (1 + TAX_RATE) : n;
  return v.toFixed(2);
}

// ---- envelope helpers -------------------------------------------------------

async function listEnvelopes(store) {
  const out = [];
  const { blobs } = await store.list({ prefix: PREFIX });
  const envs = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: "json" })));
  for (const env of envs) if (env && typeof env === "object") out.push(env);
  return out;
}

async function readEnvelope(store, sourceMsgId) {
  if (!sourceMsgId) return null;
  return await store.get(PREFIX + sourceMsgId, { type: "json" });
}

async function writeEnvelope(store, env) {
  await store.setJSON(PREFIX + env.msgId, env);
}

// Locate an item by id: fast path via its sourceMsgId, fallback full scan
// (covers stale UIs that don't send sourceMsgId yet).
async function findItem(store, id, sourceMsgId) {
  const tryEnv = async (env) => {
    if (!env || !Array.isArray(env.items)) return null;
    const item = env.items.find((r) => clean(r.id) === id);
    return item ? { env, item } : null;
  };
  if (sourceMsgId) {
    const hit = await tryEnv(await readEnvelope(store, sourceMsgId));
    if (hit) return hit;
  }
  for (const env of await listEnvelopes(store)) {
    const hit = await tryEnv(env);
    if (hit) return hit;
  }
  return null;
}

// Flatten envelopes into UI rows. A still-processing (or crashed-pre-items)
// envelope surfaces as one synthetic read-only row so nothing is invisible.
function toRows(envelopes) {
  const rows = [];
  for (const env of envelopes) {
    const items = Array.isArray(env.items) ? env.items : [];
    for (const it of items) {
      rows.push({ ...normalize(it), sourceMsgId: clean(it.sourceMsgId) || clean(env.msgId), emailUrl: clean(env.gmailUrl), envStatus: env.status || "done" });
    }
    if (env.status === "processing" && items.length === 0) {
      rows.push({
        id: "proc-" + clean(env.msgId),
        vendor: clean(env.from), date: "", item: clean(env.subject) || "(reading receipt…)",
        amount: "", category: "", taxable: false, confidence: "", notes: "",
        channel: clean(env.channel) || "receipts",
        sourceUrl: clean(env.gmailUrl), status: "processing", autoFiled: false,
        sheetCell: "", source: "gmail", sourceMsgId: clean(env.msgId),
        receivedAt: clean(env.receivedAt) || clean(env.startedAt), approvedAt: "",
        envStatus: "processing",
      });
    }
  }
  rows.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
  return rows;
}

// Fake receipt line items so the queue/Approve flow can be tested before Gmail
// is wired in. Spans several categories on purpose.
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
  const store = getStore({ name: "receipts-data", consistency: "strong" });

  try {
    if (body.action === "list") {
      return Response.json({ ok: true, rows: toRows(await listEnvelopes(store)) });
    }

    if (body.action === "seed") {
      const existing = await readEnvelope(store, "manual-seed");
      if (existing && !body.force) {
        return Response.json({ ok: true, count: (existing.items || []).length, note: "already has items" });
      }
      const msgId = "manual-seed";
      const items = SEED.map((s) => normalize({ ...s, source: "seed", sourceMsgId: msgId, status: "pending", sourceUrl: "https://mail.google.com/" }));
      await writeEnvelope(store, {
        msgId, channel: "receipts", gmailUrl: "", subject: "Seed items", from: "seed",
        receivedAt: new Date().toISOString(), status: "done", items,
      });
      return Response.json({ ok: true, count: items.length });
    }

    if (body.action === "update") {
      const hit = await findItem(store, clean(body.id), clean(body.sourceMsgId));
      if (!hit) return Response.json({ ok: false, error: "Item not found" }, { status: 404 });
      applyPatch(hit.item, body.patch);
      await writeEnvelope(store, hit.env);
      return Response.json({ ok: true });
    }

    if (body.action === "approve") {
      const hit = await findItem(store, clean(body.id), clean(body.sourceMsgId));
      if (!hit) return Response.json({ ok: false, error: "Item not found" }, { status: 404 });
      const item = hit.item;
      applyPatch(item, body.patch);
      if (!item.category) return Response.json({ ok: false, error: "Pick a category before approving." }, { status: 400 });

      // Append into the matching block on the sheet via the receipts-sheet Apps
      // Script. Only mark approved once the write succeeds.
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
              link: item.sourceUrl,        // clickable link to the source email
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
      await writeEnvelope(store, hit.env);
      return Response.json({ ok: true, wrote: item.sheetCell || null });
    }

    if (body.action === "dismiss") {
      const hit = await findItem(store, clean(body.id), clean(body.sourceMsgId));
      if (!hit) return Response.json({ ok: false, error: "Item not found" }, { status: 404 });
      hit.item.status = "dismissed";
      await writeEnvelope(store, hit.env);
      return Response.json({ ok: true });
    }

    if (body.action === "delete") {
      // A dismissed item still blocks re-ingest of its email; delete truly
      // removes it (and its envelope once empty) so the poller can re-read.
      const ids = Array.isArray(body.ids) ? body.ids.map(clean) : (body.id ? [clean(body.id)] : []);
      let removed = 0;
      for (const env of await listEnvelopes(store)) {
        const before = (env.items || []).length;
        env.items = (env.items || []).filter((r) => !ids.includes(clean(r.id)));
        if (env.items.length !== before) {
          removed += before - env.items.length;
          if (env.items.length === 0 && env.status !== "processing") {
            await store.delete(PREFIX + env.msgId);
          } else {
            await writeEnvelope(store, env);
          }
        }
      }
      return Response.json({ ok: true, removed });
    }

    if (body.action === "clear") {
      const { blobs } = await store.list({ prefix: PREFIX });
      for (const b of blobs || []) await store.delete(b.key);
      await store.delete(LEGACY_KEY);
      return Response.json({ ok: true });
    }

    if (body.action === "migrate") {
      // One-time: split the legacy flat queue.json array into per-message blobs.
      const legacy = await store.get(LEGACY_KEY, { type: "json" });
      if (!Array.isArray(legacy)) return Response.json({ ok: true, migrated: 0, note: "no legacy queue.json" });
      const groups = new Map();
      for (const raw of legacy) {
        const it = normalize(raw);
        const msgId = it.sourceMsgId && it.sourceMsgId !== "seed" ? it.sourceMsgId : "manual-" + it.id;
        it.sourceMsgId = msgId;
        if (!groups.has(msgId)) groups.set(msgId, []);
        groups.get(msgId).push(it);
      }
      let migrated = 0;
      for (const [msgId, items] of groups) {
        await writeEnvelope(store, {
          msgId, channel: "receipts", gmailUrl: items[0].sourceUrl, subject: "", from: items[0].vendor,
          receivedAt: items[0].receivedAt, status: "done", processedAt: new Date().toISOString(), items,
        });
        migrated += items.length;
      }
      await store.delete(LEGACY_KEY);
      return Response.json({ ok: true, migrated, envelopes: groups.size });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
