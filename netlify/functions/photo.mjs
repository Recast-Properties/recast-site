// Serves listing photos from Netlify Blobs at /photos/<folder>/<n>.jpg
// A forced redirect in netlify.toml routes /photos/* here. Public (no auth) —
// these images are meant to be seen on the site.
import { getStore } from "@netlify/blobs";

const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export default async (req) => {
  const url = new URL(req.url);
  // Path arrives as either /photos/<folder>/<file> or
  // /.netlify/functions/photo/<folder>/<file> (via the redirect :splat).
  const segs = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  // last two segments = folder/file
  const file = segs[segs.length - 1];
  const folder = segs[segs.length - 2];
  if (!folder || !file) return new Response("Not found", { status: 404 });

  const ext = (file.split(".").pop() || "jpg").toLowerCase();
  const key = `${folder}/${file}`;

  const cacheHeaders = {
    "content-type": TYPES[ext] || "image/jpeg",
    // Serve instantly from the CDN, then refresh in the background. A visitor
    // never waits on this function past the first fetch: for a week the CDN
    // returns the cached copy immediately (stale-while-revalidate) and re-reads
    // the Blob out of band. An admin reorder/replace propagates within ~5 min
    // (max-age) — the same "edits show up fast" goal the old 60s cache had,
    // without making every visit re-download every image through the function.
    "cache-control": "public, max-age=300, stale-while-revalidate=604800",
  };

  try {
    const store = getStore("listing-photos");

    // HEAD = existence check only (used by the gallery's fallback count). Read
    // metadata, never the full image bytes.
    if (req.method === "HEAD") {
      const meta = await store.getMetadata(key);
      return new Response(null, { status: meta ? 200 : 404, headers: cacheHeaders });
    }

    const data = await store.get(key, { type: "arrayBuffer" });
    if (!data) return new Response("Not found", { status: 404 });
    return new Response(data, { status: 200, headers: cacheHeaders });
  } catch (e) {
    return new Response("Error: " + String((e && e.message) || e), { status: 500 });
  }
};
