// Email blasts: who gets one, the email itself, and the send.
// Sends through the same Nylas grant (paul@) analyst-bridge.mjs uses, from the
// info@ alias, one email per person. Blast records: Blobs store "crm-blasts",
// one key per blast. Used by admin-blast.mjs and admin-blast-send-background.mjs.
import { getStore } from "@netlify/blobs";
import { readListings, esc, fmtPrice, photoUrl, canonicalFor, SITE } from "./listings.mjs";

export const blastsStore = () => getStore({ name: "crm-blasts", consistency: "strong" });
export const TEST_TO = "paul@recast-properties.com";
const FROM = { name: "Recast Properties", email: "info@recast-properties.com" };
// Every marketing email must carry a postal address (CAN-SPAM). Real sends are
// refused while this is blank; test sends show a placeholder.
export const MAILING_ADDRESS = "";

// Who gets a blast: has an email, isn't unsubscribed, didn't choose text-only.
export const recipientsOf = (contacts) => contacts.filter((c) => c.email && !c.unsubscribed && c.prefers !== "text");

const unsubUrl = (contactId) => `${SITE}/unsubscribe?id=${encodeURIComponent(contactId)}`;

// Typed message -> HTML: escaped, blank line = new paragraph, links clickable.
function messageHtml(text) {
  return String(text || "").trim().split(/\n\s*\n/).filter(Boolean).map((p) =>
    '<p style="margin:0 0 16px">' + esc(p)
      .replace(/https?:\/\/[^\s<]*[^\s<.,!?)]/g, (u) => `<a href="${u}" style="color:#c2643a">${u}</a>`)
      .replace(/\n/g, "<br>") + "</p>").join("");
}

function listingCard(l) {
  const url = canonicalFor(l), img = photoUrl(l, 0, 1200, "jpg");
  const facts = [l.beds && `${l.beds} bd`, l.baths && `${l.baths} ba`,
    l.sqft && `${Number(l.sqft).toLocaleString("en-US")} sqft`].filter(Boolean).join(" · ");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e4e9;border-radius:12px;border-collapse:separate;margin:0 0 16px"><tr><td>
${img ? `<a href="${url}"><img src="${esc(img)}" width="566" alt="${esc(l.address)}" style="display:block;width:100%;height:auto;border:0;border-radius:12px 12px 0 0"></a>` : ""}
<div style="padding:14px 16px 16px">
<div style="font-size:21px;font-weight:700">${esc(fmtPrice(l.price))}</div>
<div style="font-size:14px;color:#53575f;margin:2px 0 4px">${esc(facts)}</div>
<div style="font-size:15px">${esc(l.address)}${l.city ? ", " + esc(l.city) : ""}</div>
<a href="${url}" style="display:inline-block;margin-top:12px;background:#d9743f;color:#ffffff;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px">View home</a>
</div></td></tr></table>`;
}

// The email, built once per blast. {{UNSUB}} is swapped per person in sendOne().
export async function buildEmail({ message, listingIds = [] }) {
  const live = await readListings(); // hidden listings never go out
  const cards = listingIds.map((id) => live.find((l) => l.id === id)).filter(Boolean).map(listingCard).join("");
  return `<div style="background:#f6f7f9;padding:24px 12px"><div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px 16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#18191c">
<a href="${SITE}/"><img src="${SITE}/assets/recast-logo-horizontal-black.png" alt="Recast Properties" width="200" height="30" style="display:block;border:0;margin:0 0 22px"></a>
${messageHtml(message)}${cards}
<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e1e4e9;font-size:12px;line-height:1.5;color:#71757e">Recast Properties · ${esc(MAILING_ADDRESS || "[mailing address]")}<br>
You're getting this because you asked to hear about homes from Recast Properties. <a href="{{UNSUB}}" style="color:#71757e">Unsubscribe</a></p>
</div></div>`;
}

// One email to one person (copied from analyst-bridge.mjs sendEmail, plus the
// unsubscribe headers Gmail's own Unsubscribe button uses, and one retry on a
// rate-limit or server error).
export async function sendOne(to, subject, template, contactId) {
  const key = process.env.NYLAS_API_KEY, grant = process.env.NYLAS_GRANT_ID;
  if (!key || !grant) return { ok: false, error: "NYLAS env missing" };
  const unsub = unsubUrl(contactId);
  const body = JSON.stringify({ from: [FROM], reply_to: [FROM], to: [{ email: to }], subject,
    body: template.replaceAll("{{UNSUB}}", unsub),
    custom_headers: [{ name: "List-Unsubscribe", value: `<${unsub}>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }] });
  for (let attempt = 0; ; attempt++) {
    let res;
    // 30s cap: a hung call must not outlast the page's 3-minute "stopped" check,
    // or a Resume could run alongside it. No retry after a timeout (it may have sent).
    try {
      res = await fetch(`https://api.us.nylas.com/v3/grants/${grant}/messages/send`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body, signal: AbortSignal.timeout(30000) });
    } catch (e) { return { ok: false, error: "Nylas no response: " + e.message }; }
    if (res.ok) return { ok: true };
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    return { ok: false, error: `Nylas ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
}
