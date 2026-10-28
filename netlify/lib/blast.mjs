// Email blasts: who gets one, the email itself, and the send.
// Sends through the same Nylas grant (paul@) analyst-bridge.mjs uses, from the
// info@ alias, one email per person. Blast records: Blobs store "crm-blasts",
// one key per blast. Used by admin-blast.mjs and admin-blast-send-background.mjs.
import { getStore } from "@netlify/blobs";
import { readListings, esc, fmtPrice, canonicalFor, SITE } from "./listings.mjs";

export const blastsStore = () => getStore({ name: "crm-blasts", consistency: "strong" });
export const TEST_TO = "paul@recast-properties.com";
const FROM = { name: "Recast Properties", email: "info@recast-properties.com" };
// Every marketing email must carry a postal address (CAN-SPAM). Real sends are
// refused while this is blank; test sends show a placeholder.
export const MAILING_ADDRESS = "";

// Who gets a blast: has an email, isn't unsubscribed, didn't choose text-only.
export const recipientsOf = (contacts) => contacts.filter((c) => c.email && !c.unsubscribed && c.prefers !== "text");

const unsubUrl = (contactId) => `${SITE}/unsubscribe?id=${encodeURIComponent(contactId)}`;

// ---- The email: the site's look (colors_and_type.css), in email-safe inline styles ----
const C = { paper: "#FBF8F4", ink: "#18191C", body: "#3A3D44", muted: "#53575F", subtle: "#71757E",
  line: "#E1E4E9", brandDeep: "#DC8244", tint: "#FDF6EF", tintLine: "#F6D9BF" };
// Poppins/Mulish load where the mail app allows web fonts (Apple Mail, iOS); others fall back.
const HEAD = "font-family:Poppins,'Segoe UI',Arial,Helvetica,sans-serif";
const BODY = "font-family:Mulish,'Segoe UI',Arial,Helvetica,sans-serif";
// Who to call when a listing leaves agentName/agentPhone blank: mirrors window.RECAST_AGENT in homes/data.js.
const DEFAULT_AGENT = { name: "Dennis Little", phone: "214.906.4994" };
const STATUS = { available: ["Available", "#ECF6F0", "#2C6E4C"], pending: ["Pending", "#FCF3E2", "#9C6E15"], sold: ["Sold", "#EFF1F4", "#53575F"] };

// Typed message -> HTML: escaped, blank line = new paragraph, links clickable.
function messageHtml(text) {
  return String(text || "").trim().split(/\n\s*\n/).filter(Boolean).map((p) =>
    `<p style="margin:0 0 14px">` + esc(p)
      .replace(/https?:\/\/[^\s<]*[^\s<.,!?)]/g, (u) => `<a href="${u}" style="color:${C.brandDeep}">${u}</a>`)
      .replace(/\n/g, "<br>") + "</p>").join("");
}

// Photo i (0-based) cropped to w x h through the Image CDN, as JPG (email apps don't all do WebP).
function img(l, i, w, h) {
  if (l.photos.length) return l.photos[i] || "";
  return `${SITE}/.netlify/images?url=${encodeURIComponent(`/photos/${l.photoFolder}/${i + 1}.jpg`)}&w=${w}&h=${h}&fit=cover&fm=jpg&q=75`;
}
// How many photos a listing has (same count photos-list.mjs gives the gallery).
async function photoCount(l) {
  if (l.photos.length) return l.photos.length;
  if (!l.photoFolder) return 0;
  const { blobs } = await getStore("listing-photos").list({ prefix: l.photoFolder + "/" });
  const nums = new Set(blobs.map((b) => b.key.slice(l.photoFolder.length + 1))
    .filter((k) => /^\d+\.jpg$/.test(k)).map((k) => parseInt(k, 10)));
  let n = 0;
  while (nums.has(n + 1)) n++;
  return n;
}

// One listing, laid out like a cut-down /homes/<id> page.
function listingSection(l, count) {
  const url = canonicalFor(l);
  const photo = (i, w, h, radius) => `<a href="${url}"><img src="${esc(img(l, i, w, h))}" width="${w / 2}" alt="${esc(l.address)}" style="display:block;width:100%;height:auto;border:0;border-radius:${radius}px"></a>`;
  const [label, pillBg, pillFg] = STATUS[l.status] || STATUS.available;
  const facts = [[l.beds, "Bedrooms"], [l.baths, "Bathrooms"], [l.sqft && Number(l.sqft).toLocaleString("en-US"), "Sq ft"],
    [l.lot !== "—" && l.lot, "Lot size"], [l.year !== "—" && l.year, "Year built"], [l.type, "Type"]].filter(([v]) => v);
  const cell = ([v, k], i) => `<td width="33%" valign="top" style="padding:12px 14px;${i % 3 ? `border-left:1px solid ${C.line};` : ""}${i > 2 ? `border-top:1px solid ${C.line};` : ""}">
<div style="${HEAD};font-size:17px;font-weight:600;color:${C.ink}">${esc(v)}</div><div style="${BODY};font-size:12px;color:${C.subtle}">${k}</div></td>`;
  const rows = [];
  for (let i = 0; i < facts.length; i += 3) rows.push(`<tr>${facts.slice(i, i + 3).map((f, j) => cell(f, i + j)).join("")}</tr>`);
  const agent = l.agentPhone ? { name: l.agentName, phone: l.agentPhone } : DEFAULT_AGENT;
  const h3 = (t) => `<h3 style="${HEAD};font-size:18px;font-weight:600;color:${C.ink};margin:26px 0 8px">${t}</h3>`;

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${C.line};border-radius:16px;border-collapse:separate;margin:0 0 20px"><tr><td style="padding:22px 20px 24px">
<h2 style="${HEAD};font-size:24px;line-height:1.2;font-weight:600;margin:0"><a href="${url}" style="color:${C.ink};text-decoration:none">${esc(l.address)}</a></h2>
<div style="${BODY};font-size:14px;color:${C.muted};margin:4px 0 16px">${esc([l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "))}</div>
${count ? photo(0, 1120, 746, 12) : ""}
${count >= 3 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px"><tr>
<td width="50%" style="padding-right:4px">${photo(1, 556, 370, 10)}</td><td width="50%" style="padding-left:4px">${photo(2, 556, 370, 10)}</td></tr></table>` : ""}
${count > 3 ? `<div style="${BODY};font-size:13.5px;font-weight:700;margin-top:8px"><a href="${url}" style="color:${C.brandDeep};text-decoration:none">See all ${count} photos →</a></div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>
<td valign="bottom"><div style="${BODY};font-size:12.5px;color:${C.subtle}">Asking price</div>
<div style="${HEAD};font-size:30px;line-height:1.15;font-weight:700;color:${C.ink}">${esc(fmtPrice(l.price))}</div></td>
<td valign="bottom" align="right"><span style="display:inline-block;${BODY};font-size:12.5px;font-weight:700;background:${pillBg};color:${pillFg};border-radius:999px;padding:5px 11px">&#9679; ${label}</span></td></tr></table>
${l.tagline ? `<div style="${BODY};font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${C.ink};margin:22px 0 0">${esc(l.tagline)}</div>` : ""}
${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border:1px solid ${C.line};border-radius:12px;border-collapse:separate">${rows.join("")}</table>` : ""}
${l.description ? h3("About this home") + String(l.description).split(/\n+/).filter((p) => p.trim()).map((p) =>
  `<p style="${BODY};font-size:15px;line-height:1.65;color:${C.body};margin:0 0 12px">${esc(p.trim())}</p>`).join("") : ""}
${l.highlights.length ? h3("Highlights") + `<div>${l.highlights.map((h) =>
  `<span style="display:inline-block;${BODY};font-size:13px;font-weight:700;color:${C.ink};background:${C.tint};border:1px solid ${C.tintLine};border-radius:999px;padding:6px 12px;margin:0 6px 8px 0">&#10003; ${esc(h)}</span>`).join("")}</div>` : ""}
<a href="${url}" style="display:block;margin-top:20px;text-align:center;background:${C.brandDeep};color:#ffffff;${HEAD};font-size:16px;font-weight:600;text-decoration:none;padding:14px 18px;border-radius:12px">View the full listing</a>
<div style="${BODY};font-size:14px;color:${C.muted};text-align:center;margin-top:12px">Call for a showing:
<a href="tel:${agent.phone.replace(/\D/g, "")}" style="color:${C.ink};font-weight:700;text-decoration:none">${esc([agent.name, agent.phone].filter(Boolean).join(" · "))}</a></div>
</td></tr></table>`;
}

// The email, built once per blast. {{UNSUB}} is swapped per person in sendOne().
export async function buildEmail({ message, listingIds = [] }) {
  const live = await readListings(); // hidden listings never go out
  const picked = listingIds.map((id) => live.find((l) => l.id === id)).filter(Boolean);
  const counts = await Promise.all(picked.map(photoCount));
  const msg = messageHtml(message);
  // The grey line inboxes show after the subject: the start of the message.
  const preheader = esc(String(message || "").replace(/\s+/g, " ").trim().slice(0, 140));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><link href="https://fonts.googleapis.com/css2?family=Mulish:wght@400;700;800&family=Poppins:wght@600;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${C.paper}">
<div style="display:none;max-height:0;overflow:hidden">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:0 12px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:28px 4px 18px"><a href="${SITE}/" style="text-decoration:none"><img src="${SITE}/assets/recast-mark-orange-transparent.png" alt="" width="28" height="28" style="vertical-align:middle;border:0">
<span style="${HEAD};font-size:19px;font-weight:700;color:${C.ink};vertical-align:middle;margin-left:6px">Recast Properties</span></a></td></tr>
${msg ? `<tr><td style="background:#ffffff;border:1px solid ${C.line};border-radius:16px;padding:22px 20px 8px;${BODY};font-size:16px;line-height:1.6;color:${C.ink}">${msg}</td></tr>
<tr><td style="height:20px;line-height:20px;font-size:0">&nbsp;</td></tr>` : ""}
${picked.map((l, i) => `<tr><td>${listingSection(l, counts[i])}</td></tr>`).join("")}
<tr><td style="padding:12px 8px 0;text-align:center;${BODY};font-size:12px;line-height:1.6;color:${C.subtle}">
Recast Properties · ${esc(MAILING_ADDRESS || "[mailing address]")}<br>
You're getting this because you asked to hear about homes from Recast Properties.<br>
<a href="{{UNSUB}}" style="color:${C.subtle}">Unsubscribe</a> · <a href="${SITE}/" style="color:${C.subtle}">recast-properties.com</a></td></tr>
</table></td></tr></table></body></html>`;
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
