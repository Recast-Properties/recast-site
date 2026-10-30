// Admin CRM contacts API (auth required) — the /admin/contacts/ page.
// Storage and field rules: netlify/lib/contacts.mjs.
//
// POST JSON (header x-admin-token: see lib/admin-auth.mjs):
//   { action:"list" }                  -> { ok, rows }  (newest first)
//   { action:"save", contact:{...} }   -> { ok, row }   (no id = add; with id = edit.
//                                         Adding someone whose email or mobile is
//                                         already in the list -> 409 + existing id)
//   { action:"delete", id }            -> { ok }
import { contactsStore, readAll, findMatch, normalize, put } from "../lib/contacts.mjs";
import { authed } from "../lib/admin-auth.mjs";

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!(await authed(req))) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  const store = contactsStore();

  if (body.action === "list") return Response.json({ ok: true, rows: await readAll(store) });

  if (body.action === "save") {
    const c = body.contact || {};
    const next = normalize(c);
    if (!next.email && !next.phone) return Response.json({ ok: false, error: "Enter an email or a mobile number." }, { status: 400 });
    let prev = null;
    if (c.id) {
      prev = await store.get(String(c.id), { type: "json" });
      if (!prev) return Response.json({ ok: false, error: "That contact was deleted." }, { status: 404 });
      next.source = prev.source; // where they came from never changes
    } else {
      const dup = findMatch(await readAll(store), next);
      if (dup) return Response.json({ ok: false, id: dup.id,
        error: `Already in the list as ${dup.name || dup.email || dup.phone}.` }, { status: 409 });
      next.source = "Added by hand";
    }
    return Response.json({ ok: true, row: await put(store, next, prev) });
  }

  if (body.action === "delete") {
    if (!body.id) return Response.json({ ok: false, error: "Missing id" }, { status: 400 });
    await store.delete(String(body.id));
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
};
