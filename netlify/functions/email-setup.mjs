// Email Setup — create/remove a property email address in one shot.
//
// TWO MODELS, keyed by the mailbox (mirrors how each account was historically set up):
//   paul@       ALIAS model: Workspace alias on the user + Gmail label (named after
//               the alias) + filter to:<alias> -> label, skip inbox.
//   properties@ GROUP model (matches the retired Apps Script "Add Property Email"):
//               a Google GROUP <alias>@ (name = the human property label) with
//               external posting allowed, properties@ as a MEMBER, plus a Gmail
//               label (named the property label) in properties@ and a filter
//               query:<groupEmail> -> label, skip inbox AND spam.
//
// Auth in:  x-admin-token header == ADMIN_PASSWORD (same as every /admin function).
// Auth out: Google service account with DOMAIN-WIDE DELEGATION. We hand-roll the
//   RS256 JWT -> access-token exchange with native crypto (no googleapis dep),
//   impersonating GOOGLE_ADMIN_USER for Directory/Groups calls and the target
//   mailbox for the Gmail calls. DWD scopes that must be authorized in
//   admin.google.com (Security -> API controls -> Domain-wide delegation):
//     https://www.googleapis.com/auth/admin.directory.user.alias
//     https://www.googleapis.com/auth/gmail.labels
//     https://www.googleapis.com/auth/gmail.settings.basic
//     https://www.googleapis.com/auth/admin.directory.group        (group model)
//     https://www.googleapis.com/auth/apps.groups.settings         (group model)
//   The group model also needs the "Groups Settings API" enabled on the SA's
//   GCP project (Admin SDK is already on).
//
// POST contract:
//   { action:"list",   mailbox }               -> { ok, mode, entries:[{address,name}], protectedAliases }
//   { action:"create", mailbox, alias, label } -> { ok, steps:[{name, ok, detail}] }   (label: group model only)
//   { action:"remove", mailbox, alias }        -> { ok, steps:[{name, ok, detail}] }
//     ok is true only if ALL steps succeeded; steps always reports each one.
//     Safe to re-run: already-existing (create) / already-gone (remove) pieces
//     count as success. remove refuses PROTECTED addresses.
//
// Env: ADMIN_PASSWORD, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY (PEM; \n-escaped ok),
//      GOOGLE_ADMIN_USER (super-admin, e.g. paul@recast-properties.com)

import crypto from "node:crypto";

const DOMAIN = "recast-properties.com";
// Fail-closed allowlist: the only mailboxes this tool may touch.
const MAILBOXES = [`paul@${DOMAIN}`, `properties@${DOMAIN}`];
// Mailboxes whose property emails are Google GROUPS delivering to the mailbox
// (the properties@ model), not Workspace aliases on the user.
const GROUP_MAILBOXES = [`properties@${DOMAIN}`];
const isGroupMode = (mailbox) => GROUP_MAILBOXES.includes(mailbox);
// Addresses that must never be removed: info@ is the FROM address for the
// call-summary and seller-confirmation emails (apps-script/call-summary.gs).
const PROTECTED = [`info@${DOMAIN}`];

const DIR = "https://admin.googleapis.com/admin/directory/v1";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GSETTINGS = "https://www.googleapis.com/groups/v1/groups";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE_ALIAS = "https://www.googleapis.com/auth/admin.directory.user.alias";
const SCOPE_GROUP = "https://www.googleapis.com/auth/admin.directory.group";
const SCOPE_GSET = "https://www.googleapis.com/auth/apps.groups.settings";
const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.settings.basic";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function createFilter(mailbox, fullAlias, labelId, groupMode) {
  // Alias model filters on to:<alias>; the group model (matching the old Apps
  // Script) filters on query:<groupEmail> and also keeps group mail out of spam.
  const r = await gapi(mailbox, SCOPE_GMAIL, "POST", `${GMAIL}/settings/filters`, groupMode ? {
    criteria: { query: fullAlias },
    action: { addLabelIds: [labelId], removeLabelIds: ["INBOX", "SPAM"] },
  } : {
    criteria: { to: fullAlias },
    action: { addLabelIds: [labelId], removeLabelIds: ["INBOX"] },
  });
  if (r.ok) return { ok: true, detail: (groupMode ? "query:" : "to:") + fullAlias + " → label, skip inbox" + (groupMode ? " & spam" : "") };
  if (r.status === 400 && /already exists/i.test(gErr(r))) {
    return { ok: true, detail: "filter already existed — kept as is" };
  }
  return { ok: false, detail: gErr(r) };
}

// ---- group-model steps (properties@ — mirrors apps-script "Add Property Email") ----
async function getGroup(fullAlias) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  const r = await gapi(admin, SCOPE_GROUP, "GET", `${DIR}/groups/${encodeURIComponent(fullAlias)}`);
  return r.ok ? r.data : null;
}

async function listGroups(mailbox) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  if (!admin) throw new Error("GOOGLE_ADMIN_USER not configured.");
  const r = await gapi(admin, SCOPE_GROUP, "GET", `${DIR}/groups?userKey=${encodeURIComponent(mailbox)}&maxResults=200`);
  if (!r.ok) throw new Error("Couldn't list groups: " + gErr(r));
  return (r.data.groups || [])
    .map((g) => ({ address: g.email, name: g.name || "" }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

async function createGroup(fullAlias, label) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  if (!admin) return { ok: false, detail: "GOOGLE_ADMIN_USER not configured." };
  const r = await gapi(admin, SCOPE_GROUP, "POST", `${DIR}/groups`, {
    email: fullAlias, name: label,
    description: "Receipts and correspondence for " + label + ".",
  });
  if (r.ok) return { ok: true, created: true, detail: "group " + fullAlias + " (\"" + label + "\")" };
  if (r.status === 409) {
    const existing = await getGroup(fullAlias);
    if (existing) return { ok: true, created: false, detail: "group already existed — kept as is" };
    return { ok: false, detail: "address already in use (not as a group) — is it an alias on a user?" };
  }
  return { ok: false, detail: gErr(r) };
}

async function setGroupSettings(fullAlias, justCreated) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  // A fresh group can take a few seconds to provision; retry instead of a blind sleep.
  for (let attempt = 1; ; attempt++) {
    const r = await gapi(admin, SCOPE_GSET, "PATCH", `${GSETTINGS}/${encodeURIComponent(fullAlias)}?alt=json`, {
      whoCanPostMessage: "ANYONE_CAN_POST",
      messageModerationLevel: "MODERATE_NONE",
      spamModerationLevel: "ALLOW",
      whoCanJoin: "INVITED_CAN_JOIN",
    });
    if (r.ok) return { ok: true, detail: "external senders allowed, no moderation" };
    if (justCreated && r.status === 404 && attempt < 4) { await sleep(1500); continue; }
    return { ok: false, detail: gErr(r) };
  }
}

async function addMember(fullAlias, memberEmail) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  const r = await gapi(admin, SCOPE_GROUP, "POST",
    `${DIR}/groups/${encodeURIComponent(fullAlias)}/members`, { email: memberEmail, role: "MEMBER" });
  if (r.ok) return { ok: true, detail: memberEmail + " added as member" };
  if (r.status === 409) return { ok: true, detail: memberEmail + " already a member — kept as is" };
  return { ok: false, detail: gErr(r) };
}

async function removeGroup(fullAlias) {
  const admin = process.env.GOOGLE_ADMIN_USER || "";
  if (!admin) return { ok: false, detail: "GOOGLE_ADMIN_USER not configured." };
  const r = await gapi(admin, SCOPE_GROUP, "DELETE", `${DIR}/groups/${encodeURIComponent(fullAlias)}`);
  if (r.ok || r.status === 404) {
    return { ok: true, detail: r.status === 404 ? "didn't exist — nothing to remove" : fullAlias + " deleted — mail to it now bounces" };
  }
  return { ok: false, detail: gErr(r) };
}

// ---- removal steps (reverse order of create: filter -> label -> alias, so a
// label is never deleted out from under a filter that still references it) ----
async function removeFilter(mailbox, fullAlias) {
  const all = await gapi(mailbox, SCOPE_GMAIL, "GET", `${GMAIL}/settings/filters`);
  if (!all.ok) return { ok: false, detail: "couldn't list filters: " + gErr(all) };
  const matches = (all.data.filter || []).filter((f) =>
    f.criteria && (f.criteria.to === fullAlias || f.criteria.query === fullAlias));
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

  const groupMode = isGroupMode(mailbox);

  try {
    if (body.action === "list") {
      const entries = groupMode
        ? await listGroups(mailbox)
        : (await listAliases(mailbox)).map((a) => ({ address: a, name: "" }));
      return Response.json({
        ok: true,
        mode: groupMode ? "group" : "alias",
        entries,
        // kept for anything still reading the old shape
        aliases: entries.map((e) => e.address),
        protectedAliases: PROTECTED,
      });
    }

    if (body.action === "create") {
      const alias = String(body.alias || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!alias) return Response.json({ ok: false, error: "Alias required (letters/digits)." }, { status: 400 });
      const fullAlias = alias + "@" + DOMAIN;
      const steps = [];

      if (groupMode) {
        const label = String(body.label || "").trim();
        if (!label) return Response.json({ ok: false, error: "Property name (label) required for " + mailbox + "." }, { status: 400 });

        const groupStep = await createGroup(fullAlias, label);
        steps.push({ name: "Google Group", ok: groupStep.ok, detail: groupStep.detail });

        // Group-create failure blocks everything; the rest run independently so a
        // re-run can repair any single failed piece.
        const skipped = { ok: false, detail: "skipped — group step failed" };
        const setStep = groupStep.ok ? await setGroupSettings(fullAlias, groupStep.created) : skipped;
        steps.push({ name: "Group settings", ok: setStep.ok, detail: setStep.detail });

        const memberStep = groupStep.ok ? await addMember(fullAlias, mailbox) : skipped;
        steps.push({ name: "Mailbox member", ok: memberStep.ok, detail: memberStep.detail });

        const labelStep = groupStep.ok ? await createLabel(mailbox, label) : skipped;
        steps.push({ name: "Gmail label", ok: labelStep.ok, detail: labelStep.detail });

        const filterStep = labelStep.ok
          ? await createFilter(mailbox, fullAlias, labelStep.id, true)
          : { ok: false, detail: groupStep.ok ? "skipped — no label to attach" : "skipped — group step failed" };
        steps.push({ name: "Skip-inbox filter", ok: filterStep.ok, detail: filterStep.detail });
      } else {
        const aliasStep = await createAlias(mailbox, fullAlias);
        steps.push({ name: "Workspace alias", ok: aliasStep.ok, detail: aliasStep.detail });

        const labelStep = aliasStep.ok
          ? await createLabel(mailbox, alias)
          : { ok: false, detail: "skipped — alias step failed" };
        steps.push({ name: "Gmail label", ok: labelStep.ok, detail: labelStep.detail });

        const filterStep = labelStep.ok
          ? await createFilter(mailbox, fullAlias, labelStep.id, false)
          : { ok: false, detail: aliasStep.ok ? "skipped — no label to attach" : "skipped — alias step failed" };
        steps.push({ name: "Skip-inbox filter", ok: filterStep.ok, detail: filterStep.detail });
      }

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

      if (groupMode) {
        // Look the group up first: its name is the Gmail label name.
        const group = await getGroup(fullAlias);

        const filterStep = await removeFilter(mailbox, fullAlias);
        steps.push({ name: "Skip-inbox filter", ok: filterStep.ok, detail: filterStep.detail });

        const labelStep = group
          ? await removeLabel(mailbox, group.name || alias)
          : { ok: true, detail: "group not found — no label name to look up" };
        steps.push({ name: "Gmail label", ok: labelStep.ok, detail: labelStep.detail });

        const groupStep = await removeGroup(fullAlias);
        steps.push({ name: "Google Group", ok: groupStep.ok, detail: groupStep.detail });
      } else {
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
      }

      return Response.json({ ok: steps.every((s) => s.ok), steps });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
