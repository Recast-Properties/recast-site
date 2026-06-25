// ONE-TIME migration (auth required). Pulls the existing static listing photos
// (photos/<folder>/<n>.jpg, currently served as files) into Netlify Blobs so the
// photo function can serve everything from one place. Run this BEFORE switching
// the /photos/* redirect on. Idempotent — safe to re-run.
//
// POST { action?, folders?: string[], origin?: string }
//   folders: defaults to the known existing folders.
//   origin:  where to fetch the current static files from (default: live site).
import { getStore } from "@netlify/blobs";

const STORE = "listing-photos";
const DEFAULT_FOLDERS = ["104ashburne", "1616granite", "280sparkling"];

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}

export default async (req) => {
  if (!authed(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const folders = Array.isArray(body.folders) && body.folders.length ? body.folders : DEFAULT_FOLDERS;
  const origin = (body.origin || "https://recast-properties.com").replace(/\/+$/, "");
  const max = Number(body.max) || 80;
  const store = getStore(STORE);
  const report = {};

  for (const folder of folders) {
    // Fetch indices 1..max in parallel; keep the ones that exist.
    const results = await Promise.all(
      Array.from({ length: max }, (_, k) => k + 1).map(async (i) => {
        const res = await fetch(`${origin}/photos/${folder}/${i}.jpg`, { cache: "no-store" });
        if (!res.ok) return null;
        return { i, buf: Buffer.from(await res.arrayBuffer()) };
      })
    );
    const found = results.filter(Boolean);
    // Store in parallel.
    await Promise.all(
      found.map((f) => store.set(`${folder}/${f.i}.jpg`, f.buf, { metadata: { contentType: "image/jpeg" } }))
    );
    report[folder] = found.length;
  }

  return Response.json({ ok: true, migrated: report });
};
