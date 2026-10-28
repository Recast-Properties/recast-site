// Netlify runs this (by its file name) after every VERIFIED form submission —
// past the honeypot and spam filter, and signed by Netlify, so outside requests
// can't invoke it. Get Notified sign-ups become CRM contacts (see
// netlify/lib/contacts.mjs); other forms are ignored. A repeat sign-up (same email
// or mobile) updates the existing contact: blank fields never erase, and an
// Unsubscribed contact stays unsubscribed.
import { contactsStore, readAll, findMatch, normalize, put } from "../lib/contacts.mjs";

export default async (req) => {
  const { payload = {} } = await req.json();
  const d = payload.data || {};
  // Production sends form_name; `netlify dev` only has the form's own form-name field.
  if ((payload.form_name || d["form-name"]) !== "get-notified") return new Response("ignored");

  const incoming = normalize({ name: d.name, email: d.email, phone: d.phone,
    prefers: d["contact-pref"], smsConsent: d["sms-consent"], source: "Get Notified" });
  if (!incoming.email && !incoming.phone) return new Response("no email or phone");

  const store = contactsStore();
  const prev = findMatch(await readAll(store), incoming) || null;
  const next = prev ? { ...prev } : incoming;
  if (prev) for (const f of ["name", "email", "phone", "prefers", "smsConsent"]) if (incoming[f]) next[f] = incoming[f];
  const row = await put(store, next, prev);
  console.log(`[crm] ${prev ? "updated" : "added"} contact ${row.id}`);
  return new Response("ok");
};
