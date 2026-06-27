// Receipts ingest (auth required, shares the receipts token). Receives one
// receipt email from the Gmail poller (apps-script/receipts-poller.gs), asks
// Claude to extract the itemized line items, and appends them to the queue as
// "pending" so they show up in the receipts queue UI.
//
// Writes to the same Netlify Blobs store as receipts-data.mjs
// (store "receipts-data", key "queue.json").
//
// POST JSON (body.token must match RECEIPTS_SHEET_TOKEN):
//   { token, gmailMessageId, gmailUrl, subject, from, receivedDate, body,
//     attachments: [{ filename, mimeType, dataBase64 }] }
//   -> { ok, added }  (added = number of line items queued; 0 if already ingested)
import { getStore } from "@netlify/blobs";
import heicConvert from "heic-convert";

const STORE = "receipts-data";
const KEY = "queue.json";
const TAX_RATE = 0.0825;
// Most capable model — best at messy/scanned receipts. Switch to
// "claude-haiku-4-5" to cut cost if accuracy is fine.
const MODEL = "claude-opus-4-8";

const clean = (v) => (v == null ? "" : String(v).trim());
const newId = () => (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2));
// "VistaPrint <no-reply@vistaprint.com>" -> "VistaPrint"
const senderName = (from) => {
  const s = clean(from);
  const m = s.match(/^([^<]+)</);
  return (m ? m[1] : s.replace(/<[^>]*>/, "")).trim().replace(/^"|"$/g, "");
};

async function readAll(store) {
  const raw = await store.get(KEY, { type: "json" });
  return Array.isArray(raw) ? raw : [];
}
async function writeAll(store, arr) {
  await store.set(KEY, JSON.stringify(arr), { metadata: { contentType: "application/json" } });
}

function makeItem(it) {
  return {
    id: newId(),
    vendor: clean(it.vendor),
    date: clean(it.date),
    item: clean(it.item),
    amount: clean(it.amount),
    category: "",
    taxable: it.taxable !== false,
    sourceUrl: clean(it.sourceUrl),
    status: "pending",
    source: "gmail",
    sourceMsgId: clean(it.sourceMsgId),
    receivedAt: clean(it.receivedAt) || new Date().toISOString(),
    approvedAt: "",
  };
}

const EXTRACT_INSTRUCTIONS =
  'You extract structured expense data from a purchase receipt for a real-estate rehab business. ' +
  'Return ONLY a single JSON object (no prose, no markdown fences) of the form:\n' +
  '{"vendor": string, "date": string, "taxApplies": boolean, "items": [{"description": string, "amount": number}]}\n' +
  'Rules:\n' +
  '- "vendor" is the store/merchant name. "date" is the purchase date as MM/DD/YY if you can determine it, else "".\n' +
  '- Each item "amount" is that line item\'s price BEFORE tax, as a number (e.g. 24.97).\n' +
  '- Do NOT include subtotal, tax, total, store info, or payment lines as items.\n' +
  '- "taxApplies" is true if US sales tax was charged on this receipt, false otherwise (e.g. out-of-state, tax-exempt).\n' +
  '- If the receipt has no itemized list (e.g. gas or a single service charge), return one item describing the whole purchase with its pre-tax amount.\n' +
  '- If a value is unknown, use "" for strings.\n' +
  'Return ONLY the JSON object.';

function buildContent(payload) {
  const ctx =
    EXTRACT_INSTRUCTIONS +
    "\n\n--- Email ---\n" +
    "Subject: " + clean(payload.subject) + "\n" +
    "From: " + clean(payload.from) + "\n" +
    "Date: " + clean(payload.receivedDate) + "\n\n" +
    (clean(payload.body) ? clean(payload.body).slice(0, 20000) : "(no text body)");

  const content = [{ type: "text", text: ctx }];
  for (const att of payload.attachments || []) {
    let mime = clean(att.mimeType).toLowerCase();
    const data = clean(att.dataBase64);
    if (!data) continue;
    if (mime === "image/jpg") mime = "image/jpeg";
    if (mime === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
    } else if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) {
      content.push({ type: "image", source: { type: "base64", media_type: mime, data } });
    }
    // Unsupported types (e.g. HEIC) are skipped -> handled as a review placeholder.
  }
  return content;
}

// iPhone photos are often HEIC, which Claude can't read. Convert to JPEG in place.
async function convertHeic(att) {
  try {
    const inBuf = Buffer.from(att.dataBase64, "base64");
    const out = await heicConvert({ buffer: inBuf, format: "JPEG", quality: 0.85 });
    att.dataBase64 = Buffer.from(out).toString("base64");
    att.bytes = out.length;
    att.mimeType = "image/jpeg";
    return true;
  } catch (e) {
    console.error("[ingest] HEIC convert failed: " + String((e && e.message) || e));
    return false;
  }
}

function parseJsonLoose(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });

  const expected = process.env.RECEIPTS_SHEET_TOKEN || "";
  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  if (!expected || clean(body.token) !== expected) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) return Response.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const msgId = clean(body.gmailMessageId);
  const store = getStore({ name: STORE, consistency: "strong" });

  // Idempotency: never ingest the same Gmail message twice.
  const existing = await readAll(store);
  if (msgId && existing.some((r) => clean(r.sourceMsgId) === msgId)) {
    return Response.json({ ok: true, added: 0, skipped: "already ingested" });
  }

  // Convert any HEIC/HEIF photos (iPhone default) to JPEG so Claude can read them.
  for (const att of body.attachments || []) {
    const m = clean(att.mimeType).toLowerCase();
    if (m === "image/heic" || m === "image/heif") await convertHeic(att);
  }

  // Ask Claude to extract the line items.
  let aiText = "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: "Output only the requested JSON object. No explanation, no markdown.",
        messages: [{ role: "user", content: buildContent(body) }],
      }),
    });
    const j = await res.json();
    if (!res.ok) return Response.json({ ok: false, error: "Claude " + res.status + ": " + (j.error?.message || "") }, { status: 502 });
    if (j.stop_reason === "refusal") return Response.json({ ok: false, error: "Claude refused to process this receipt" }, { status: 502 });
    aiText = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (e) {
    return Response.json({ ok: false, error: "Claude call failed: " + String((e && e.message) || e) }, { status: 502 });
  }

  const attCount = (body.attachments || []).length;
  const bodyLen = (clean(body.body) || "").length;
  const attMimes = (body.attachments || []).map((a) => clean(a.mimeType) + "(" + (a.bytes || "?") + "b)").join("|");

  const parsed = parseJsonLoose(aiText);
  const taxable = !!parsed && parsed.taxApplies !== false;
  let newItems = [];
  if (parsed && Array.isArray(parsed.items)) {
    newItems = parsed.items
      .filter((it) => it && (clean(it.description) || it.amount != null))
      .map((it) => makeItem({
        vendor: parsed.vendor,
        date: parsed.date,
        item: it.description,
        amount: it.amount,
        taxable,
        sourceUrl: body.gmailUrl,
        sourceMsgId: msgId,
      }));
  } else {
    console.error(`[ingest] PARSE-FAIL msg=${msgId} subject="${clean(body.subject)}" atts=${attCount} mimes=${attMimes} bodyLen=${bodyLen} aiLen=${aiText.length} head=${aiText.slice(0, 200)}`);
  }

  // Never silently drop a receipt: if Claude couldn't pull any line items,
  // queue ONE "needs review" placeholder linking to the email so it stays
  // visible instead of disappearing.
  if (!newItems.length) {
    console.warn(`[ingest] NO-ITEMS -> review placeholder msg=${msgId} subject="${clean(body.subject)}" from="${clean(body.from)}" atts=${attCount} mimes=${attMimes} bodyLen=${bodyLen} aiHead=${aiText.slice(0, 200)}`);
    newItems = [makeItem({
      vendor: senderName(body.from) || clean(body.subject) || "Unknown sender",
      date: "",
      item: "⚠️ Couldn't auto-read — open the receipt (🧾) and enter it manually",
      amount: "",
      taxable: false,
      sourceUrl: body.gmailUrl,
      sourceMsgId: msgId,
    })];
  }

  // Re-read + append (small window; the poller calls these one at a time).
  const arr = await readAll(store);
  if (msgId && arr.some((r) => clean(r.sourceMsgId) === msgId)) {
    return Response.json({ ok: true, added: 0, skipped: "already ingested" });
  }
  arr.push(...newItems);
  await writeAll(store, arr);

  console.log(`[ingest] OK msg=${msgId} subject="${clean(body.subject)}" atts=${attCount} mimes=${attMimes} bodyLen=${bodyLen} added=${newItems.length} vendor="${clean(parsed && parsed.vendor)}" total=${arr.length}`);
  return Response.json({ ok: true, added: newItems.length, vendor: clean(parsed && parsed.vendor), taxable });
};
