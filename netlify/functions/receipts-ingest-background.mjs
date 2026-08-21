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
//     attachments: [{ filename, mimeType, dataBase64 }] }
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

// Save the receipt itself (attachments + email text) so the queue page, the
// sheet Link column, and the morning email can show the actual receipt with
// one click (via receipts/view.html + receipts-file.mjs) instead of a Gmail
// search. Keys: file/<msgId>/<n> (base64 in the blob, mime in metadata).
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
  if (recentContext) {
    content.push({ type: "text", text: "--- Charges already recorded in the books (last 60 days) ---\n" + recentContext });
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

// True when an item is safe to file with no human review.
function autoFileGate(item) {
  return item.confidence === "high" &&
    CATEGORIES.includes(item.category) &&
    num(item.amount) > 0 &&
    !!item.vendor && !!item.date;
}

// Append one item into its category block via the receipts-sheet Apps Script.
// Returns the written cell (e.g. "B14:F14") or throws.
async function sheetAppend(item) {
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
    }),
  });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  if (!res.ok || j.ok === false) throw new Error(j.error || ("sheet HTTP " + res.status));
  return j.wrote || "";
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
    notes: clean(base.notes),
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
  try {
    // Convert any HEIC/HEIF photos (iPhone default) to JPEG so Claude can read them.
    for (const att of body.attachments || []) {
      const m = clean(att.mimeType).toLowerCase();
      if (m === "image/heic" || m === "image/heif") await convertHeic(att);
    }

    // Keep a copy of the receipt itself; every link points at the viewer.
    envelope.files = await saveReceiptFiles(store, msgId, body);
    const viewerUrl = VIEWER_BASE + encodeURIComponent(msgId);
    await store.setJSON(key, envelope);

    const client = new Anthropic();
    const recentContext = await recentItemsContext(store);
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
          sourceUrl: viewerUrl,
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
      items[0].sourceUrl = viewerUrl;
    }

    // File the confident items; anything that fails the write stays pending.
    // Duplicates: a CONFIRMED duplicate dismisses itself (visible in the
    // Dismissed tab + morning email, never on the sheet); a SUSPECTED one
    // waits in Pending for review.
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
        try {
          item.sheetCell = await sheetAppend(item);
          item.status = "filed";
          item.autoFiled = true;
          item.approvedAt = new Date().toISOString();
          filed++;
        } catch (e) {
          item.status = "pending";
          item.notes = clean(item.notes + " — sheet write failed: " + String((e && e.message) || e)).slice(0, 300);
          pending++;
        }
      } else {
        pending++;
      }
    }

    envelope.items = items;
    envelope.status = "done";
    envelope.processedAt = new Date().toISOString();
    envelope.vendor = clean(parsed && parsed.vendor);
    await store.setJSON(key, envelope);

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
    return Response.json({ ok: false, error: err }, { status: 500 });
  }
};
