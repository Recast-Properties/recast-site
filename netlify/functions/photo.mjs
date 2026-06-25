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

  try {
    const store = getStore("listing-photos");
    const data = await store.get(key, { type: "arrayBuffer" });
    if (!data) return new Response("Not found", { status: 404 });
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": TYPES[ext] || "image/jpeg",
        // Short cache so edits/reorders/deletes from the admin show up within ~a
        // minute. Listing photos change rarely, so re-serving is cheap.
        "cache-control": "public, max-age=60",
      },
    });
  } catch (e) {
    return new Response("Error: " + String((e && e.message) || e), { status: 500 });
  }
};
