// Public photo manifest for a listing folder. ONE request tells the gallery how
// many photos a listing has, so it never has to probe 1.jpg, 2.jpg, 3.jpg …
// sequentially (that walk cost ~6s for a 27-photo listing and blocked the
// lightbox from rendering its images). Reads the same "listing-photos" Blob store
// that photo.mjs serves from.
import { getStore } from "@netlify/blobs";

const STORE = "listing-photos";
const slugFolder = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export default async (req) => {
  const url = new URL(req.url);
  const folder = slugFolder(url.searchParams.get("folder"));
  if (!folder) return Response.json({ ok: false, count: 0, error: "Missing folder" }, { status: 400 });

  try {
    const store = getStore(STORE);
    const listing = await store.list({ prefix: folder + "/" });
    // Match only "<folder>/<n>.jpg" — this excludes staging keys ("<folder>/.stg/…").
    const re = new RegExp("^" + folder + "/(\\d+)\\.jpg$");
    const nums = new Set();
    for (const b of (listing.blobs || [])) {
      const m = b.key.match(re);
      if (m) nums.add(parseInt(m[1], 10));
    }
    // Photos are always written contiguously 1..n by the admin; count the run from 1.
    let count = 0;
    while (nums.has(count + 1)) count++;

    return new Response(JSON.stringify({ ok: true, folder, count }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Same cache posture as the photos themselves: instant repeat loads,
        // background refresh, admin edits visible within ~5 min.
        "cache-control": "public, max-age=300, stale-while-revalidate=604800",
      },
    });
  } catch (e) {
    return Response.json({ ok: false, count: 0, error: String((e && e.message) || e) }, { status: 500 });
  }
};
