// Admin email blast API (auth required) — the /admin/blast/ page.
// Who gets a blast, the email and the send: netlify/lib/blast.mjs.
//
// POST JSON (header x-admin-token == ADMIN_PASSWORD):
//   { action:"info" }   -> { ok, recipients, addressSet, testTo, listings:[{id,label}], blasts:[...] }
//   { action:"preview", subject, message, listingIds } -> { ok, html }
//   { action:"test", subject, message, listingIds }  -> { ok }   (to TEST_TO only)
//   { action:"send", subject, message, listingIds }  -> { ok, id } (snapshots who gets
//        it, then admin-blast-send-background.mjs sends; refused while another is sending)
//   { action:"resume", id }  -> { ok }  (a "stopped" blast continues where it left off)
import { contactsStore, readAll } from "../lib/contacts.mjs";
import { readListings, fmtPrice } from "../lib/listings.mjs";
import { blastsStore, buildEmail, sendOne, recipientsOf, TEST_TO, MAILING_ADDRESS } from "../lib/blast.mjs";

const json = (o, status = 200) => Response.json(o, { status });
// The sender saves after every email; 3 minutes with no save = it stopped.
const isStalled = (b) => b.status === "sending" && Date.now() - Date.parse(b.updatedAt) > 3 * 60 * 1000;

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}

async function readBlasts(store) {
  const { blobs } = await store.list();
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return all.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function draft(body) {
  const subject = String(body.subject || "").trim().slice(0, 200);
  const message = String(body.message || "").trim().slice(0, 20000);
  const listingIds = (Array.isArray(body.listingIds) ? body.listingIds : []).map(String).slice(0, 10);
  if (!subject) return { error: "Add a subject." };
  if (!message && !listingIds.length) return { error: "Write a message or pick a listing." };
  return { subject, message, listingIds };
}

// Start the background sender (it answers 202 straight away).
const kick = (req, id) => fetch(new URL("/.netlify/functions/admin-blast-send-background", req.url), {
  method: "POST", headers: { "x-admin-token": req.headers.get("x-admin-token") }, body: JSON.stringify({ id }) });

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!authed(req)) return json({ ok: false, error: "Unauthorized" }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const store = blastsStore();

  if (body.action === "info") {
    const [contacts, listings, blasts] = await Promise.all([readAll(contactsStore()), readListings(), readBlasts(store)]);
    return json({ ok: true, recipients: recipientsOf(contacts).length, addressSet: !!MAILING_ADDRESS, testTo: TEST_TO,
      listings: listings.map((l) => ({ id: l.id, label: `${l.address}${l.city ? ", " + l.city : ""} · ${fmtPrice(l.price)}` })),
      blasts: blasts.map((b) => ({ id: b.id, subject: b.subject, createdAt: b.createdAt,
        status: isStalled(b) ? "stopped" : b.status, total: b.recipients.length, done: b.next, failed: b.failed })) });
  }

  if (body.action === "preview") {
    const d = draft(body);
    if (d.error) return json({ ok: false, error: d.error }, 400);
    return json({ ok: true, html: (await buildEmail(d)).replaceAll("{{UNSUB}}", "#") });
  }

  if (body.action === "test") {
    const d = draft(body);
    if (d.error) return json({ ok: false, error: d.error }, 400);
    const res = await sendOne(TEST_TO, "[TEST] " + d.subject, await buildEmail(d), "test");
    return res.ok ? json({ ok: true }) : json({ ok: false, error: res.error }, 502);
  }

  if (body.action === "send") {
    if (!MAILING_ADDRESS) return json({ ok: false, error: "The mailing address for the email footer isn't set yet." }, 400);
    const d = draft(body);
    if (d.error) return json({ ok: false, error: d.error }, 400);
    if ((await readBlasts(store)).some((b) => b.status === "sending" && !isStalled(b)))
      return json({ ok: false, error: "Another blast is still sending. Wait for it to finish." }, 409);
    const recipients = recipientsOf(await readAll(contactsStore())).map((c) => ({ id: c.id, email: c.email }));
    if (!recipients.length) return json({ ok: false, error: "No one to send to yet." }, 400);
    const now = new Date().toISOString();
    const b = { id: crypto.randomUUID(), ...d, createdAt: now, updatedAt: now, status: "sending", recipients, next: 0, failed: [] };
    await store.setJSON(b.id, b);
    const k = await kick(req, b.id);
    if (!k.ok) return json({ ok: false, error: `Saved, but sending didn't start (HTTP ${k.status}). Use Resume in a few minutes.` }, 502);
    return json({ ok: true, id: b.id });
  }

  if (body.action === "resume") {
    const b = await store.get(String(body.id || ""), { type: "json" });
    if (!b || !isStalled(b)) return json({ ok: false, error: "Only a stopped blast can be resumed." }, 400);
    b.updatedAt = new Date().toISOString();
    await store.setJSON(b.id, b);
    const k = await kick(req, b.id);
    return k.ok ? json({ ok: true }) : json({ ok: false, error: `Sending didn't start (HTTP ${k.status}).` }, 502);
  }

  return json({ ok: false, error: "Unknown action" }, 400);
};
