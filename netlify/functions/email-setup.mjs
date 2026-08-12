// Email Setup — create a property email address in one shot:
//   1. Workspace alias on the chosen mailbox   (Admin Directory API, as GOOGLE_ADMIN_USER)
//   2. Gmail label named after the alias       (Gmail API, as the mailbox)
//   3. Filter: to:<alias> -> label, skip inbox (Gmail API, as the mailbox)
//
// Auth in:  x-admin-token header == ADMIN_PASSWORD (same as every /admin function).
// Auth out: Google service account with DOMAIN-WIDE DELEGATION. We hand-roll the
//   RS256 JWT -> access-token exchange with native crypto (no googleapis dep),
//   impersonating GOOGLE_ADMIN_USER for the Directory call and the target mailbox
//   for the Gmail calls. DWD scopes that must be authorized in admin.google.com:
//     https://www.googleapis.com/auth/admin.directory.user.alias
//     https://www.googleapis.com/auth/gmail.labels
//     https://www.googleapis.com/auth/gmail.settings.basic
//
// POST contract:
//   { action:"list",   mailbox }        -> { ok, aliases:[...], protectedAliases:[...] }
//   { action:"create", mailbox, alias } -> { ok, steps:[{name, ok, detail}] }
//   { action:"remove", mailbox, alias } -> { ok, steps:[{name, ok, detail}] }
//     ok is true only if ALL steps succeeded; steps always reports each one.
//     Safe to re-run: create treats existing alias on the SAME mailbox / existing
//     label / existing filter as success; remove treats already-gone as success.
//     remove refuses PROTECTED aliases (in-use sending addresses).
//
// Env: ADMIN_PASSWORD, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY (PEM; \n-escaped ok),
//      GOOGLE_ADMIN_USER (super-admin, e.g. paul@recast-properties.com)

import crypto from "node:crypto";

const DOMAIN = "recast-properties.com";
// Fail-closed allowlist: the only mailboxes this tool may touch.
const MAILBOXES = [`paul@${DOMAIN}`, `properties@${DOMAIN}`];
// Aliases that must never be removed: info@ is the FROM address for the
// call-summary and seller-confirmation emails (apps-script/call-summary.gs).
const PROTECTED = [`info@${DOMAIN}`];

const DIR = "https://admin.googleapis.com/admin/directory/v1";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE_ALIAS = "https://www.googleapis.com/auth/admin.directory.user.alias";
const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.settings.basic";

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}

// ---- service-account token (JWT bearer grant, impersonating `sub`) ----
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Rebuild a proper PEM no matter how the key was pasted into the env var:
// full PEM with real newlines, \n-escaped one-liner, or bare base64 body.
function pemFromEnv(raw) {
  const b64 = String(raw || "")
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  if (!b64) return "";
  return "-----BEGIN PRIVATE KEY-----\n" + b64.match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n";
}
const tokenCache = new Map(); // `${sub}|${scope}` -> { accessToken, exp }

async function accessToken(sub, scope) {
  const key = sub + "|" + scope;
  const hit = tokenCache.get(key);
  const now = Math.floor(Date.now() / 1000);
  if (hit && hit.exp - 60 > now) return hit.accessToken;

  const saEmail = process.env.GOOGLE_SA_EMAIL || "";
  const saKey = pemFromEnv(process.env.GOOGLE_SA_KEY);
  if (!saEmail || !saKey) throw new Error("Service account not configured (GOOGLE_SA_EMAIL / GOOGLE_SA_KEY).");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: saEmail, sub, scope, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(header + "." + claims);
  const jwt = header + "." + claims + "." + signer.sign(saKey, "base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Surface Google's reason — this is where a missing DWD grant shows up.
    throw new Error("Google token exchange failed for " + sub + ": " +
      (data.error_description || data.error || res.status));
  }
  tokenCache.set(key, { accessToken: data.access_token, exp: now + (data.expires_in || 3600) });
  return data.access_token;
}

async function gapi(sub, scope, method, url, body) {
  const tok = await accessToken(sub, scope);
  const res = await fetch(url, {
    method,
    headers: { authorization: "Bearer " + tok, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

const gErr = (r) => (r.data && r.data.error && r.data.error.message) || ("HTTP " + r.status);

// ---- steps ----
async function listAliases(mailbox) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  if (!admin) throw new Error("GOOGLE_ADMIN_USER not configured.");
  const r = await gapi(admin, SCOPE_ALIAS, "GET", `${DIR}/users/${encodeURIComponent(mailbox)}/aliases`);
  if (!r.ok) throw new Error("Couldn't list aliases: " + gErr(r));
  return (r.data.aliases || []).map((a) => a.alias).sort();
}

async function createAlias(mailbox, fullAlias) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  if (!admin) return { ok: false, detail: "GOOGLE_ADMIN_USER not configured." };
  const r = await gapi(admin, SCOPE_ALIAS, "POST",
    `${DIR}/users/${encodeURIComponent(mailbox)}/aliases`, { alias: fullAlias });
  if (r.ok) return { ok: true, detail: fullAlias };
  if (r.status === 409) {
    // Already exists somewhere — name the owner so the fix is obvious.
    const who = await gapi(admin, SCOPE_ALIAS, "GET", `${DIR}/users/${encodeURIComponent(fullAlias)}/aliases`)
      .catch(() => null);
    const owned = who && who.ok && (who.data.aliases || []).some((a) => a.alias === fullAlias);
    // The aliases endpoint resolves an alias to its owning user; primaryEmail comes back on each row.
    const owner = owned ? (who.data.aliases.find((a) => a.alias === fullAlias) || {}).primaryEmail : null;
    if (owner === mailbox) return { ok: true, detail: "already on " + mailbox + " — kept as is" };
    return { ok: false, detail: "already assigned to " + (owner || "another user") + " — remove it there first, then re-run" };
  }
  return { ok: false, detail: gErr(r) };
}

async function createLabel(mailbox, name) {
  const r = await gapi(mailbox, SCOPE_GMAIL, "POST", `${GMAIL}/labels`,
    { name, labelListVisibility: "labelShow", messageListVisibility: "show" });
  if (r.ok) return { ok: true, id: r.data.id, detail: "label \"" + name + "\"" };
  if (r.status === 409) {
    // Exists — find its id so the filter step can still attach to it.
    const all = await gapi(mailbox, SCOPE_GMAIL, "GET", `${GMAIL}/labels`);
    const found = all.ok && (all.data.labels || []).find((l) => l.name === name);
    if (found) return { ok: true, id: found.id, detail: "label \"" + name + "\" already existed — kept as is" };
  }
  return { ok: false, detail: gErr(r) };
}

async function createFilter(mailbox, fullAlias, labelId) {
  const r = await gapi(mailbox, SCOPE_GMAIL, "POST", `${GMAIL}/settings/filters`, {
    criteria: { to: fullAlias },
    action: { addLabelIds: [labelId], removeLabelIds: ["INBOX"] },
  });
  if (r.ok) return { ok: true, detail: "to:" + fullAlias + " → label, skip inbox" };
  if (r.status === 400 && /already exists/i.test(gErr(r))) {
    return { ok: true, detail: "filter already existed — kept as is" };
  }
  return { ok: false, detail: gErr(r) };
}

// ---- removal steps (reverse order of create: filter -> label -> alias, so a
// label is never deleted out from under a filter that still references it) ----
async function removeFilter(mailbox, fullAlias) {
  const all = await gapi(mailbox, SCOPE_GMAIL, "GET", `${GMAIL}/settings/filters`);
  if (!all.ok) return { ok: false, detail: "couldn't list filters: " + gErr(all) };
  const matches = (all.data.filter || []).filter((f) => f.criteria && f.criteria.to === fullAlias);
  if (!matches.length) return { ok: true, detail: "no filter found — nothing to remove" };
  for (const f of matches) {
    const r = await gapi(mailbox, SCOPE_GMAIL, "DELETE", `${GMAIL}/settings/filters/${encodeURIComponent(f.id)}`);
    if (!r.ok) return { ok: false, detail: gErr(r) };
  }
  return { ok: true, detail: "removed to:" + fullAlias + " filter" + (matches.length > 1 ? "s (" + matches.length + ")" : "") };
}

async function removeLabel(mailbox, name) {
  const all = await gapi(mailbox, SCOPE_GMAIL, "GET", `${GMAIL}/labels`);
  if (!all.ok) return { ok: false, detail: "couldn't list labels: " + gErr(all) };
  const found = (all.data.labels || []).find((l) => l.name === name);
  if (!found) return { ok: true, detail: "no label found — nothing to remove" };
  const r = await gapi(mailbox, SCOPE_GMAIL, "DELETE", `${GMAIL}/labels/${encodeURIComponent(found.id)}`);
  if (r.ok || r.status === 404) return { ok: true, detail: "removed label \"" + name + "\" (messages keep their mail, lose the grouping)" };
  return { ok: false, detail: gErr(r) };
}

async function removeAlias(mailbox, fullAlias) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  if (!admin) return { ok: false, detail: "GOOGLE_ADMIN_USER not configured." };
  const r = await gapi(admin, SCOPE_ALIAS, "DELETE",
    `${DIR}/users/${encodeURIComponent(mailbox)}/aliases/${encodeURIComponent(fullAlias)}`);
  if (r.ok) return { ok: true, detail: fullAlias + " removed — mail to it now bounces" };
  if (r.status === 404) {
    // Not on this mailbox — is it on the other one? Same owner lookup create uses.
    const who = await gapi(admin, SCOPE_ALIAS, "GET", `${DIR}/users/${encodeURIComponent(fullAlias)}/aliases`)
      .catch(() => null);
    const owned = who && who.ok && (who.data.aliases || []).some((a) => a.alias === fullAlias);
    const owner = owned ? (who.data.aliases.find((a) => a.alias === fullAlias) || {}).primaryEmail : null;
    if (owner && owner !== mailbox) return { ok: false, detail: "belongs to " + owner + " — switch the mailbox and re-run" };
    return { ok: true, detail: "didn't exist — nothing to remove" };
  }
  return { ok: false, detail: gErr(r) };
}

// ---- handler ----
export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!authed(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const mailbox = String(body.mailbox || "");
  if (!MAILBOXES.includes(mailbox)) {
    return Response.json({ ok: false, error: "Unknown mailbox. Allowed: " + MAILBOXES.join(", ") }, { status: 400 });
  }

  try {
    if (body.action === "list") {
      return Response.json({ ok: true, aliases: await listAliases(mailbox), protectedAliases: PROTECTED });
    }

    if (body.action === "create") {
      const alias = String(body.alias || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!alias) return Response.json({ ok: false, error: "Alias required (letters/digits)." }, { status: 400 });
      const fullAlias = alias + "@" + DOMAIN;
      const steps = [];

      const aliasStep = await createAlias(mailbox, fullAlias);
      steps.push({ name: "Workspace alias", ok: aliasStep.ok, detail: aliasStep.detail });

      const labelStep = aliasStep.ok
        ? await createLabel(mailbox, alias)
        : { ok: false, detail: "skipped — alias step failed" };
      steps.push({ name: "Gmail label", ok: labelStep.ok, detail: labelStep.detail });

      const filterStep = labelStep.ok
        ? await createFilter(mailbox, fullAlias, labelStep.id)
        : { ok: false, detail: aliasStep.ok ? "skipped — no label to attach" : "skipped — alias step failed" };
      steps.push({ name: "Skip-inbox filter", ok: filterStep.ok, detail: filterStep.detail });

      return Response.json({ ok: steps.every((s) => s.ok), steps });
    }

    if (body.action === "remove") {
      const alias = String(body.alias || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!alias) return Response.json({ ok: false, error: "Alias required (letters/digits)." }, { status: 400 });
      const fullAlias = alias + "@" + DOMAIN;
      if (PROTECTED.includes(fullAlias)) {
        return Response.json({ ok: false, error: fullAlias + " is protected — it's an in-use sending address." }, { status: 400 });
      }
      const steps = [];

      const filterStep = await removeFilter(mailbox, fullAlias);
      steps.push({ name: "Skip-inbox filter", ok: filterStep.ok, detail: filterStep.detail });

      const labelStep = filterStep.ok
        ? await removeLabel(mailbox, alias)
        : { ok: false, detail: "skipped — remove the filter first (it references the label)" };
      steps.push({ name: "Gmail label", ok: labelStep.ok, detail: labelStep.detail });

      const aliasStep = labelStep.ok
        ? await removeAlias(mailbox, fullAlias)
        : { ok: false, detail: "skipped — earlier step failed" };
      steps.push({ name: "Workspace alias", ok: aliasStep.ok, detail: aliasStep.detail });

      return Response.json({ ok: steps.every((s) => s.ok), steps });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
