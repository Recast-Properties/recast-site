// Public, read-only listings feed for the website (homes/sheet-loader.js).
// Reads the listings array from Netlify Blobs and returns it as CSV in the same
// shape the site already parses — so switching the site over is a one-line URL
// change. No auth (this data is public on the site anyway).
import { getStore } from "@netlify/blobs";

const STORE = "listings-data";
const KEY = "listings.json";
const HEADERS = ["id","status","price","address","city","state","zip","beds","baths","sqft","lot","year","type","tagline","description","highlights","mlsId","agentName","agentPhone","photos"];

const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';

export default async () => {
  let rows = [];
  try {
    const raw = await getStore({ name: STORE, consistency: "strong" }).get(KEY, { type: "json" });
    if (Array.isArray(raw)) rows = raw;
  } catch (_) { /* fall through to header-only CSV */ }

  const lines = [HEADERS.map(q).join(",")];
  for (const r of rows) lines.push(HEADERS.map((h) => q(r[h])).join(","));

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "cache-control": "public, max-age=30",
    },
  });
};
