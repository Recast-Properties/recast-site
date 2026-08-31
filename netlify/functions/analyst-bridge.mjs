// Recast Analyst bridge — the queue between the public /analyze page and the Mac
// watcher that runs analyst-cli (Recast-analyst repo). One function, action-routed.
//
// Public actions:  submit (address+email -> queued), check (id -> state/url)
// Secret actions (ANALYST_BRIDGE_SECRET): claim, status, store-report, complete,
//                                         fail, notify
//
// Rails (Paul declined a password, 2026-08-30): recipient allowlist
// (ANALYST_ALLOWED_EMAILS), daily cap (ANALYST_DAILY_CAP, default 5), and
// same-address dedupe (a report generated in the last 30 days is re-sent, not re-run).
import { getStore } from "@netlify/blobs";

const STORE = "analyst";
const CAP = Number(process.env.ANALYST_DAILY_CAP || 5);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const slugify = (a) => String(a).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const today = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10); // America/Chicago-ish day

function allowedEmail(email) {
  const list = String(process.env.ANALYST_ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email || "").trim().toLowerCase());
}

async function sendEmail(to, subject, html) {
  const key = process.env.NYLAS_API_KEY, grant = process.env.NYLAS_GRANT_ID;
  if (!key || !grant) return { ok: false, error: "NYLAS env missing" };
  const res = await fetch(`https://api.us.nylas.com/v3/grants/${grant}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ to: [{ email: to }], subject, body: html }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, detail: res.ok ? undefined : text.slice(0, 300) };
}

const reportEmail = (address, url) => `
<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#26231F">
<p>Your Recast Analyst report is ready:</p>
<p style="font-size:18px"><b>${address}</b><br>
<a href="${url}">${url}</a></p>
<p style="color:#524C43;font-size:14px">Every figure in the report is drawn from cited sources
(county records, live listing data, recorded market statistics); anything that could not be
verified is listed as such at the bottom of the page.</p>
<p style="color:#7D766B;font-size:13px">— Recast Properties · automated report, link is private to whoever holds it</p></div>`;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const store = getStore({ name: STORE, consistency: "strong" });
  const action = body.action;

  const secretOk = body.secret && body.secret === process.env.ANALYST_BRIDGE_SECRET;
  const needsSecret = ["claim", "status", "store-report", "complete", "fail", "notify"];
  if (needsSecret.includes(action) && !secretOk) return json({ error: "unauthorized" }, 401);

  // ---------- public ----------
  if (action === "submit") {
    const address = String(body.address || "").trim();
    const email = String(body.email || "").trim();
    if (!/\d+.+\d{5}/.test(address)) return json({ error: "Enter a full street address including the ZIP code." }, 400);
    if (!allowedEmail(email)) return json({ error: "That email isn't on the report list. Ask Paul to add it." }, 403);

    const slug = slugify(address);
    const done = await store.get(`done/${slug}`, { type: "json" });
    if (done && done.url && Date.now() - new Date(done.at).getTime() < 30 * 86400000) {
      await sendEmail(email, `Recast Analyst report: ${address}`, reportEmail(address, done.url));
      return json({ status: "existing", url: done.url, note: "A report from the last 30 days exists — emailed you the link." });
    }

    // Belt behind the UI lock: while this email already has 3+ runs in flight,
    // new submissions are refused (a stuck claim re-pools after 2h via claim()).
    const { blobs: qb } = await store.list({ prefix: "queue/" });
    let inFlight = 0;
    for (const b of qb) {
      const q = await store.get(b.key, { type: "json" });
      if (q && q.email?.toLowerCase() === email.toLowerCase()
        && ["queued", "claimed", "running"].includes(q.state)
        && Date.now() - new Date(q.at).getTime() < 3 * 3600 * 1000) inFlight++;
    }
    if (inFlight >= 3) return json({ error: "Reports are already running for this email — wait for them to finish before adding more." }, 429);

    const dayKey = `meta/day-${today()}`;
    const count = (await store.get(dayKey, { type: "json" }))?.n || 0;
    if (count >= CAP) return json({ error: `Daily report cap reached (${CAP}). Try tomorrow or ask Paul.` }, 429);
    await store.setJSON(dayKey, { n: count + 1 });

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await store.setJSON(`queue/${id}`, { id, address, email, slug, state: "queued", at: new Date().toISOString() });
    return json({ status: "queued", id });
  }

  if (action === "check") {
    const r = await store.get(`queue/${body.id}`, { type: "json" });
    if (!r) return json({ error: "unknown id" }, 404);
    return json({ state: r.state, url: r.url || null, detail: r.detail || null });
  }

  // ---------- watcher (secret) ----------
  if (action === "claim") {
    const { blobs } = await store.list({ prefix: "queue/" });
    const reqs = [];
    for (const b of blobs) {
      const r = await store.get(b.key, { type: "json" });
      if (r && r.state === "queued") reqs.push(r);
      // stale claims (watcher died mid-run) go back to the pool after 2h
      else if (r && (r.state === "claimed" || r.state === "running") && Date.now() - new Date(r.claimedAt || r.at).getTime() > 2 * 3600 * 1000) reqs.push({ ...r, state: "queued" });
    }
    if (!reqs.length) return json({ none: true });
    reqs.sort((a, b) => a.at.localeCompare(b.at));
    const r = { ...reqs[0], state: "claimed", claimedAt: new Date().toISOString() };
    await store.setJSON(`queue/${r.id}`, r);
    return json({ request: r });
  }

  if (action === "status") {
    const r = await store.get(`queue/${body.id}`, { type: "json" });
    if (!r) return json({ error: "unknown id" }, 404);
    await store.setJSON(`queue/${body.id}`, { ...r, state: body.status || r.state, detail: body.detail || null });
    return json({ ok: true });
  }

  if (action === "store-report") {
    const file = String(body.file || "");
    if (!/^[a-z0-9-]+\.html$/.test(file)) return json({ error: "bad file name" }, 400);
    if (!body.html || body.html.length > 4 * 1024 * 1024) return json({ error: "bad html" }, 400);
    await store.set(`reports/${file}`, body.html);
    return json({ ok: true, url: `https://recast-properties.com/reports/${file}` });
  }

  if (action === "complete") {
    const r = await store.get(`queue/${body.id}`, { type: "json" });
    if (!r) return json({ error: "unknown id" }, 404);
    await store.setJSON(`queue/${body.id}`, { ...r, state: "done", url: body.url, doneAt: new Date().toISOString() });
    await store.setJSON(`done/${r.slug}`, { url: body.url, at: new Date().toISOString() });
    const mail = await sendEmail(r.email, `Recast Analyst report: ${r.address}`, reportEmail(r.address, body.url));
    return json({ ok: true, mail });
  }

  if (action === "fail") {
    const r = await store.get(`queue/${body.id}`, { type: "json" });
    if (r) {
      await store.setJSON(`queue/${body.id}`, { ...r, state: "failed", detail: String(body.error || "").slice(0, 300) });
      await sendEmail(r.email, `Recast Analyst: report failed for ${r.address}`,
        `<p>The report for <b>${r.address}</b> hit an error and didn't finish. Paul's Mac has the details; ask him to re-run it.</p>`);
    }
    return json({ ok: true });
  }

  if (action === "notify") {
    const mail = await sendEmail(body.to, `Recast Analyst report: ${body.address}`, reportEmail(body.address, body.url));
    return json({ ok: mail.ok, mail });
  }

  return json({ error: "unknown action" }, 400);
};
