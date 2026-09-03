// Receipts ingest — the autonomous bookkeeper (Netlify BACKGROUND function; the
// "-background" suffix gives it a 15-minute limit and callers an immediate 202).
//
// Receives one receipt email from the Gmail poller (apps-script/receipts-poller.gs),
// has Claude (Opus 5 + web search for SKU lookups) itemize + categorize it, and:
//   • files high-confidence items STRAIGHT into the expense sheet (status "filed"),
//   • leaves uncertain/unreadable items in the queue for review (status "pending").
//
// Never silently drops a receipt: the FIRST thing this function does is write a
// visible "processing" record to Blobs, so even a hard crash leaves a trail the
// morning summary email can flag.
//
// Storage: one blob per email in store "receipts-data", key "msg/<gmailMessageId>"
// (this function is that key's only writer → concurrent ingests can't race).
//
// POST JSON (body.token must match RECEIPTS_SHEET_TOKEN):
//   { token, gmailMessageId, gmailUrl, subject, from, receivedDate, body,
//     channel: "receipts"|"travel",
//     attachments: [{ filename, mimeType, bytes, blobKey }] }
//
// ⚠️ This is a BACKGROUND function — async invocation, ~256 KB request cap
// (a photo in the POST body 413-bounces the whole call). Attachment BYTES
// therefore never ride this request: the poller first uploads each one via
// receipts-upload.mjs (synchronous, 6 MB cap) to Blobs key
// "upload/<msgId>/<i>" and sends only { blobKey } references here; the bytes
// are loaded back from Blobs below and the upload/* keys deleted when done.
// (Legacy inline { dataBase64 } is still honored if present and small.)
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import heicConvert from "heic-convert";

const STORE = "receipts-data";
const VIEWER_BASE = "https://receipts--incomparable-raindrop-8f3d22.netlify.app/receipts/view.html?m=";
const TAX_RATE = 0.0825;
const MODEL = "claude-opus-5";
const MAX_TURNS = 8;               // hard cap on the agentic loop (pause_turn resumes)
const CATEGORIES = ["Tools","Materials","Marketing","Meals","Travel","Office","Gas/Truck/Trailer","Subscriptions","Website","Business"];

const clean = (v) => (v == null ? "" : String(v).trim());
const newId = () => (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2));
// Model notes occasionally leak tool/schema fragments (seen live 2026-08-21:
// a Japanese schema-validation error mid-note, a trailing "}]}</parameter>"
// tail). Notes are plain prose — cut from the first curly brace / angle-tag
// / validation-error phrase onward. (Square brackets stay: "[Personal]".)
function sanitizeNote(s) {
  return String(s || "")
    .replace(/(?:Json ?検証エラー|JSON validation error)[\s\S]*$/i, "")
    .replace(/[{}<][\s\S]*$/, "")
    .trim();
}
// "VistaPrint <no-reply@vistaprint.com>" -> "VistaPrint"
const senderName = (from) => {
  const s = clean(from);
  const m = s.match(/^([^<]+)</);
  return (m ? m[1] : s.replace(/<[^>]*>/, "")).trim().replace(/^"|"$/g, "");
};

// ---- extraction schema (structured output) ---------------------------------
const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["vendor", "date", "subtotal", "items"],
  properties: {
    vendor: { type: "string", description: "Store/merchant name, '' if unknown" },
    date: { type: "string", description: "Purchase date MM/DD/YY, '' if unknown" },
    subtotal: { type: "number", description: "The receipt's stated pre-tax subtotal (or pre-tax total if no subtotal line); 0 if the receipt shows none" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "amount", "taxable", "category", "confidence", "duplicate", "notes"],
        properties: {
          description: { type: "string" },
          amount: { type: "number", description: "What was actually paid for this line, excluding ONLY Texas sales tax" },
          duplicate: { enum: ["no", "suspected", "confirmed"], description: "Is this charge already recorded in the books shown to you?" },
          taxable: { type: "boolean" },
          category: { enum: [...CATEGORIES, ""] },
          confidence: { enum: ["high", "medium", "low"] },
          notes: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the automated bookkeeper for Recast Properties, a small real-estate rehab business in Ellis County, Texas. You receive one receipt email at a time (text, PDF, or photo) and itemize it for the expense sheet. Your output is filed with no human in the loop when you mark it high-confidence, so be honest about uncertainty.

Extract EVERY purchased line item — completeness is critical: your item amounts are reconciled against the "subtotal" field, and a receipt with missing lines corrupts the books.

Amounts policy — record what was ACTUALLY PAID: amounts must include shipping, delivery fees, airline taxes and carrier fees, tips, out-of-state taxes — everything the business was charged — EXCLUDING ONLY Texas sales tax (the system re-adds 8.25% per taxable item, so TX sales tax must never be inside an amount). If a receipt includes shipping/delivery/handling charges, do NOT itemize it: return ONE item summarizing the whole purchase (name the main products in the description) with the full amount paid. Restaurant/food/drink receipts are NEVER itemized: one line ("Meal at <restaurant>") with the full amount paid including tip (still excluding TX sales tax). Itemize only product receipts without shipping (e.g. in-store hardware/materials purchases). Never include TX-sales-tax, subtotal, or total lines as items. Set "subtotal" to the amount charged minus any TX sales tax (i.e. what your item amounts should sum to); 0 if it cannot be determined.

Duplicate detection — you may be shown a list of charges already recorded in the books. Judge each item: "confirmed" duplicate when this email clearly documents a charge that is already recorded (e.g. an invoice email and a receipt email for the same payment, same vendor + amount + service period); "suspected" when it plausibly is but you cannot be sure (e.g. same vendor and amount but the receipt does not show a distinguishing date/period/invoice number); "no" otherwise. Two genuinely separate charges that happen to match (two months of the same subscription with different periods) are NOT duplicates. Explain your duplicate reasoning in that item's notes. If the receipt has no itemized list (gas, a single service charge, a hotel folio total), return one item describing the whole purchase with its pre-tax amount. If the email is not a receipt at all (marketing, shipping notice with no charges), return an empty items array with a note of why in vendor position is not needed — just items: [].

Rideshare rules (Uber and Lyft RIDES — not Uber Eats or any food delivery): a ride is always ONE item, amount = everything paid including the tip. Write the description as route and time, e.g. "Uber 5:12 PM DFW Airport -> Waxahachie" — route and time are how a later receipt for the same ride gets matched, so always include them when the receipt shows them. Uber's "[Personal]" subject tag is a profile label, not a verdict on the expense. Standing owner rule: any ride whose pickup OR dropoff is an airport (an airport name or code — DFW, DAL, PDX, "International Airport", etc.) IS a business expense — category Travel, and the [Personal] tag alone must not keep such a ride from high confidence. A [Personal] ride with no airport end stays a human call: confidence at most medium, and say why in the notes. [Personal] food delivery is usually a personal expense — never high confidence.

Tipped updates: Uber often sends TWO receipts for one ride — the base fare first, then an updated receipt that includes the tip. The tip-included receipt is the authoritative total; the books must hold exactly ONE row per ride, at the tipped total. If the books already show what looks like the same ride (same date, matching route/time, LOWER amount) and THIS receipt includes the tip, mark the item duplicate "suspected" with a note naming both amounts, e.g. "Tipped total $23.45 replaces the untipped $19.80 already on the sheet — fix that row to $23.45, then dismiss this card." If the books already show the ride at a HIGHER (tipped) total and this receipt is the earlier untipped version, mark it duplicate "confirmed" — the charge is already recorded. Two rides on the same day with different routes or times are separate charges, not duplicates.

Categories (pick exactly one per item; "" only when you truly cannot tell):
- Tools: durable tools & equipment — drills, saws, ladders, batteries for tools.
- Materials: rehab/building materials & job supplies — lumber, paint, drywall, fixtures, fasteners, caulk.
- Marketing: advertising, signage, mailers, print, photos, promotion.
- Meals: food & drink — crew meals, client meals, coffee runs.
- Travel: flights, hotels, rental cars, rideshare, tolls, parking, baggage fees.
- Office: office supplies & small office equipment.
- Gas/Truck/Trailer: fuel and vehicle/trailer expenses — gas, oil changes, parts, repairs, registration.
- Subscriptions: recurring software or service subscriptions.
- Website: hosting, domains, web services for the company site.
- Business: general business expenses that fit nowhere else — fees, licenses, postage, insurance.

Sales tax is applied PER LINE ITEM at 8.25%. Set taxable=true when Texas sales tax applies to that specific line (most goods bought in-state), false when it does not (out-of-state/no-tax receipts, tax-exempt lines, most grocery staples, many services). Use the receipt's own tax lines as evidence: if the receipt charged no tax at all, items are probably not taxable; if some lines are marked T/X or the tax amount only covers some lines, reflect that per item.

Cryptic line items: receipts often abbreviate ("HDX 27GAL TOTE", SKU numbers, model codes). You may use web search — and fetch a retailer page — to identify what a product actually is. Keep it to a couple of lookups per receipt, on the lines where identity actually changes the category. Record what a code decoded to in that item's notes. If a lookup fails, keep the raw text and lower the confidence.

Confidence per item — this is the autofile gate:
- "high": vendor, date, amount, taxability, and category are all certain. The item files to the books with no review.
- "medium"/"low": anything is uncertain — unclear product, ambiguous category, unreadable amount, guessed date. A human will review it. When in doubt, do NOT say high.
notes: one short line per item — why this category, what a SKU decoded to, or what is uncertain. Keep it terse.

Return ONLY the JSON object matching the schema. No prose, no markdown fences.`;

// ---- build the user content (email text + attachments) ---------------------
function buildContent(payload) {
  const channelHint = clean(payload.channel) === "travel"
    ? "\nRouting hint: this arrived via the travel@ inbox — prefer the Travel category when plausible (but do not force it; a tool bought on a trip is still Tools).\n"
    : "";
  const ctx =
    "--- Receipt email ---" + channelHint + "\n" +
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
    // Unsupported types (e.g. unconverted HEIC) are skipped -> review placeholder.
  }
  return content;
}

// Keep a stored copy of the receipt (attachments + email text) under
// file/<msgId>/<n> (base64 in the blob, mime in metadata), served by
// receipts/view.html + receipts-file.mjs. Since 2026-09-03 this is only the
// FALLBACK link target: every link points at the Gmail message itself (Paul
// found the viewer's plain-text rendering of an email receipt unhelpful and
// wants the real email). The copy survives if a message ever leaves Gmail.
async function saveReceiptFiles(store, msgId, body) {
  const files = [];
  let i = 0;
  for (const att of body.attachments || []) {
    const data = clean(att.dataBase64);
    if (!data) continue;
    const key = "file/" + msgId + "/" + i;
    await store.set(key, data, { metadata: { contentType: clean(att.mimeType) || "application/octet-stream", filename: clean(att.filename) } });
    files.push({ key, name: clean(att.filename), mime: clean(att.mimeType), bytes: att.bytes || 0 });
    i++;
  }
  if (clean(body.body)) {
    const key = "file/" + msgId + "/body";
    await store.set(key, clean(body.body).slice(0, 20000), { metadata: { contentType: "text/plain" } });
    files.push({ key, name: "email body", mime: "text/plain", bytes: clean(body.body).length });
  }
  return files;
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

// What is ACTUALLY recorded in the expense sheet, straight from the tab. This
// is the duplicate context that matters: the queue only knows what passed
// through it, so anything typed onto the sheet by hand is invisible to a
// store-only check (Paul confirmed 2026-08-23 he hand-entered a fair number of
// Tools purchases during the June-system stall). Best-effort — on any failure
// we fall back to the store-only view rather than blocking the ingest.
async function sheetBooksContext() {
  const sheetUrl = process.env.RECEIPTS_SHEET_URL || "";
  if (!sheetUrl) return "";
  try {
    const res = await fetch(sheetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: process.env.RECEIPTS_SHEET_TOKEN || "", action: "readRecent", maxPerBlock: 40 }),
    });
    const j = await res.json();
    if (!j || !Array.isArray(j.rows)) return "";
    return j.rows
      .map((r) => `${clean(r.category)} | ${clean(r.vendor)} | ${clean(r.date)} | ${clean(r.item)} | $${clean(r.amount)}`)
      .join("\n");
  } catch (e) {
    console.warn("[ingest] sheet books context failed: " + String((e && e.message) || e));
    return "";
  }
}

// Compact list of recently recorded charges, shown to Claude so it can catch
// duplicates (a vendor's invoice email + receipt email for the same payment).
async function recentItemsContext(store) {
  try {
    const { blobs } = await store.list({ prefix: "msg/" });
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const lines = [];
    const envs = await Promise.all((blobs || []).slice(-80).map((b) => store.get(b.key, { type: "json" })));
    for (const env of envs) {
      for (const it of (env && env.items) || []) {
        if (it.status === "dismissed") continue;
        const t = Date.parse(it.approvedAt || it.receivedAt) || 0;
        if (t < cutoff) continue;
        lines.push(clean(it.vendor) + " | " + clean(it.date) + " | " + clean(it.item).slice(0, 60) + " | $" + clean(it.amount) + " | " + it.status);
      }
    }
    return lines.slice(-60).join("\n");
  } catch (e) {
    console.warn("[ingest] recent-items context failed: " + String((e && e.message) || e));
    return "";
  }
}

// ---- the agentic extraction call -------------------------------------------
// One conversation per receipt: Opus 5 + server-side web search/fetch (SKU
// lookups run on Anthropic's servers — no tool loop to execute here). We only
// have to resume "pause_turn" until the model finishes. Structured output
// guarantees the JSON shape; if the API rejects the schema+tools combination we
// retry once without the schema and parse loosely.
async function extractReceipt(client, payload, useSchema, recentContext) {
  const content = buildContent(payload);
  if (recentContext && recentContext.books) {
    content.push({ type: "text", text:
      "--- WHAT IS ALREADY ON THE EXPENSE SHEET (category | vendor | date MMDDYY | description | amount incl. tax) ---\n" +
      "These rows are the actual books. Some were typed in by hand and never passed through the queue. " +
      "If this receipt documents a charge already listed here, say so: mark the item duplicate \"confirmed\" " +
      "(or \"suspected\" if you cannot be sure) and explain which row it matches.\n" + recentContext.books });
  }
  if (recentContext && recentContext.queue) {
    content.push({ type: "text", text:
      "--- Recently processed receipts (queue records, last 60 days; status shown) ---\n" + recentContext.queue });
  }
  const messages = [{ role: "user", content }];
  const req = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 4 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
    ],
  };
  if (useSchema) req.output_config = { format: { type: "json_schema", schema: EXTRACT_SCHEMA } };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.beta.messages.create({ ...req, messages });
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    if (res.stop_reason === "refusal") {
      console.warn("[ingest] Claude refused; leaving for review");
      return null;
    }
    const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return parseJsonLoose(text);
  }
  console.warn("[ingest] hit MAX_TURNS without a final answer");
  return null;
}

async function extractWithFallback(client, payload, recentContext) {
  try {
    return await extractReceipt(client, payload, true, recentContext);
  } catch (e) {
    // If structured output is rejected alongside server tools, degrade to
    // prompt-only JSON. Anything else (auth, overload) propagates to the
    // error handler, which leaves a review placeholder.
    if (e && e.status === 400) {
      console.warn("[ingest] 400 with output_config, retrying without schema: " + String(e.message || e).slice(0, 200));
      return await extractReceipt(client, payload, false, recentContext);
    }
    throw e;
  }
}

// ---- filing ----------------------------------------------------------------
const num = (a) => { const n = parseFloat(String(a == null ? "" : a).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const sheetAmount = (item) => {
  const n = num(item.amount);
  return (item.taxable ? n * (1 + TAX_RATE) : n).toFixed(2);
};
// Uber/Lyft rides (food delivery excluded) — a ride's base-fare receipt and
// its later tip-updated receipt carry DIFFERENT amounts, so the exact-match
// twin gates can't pair them; these helpers feed the ride-pair hold below.
const isRideshare = (v) => { const s = clean(v).toLowerCase(); return /\b(uber|lyft)\b/.test(s) && !/eats|food|deliver/.test(s); };
const dateDigits = (d) => clean(d).replace(/[^0-9]/g, "");

// True when an item is safe to file with no human review.
function autoFileGate(item) {
  return item.confidence === "high" &&
    CATEGORIES.includes(item.category) &&
    num(item.amount) > 0 &&
    !!item.vendor && !!item.date;
}

// Append one item into its category block via the receipts-sheet Apps Script.
// Returns { wrote } on success, { duplicate: true, existing } when the
// writer's serialized duplicate gate rejected it (same vendor+amount+date
// already written by another message — the caller holds the item for review),
// or throws on a real error.
async function sheetAppend(item, msgId) {
  const sheetUrl = process.env.RECEIPTS_SHEET_URL || "";
  if (!sheetUrl) throw new Error("RECEIPTS_SHEET_URL not set");
  const res = await fetch(sheetUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: process.env.RECEIPTS_SHEET_TOKEN || "",
      action: "append",
      category: item.category,
      vendor: item.vendor,
      date: item.date,
      item: item.item,
      link: item.sourceUrl,       // clickable link to the source email
      amount: sheetAmount(item),  // tax-inclusive when taxable
      subtotal: item.amount,
      taxable: item.taxable,
      msgId,                      // lets the writer allow same-receipt repeats
    }),
  });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  if (j.duplicate) return { duplicate: true, existing: clean(j.existing) };
  if (!res.ok || j.ok === false) throw new Error(j.error || ("sheet HTTP " + res.status));
  return { wrote: j.wrote || "" };
}

function makeItem(base) {
  return {
    id: newId(),
    vendor: clean(base.vendor),
    date: clean(base.date),
    item: clean(base.item),
    amount: clean(base.amount),
    category: clean(base.category),
    taxable: base.taxable !== false,
    confidence: clean(base.confidence) || "low",
    duplicate: clean(base.duplicate) || "no",
    notes: sanitizeNote(base.notes),
    channel: clean(base.channel) || "receipts",
    sourceUrl: clean(base.sourceUrl),
    status: base.status || "pending",
    autoFiled: !!base.autoFiled,
    sheetCell: clean(base.sheetCell),
    source: "gmail",
    sourceMsgId: clean(base.sourceMsgId),
    receivedAt: clean(base.receivedAt) || new Date().toISOString(),
    approvedAt: clean(base.approvedAt),
  };
}

function reviewPlaceholder(body, msgId, channel, why) {
  return makeItem({
    vendor: senderName(body.from) || clean(body.subject) || "Unknown sender",
    date: "",
    item: "⚠️ Couldn't auto-read — open the receipt (🧾) and enter it manually",
    amount: "",
    taxable: false,
    confidence: "low",
    notes: clean(why),
    channel,
    sourceUrl: body.gmailUrl,
    sourceMsgId: msgId,
  });
}

// ---- handler ----------------------------------------------------------------
export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });

  const expected = process.env.RECEIPTS_SHEET_TOKEN || "";
  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  if (!expected || clean(body.token) !== expected) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const msgId = clean(body.gmailMessageId);
  if (!msgId) return Response.json({ ok: false, error: "Missing gmailMessageId" }, { status: 400 });
  const channel = clean(body.channel) === "travel" ? "travel" : "receipts";
  const key = "msg/" + msgId;
  const store = getStore({ name: STORE, consistency: "strong" });

  // Idempotency: this key has exactly one writer (us), so a plain existence
  // check is race-free. A prior "error" record may be reprocessed.
  const existing = await store.get(key, { type: "json" });
  if (existing && existing.status !== "error") {
    return Response.json({ ok: true, added: 0, skipped: "already ingested" });
  }

  // FIRST WRITE: a visible processing record. If anything below crashes hard,
  // this record (and the morning summary's stale-processing check) is the trail.
  const envelope = {
    msgId, channel,
    gmailUrl: clean(body.gmailUrl),
    subject: clean(body.subject),
    from: clean(body.from),
    receivedAt: clean(body.receivedDate) || new Date().toISOString(),
    status: "processing",
    startedAt: new Date().toISOString(),
    items: [],
  };
  await store.setJSON(key, envelope);

  const attCount = (body.attachments || []).length;
  const uploadKeys = [];
  try {
    // Load attachment bytes from Blobs (uploaded by the poller via
    // receipts-upload) — references only in this request, see header comment.
    for (const att of body.attachments || []) {
      if (att.blobKey && !att.dataBase64) {
        const b64 = await store.get(clean(att.blobKey));
        if (b64) {
          att.dataBase64 = b64;
          uploadKeys.push(clean(att.blobKey));
        } else {
          console.warn(`[ingest] upload blob missing: ${att.blobKey} (msg=${msgId})`);
        }
      }
    }

    // Convert any HEIC/HEIF photos (iPhone default) to JPEG so Claude can read them.
    for (const att of body.attachments || []) {
      const m = clean(att.mimeType).toLowerCase();
      if (m === "image/heic" || m === "image/heif") await convertHeic(att);
    }

    // Keep a stored copy of the receipt, then decide the link every item and
    // the sheet's Link column will carry: the Gmail message itself, with the
    // viewer only as the fallback for a record that has no Gmail URL.
    envelope.files = await saveReceiptFiles(store, msgId, body);
    const viewerUrl = VIEWER_BASE + encodeURIComponent(msgId);
    const receiptUrl = envelope.gmailUrl || viewerUrl;
    await store.setJSON(key, envelope);

    const client = new Anthropic();
    const [books, queue] = await Promise.all([sheetBooksContext(), recentItemsContext(store)]);
    const recentContext = { books, queue };
    const parsed = await extractWithFallback(client, body, recentContext);

    let items = [];
    if (parsed && Array.isArray(parsed.items)) {
      items = parsed.items
        .filter((it) => it && (clean(it.description) || it.amount != null))
        .map((it) => makeItem({
          vendor: parsed.vendor,
          date: parsed.date,
          item: it.description,
          amount: it.amount,
          taxable: it.taxable !== false,
          category: CATEGORIES.includes(it.category) ? it.category : "",
          confidence: it.confidence,
          duplicate: clean(it.duplicate) || "no",
          notes: it.notes,
          channel,
          sourceUrl: receiptUrl,
          sourceMsgId: msgId,
        }));
    }

    // Reconcile against the receipt's own subtotal: if the extracted line items
    // don't add up to what the receipt says, something was missed or misread —
    // demote everything to review rather than filing an incomplete receipt.
    const statedSubtotal = parsed ? num(parsed.subtotal) : 0;
    if (items.length && statedSubtotal > 0) {
      const itemsSum = items.reduce((t, it) => t + num(it.amount), 0);
      const tolerance = Math.max(0.02, statedSubtotal * 0.005);
      if (Math.abs(itemsSum - statedSubtotal) > tolerance) {
        console.warn(`[ingest] RECONCILE-FAIL msg=${msgId} itemsSum=${itemsSum.toFixed(2)} subtotal=${statedSubtotal.toFixed(2)} — demoting all items to review`);
        for (const item of items) {
          if (item.confidence === "high") item.confidence = "medium";
          item.notes = clean("⚠️ Items sum $" + itemsSum.toFixed(2) + " ≠ receipt subtotal $" + statedSubtotal.toFixed(2) + " — check for missing lines. " + item.notes).slice(0, 300);
        }
      }
    }

    // Not a receipt at all (parsed OK, zero items) → nothing to queue.
    const isEmpty = parsed && Array.isArray(parsed.items) && parsed.items.length === 0;

    // Never silently drop: if Claude couldn't produce items, queue ONE review
    // placeholder linking to the email.
    if (!items.length && !isEmpty) {
      console.warn(`[ingest] NO-ITEMS -> review placeholder msg=${msgId} subject="${envelope.subject}" atts=${attCount}`);
      items = [reviewPlaceholder(body, msgId, channel, "Claude could not extract line items")];
      items[0].sourceUrl = receiptUrl;
    }

    // Fresh view of what OTHER ingests filed/approved in the last hours. This
    // closes the concurrency race found on the 2026-08-21 batch test: an
    // original and its "Fwd:" (same charge) extracted simultaneously — the
    // 60-day context both models saw predated both writes, so each concluded
    // "not in books" and both filed. Same vendor+amount recorded by another
    // message → hold as a suspected duplicate instead of filing a twin.
    // Repeated identical lines WITHIN one receipt stay legit (own msg
    // excluded). Residual window: twins passing this check in the same few
    // seconds — envelopes are persisted immediately after each file below to
    // keep that window tiny.
    const justFiled = new Map();
    const justFiledRides = [];   // same-day rideshare charges for the tip-pair hold
    try {
      const { blobs } = await store.list({ prefix: "msg/" });
      const cutoffT = Date.now() - 6 * 60 * 60 * 1000;
      const others = await Promise.all((blobs || []).filter((b) => b.key !== key).map((b) => store.get(b.key, { type: "json" })));
      for (const env2 of others) {
        for (const it2 of (env2 && env2.items) || []) {
          if (it2.status !== "filed" && it2.status !== "approved") continue;
          if ((Date.parse(it2.approvedAt) || 0) < cutoffT) continue;
          justFiled.set(clean(it2.vendor).toLowerCase() + "|" + num(it2.amount).toFixed(2),
            { amount: num(it2.amount).toFixed(2), cell: clean(it2.sheetCell) });
          if (isRideshare(it2.vendor)) {
            justFiledRides.push({ amount: num(it2.amount), date: dateDigits(it2.date), cell: clean(it2.sheetCell) });
          }
        }
      }
    } catch (e) {
      console.warn("[ingest] just-filed check failed (continuing without): " + String((e && e.message) || e));
    }

    // File the confident items; anything that fails the write stays pending.
    // Duplicates: a CONFIRMED duplicate dismisses itself (visible in the
    // Dismissed tab + morning email, never on the sheet); a SUSPECTED one
    // waits in Pending for review.
    envelope.items = items;
    let filed = 0, pending = 0, dismissed = 0;
    for (const item of items) {
      if (item.duplicate === "confirmed") {
        item.status = "dismissed";
        item.notes = clean("Auto-dismissed as duplicate. " + item.notes).slice(0, 300);
        dismissed++;
        continue;
      }
      if (item.duplicate === "suspected") {
        pending++;
        continue;
      }
      if (autoFileGate(item)) {
        const twin = justFiled.get(clean(item.vendor).toLowerCase() + "|" + num(item.amount).toFixed(2));
        if (twin) {
          item.duplicate = "suspected";
          item.status = "pending";
          item.notes = clean("⚠️ Same vendor + amount ($" + twin.amount + (twin.cell ? ", sheet " + twin.cell : "") + ") was just recorded from another email — possible original/forward pair. Verify before approving. " + item.notes).slice(0, 300);
          console.warn(`[ingest] CONCURRENT-DUP-HOLD msg=${msgId} vendor="${item.vendor}" amount=${item.amount}`);
          pending++;
          continue;
        }
        // Rideshare tip pairs: Uber sends a base-fare receipt and, once the
        // rider tips, an UPDATED receipt for the same ride at a higher total.
        // The amounts differ, so the exact-match gates above (and the sheet
        // writer's vendor|amount|date gate) can never pair them — and both
        // versions often land in the same poll batch, where the 60-day context
        // predates both. A same-day Uber/Lyft charge within a tip-sized ratio
        // just filed from another email is held instead of filed: the sheet
        // must keep ONE row per ride, at the tip-included total. A genuine
        // second same-day ride gets held too — its note says to just Approve.
        if (isRideshare(item.vendor)) {
          const d = dateDigits(item.date), amt = num(item.amount);
          const ride = justFiledRides.find((r) => r.date && d && r.date === d &&
            Math.abs(r.amount - amt) > 0.005 &&
            Math.max(r.amount, amt) <= Math.min(r.amount, amt) * 1.6);
          if (ride) {
            item.duplicate = "suspected";
            item.status = "pending";
            item.notes = clean("⚠️ A same-day rideshare charge of $" + ride.amount.toFixed(2) +
              (ride.cell ? " (sheet " + ride.cell + ")" : "") +
              " was just filed from another email — likely one ride's base + tipped receipt pair. Keep only the tip-included total: if THIS is the tipped one, fix that row to this amount, then Dismiss this card. Two separate rides → Approve. " + item.notes).slice(0, 300);
            console.warn(`[ingest] RIDE-PAIR-HOLD msg=${msgId} vendor="${item.vendor}" amount=${item.amount} vs=${ride.amount}`);
            pending++;
            continue;
          }
        }
        try {
          const wrote = await sheetAppend(item, msgId);
          if (wrote.duplicate) {
            // The writer's serialized gate saw this charge land from another
            // message — the airtight backstop for twins racing within seconds.
            item.duplicate = "suspected";
            item.status = "pending";
            item.notes = clean("⚠️ Same vendor + amount + date" + (wrote.existing ? " (sheet " + wrote.existing + ")" : "") + " was already written by another email — possible original/forward pair. Verify before approving. " + item.notes).slice(0, 300);
            console.warn(`[ingest] SHEET-DUP-HOLD msg=${msgId} vendor="${item.vendor}" amount=${item.amount}`);
            pending++;
            continue;
          }
          item.sheetCell = wrote.wrote;
          item.status = "filed";
          item.autoFiled = true;
          item.approvedAt = new Date().toISOString();
          filed++;
          // Persist right away so concurrent ingests' just-filed checks see it.
          await store.setJSON(key, envelope);
        } catch (e) {
          item.status = "pending";
          item.notes = clean(item.notes + " — sheet write failed: " + String((e && e.message) || e)).slice(0, 300);
          pending++;
        }
      } else {
        pending++;
      }
    }

    envelope.status = "done";
    envelope.processedAt = new Date().toISOString();
    envelope.vendor = clean(parsed && parsed.vendor);
    await store.setJSON(key, envelope);

    // The receipt files are copied into file/<msgId>/* by now — drop the
    // transient upload/* blobs.
    for (const k of uploadKeys) { try { await store.delete(k); } catch (_) {} }

    console.log(`[ingest] OK msg=${msgId} channel=${channel} subject="${envelope.subject}" atts=${attCount} filed=${filed} pending=${pending} dupDismissed=${dismissed} vendor="${envelope.vendor}"`);
    return Response.json({ ok: true, filed, pending, dismissed });
  } catch (e) {
    const err = String((e && e.message) || e);
    console.error(`[ingest] ERROR msg=${msgId} subject="${envelope.subject}": ${err}`);
    envelope.status = "error";
    envelope.error = err.slice(0, 500);
    envelope.processedAt = new Date().toISOString();
    envelope.items = [reviewPlaceholder(body, msgId, channel, "Ingest error: " + err.slice(0, 200))];
    try { await store.setJSON(key, envelope); } catch (_) {}
    // An error envelope is re-ingestable; the poller re-uploads attachments
    // on the retry, so the transient blobs can go now either way.
    for (const k of uploadKeys) { try { await store.delete(k); } catch (_) {} }
    return Response.json({ ok: false, error: err }, { status: 500 });
  }
};
