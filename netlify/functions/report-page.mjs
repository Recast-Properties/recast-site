// Serves analyst-generated reports from Netlify Blobs at /reports/<file>.html.
// The netlify.toml redirect for /reports/* is NOT forced, so real static files in
// the repo's reports/ folder (the two hand-built reports) win; only misses land here.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const segs = url.pathname.split("/").filter(Boolean);
  const file = segs[segs.length - 1] || "";
  if (!/^[a-z0-9-]+\.html$/.test(file)) return new Response("Not found", { status: 404 });
  const html = await getStore({ name: "analyst", consistency: "strong" }).get(`reports/${file}`);
  if (!html) return new Response("Not found", { status: 404 });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "public, max-age=300",
    },
  });
};
