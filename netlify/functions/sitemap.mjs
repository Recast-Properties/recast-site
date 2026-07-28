// Dynamic sitemap.xml — lists the static pages plus every current listing
// (/homes/<id>) read from Blobs, so new listings added in the admin show up
// automatically. Wired in netlify.toml: /sitemap.xml -> this function (force=true).
import { readListings, SITE, canonicalFor } from "../lib/listings.mjs";

export default async () => {
  const listings = await readListings();
  const urls = [
    `${SITE}/`,
    `${SITE}/homes/`,
    ...listings.map((l) => canonicalFor(l)),
    `${SITE}/privacy.html`,
    `${SITE}/terms.html`,
  ];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    },
  });
};
