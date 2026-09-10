// Receipts ingest — the autonomous bookkeeper (Netlify BACKGROUND function; the
// "-background" suffix gives it a 15-minute limit and callers an immediate 202).
//
// Receives one receipt email from the Gmail poller (apps-script/receipts-poller.gs),
// has Claude (Opus 5) itemize + categorize it, and:
//   • files high-confidence items STRAIGHT into the expense sheet (status "filed"),
//   • leaves uncertain/unreadable items in the queue for review (status "pending").
//
// The model is the DIRECTOR of the read, not a form-filler (2026-09-09, Paul:
// "I want the API to solve it"). It runs with extended thinking and a tool
// loop: `zoom` crops any region of an attachment at full resolution (blurry
// pump displays, small print), `read_books` queries the real expense sheet,
// `search_records` queries the queue's own history — plus server-side web
// search for SKU lookups. It is told to LOOK before it guesses and to CHECK
// before it calls anything a duplicate. The deterministic gates further down
// (subtotal reconcile, txn numbers, ride-pair hold, the writer's ScriptLock
// gate) stay as seatbelts.
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
import { Jimp } from "jimp";

const STORE = "receipts-data";
const VIEWER_BASE = "https://receipts--incomparable-raindrop-8f3d22.netlify.app/receipts/view.html?m=";
const TAX_RATE = 0.0825;
const MODEL = "claude-opus-5";
const MAX_TURNS = 20;              // hard cap on the tool loop (each zoom/read/search is a turn)
const THINKING = { type: "adaptive" };   // extended thinking — the model reasons before it answers
const ZOOM_MAX_EDGE = 1568;        // API downsamples beyond this; crops come back at native res up to it
const ZOOM_MIN_EDGE = 800;         // small crops are upscaled so digits aren't a handful of pixels
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
  required: ["vendor", "date", "transactionId", "subtotal", "items"],
  properties: {
    vendor: { type: "string", description: "Store/merchant name, '' if unknown" },
    date: { type: "string", description: "Purchase date MM/DD/YY, '' if unknown" },
    transactionId: { type: "string", description: "The receipt's own transaction / order / invoice / confirmation / payment / trip number, exactly as printed (digits, letters, dashes); '' if the receipt shows none" },
    subtotal: { type: "number", description: "The receipt's stated pre-tax subtotal (or pre-tax total if no subtotal line); 0 if the receipt shows none" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "amount", "taxable", "category", "confidence", "duplicate", "supersedesAmount", "supersedesCell", "notes"],
        properties: {
          description: { type: "string" },
          amount: { type: "number", description: "What was actually paid for this line, excluding ONLY Texas sales tax" },
          duplicate: { enum: ["no", "suspected", "confirmed", "supersedes"], description: "Is this charge already recorded in the books? 'supersedes' = this receipt is an UPDATED version of a charge that is already recorded (Uber's tipped receipt after the base receipt was filed; a corrected invoice) and the recorded row must be changed to THIS amount" },
          supersedesAmount: { type: "number", description: "When duplicate is 'supersedes': the amount currently recorded for that charge, exactly as read_books / search_records showed it; 0 otherwise" },
          supersedesCell: { type: "string", description: "When duplicate is 'supersedes' and search_records showed a sheet cell for the recorded charge, that cell (e.g. Z65:AD65); '' otherwise" },
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

You are in charge of this read — you have tools, and you are expected to use them the way a careful bookkeeper would, rather than guessing from a single glance:
- zoom: crops any region of a photo/image attachment and returns it at full resolution. The image you were handed is downscaled; small print, 7-segment pump displays, handwriting and faded thermal paper are often unreadable in the full frame but clear when zoomed. Whenever ANY digit, word or line you need is not crisp, zoom in on it BEFORE you decide what it says. Zoom more than once if the first crop is not enough (a tighter region, or a different part of the receipt). Never mark an amount you had to squint at as high confidence without having zoomed on it.
- read_books: queries what is actually recorded on the expense sheet — including rows the owner typed in by hand that never passed through you. Before you decide whether this charge is or is not already recorded, look it up (by vendor, and by category/date range when the vendor name might differ). Category precedent lives here too: the vendor's existing rows show which category the owner uses.
- search_records: queries your own recent history (every receipt processed in the last 90 days, with status, sheet cell and transaction number). Use it alongside read_books when judging duplicates and rideshare tip pairs.
- web_search / web_fetch: identify cryptic SKUs, model codes and unfamiliar vendors.

Make the numbers reconcile before you answer. Line items must sum to the receipt's pre-tax subtotal. A fuel pump shows gallons and total, and gallons × a plausible per-gallon price (pump prices end in 9/10 of a cent, e.g. $3.539) must reproduce the total to the cent — if it doesn't, you misread a digit: zoom and re-read (7-segment confusions: 0/8, 6/8, 9/8, 1/7, 3/9, 5/6). A total that does not equal subtotal + tax means a line was missed or a digit misread — go back and look. When you have zoomed, checked the books and reconciled the arithmetic, say what you verified in the notes and give the confidence the evidence earns; when you genuinely cannot resolve something after looking, say exactly what is unresolved so the human can settle it quickly.

Extract EVERY purchased line item — completeness is critical: your item amounts are reconciled against the "subtotal" field, and a receipt with missing lines corrupts the books.

Amounts policy — record what was ACTUALLY PAID: amounts must include shipping, delivery fees, airline taxes and carrier fees, tips, out-of-state taxes — everything the business was charged — EXCLUDING ONLY Texas sales tax (the system re-adds 8.25% per taxable item, so TX sales tax must never be inside an amount). If a receipt includes shipping/delivery/handling charges, do NOT itemize it: return ONE item summarizing the whole purchase (name the main products in the description) with the full amount paid. Restaurant/food/drink receipts are NEVER itemized: one line ("Meal at <restaurant>") with the full amount paid including tip (still excluding TX sales tax). Itemize only product receipts without shipping (e.g. in-store hardware/materials purchases). Never include TX-sales-tax, subtotal, or total lines as items. Set "subtotal" to the amount charged minus any TX sales tax (i.e. what your item amounts should sum to); 0 if it cannot be determined.

Transaction numbers are decisive. Every receipt with a transaction, order, invoice, confirmation, payment or trip number must return it in "transactionId" exactly as printed. The records search_records returns carry their numbers too (the "txn" column). If this receipt's number matches one of them, this IS the same charge — duplicate "confirmed" — no matter how the emails differ. If the numbers are both present and DIFFERENT, these are separate charges — duplicate "no" — even when vendor, amount and date all match (a $5 top-up that recurs, two same-day orders); do not lower confidence for that, just state the two numbers in the notes. Only fall back to judging by vendor/amount/date when one side has no number.

Category precedent: when the books already show this vendor under a category, use that category and treat it as certain — the owner chose it. Do not drop to medium because another category is arguable.

Duplicate detection — read_books and search_records show you what is already recorded; check them. Judge each item: "confirmed" duplicate when this email clearly documents a charge that is already recorded (e.g. an invoice email and a receipt email for the same payment, same vendor + amount + service period); "suspected" when it plausibly is but you cannot be sure (e.g. same vendor and amount but the receipt does not show a distinguishing date/period/invoice number); "no" otherwise. Two genuinely separate charges that happen to match (two months of the same subscription with different periods) are NOT duplicates. A fourth verdict, "supersedes", is for an UPDATED version of a charge that is already recorded: the recorded row is right about the charge but wrong about the amount, and this receipt has the final number (Uber's tipped receipt after the base receipt was filed; a corrected or amended invoice). Give supersedesAmount = the recorded amount exactly as the books/records showed it, and supersedesCell = the sheet cell if search_records showed one. The system then updates that row to this amount by itself — nothing waits for a human — so use "supersedes" only when you have actually found the recorded row and are sure it is the same charge. Explain your duplicate reasoning in that item's notes. If the receipt has no itemized list (gas, a single service charge, a hotel folio total), return one item describing the whole purchase with its pre-tax amount. If the email is not a receipt at all (marketing, shipping notice with no charges), return an empty items array with a note of why in vendor position is not needed — just items: [].

Rideshare rules (Uber and Lyft RIDES — not Uber Eats or any food delivery): a ride is always ONE item, amount = everything paid including the tip. Write the description as route and time, e.g. "Uber 5:12 PM DFW Airport -> Waxahachie" — route and time are how a later receipt for the same ride gets matched, so always include them when the receipt shows them. Uber sends a base-fare receipt and, once the rider tips, an UPDATED receipt for the same ride at a higher total; the books must hold ONE row per ride at the tip-included total. If the base ride is already recorded (same route and time) and this is the tipped receipt, that is duplicate "supersedes" with supersedesAmount = the recorded amount; if this is the base receipt and the tipped total is already recorded, that is duplicate "confirmed"; an identical amount already recorded for the same ride is "confirmed" too. Uber's "[Personal]" subject tag is a profile label, not a verdict on the expense. Standing owner rule: any ride whose pickup OR dropoff is an airport (an airport name or code — DFW, DAL, PDX, "International Airport", etc.) IS a business expense — category Travel, and the [Personal] tag alone must not keep such a ride from high confidence. A [Personal] ride with no airport end stays a human call: confidence at most medium, and say why in the notes. [Personal] food delivery is usually a personal expense — never high confidence.

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
- "high": vendor, date, amount, taxability, and category are all certain BECAUSE YOU CHECKED — zoomed where it was unclear, reconciled the arithmetic, looked up the books. The item files with no review.
- "medium"/"low": something is still uncertain after you looked — unclear product, ambiguous category, an amount you could not resolve, guessed date. A human will review it. Do not say high on a hunch; do not say medium out of laziness when a zoom or a lookup would have settled it.
notes: one short line per item — what you verified (e.g. "zoomed pump display: 22.318 gal x $3.539 = $78.98"), why this category, what a SKU decoded to, or what is still uncertain. Keep it terse.

When you are done using tools, return ONLY the JSON object matching the schema. No prose, no markdown fences.`;

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
  let n = 0;
  for (const att of payload.attachments || []) {
    let mime = clean(att.mimeType).toLowerCase();
    const data = clean(att.dataBase64);
    if (!data) continue;
    if (mime === "image/jpg") mime = "image/jpeg";
    if (mime === "application/pdf") {
      content.push({ type: "text", text: `[attachment ${n}: ${clean(att.filename) || "document"} (PDF — zoom is not available on PDFs)]` });
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
      n++;
    } else if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) {
      // Label each image with its index so the model can name it to `zoom`.
      content.push({ type: "text", text: `[attachment ${n}: ${clean(att.filename) || "image"} — you may zoom on this one]` });
      content.push({ type: "image", source: { type: "base64", media_type: mime, data } });
      n++;
    }
    // Unsupported types (e.g. unconverted HEIC) are skipped -> review placeholder.
  }
  return content;
}

// ---- the model's tools -----------------------------------------------------
// Indices given to the model count only the attachments it was actually shown
// (same order as buildContent), so resolve them the same way here.
function shownAttachments(payload) {
  return (payload.attachments || []).filter((att) => {
    const mime = clean(att.mimeType).toLowerCase();
    return clean(att.dataBase64) && (mime === "application/pdf" || /^image\/(jpeg|jpg|png|gif|webp)$/.test(mime));
  });
}

const TOOLS = [
  {
    name: "zoom",
    description: "Crop a region of an image attachment and return it at full resolution. The images you were shown are downscaled; use this on any digits, small print, handwriting or faded text you cannot read with certainty. Coordinates are FRACTIONS of the image (0..1) measured from the top-left corner. Not available for PDF attachments.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["attachment", "left", "top", "right", "bottom"],
      properties: {
        attachment: { type: "integer", description: "Index of the attachment as labeled ([attachment N])" },
        left: { type: "number", minimum: 0, maximum: 1 },
        top: { type: "number", minimum: 0, maximum: 1 },
        right: { type: "number", minimum: 0, maximum: 1 },
        bottom: { type: "number", minimum: 0, maximum: 1 },
        why: { type: "string", description: "What you are trying to read (for the log)" },
      },
    },
  },
  {
    name: "read_books",
    description: "Query what is actually recorded on the RECAST BIZ expense sheet — every row, including ones the owner typed by hand. Returns rows as 'category | vendor | date MM/DD/YY | description | amount incl. tax'. Filter by vendor substring and/or category; leave both empty for the most recent rows of every category.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: { type: "string", description: "Case-insensitive substring of the vendor name ('' for any)" },
        category: { type: "string", description: "One of the category names ('' for all)" },
        days: { type: "integer", description: "Only rows dated within the last N days (default 120; 0 = no date filter)" },
      },
    },
  },
  {
    name: "search_records",
    description: "Query the bookkeeper's own recent history: every receipt processed in the last 90 days, one line per item as 'vendor | date | description | amount | status | sheet cell | txn number'. Status filed/approved = on the sheet, pending = waiting for review, dismissed = judged a duplicate or not an expense. Filter by vendor substring and/or amount.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: { type: "string", description: "Case-insensitive substring of the vendor name ('' for any)" },
        amount: { type: "number", description: "Match items within ±$0.01 of this pre-tax amount (omit for any)" },
        days: { type: "integer", description: "Lookback window in days (default 90)" },
      },
    },
  },
];

// zoom: crop from the bytes we hold (already the best copy we have — the
// poller's Drive shrink is ~2000px, which is still well above what the API
// shows the model in the full frame) and hand the crop back as an image block.
async function toolZoom(payload, input) {
  const atts = shownAttachments(payload);
  const att = atts[Number(input.attachment)];
  if (!att) return { error: `No attachment ${input.attachment} (there are ${atts.length})` };
  const mime = clean(att.mimeType).toLowerCase();
  if (mime === "application/pdf") return { error: "zoom is not available on PDF attachments" };
  const l = Math.max(0, Math.min(1, Number(input.left) || 0));
  const t = Math.max(0, Math.min(1, Number(input.top) || 0));
  const r = Math.max(0, Math.min(1, Number(input.right) || 0));
  const b = Math.max(0, Math.min(1, Number(input.bottom) || 0));
  if (r - l < 0.02 || b - t < 0.02) return { error: "Region too small — give a box at least 2% of the image on each side" };
  const img = await Jimp.read(Buffer.from(att.dataBase64, "base64"));
  const W = img.width, H = img.height;
  const x = Math.floor(l * W), y = Math.floor(t * H);
  const w = Math.max(8, Math.min(W - x, Math.ceil((r - l) * W)));
  const h = Math.max(8, Math.min(H - y, Math.ceil((b - t) * H)));
  const crop = img.clone().crop({ x, y, w, h });
  const longEdge = Math.max(w, h);
  if (longEdge < ZOOM_MIN_EDGE) {
    const s = ZOOM_MIN_EDGE / longEdge;
    crop.resize({ w: Math.round(w * s), h: Math.round(h * s) });
  } else if (longEdge > ZOOM_MAX_EDGE) {
    const s = ZOOM_MAX_EDGE / longEdge;
    crop.resize({ w: Math.round(w * s), h: Math.round(h * s) });
  }
  const out = await crop.getBuffer("image/jpeg", { quality: 92 });
  return {
    text: `Crop of attachment ${input.attachment}: source ${W}x${H}px, region x=${x} y=${y} w=${w} h=${h}, returned at ${crop.width}x${crop.height}px.`,
    image: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: out.toString("base64") } },
  };
}

// Parse "MM/DD/YY" (or MM/DD/YYYY) into a timestamp; 0 when unparseable.
function dateTs(s) {
  const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return 0;
  const yy = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
  return new Date(yy, parseInt(m[1], 10) - 1, parseInt(m[2], 10)).getTime();
}

// read_books: the writer's readRecent (up to 200 rows per block), filtered here.
async function toolReadBooks(input) {
  const sheetUrl = process.env.RECEIPTS_SHEET_URL || "";
  if (!sheetUrl) return { error: "Expense sheet not configured" };
  const res = await fetch(sheetUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.RECEIPTS_SHEET_TOKEN || "", action: "readRecent", maxPerBlock: 200 }),
  });
  const j = await res.json();
  if (!j || !Array.isArray(j.rows)) return { error: "Sheet read failed: " + clean(j && j.error) };
  const vendor = clean(input.vendor).toLowerCase();
  const category = clean(input.category).toLowerCase();
  const days = input.days === 0 ? 0 : (parseInt(input.days, 10) || 120);
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  let rows = j.rows.filter((r) =>
    (!vendor || clean(r.vendor).toLowerCase().includes(vendor)) &&
    (!category || clean(r.category).toLowerCase() === category) &&
    (!cutoff || !dateTs(r.date) || dateTs(r.date) >= cutoff));
  const total = rows.length;
  if (!vendor && !category) rows = rows.slice(-120);
  const text = rows.map((r) => `${clean(r.category)} | ${clean(r.vendor)} | ${clean(r.date)} | ${clean(r.item)} | $${clean(r.amount)}`).join("\n");
  return { text: `${total} matching row(s) on tab "${clean(j.tab)}"${rows.length < total ? ` (showing last ${rows.length})` : ""}:\n${text || "(none)"}` };
}

// search_records: the queue's own envelopes, filtered.
async function toolSearchRecords(store, input, selfKey) {
  const vendor = clean(input.vendor).toLowerCase();
  const amount = input.amount == null || input.amount === "" ? null : Number(input.amount);
  const days = parseInt(input.days, 10) || 90;
  const cutoff = Date.now() - days * 86400000;
  const { blobs } = await store.list({ prefix: "msg/" });
  const envs = await Promise.all((blobs || []).filter((b) => b.key !== selfKey).map((b) => store.get(b.key, { type: "json" })));
  const lines = [];
  for (const env of envs) {
    if (!env || env.dryRun) continue;   // dry-run cards are test artifacts, never evidence
    for (const it of env.items || []) {
      const t = Date.parse(it.approvedAt || it.receivedAt) || 0;
      if (t < cutoff) continue;
      if (vendor && !clean(it.vendor).toLowerCase().includes(vendor)) continue;
      if (amount != null && Math.abs(num(it.amount) - amount) > 0.011) continue;
      lines.push(`${clean(it.vendor)} | ${clean(it.date)} | ${clean(it.item).slice(0, 70)} | $${clean(it.amount)} | ${it.status} | ${clean(it.sheetCell) || "-"} | txn ${clean(it.txnId) || "-"}`);
    }
  }
  return { text: `${lines.length} record(s):\n${lines.slice(-150).join("\n") || "(none)"}` };
}

async function runTool(name, input, ctx) {
  try {
    if (name === "zoom") return await toolZoom(ctx.payload, input || {});
    if (name === "read_books") return await toolReadBooks(input || {});
    if (name === "search_records") return await toolSearchRecords(ctx.store, input || {}, ctx.selfKey);
    return { error: "Unknown tool " + name };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 300) };
  }
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


// ---- the extraction: a tool loop the model directs ---------------------------
// One conversation per receipt. Extended thinking on; client-side tools
// (zoom / read_books / search_records) are executed here and their results
// fed back; server-side web search/fetch run on Anthropic's side and only
// need "pause_turn" resumed. Structured output guarantees the JSON shape; if
// the API rejects the schema alongside tools/thinking we retry once without
// it and parse loosely.
async function extractReceipt(client, payload, useSchema, ctx) {
  const messages = [{ role: "user", content: buildContent(payload) }];
  const req = {
    model: MODEL,
    max_tokens: 16000,
    thinking: THINKING,
    system: SYSTEM_PROMPT,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools: [
      ...TOOLS,
      { type: "web_search_20260209", name: "web_search", max_uses: 4 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
    ],
  };
  if (useSchema) req.output_config = { format: { type: "json_schema", schema: EXTRACT_SCHEMA } };

  let toolCalls = 0;
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
    if (res.stop_reason === "tool_use") {
      // Assistant turn goes back verbatim (thinking blocks + signatures included).
      messages.push({ role: "assistant", content: res.content });
      const results = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        toolCalls++;
        const out = await runTool(block.name, block.input, ctx);
        const why = block.input && block.input.why ? ` (${clean(block.input.why).slice(0, 80)})` : "";
        console.log(`[ingest] tool ${block.name}${why} msg=${ctx.msgId} -> ${out.error ? "ERROR " + out.error : (out.text || "").split("\n")[0].slice(0, 120)}`);
        const content = [];
        if (out.error) content.push({ type: "text", text: "Error: " + out.error });
        if (out.text) content.push({ type: "text", text: out.text });
        if (out.image) content.push(out.image);
        results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: !!out.error });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const u = res.usage || {};
    console.log(`[ingest] extract done msg=${ctx.msgId} turns=${turn + 1} tools=${toolCalls} in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
    return parseJsonLoose(text);
  }
  console.warn(`[ingest] hit MAX_TURNS (${MAX_TURNS}) without a final answer msg=${ctx.msgId}`);
  return null;
}

async function extractWithFallback(client, payload, ctx) {
  try {
    return await extractReceipt(client, payload, true, ctx);
  } catch (e) {
    // If structured output is rejected alongside tools/thinking, degrade to
    // prompt-only JSON. Anything else (auth, overload) propagates to the
    // error handler, which leaves a review placeholder.
    if (e && e.status === 400) {
      console.warn("[ingest] 400 with output_config, retrying without schema: " + String(e.message || e).slice(0, 200));
      return await extractReceipt(client, payload, false, ctx);
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
async function sheetAppend(item, msgId, force) {
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
      force: !!force,             // transaction number proved it a separate charge
    }),
  });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  if (j.duplicate) return { duplicate: true, existing: clean(j.existing) };
  if (!res.ok || j.ok === false) throw new Error(j.error || ("sheet HTTP " + res.status));
  return { wrote: j.wrote || "" };
}

// Update the row that a superseding receipt replaces (2026-09-10, Paul: "if it
// caught and adjusted the Uber ride then why does it need my review?"). The
// writer finds the row by vendor + date inside the category block (amount
// disambiguates when several match) and rewrites description, link and price.
// Returns { updated, from } or { notFound: true }; throws on a real error.
async function sheetUpdate(target, item, msgId) {
  const sheetUrl = process.env.RECEIPTS_SHEET_URL || "";
  if (!sheetUrl) throw new Error("RECEIPTS_SHEET_URL not set");
  const res = await fetch(sheetUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: process.env.RECEIPTS_SHEET_TOKEN || "",
      action: "update",
      category: target.category,
      vendor: target.vendor,
      date: target.date,
      oldAmount: target.oldAmount,   // as recorded (tax-inclusive on the sheet)
      cell: target.cell,             // hint only
      item: item.item,
      link: item.sourceUrl,
      amount: sheetAmount(item),
      msgId,
    }),
  });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  if (j.notFound) return { notFound: true, error: clean(j.error) };
  if (!res.ok || j.ok === false) throw new Error(j.error || ("sheet HTTP " + res.status));
  return { updated: clean(j.updated), from: clean(j.from) };
}

// After the writer's serialized gate bounced a write as "already written by
// another email", look at the record that won the race — it persisted the
// moment it filed, so its transaction number is available now even though it
// was not when this ingest's scans ran (twins in the same poll batch, 2026-09-09
// Anthropic original + Fwd). Returns { txnId, cell, status } or null.
async function findCompetitor(store, selfKey, existingCell, vendorAmountKey) {
  const { blobs } = await store.list({ prefix: "msg/" });
  const envs = await Promise.all((blobs || []).filter((b) => b.key !== selfKey).map((b) => store.get(b.key, { type: "json" })));
  let byKey = null;
  for (const env of envs) {
    if (!env || env.dryRun) continue;
    for (const it of env.items || []) {
      if (it.status !== "filed" && it.status !== "approved") continue;
      if (existingCell && clean(it.sheetCell) && clean(it.sheetCell) === existingCell) {
        return { txnId: clean(it.txnId), cell: clean(it.sheetCell), status: it.status };
      }
      if (!byKey && clean(it.vendor).toLowerCase() + "|" + num(it.amount).toFixed(2) === vendorAmountKey) {
        byKey = { txnId: clean(it.txnId), cell: clean(it.sheetCell), status: it.status };
      }
    }
  }
  return byKey;
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
    supersedesAmount: num(base.supersedesAmount) || 0,
    supersedesCell: clean(base.supersedesCell),
    txnId: clean(base.txnId),
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
  // Dry run (testing the bookkeeper's READ without touching the books): the
  // full extraction runs, nothing is written to the sheet, and the result is
  // stored under its own key "msg/dry-<id>" so it shows up in the queue's
  // Pending tab as a separate, clearly labeled envelope — the real record for
  // that email (if any) is left alone. Delete dry-run cards from the queue
  // when done. Triggered by the poller's dryRunIngest().
  const dryRun = body.dryRun === true || body.dryRun === "true";
  const recordId = dryRun ? "dry-" + msgId : msgId;   // what the queue knows this envelope as
  const key = "msg/" + recordId;
  const store = getStore({ name: STORE, consistency: "strong" });

  // Idempotency: this key has exactly one writer (us), so a plain existence
  // check is race-free. A prior "error" record may be reprocessed; a dry run
  // always re-runs.
  const existing = await store.get(key, { type: "json" });
  if (existing && existing.status !== "error" && !dryRun) {
    return Response.json({ ok: true, added: 0, skipped: "already ingested" });
  }

  // FIRST WRITE: a visible processing record. If anything below crashes hard,
  // this record (and the morning summary's stale-processing check) is the trail.
  const envelope = {
    msgId: recordId, channel, dryRun,
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
    // The model pulls the books / queue history itself via tools now, so
    // nothing is pre-chewed into the prompt.
    const parsed = await extractWithFallback(client, body, { payload: body, store, selfKey: key, msgId });

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
          supersedesAmount: it.supersedesAmount,
          supersedesCell: it.supersedesCell,
          txnId: parsed.transactionId,
          notes: it.notes,
          channel,
          sourceUrl: receiptUrl,
          sourceMsgId: recordId,
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
      items = [reviewPlaceholder(body, recordId, channel, "Claude could not extract line items")];
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
    // Transaction numbers settle what vendor+amount cannot (2026-09-03, Paul:
    // "you should be smart enough to check the transaction numbers"). Every
    // non-dismissed record from another email, keyed vendor|amount, with its
    // number — compared below before any twin hold fires.
    const knownTxns = new Map();   // vendor|amount -> [{ txnId, cell, status }]
    const otherEnvs = [];          // [{ key, env }] of every other real envelope, for supersede lookups
    try {
      const { blobs } = await store.list({ prefix: "msg/" });
      const cutoffT = Date.now() - 6 * 60 * 60 * 1000;
      const otherKeys = (blobs || []).filter((b) => b.key !== key).map((b) => b.key);
      const others = await Promise.all(otherKeys.map((k2) => store.get(k2, { type: "json" })));
      others.forEach((env2, i) => { if (env2 && !env2.dryRun) otherEnvs.push({ key: otherKeys[i], env: env2 }); });
      for (const env2 of others) {
        if (!env2 || env2.dryRun) continue;   // dry-run cards are test artifacts, never evidence
        for (const it2 of env2.items || []) {
          if (it2.status === "dismissed") continue;
          const k2 = clean(it2.vendor).toLowerCase() + "|" + num(it2.amount).toFixed(2);
          if (!knownTxns.has(k2)) knownTxns.set(k2, []);
          knownTxns.get(k2).push({ txnId: clean(it2.txnId), cell: clean(it2.sheetCell), status: it2.status });
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
      // The model found the recorded row and says THIS receipt has the final
      // number for it (tipped Uber receipt, amended invoice): update that row,
      // then retire this card. Only on a high-confidence read; otherwise the
      // card waits with the model's instructions in the note.
      if (item.duplicate === "supersedes") {
        const newAmt = num(item.amount), oldAmt = num(item.supersedesAmount);
        const vend = clean(item.vendor).toLowerCase();
        const sameVendor = (v) => { const o = clean(v).toLowerCase(); return o && vend && (o.includes(vend) || vend.includes(o)); };
        // The recorded charge, if the bookkeeper filed it: its envelope + item.
        let hit = null;
        for (const { key: k2, env: env2 } of otherEnvs) {
          for (const it2 of env2.items || []) {
            if (it2.status !== "filed" && it2.status !== "approved") continue;
            const cellMatch = item.supersedesCell && clean(it2.sheetCell) === item.supersedesCell;
            const rowMatch = sameVendor(it2.vendor) && dateDigits(it2.date) === dateDigits(item.date) &&
              oldAmt > 0 && (Math.abs(num(it2.amount) - oldAmt) < 0.011 || Math.abs(num(sheetAmount(it2)) - oldAmt) < 0.011);
            if (cellMatch || rowMatch) { hit = { key: k2, env: env2, it: it2 }; break; }
          }
          if (hit) break;
        }
        const target = hit
          ? { category: hit.it.category, vendor: hit.it.vendor, date: hit.it.date, oldAmount: sheetAmount(hit.it), cell: clean(hit.it.sheetCell) }
          : { category: item.category, vendor: item.vendor, date: item.date, oldAmount: oldAmt, cell: item.supersedesCell };
        const where = (target.cell ? "sheet " + target.cell : target.category + " block") + " (" + target.vendor + " " + target.date + " $" + num(target.oldAmount).toFixed(2) + ")";
        if (!autoFileGate(item) || !(oldAmt > 0) || !(newAmt > 0) || !CATEGORIES.includes(target.category)) {
          item.status = "pending";
          item.notes = clean("Supersedes " + where + " → $" + newAmt.toFixed(2) + ", but not filed automatically (" + (autoFileGate(item) ? "recorded row not identified" : "confidence " + item.confidence) + ") — fix that row by hand, then Dismiss this card. " + item.notes).slice(0, 300);
          console.warn(`[ingest] SUPERSEDE-HOLD msg=${msgId} vendor="${item.vendor}" ${oldAmt}->${newAmt} conf=${item.confidence}`);
          pending++;
          continue;
        }
        if (dryRun) {
          item.status = "dismissed";
          item.notes = clean("Supersedes " + where + " → $" + sheetAmount(item) + ". " + item.notes).slice(0, 300);
          dismissed++;
          continue;
        }
        try {
          const upd = await sheetUpdate(target, item, msgId);
          if (upd.notFound) {
            item.status = "pending";
            item.notes = clean("Supersedes " + where + " → $" + newAmt.toFixed(2) + ", but that row was not found on the sheet (" + upd.error + ") — fix by hand, then Dismiss this card. " + item.notes).slice(0, 300);
            console.warn(`[ingest] SUPERSEDE-NOTFOUND msg=${msgId} vendor="${item.vendor}" ${where}`);
            pending++;
            continue;
          }
          item.status = "dismissed";
          item.sheetCell = upd.updated;
          item.notes = clean("Updated " + upd.updated + " from $" + num(upd.from || target.oldAmount).toFixed(2) + " to $" + sheetAmount(item) + " — this receipt supersedes the recorded charge. " + item.notes).slice(0, 300);
          console.log(`[ingest] SUPERSEDE-UPDATED msg=${msgId} vendor="${item.vendor}" cell=${upd.updated} ${upd.from}->${sheetAmount(item)}`);
          dismissed++;
          if (hit) {
            // Keep the queue's record of the recorded charge in step with the sheet.
            hit.it.amount = item.amount;
            hit.it.item = item.item;
            hit.it.sourceUrl = item.sourceUrl;
            hit.it.notes = clean("Updated to $" + sheetAmount(item) + " by a later receipt for the same charge (" + msgId + "). " + hit.it.notes).slice(0, 300);
            try { await store.setJSON(hit.key, hit.env); } catch (_) {}
          }
        } catch (e) {
          item.status = "pending";
          item.notes = clean("Supersedes " + where + " → $" + newAmt.toFixed(2) + " — sheet update failed: " + String((e && e.message) || e) + ". Fix by hand, then Dismiss this card. " + item.notes).slice(0, 300);
          pending++;
        }
        continue;
      }
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
        const k = clean(item.vendor).toLowerCase() + "|" + num(item.amount).toFixed(2);
        // Transaction-number verdict against every known record with this
        // vendor+amount: "same" = this exact charge is already recorded →
        // auto-dismiss; "distinct" = every prior record carries a number and
        // none is this one → a separate charge, so the twin holds AND the
        // writer's vendor|amount|date gate are bypassed (force). Anything
        // less certain falls through to the holds below as before. Rideshare
        // is excluded: a ride's base and tipped receipts describe one trip,
        // and whatever number the model pulls from them is not proof either way.
        const priors = knownTxns.get(k) || [];
        let verdict = "unknown";
        if (item.txnId && priors.length && !isRideshare(item.vendor)) {
          if (priors.some((p) => p.txnId && p.txnId === item.txnId)) verdict = "same";
          else if (priors.every((p) => p.txnId)) verdict = "distinct";
        }
        if (verdict === "same") {
          const hit = priors.find((p) => p.txnId === item.txnId);
          item.duplicate = "confirmed";
          item.status = "dismissed";
          item.notes = clean("Auto-dismissed: transaction #" + item.txnId + " is already recorded" + (hit.cell ? " (sheet " + hit.cell + ")" : hit.status === "pending" ? " (waiting in Pending)" : "") + ". " + item.notes).slice(0, 300);
          console.warn(`[ingest] TXN-SAME-DISMISS msg=${msgId} vendor="${item.vendor}" amount=${item.amount} txn=${item.txnId}`);
          dismissed++;
          continue;
        }
        const forceDistinct = verdict === "distinct";
        if (forceDistinct) {
          const others = priors.map((p) => "#" + p.txnId + (p.cell ? " (" + p.cell + ")" : "")).slice(0, 3).join(", ");
          item.notes = clean("Transaction #" + item.txnId + " differs from " + others + " already recorded — separate charge. " + item.notes).slice(0, 300);
          console.log(`[ingest] TXN-DISTINCT-FILE msg=${msgId} vendor="${item.vendor}" amount=${item.amount} txn=${item.txnId} vs=${priors.map((p) => p.txnId).join(",")}`);
        }
        const twin = forceDistinct ? null : justFiled.get(k);
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
        if (isRideshare(item.vendor) && !forceDistinct) {
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
          let wrote = dryRun ? { wrote: "(dry run)" } : await sheetAppend(item, msgId, forceDistinct);
          if (wrote.duplicate) {
            // The writer's serialized gate saw this charge land from another
            // message — the airtight backstop for twins racing within seconds.
            // Before holding, ask the record that won the race for its number:
            // same number → this is the same charge, dismiss; different numbers
            // → separate charges, write it after all. Rideshare stays a hold
            // (its numbers do not settle base/tip pairs).
            let rival = null;
            if (item.txnId && !isRideshare(item.vendor)) {
              try { rival = await findCompetitor(store, key, wrote.existing, k); }
              catch (e) { console.warn("[ingest] competitor lookup failed: " + String((e && e.message) || e)); }
            }
            if (rival && rival.txnId && rival.txnId === item.txnId) {
              item.duplicate = "confirmed";
              item.status = "dismissed";
              item.notes = clean("Auto-dismissed: transaction #" + item.txnId + " was recorded moments ago from another email" + (rival.cell ? " (sheet " + rival.cell + ")" : "") + " — same receipt arrived twice. " + item.notes).slice(0, 300);
              console.warn(`[ingest] TXN-SAME-DISMISS-AFTER-BOUNCE msg=${msgId} vendor="${item.vendor}" amount=${item.amount} txn=${item.txnId}`);
              dismissed++;
              continue;
            }
            if (rival && rival.txnId && rival.txnId !== item.txnId) {
              item.notes = clean("Transaction #" + item.txnId + " differs from #" + rival.txnId + (rival.cell ? " (" + rival.cell + ")" : "") + " recorded moments ago — separate charge. " + item.notes).slice(0, 300);
              console.log(`[ingest] TXN-DISTINCT-FILE-AFTER-BOUNCE msg=${msgId} vendor="${item.vendor}" amount=${item.amount} txn=${item.txnId} vs=${rival.txnId}`);
              wrote = await sheetAppend(item, msgId, true);
            }
          }
          if (wrote.duplicate) {
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

    // Dry run: nothing was written; every item goes to Pending carrying the
    // verdict it WOULD have received, so the read can be judged in the queue.
    if (dryRun) {
      for (const item of items) {
        const verdict = item.status === "filed" ? "would AUTO-FILE to " + item.category + " at $" + sheetAmount(item)
          : item.status === "dismissed" && item.duplicate === "supersedes" ? "would UPDATE the recorded row to $" + sheetAmount(item) + " and retire this card"
          : item.status === "dismissed" ? "would AUTO-DISMISS"
          : "would HOLD for review";
        item.status = "pending";
        item.autoFiled = false;
        item.sheetCell = "";
        item.approvedAt = "";
        item.notes = clean("[DRY RUN " + verdict + "] " + item.notes).slice(0, 300);
      }
      filed = 0; dismissed = 0; pending = items.length;
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
    envelope.items = [reviewPlaceholder(body, recordId, channel, "Ingest error: " + err.slice(0, 200))];
    try { await store.setJSON(key, envelope); } catch (_) {}
    // An error envelope is re-ingestable; the poller re-uploads attachments
    // on the retry, so the transient blobs can go now either way.
    for (const k of uploadKeys) { try { await store.delete(k); } catch (_) {} }
    return Response.json({ ok: false, error: err }, { status: 500 });
  }
};
