// Admin photo manager (auth required). Stores listing photos in Netlify Blobs
// under "<folder>/<n>.jpg", always contiguously numbered 1..n so the site's
// folder-based loader (photos/<folder>/1.jpg, 2.jpg, …) finds them.
//
// Photos are uploaded ONE AT A TIME (each request stays well under Netlify's
// ~6MB function body limit), then a final lightweight "arrange" sets the order.
//
// POST JSON actions (header x-admin-token: see lib/admin-auth.mjs):
//   { action:"list",    folder }                 -> { ok, count }
//   { action:"add",     folder, dataUrl }        -> { ok, id }   (stages one photo)
//   { action:"arrange", folder, order:[ ... ] }  -> { ok, count }
//        order is the FINAL desired sequence; each item is either
//          { keep: <currentIndex> }   (a photo already numbered in the folder), or
//          { staged: "<id>" }         (a photo just uploaded via "add")
//        The folder is rewritten to exactly these, numbered 1..n; staging cleared.
//   { action:"clear",   folder }                 -> { ok }
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { authed } from "../lib/admin-auth.mjs";

const STORE = "listing-photos";
const STG = "/.stg/"; // staging sub-path; never matches a numbered photo

const slugFolder = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function numberedCount(listing, folder) {
  return (listing.blobs || []).filter((b) => new RegExp("^" + folder + "/\\d+\\.jpg$").test(b.key)).length;
}

function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) throw new Error("bad dataUrl");
  return Buffer.from(m[2], "base64");
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!(await authed(req))) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const folder = slugFolder(body.folder);
  if (!folder) return Response.json({ ok: false, error: "Missing folder" }, { status: 400 });

  // Strong consistency: edits/reorders must be visible immediately on re-open.
  const store = getStore({ name: STORE, consistency: "strong" });

  try {
    if (body.action === "list") {
      const listing = await store.list({ prefix: folder + "/" });
      return Response.json({ ok: true, count: numberedCount(listing, folder) });
    }

    if (body.action === "clear") {
      const listing = await store.list({ prefix: folder + "/" });
      await Promise.all((listing.blobs || []).map((b) => store.delete(b.key)));
      return Response.json({ ok: true });
    }

    if (body.action === "add") {
      const bytes = decodeDataUrl(body.dataUrl);
      const id = randomUUID();
      await store.set(folder + STG + id + ".jpg", bytes, { metadata: { contentType: "image/jpeg" } });
      return Response.json({ ok: true, id });
    }

    if (body.action === "arrange") {
      const order = Array.isArray(body.order) ? body.order : [];
      // Read every final photo's bytes into memory FIRST (clobber-free reorder).
      const finalBytes = await Promise.all(
        order.map(async (it) => {
          const key = it && Number.isInteger(it.keep)
            ? `${folder}/${it.keep}.jpg`
            : (it && it.staged ? `${folder}${STG}${it.staged}.jpg` : null);
          if (!key) throw new Error("bad order item");
          const buf = await store.get(key, { type: "arrayBuffer" });
          if (!buf) throw new Error("missing photo " + key);
          return Buffer.from(buf);
        })
      );
      // Write contiguously 1..n.
      for (let i = 0; i < finalBytes.length; i++) {
        await store.set(`${folder}/${i + 1}.jpg`, finalBytes[i], { metadata: { contentType: "image/jpeg" } });
      }
      // Delete anything that isn't one of the final numbered keys (old extras + all staging).
      const keepKeys = new Set(finalBytes.map((_, i) => `${folder}/${i + 1}.jpg`));
      const after = await store.list({ prefix: folder + "/" });
      await Promise.all(
        (after.blobs || []).filter((b) => !keepKeys.has(b.key)).map((b) => store.delete(b.key))
      );
      return Response.json({ ok: true, count: finalBytes.length });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
