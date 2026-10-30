// Saved deeds API (auth required) — the /admin/deed/ page.
// Netlify Blobs store "deeds", ONE KEY PER DEED (key = id, value = the deed JSON),
// same layout as crm-contacts.
//
// POST JSON (header x-admin-token == ADMIN_PASSWORD):
//   { action:"list" }               -> { ok, rows }  (last edited first)
//   { action:"get", id }            -> { ok, row }
//   { action:"save", deed:{...} }   -> { ok, row }   (no id = new; with id = edit)
//   { action:"delete", id }         -> { ok }
import { getStore } from "@netlify/blobs";

const FIELDS = ["grantor", "grantorAddr", "signer", "grantee", "granteeAddr", "county", "legal",
  "consideration", "city", "day", "month", "year", "ackState", "ackCounty"];
const clean = (v, max) => (v == null ? "" : String(v).trim().slice(0, max));

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!authed(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  const store = getStore({ name: "deeds", consistency: "strong" });

  if (body.action === "list") {
    // ponytail: one Blob get per deed, in parallel — fine into the hundreds.
    const { blobs } = await store.list();
    const rows = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return Response.json({ ok: true, rows });
  }

  if (body.action === "get") {
    const row = body.id && (await store.get(String(body.id), { type: "json" }));
    if (!row) return Response.json({ ok: false, error: "That deed was deleted." }, { status: 404 });
    return Response.json({ ok: true, row });
  }

  if (body.action === "save") {
    const d = body.deed || {};
    let prev = null;
    if (d.id) {
      prev = await store.get(String(d.id), { type: "json" });
      if (!prev) return Response.json({ ok: false, error: "That deed was deleted." }, { status: 404 });
    }
    const now = new Date().toISOString();
    const row = { id: prev?.id || crypto.randomUUID(), createdAt: prev?.createdAt || now, updatedAt: now };
    for (const f of FIELDS) row[f] = clean(d[f], f === "legal" ? 20000 : 500);
    await store.setJSON(row.id, row);
    return Response.json({ ok: true, row });
  }

  if (body.action === "delete") {
    if (!body.id) return Response.json({ ok: false, error: "Missing id" }, { status: 400 });
    await store.delete(String(body.id));
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
};
