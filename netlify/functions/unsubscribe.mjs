// Public unsubscribe page at /unsubscribe?id=<contact id> — the link in every
// blast email, and the List-Unsubscribe header Gmail's own button uses.
// GET only shows a button: mail scanners open links, so opening one must never
// unsubscribe anyone. POST (that button, or Gmail's one-click) ticks Unsubscribed.
import { contactsStore, put } from "../lib/contacts.mjs";
import { esc } from "../lib/listings.mjs";

export const config = { path: "/unsubscribe" };

const page = (inner) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Unsubscribe — Recast Properties</title></head>
<body style="margin:0;padding:0 16px;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#18191c;line-height:1.5">
<div style="max-width:440px;margin:12vh auto 0;padding:28px 24px;background:#fff;border:1px solid #e1e4e9;border-radius:14px;text-align:center">
<img src="/assets/recast-logo-horizontal-black.png" alt="Recast Properties" width="200" height="30" style="margin-bottom:18px">
${inner}</div></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id") || "";
  const store = contactsStore();
  const c = /^[0-9a-f-]{36}$/.test(id) ? await store.get(id, { type: "json" }) : null;
  if (!c) return page("<p>This link isn't valid, or it came from a test email. Nothing was changed.</p>");

  if (req.method === "POST") {
    if (!c.unsubscribed) await put(store, { ...c, unsubscribed: "1" }, c);
    return page(`<h1 style="font-size:20px;margin:0 0 8px">You're unsubscribed.</h1>
<p style="margin:0;color:#53575f">You won't hear from Recast Properties about new homes again.</p>`);
  }
  return page(`<h1 style="font-size:20px;margin:0 0 8px">Unsubscribe?</h1>
<p style="margin:0 0 20px;color:#53575f">Stop emails from Recast Properties to <b>${esc(c.email || c.phone)}</b>.</p>
<form method="post"><button style="font:700 15px Arial,Helvetica,sans-serif;background:#d9743f;color:#fff;border:0;border-radius:10px;padding:11px 22px;cursor:pointer">Unsubscribe</button></form>`);
};
