// Who can sign in to /admin besides Paul — the "Who can sign in" card on the hub.
// Owner only (the admin password); storage in lib/admin-auth.mjs.
//
// POST JSON (header x-admin-token == ADMIN_PASSWORD):
//   { action:"list" }                 -> { ok, rows:[{ id, name, email, addedAt }] }
//   { action:"invite", name, email }  -> { ok, row, sent, error? }  emails their sign-in
//                                        link from paul@. Inviting an email that is already
//                                        on the list re-sends the same link. The person is
//                                        kept even if the email fails, so a retry re-sends.
//   { action:"remove", id }           -> { ok }   their link stops working everywhere
import { randomBytes } from "node:crypto";
import { usersStore, isOwner } from "../lib/admin-auth.mjs";
import { esc, SITE } from "../lib/listings.mjs";

// Copied from analyst-bridge.mjs sendEmail (sends as paul@ through the Nylas grant).
async function sendEmail(to, subject, html) {
  const key = process.env.NYLAS_API_KEY, grant = process.env.NYLAS_GRANT_ID;
  if (!key || !grant) return { ok: false, error: "NYLAS env missing" };
  const res = await fetch(`https://api.us.nylas.com/v3/grants/${grant}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ to: [{ email: to }], subject, body: html }),
  });
  return res.ok ? { ok: true } : { ok: false, error: `Nylas ${res.status}: ${(await res.text()).slice(0, 200)}` };
}

const inviteEmail = (name, link) => `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#18191c;max-width:520px">
<p>Hi ${esc(name.split(/\s+/)[0])},</p>
<p>Paul set you up on the Recast Properties admin: listings, contacts, email blasts, email setup and the Deed Maker.</p>
<p style="margin:24px 0"><a href="${link}" style="background:#d9743f;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">Sign in to Recast admin</a></p>
<p>The link signs you in on the device you open it on and keeps you signed in there. To use another device, open this email there and click it again.</p>
<p style="color:#71757e;font-size:13px">This link is your personal sign-in, so please don't forward this email.</p>
</div>`;

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!isOwner(req)) return Response.json({ ok: false, error: "Only the admin password can manage who signs in." }, { status: 403 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  const store = usersStore();
  const readAll = async () => {
    const { blobs } = await store.list();
    const rows = await Promise.all(blobs.map(async (b) => ({ id: b.key, ...(await store.get(b.key, { type: "json" })) })));
    return rows.filter((r) => r.email).sort((a, b) => (a.addedAt || "").localeCompare(b.addedAt || ""));
  };

  if (body.action === "list") return Response.json({ ok: true, rows: await readAll() });

  if (body.action === "invite") {
    const name = String(body.name || "").trim().slice(0, 100);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
    if (!name) return Response.json({ ok: false, error: "Enter their name." }, { status: 400 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ ok: false, error: "Enter a valid email." }, { status: 400 });
    let row = (await readAll()).find((r) => r.email === email);
    if (!row) {
      row = { id: randomBytes(32).toString("hex"), name, email, addedAt: new Date().toISOString() };
      await store.setJSON(row.id, { name, email, addedAt: row.addedAt });
    }
    const sent = await sendEmail(email, "Your sign-in link for Recast admin", inviteEmail(row.name, `${SITE}/admin/#key=${row.id}`));
    return Response.json({ ok: true, row, sent: sent.ok, error: sent.error });
  }

  if (body.action === "remove") {
    if (!/^[a-f0-9]{64}$/.test(String(body.id || ""))) return Response.json({ ok: false, error: "Missing id" }, { status: 400 });
    await store.delete(body.id);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
};
