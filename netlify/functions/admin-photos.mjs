// Admin photo manager (auth required). Stores listing photos in Netlify Blobs
// under "<folder>/<n>.jpg", always contiguously numbered 1..n so the site's
// folder-based loader (photos/<folder>/1.jpg, 2.jpg, …) finds them.
//
// POST JSON actions (header x-admin-token must equal ADMIN_PASSWORD):
//   { action:"list",   folder }                  -> { ok, count }
//   { action:"commit", folder, items:[ ... ] }   -> { ok, count }
//        items is the FINAL desired order; each item is either
//          { keep: <currentIndex> }  (a photo already in the folder), or
//          { dataUrl: "data:image/jpeg;base64,..." }  (a new upload)
//        The folder is rewritten to exactly these, numbered 1..n.
//   { action:"clear",  folder }                  -> { ok }
import { getStore } from "@netlify/blobs";

const STORE = "listing-photos";

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}
const slugFolder = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function indicesIn(listing) {
  return (listing.blobs || [])
    .map((b) => parseInt((b.key.split("/").pop() || "").replace(/\D/g, ""), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) throw new Error("bad dataUrl");
  return { type: m[1], bytes: Buffer.from(m[2], "base64") };
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!authed(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const folder = slugFolder(body.folder);
  if (!folder) return Response.json({ ok: false, error: "Missing folder" }, { status: 400 });

  const store = getStore(STORE);

  try {
    if (body.action === "list") {
      const listing = await store.list({ prefix: folder + "/" });
      return Response.json({ ok: true, count: indicesIn(listing).length });
    }

    if (body.action === "clear") {
      const listing = await store.list({ prefix: folder + "/" });
      await Promise.all((listing.blobs || []).map((b) => store.delete(b.key)));
      return Response.json({ ok: true });
    }

    if (body.action === "commit") {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) {
        // empty commit == clear
        const listing = await store.list({ prefix: folder + "/" });
        await Promise.all((listing.blobs || []).map((b) => store.delete(b.key)));
        return Response.json({ ok: true, count: 0 });
      }
      // 1) Resolve every item to bytes IN MEMORY first (avoids clobber on reorder).
      const finalBytes = [];
      for (const it of items) {
        if (it && it.dataUrl) {
          finalBytes.push(decodeDataUrl(it.dataUrl).bytes);
        } else if (it && Number.isInteger(it.keep)) {
          const buf = await store.get(`${folder}/${it.keep}.jpg`, { type: "arrayBuffer" });
          if (!buf) throw new Error("missing photo " + it.keep);
          finalBytes.push(Buffer.from(buf));
        } else {
          throw new Error("bad item");
        }
      }
      // 2) Write contiguously 1..n as jpg.
      for (let i = 0; i < finalBytes.length; i++) {
        await store.set(`${folder}/${i + 1}.jpg`, finalBytes[i], {
          metadata: { contentType: "image/jpeg" },
        });
      }
      // 3) Delete any leftovers beyond n (old higher indices / stray extensions).
      const after = await store.list({ prefix: folder + "/" });
      await Promise.all(
        (after.blobs || [])
          .filter((b) => {
            const n = parseInt((b.key.split("/").pop() || "").replace(/\D/g, ""), 10);
            return !(Number.isInteger(n) && n >= 1 && n <= finalBytes.length && b.key === `${folder}/${n}.jpg`);
          })
          .map((b) => store.delete(b.key))
      );
      return Response.json({ ok: true, count: finalBytes.length });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
