// Server-rendered "Available Properties" grid (crawlable). Serves /homes/ with a
// meta description, canonical/OG tags, an ItemList JSON-LD, and a plain-HTML list
// of every listing (linked to its /homes/<id> page) baked into the HTML, so
// crawlers / AI search can discover the inventory without running JavaScript. The
// React grid still boots on top (it uses the injected window.__LISTINGS__).
//
// Wired in netlify.toml: /homes/  ->  /.netlify/functions/homes-index (force=true)
import { readListings, SITE, esc, fmtPrice, canonicalFor, readTemplate } from "../lib/listings.mjs";

let TEMPLATE = null;
async function template() {
  if (TEMPLATE == null) TEMPLATE = await readTemplate("homes/index.html");
  return TEMPLATE;
}

const TITLE = "Homes for Sale in Ellis County & Southern DFW | Recast Properties";

function headTags(listings) {
  const canon = `${SITE}/homes/`;
  const n = listings.length;
  const desc = `Browse ${n} move-in ready and renovated ${n === 1 ? "home" : "homes"} for sale across Ellis County and the southern Dallas–Fort Worth metro. New properties from Recast Properties are added as they come available.`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Available Properties — Recast Properties",
    url: canon,
    numberOfItems: n,
    itemListElement: listings.map((l, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: canonicalFor(l),
      name: `${l.address}, ${[l.city, l.state].filter(Boolean).join(", ")}`,
    })),
  };
  return [
    `<meta name="description" content="${esc(desc)}">`,
    `<meta name="robots" content="max-snippet:-1, max-image-preview:large">`,
    `<link rel="canonical" href="${esc(canon)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Recast Properties LLC">`,
    `<meta property="og:title" content="${esc(TITLE)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(canon)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`,
  ].join("\n");
}

function contentHtml(listings) {
  const items = listings.map((l) => {
    const place = [l.city, l.state, l.zip].filter(Boolean).join(" ");
    const facts = [`${l.beds} bd`, `${l.baths} ba`, l.sqft ? `${Number(l.sqft).toLocaleString()} sqft` : ""].filter(Boolean).join(" · ");
    return `<li><a href="${esc(canonicalFor(l))}"><strong>${esc(l.address)}</strong></a> — ${esc(place)} · ${esc(fmtPrice(l.price))} · ${esc(facts)} · ${esc(l.status)}</li>`;
  }).join("");
  return `<section>
    <h1>Available properties</h1>
    <p>Move-in ready and renovated homes for sale across Ellis County and the southern DFW metro.</p>
    <ul>${items}</ul>
  </section>`;
}

export default async () => {
  let html;
  try { html = await template(); }
  catch (e) { return new Response("Grid template unavailable", { status: 500 }); }

  const listings = await readListings();
  const inject = `<script>window.__LISTINGS__=${JSON.stringify(listings).replace(/</g, "\\u003c")};</script>\n`;

  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(TITLE)}</title>`)
    .replace(/<\/head>/i, `${headTags(listings)}\n</head>`)
    .replace(/<div id="root">\s*<\/div>/i, `<div id="root">${contentHtml(listings)}</div>`)
    .replace(/(<script src="[^"]*data\.js)/i, `${inject}$1`);

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=120, stale-while-revalidate=86400",
    },
  });
};
