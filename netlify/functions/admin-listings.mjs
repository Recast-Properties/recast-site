// Admin listings API (auth required). Listings live entirely in Netlify Blobs
// (store "listings-data", key "listings.json" = an array of listing objects).
// No Google Sheet / Apps Script — the admin tool is the single source of truth.
//
// POST JSON (header x-admin-token == ADMIN_PASSWORD):
//   { action:"list" }                 -> { ok, rows }
//   { action:"save", listing:{...} }  -> { ok, id }   (upsert by id)
//   { action:"delete", id }           -> { ok }
//   { action:"seed", force? }         -> { ok, count } (one-time import from the
//                                        old published Google Sheet CSV)
import { getStore } from "@netlify/blobs";

const STORE = "listings-data";
const KEY = "listings.json";
const FIELDS = ["id","status","price","address","city","state","zip","beds","baths","sqft","lot","year","type","tagline","description","highlights","mlsId","photos"];
// One-time seed source: the previously-published listings sheet.
const SEED_CSV_URL = "https://docs.google.com/spreadsheets/d/1lpCONle2BfovuOu7_9k17hYwCuDKxnvE0ddeQLdGI5k/gviz/tq?tqx=out:csv&gid=701320222";

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}

async function readAll(store) {
  const raw = await store.get(KEY, { type: "json" });
  return Array.isArray(raw) ? raw : [];
}
async function writeAll(store, arr) {
  await store.set(KEY, JSON.stringify(arr), { metadata: { contentType: "application/json" } });
}
const clean = (v) => (v == null ? "" : String(v).trim());

function normalize(listing) {
  const o = {};
  FIELDS.forEach((f) => { o[f] = clean(listing[f]); });
  return o;
}

// Minimal RFC-4180 CSV parser (for the one-time seed only).
function parseCSV(text) {
  const rows = []; let row = [], field = "", i = 0, inQ = false;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!authed(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  // Strong consistency: saving then immediately re-listing must reflect the write.
  const store = getStore({ name: STORE, consistency: "strong" });

  try {
    if (body.action === "list") {
      return Response.json({ ok: true, rows: await readAll(store) });
    }

    if (body.action === "save") {
      const listing = normalize(body.listing || {});
      if (!listing.id) return Response.json({ ok: false, error: "Listing is missing an id" }, { status: 400 });
      const arr = await readAll(store);
      const idx = arr.findIndex((r) => clean(r.id) === listing.id);
      if (idx >= 0) arr[idx] = { ...arr[idx], ...listing };
      else arr.push(listing);
      await writeAll(store, arr);
      return Response.json({ ok: true, id: listing.id, updated: idx >= 0 });
    }

    if (body.action === "delete") {
      const id = clean(body.id);
      const arr = await readAll(store);
      const next = arr.filter((r) => clean(r.id) !== id);
      await writeAll(store, next);
      return Response.json({ ok: true, id, removed: arr.length - next.length });
    }

    if (body.action === "seed") {
      const existing = await readAll(store);
      if (existing.length && !body.force) {
        return Response.json({ ok: true, count: existing.length, note: "already seeded" });
      }
      const res = await fetch(SEED_CSV_URL, { cache: "no-store" });
      if (!res.ok) return Response.json({ ok: false, error: "Seed CSV fetch failed " + res.status }, { status: 502 });
      const rows = parseCSV(await res.text());
      if (!rows.length) return Response.json({ ok: false, error: "Empty seed CSV" }, { status: 502 });
      const headers = rows[0].map((h) => String(h).trim());
      const out = [];
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        if (!cells || cells.every((c) => !String(c).trim())) continue;
        const o = {}; headers.forEach((h, i) => { o[h] = cells[i] != null ? cells[i].trim() : ""; });
        if (!o.id && !o.address) continue;
        out.push(normalize(o));
      }
      await writeAll(store, out);
      return Response.json({ ok: true, count: out.length });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
