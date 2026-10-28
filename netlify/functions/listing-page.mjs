// Server-rendered listing detail page (crawlable). Serves /homes/<id> with the
// real listing content, metadata and JSON-LD baked into the HTML — so crawlers
// and AI search that don't run JavaScript see the full listing. The existing
// React app still boots on top for the interactive gallery (it reads the injected
// window.__LISTING__, so it renders instantly without re-fetching).
//
// Wired in netlify.toml: /homes/:id  ->  /.netlify/functions/listing-page/:id
// (force=false, so real static files like /homes/index.html win over this).
import { readListings, listingHeadTags, listingContentHtml, metaTitle, esc, readTemplate } from "../lib/listings.mjs";

let TEMPLATE = null;
async function template() {
  // homes/detail.html is bundled with this function (netlify.toml included_files),
  // so we transform the SAME file the site ships — no duplicated <head>/scripts.
  if (TEMPLATE == null) TEMPLATE = await readTemplate("homes/detail.html");
  return TEMPLATE;
}

function idFromReq(req) {
  const url = new URL(req.url);
  const q = url.searchParams.get("id");
  if (q) return q;
  const segs = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  return decodeURIComponent(segs[segs.length - 1] || "");
}

export default async (req) => {
  const id = idFromReq(req);
  // ?preview=1 is the admin's "Preview ↗" link: it renders a not-yet-live
  // listing so it can be shared before it goes live. No password; noindex +
  // no-store; a banner on top while the listing is hidden.
  // ponytail: anyone who knows the id and adds ?preview=1 can see a hidden
  // listing — the photos were already public at /photos/<id>/n.jpg. Add a
  // per-listing random key if that ever matters.
  const preview = new URL(req.url).searchParams.has("preview");
  let html;
  try { html = await template(); }
  catch (e) { return new Response("Listing template unavailable", { status: 500 }); }

  const listings = await readListings({ includeHidden: preview });
  const l = listings.find((x) => x.id === id);

  if (!l) {
    // Unknown id: still serve the app (it renders "Property not found") but tell
    // crawlers it's gone. noindex so we don't index an empty shell.
    const shell = html.replace(/<\/head>/i, `<meta name="robots" content="noindex">\n</head>`);
    return new Response(shell, { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  const inject =
    `<script>window.__LISTING__=${JSON.stringify(l).replace(/</g, "\\u003c")};</script>\n`;

  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(metaTitle(l))}</title>`)
    .replace(/<\/head>/i, `${listingHeadTags(l)}\n</head>`)
    .replace(/<div id="root">\s*<\/div>/i, `<div id="root"><div class="ssr-copy">${listingContentHtml(l)}</div></div>`)
    .replace(/(<script src="data\.js)/i, `${inject}$1`);

  if (preview) {
    html = html.replace(/<\/head>/i, `<meta name="robots" content="noindex">\n</head>`);
    if (l.hidden) html = html.replace(/<div id="root">/i, (m) =>
      `<div style="position:sticky;top:0;z-index:9999;background:#fdf0d9;color:#9a6a12;font:700 13px/1.4 system-ui,sans-serif;text-align:center;padding:8px 12px">Preview — this listing is not on the public site yet.</div>\n${m}`);
  }

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Fresh enough that admin edits show quickly; cached at the edge otherwise.
      // A preview is never cached and never indexed.
      "cache-control": preview ? "no-store" : "public, max-age=120, stale-while-revalidate=86400",
      ...(preview ? { "x-robots-tag": "noindex" } : {}),
    },
  });
};
