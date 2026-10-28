// CRM contacts — Netlify Blobs store "crm-contacts", ONE KEY PER CONTACT (key =
// id, value = the contact JSON). Not one array like listings: a sign-up and an
// admin edit landing at the same moment can't overwrite each other.
// Used by submission-created.mjs (Get Notified sign-ups) and admin-contacts.mjs.
import { getStore } from "@netlify/blobs";

export const contactsStore = () => getStore({ name: "crm-contacts", consistency: "strong" });

const clean = (v, max = 500) => (v == null ? "" : String(v).trim().slice(0, max));
// Last 10 digits of a US number ("+1 (214) 555-0123" -> "2145550123").
export const digits = (p) => String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

// The editable fields, cleaned. id/createdAt/updatedAt/smsConsentAt are set by put().
// smsConsent = what the person agreed to for texts (the form's exact wording, or
// how they agreed for a hand-added contact). Blank = do not text them.
export function normalize(c) {
  const o = {};
  for (const f of ["name", "email", "phone", "prefers", "source", "smsConsent"]) o[f] = clean(c[f]);
  o.notes = clean(c.notes, 5000);
  o.email = o.email.toLowerCase();
  const d = digits(o.phone);
  if (d.length === 10) o.phone = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (!["email", "text", "both"].includes(o.prefers)) o.prefers = "";
  o.unsubscribed = c.unsubscribed === true || /^(1|true|yes|on)$/i.test(clean(c.unsubscribed)) ? "1" : "";
  return o;
}

// ponytail: reads every contact (one Blob get each, in parallel) — fine into the
// low thousands; past that, move to a real database.
export async function readAll(store) {
  const { blobs } = await store.list();
  const rows = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return rows.filter(Boolean).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

// Same person = same email or same mobile.
export function findMatch(rows, c) {
  const e = c.email, p = digits(c.phone);
  return rows.find((r) => (e && r.email === e) || (p && digits(r.phone) === p));
}

// Write `next` (normalized fields) over `prev` (the stored contact, or null for new).
export async function put(store, next, prev) {
  const now = new Date().toISOString();
  const row = { ...next, id: prev?.id || crypto.randomUUID(), createdAt: prev?.createdAt || now, updatedAt: now };
  // Consent date: kept while the wording is unchanged, stamped when it's new, cleared with it.
  row.smsConsentAt = !row.smsConsent ? "" : prev?.smsConsent === row.smsConsent ? prev.smsConsentAt : now;
  await store.setJSON(row.id, row);
  return row;
}
