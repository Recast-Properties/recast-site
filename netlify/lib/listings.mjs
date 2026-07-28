// Shared server-side helpers for the crawlable (server-rendered) listing pages.
// This is NOT a Netlify function (it lives outside the functions dir) — it's a
// module imported by listing-page.mjs, homes-index.mjs, and sitemap.mjs. It reads
// the same "listings-data" Blob the public CSV feed uses and produces the HTML,
// metadata and JSON-LD that make listings visible to crawlers / AI search.
import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";

export const SITE = "https://recast-properties.com";

// Read a repo-relative file bundled with the function via netlify.toml
// `included_files`. The runtime cwd varies, so try the likely roots.
export async function readTemplate(rel) {
  const roots = [process.cwd(), "/var/task", "."];
  for (const root of roots) {
    try { return await readFile(root + "/" + rel, "utf8"); } catch (_) { /* next */ }
  }
  throw new Error("template not found: " + rel);
}
const STORE = "listings-data";
const KEY = "listings.json";

export async function readListings() {
  try {
    const raw = await getStore({ name: STORE, consistency: "strong" }).get(KEY, { type: "json" });
    if (Array.isArray(raw)) return raw.map(normalizeListing);
  } catch (_) { /* fall through */ }
  return [];
}

// Match the shape homes/sheet-loader.js produces, so the injected window.__LISTING__
// drops straight into the existing React components with no changes.
export function normalizeListing(o) {
  o = o || {};
  const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
  const photos = String(o.photos || "");
  const external = /https?:\/\/|\|/.test(photos);
  return {
    id: String(o.id || "").trim(),
    status: String(o.status || "available").toLowerCase(),
    price: num(o.price),
    address: o.address || "", city: o.city || "", state: o.state || "TX", zip: o.zip || "",
    beds: num(o.beds), baths: num(o.baths), sqft: num(o.sqft),
    lot: o.lot || "—", year: o.year ? num(o.year) : "—",
    type: o.type || "Single-family",
    tagline: o.tagline || "",
    description: o.description || "",
    highlights: String(o.highlights || "").split("|").map((s) => s.trim()).filter(Boolean),
    mlsId: o.mlsId || "",
    agentName: o.agentName || "", agentPhone: o.agentPhone || "",
    photos: external ? photos.split("|").map((s) => s.trim()).filter(Boolean) : [],
    photoFolder: external ? "" : photos.trim(),
  };
}

export const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const fmtPrice = (n) => "$" + Number(n || 0).toLocaleString("en-US");

// Absolute Image-CDN URL for a listing photo (used for OG images + the crawlable
// hero <img>). Falls back to an external URL if the listing uses one.
export function photoUrl(l, i, w, fmt) {
  if (l.photos && l.photos.length) return l.photos[i] || "";
  if (!l.photoFolder) return "";
  const src = encodeURIComponent(`/photos/${l.photoFolder}/${i + 1}.jpg`);
  return `${SITE}/.netlify/images?url=${src}&w=${w || 1200}&fm=${fmt || "webp"}&q=72`;
}

export function canonicalFor(l) { return `${SITE}/homes/${encodeURIComponent(l.id)}`; }

export function metaTitle(l) {
  const place = [l.city, l.state].filter(Boolean).join(", ");
  return `${l.address}${place ? " · " + place : ""} — ${fmtPrice(l.price)} | Recast Properties`;
}
export function metaDescription(l) {
  const bits = [
    `${l.beds} bd`, `${l.baths} ba`,
    l.sqft ? `${Number(l.sqft).toLocaleString()} sqft` : "",
    l.type, l.year && l.year !== "—" ? `built ${l.year}` : "",
  ].filter(Boolean).join(" · ");
  const base = `${l.address} in ${[l.city, l.state].filter(Boolean).join(", ")} — ${fmtPrice(l.price)}. ${bits}.`;
  const tail = (l.tagline || l.description || "").replace(/\s+/g, " ").trim();
  return (base + (tail ? " " + tail : "")).slice(0, 300);
}

const AVAIL = {
  available: "https://schema.org/InStock",
  pending: "https://schema.org/LimitedAvailability",
  sold: "https://schema.org/SoldOut",
};

export function listingJsonLd(l) {
  const obj = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    url: canonicalFor(l),
    name: `${l.address}, ${[l.city, l.state, l.zip].filter(Boolean).join(" ")}`.trim(),
    description: metaDescription(l),
    image: [photoUrl(l, 0, 1200, "jpg")].filter(Boolean),
    offers: {
      "@type": "Offer",
      price: Number(l.price || 0),
      priceCurrency: "USD",
      availability: AVAIL[l.status] || AVAIL.available,
      url: canonicalFor(l),
    },
    about: {
      "@type": "SingleFamilyResidence",
      address: {
        "@type": "PostalAddress",
        streetAddress: l.address,
        addressLocality: l.city,
        addressRegion: l.state,
        postalCode: l.zip,
        addressCountry: "US",
      },
      numberOfBedrooms: Number(l.beds || 0),
      numberOfBathroomsTotal: Number(l.baths || 0),
    },
  };
  if (l.sqft) obj.about.floorSize = { "@type": "QuantitativeValue", value: Number(l.sqft), unitCode: "FTK" };
  if (l.year && l.year !== "—") obj.about.yearBuilt = Number(l.year);
  return obj;
}

// The crawlable content block placed inside #root. React overwrites it in real
// browsers (createRoot replaces the container's children); non-JS crawlers keep it.
export function listingContentHtml(l) {
  const place = [l.city, l.state, l.zip].filter(Boolean).join(" ");
  const hero = photoUrl(l, 0, 1200, "webp");
  const facts = [
    ["Bedrooms", l.beds], ["Bathrooms", l.baths],
    ["Square feet", l.sqft ? Number(l.sqft).toLocaleString() : "—"],
    ["Lot size", l.lot], ["Year built", l.year], ["Type", l.type],
  ];
  const paras = String(l.description || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return `<article>
    <p><a href="/homes/">← All properties</a></p>
    <h1>${esc(l.address)}</h1>
    <p>${esc(place)}</p>
    <p><strong>${esc(fmtPrice(l.price))}</strong> · ${esc(l.status)}${l.mlsId ? " · MLS# " + esc(l.mlsId) : ""}</p>
    ${hero ? `<img src="${esc(hero)}" width="1200" alt="${esc(l.address + " — " + place)}">` : ""}
    ${l.tagline ? `<p>${esc(l.tagline)}</p>` : ""}
    <h2>About this home</h2>
    ${(paras.length ? paras : [""]).map((p) => `<p>${esc(p)}</p>`).join("")}
    <h2>Facts</h2>
    <ul>${facts.map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join("")}</ul>
    ${l.highlights.length ? `<h2>Highlights</h2><ul>${l.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
    <h2>Call for a showing or more info</h2>
    <p>${esc(l.agentName || "Recast Properties")} — <a href="tel:${esc((l.agentPhone || "214.906.4992").replace(/[^0-9]/g, ""))}">${esc(l.agentPhone || "214.906.4992")}</a></p>
  </article>`;
}

// Build the <head> tags we inject into the served HTML for a listing.
export function listingHeadTags(l) {
  const canon = canonicalFor(l);
  const title = metaTitle(l);
  const desc = metaDescription(l);
  const og = photoUrl(l, 0, 1200, "jpg");
  return [
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="robots" content="max-snippet:-1, max-image-preview:large">`,
    `<link rel="canonical" href="${esc(canon)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Recast Properties LLC">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(canon)}">`,
    og ? `<meta property="og:image" content="${esc(og)}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    og ? `<meta name="twitter:image" content="${esc(og)}">` : "",
    `<script type="application/ld+json">${JSON.stringify(listingJsonLd(l))}</script>`,
  ].filter(Boolean).join("\n");
}
