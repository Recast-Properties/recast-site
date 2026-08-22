// Receipts daily-summary data (auth by shared token — called by the
// receipts-daily-summary.gs Apps Script, which formats and emails it).
//
// Reads every msg/* envelope in the "receipts-data" Blobs store and reports,
// for the window [dayStartIso, dayEndIso):
//   • autoFiled  — items the bookkeeper filed, grouped by category (tax-incl.)
//   • manuallyApproved / dismissed counts
//   • needsReview — ALL currently-pending items (not just yesterday's)
//   • staleProcessing — envelopes stuck in "processing" > 1h (crashed ingest)
//   • errors — envelopes whose ingest errored in the window
//   • lostMsgIds — reconciliation: caller passes the gmailMessageIds it labeled
//     receipts-done in the window; any id with no envelope means the 202-then-
//     crash edge case fired and that email needs re-ingest.
//
// POST JSON: { token, action:"summary", dayStartIso, dayEndIso, doneMsgIds:[] }
import { getStore } from "@netlify/blobs";

const PREFIX = "msg/";
const TAX_RATE = 0.0825;
const STALE_MS = 60 * 60 * 1000;

const clean = (v) => (v == null ? "" : String(v).trim());
const num = (a) => { const n = parseFloat(String(a == null ? "" : a).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const sheetAmount = (it) => { const n = num(it.amount); return it.taxable !== false ? n * (1 + TAX_RATE) : n; };

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  const expected = process.env.RECEIPTS_SHEET_TOKEN || "";
  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  if (!expected || clean(body.token) !== expected) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const start = Date.parse(clean(body.dayStartIso)) || 0;
  const end = Date.parse(clean(body.dayEndIso)) || Date.now();
  const inWindow = (iso) => { const t = Date.parse(clean(iso)); return t >= start && t < end; };
  const doneMsgIds = (Array.isArray(body.doneMsgIds) ? body.doneMsgIds : []).map(clean).filter(Boolean);

  try {
    const store = getStore({ name: "receipts-data", consistency: "strong" });
    const { blobs } = await store.list({ prefix: PREFIX });
    const envelopes = (await Promise.all((blobs || []).map((b) => store.get(b.key, { type: "json" }))))
      .filter((e) => e && typeof e === "object");

    const autoFiled = {};            // { category: [row, ...] }
    const totals = { byCategory: {}, grand: 0 };
    const needsReview = [];
    const errors = [];
    const staleProcessing = [];
    let manuallyApproved = 0, dismissed = 0;
    const seenMsgIds = new Set();

    for (const env of envelopes) {
      seenMsgIds.add(clean(env.msgId));

      if (env.status === "processing" && Date.now() - (Date.parse(env.startedAt) || 0) > STALE_MS) {
        staleProcessing.push({ msgId: env.msgId, subject: clean(env.subject), from: clean(env.from), gmailUrl: clean(env.gmailUrl), startedAt: env.startedAt });
      }
      if (env.status === "error" && inWindow(env.processedAt)) {
        errors.push({ msgId: env.msgId, subject: clean(env.subject), from: clean(env.from), gmailUrl: clean(env.gmailUrl), error: clean(env.error) });
      }

      for (const it of env.items || []) {
        if (it.status === "pending") {
          needsReview.push({
            vendor: clean(it.vendor), date: clean(it.date), item: clean(it.item),
            amount: clean(it.amount), confidence: clean(it.confidence), notes: clean(it.notes),
            channel: clean(it.channel), sourceUrl: clean(it.sourceUrl),
            newToday: inWindow(it.receivedAt),
            // June-system leftovers (no confidence field) — the email lists
            // these as one count line instead of cluttering every morning.
            legacy: !clean(it.confidence),
          });
        } else if (inWindow(it.approvedAt)) {
          if (it.status === "filed" && it.autoFiled) {
            const cat = clean(it.category) || "(uncategorized)";
            const amt = sheetAmount(it);
            (autoFiled[cat] = autoFiled[cat] || []).push({
              vendor: clean(it.vendor), date: clean(it.date), item: clean(it.item),
              amount: amt.toFixed(2), taxable: it.taxable !== false,
              sheetCell: clean(it.sheetCell), channel: clean(it.channel), notes: clean(it.notes),
            });
            totals.byCategory[cat] = (totals.byCategory[cat] || 0) + amt;
            totals.grand += amt;
          } else if (it.status === "approved") {
            manuallyApproved++;
          }
        }
        if (it.status === "dismissed" && inWindow(it.receivedAt)) dismissed++;
      }
    }

    for (const cat of Object.keys(totals.byCategory)) totals.byCategory[cat] = totals.byCategory[cat].toFixed(2);
    totals.grand = totals.grand.toFixed(2);

    const lostMsgIds = doneMsgIds.filter((id) => !seenMsgIds.has(id));

    return Response.json({
      ok: true,
      window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      autoFiled, totals, manuallyApproved, dismissed,
      needsReview, staleProcessing, errors, lostMsgIds,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
