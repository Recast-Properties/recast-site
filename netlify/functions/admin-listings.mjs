// Admin listings API (auth required). Reads and writes rows in the Google Sheet
// the public site uses, via a standalone Apps Script web app
// (apps-script/listings-admin.gs) — same shared-secret pattern as call-summary.
//
// Browser -> this function (x-admin-token == ADMIN_PASSWORD)
//         -> Apps Script (?token / body token == its WEBHOOK_SECRET)
//
// Env: LISTINGS_WEBHOOK_URL (the script /exec URL), LISTINGS_WEBHOOK_TOKEN (secret).
//
// POST JSON:
//   { action:"list" }                 -> { ok, headers, rows }
//   { action:"save", listing:{...} }  -> { ok, id }   (upsert by id)
//   { action:"delete", id }           -> { ok }

function authed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return expected && (req.headers.get("x-admin-token") || "") === expected;
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  if (!authed(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const url = process.env.LISTINGS_WEBHOOK_URL;
  const token = process.env.LISTINGS_WEBHOOK_TOKEN;
  if (!url || !token) {
    return Response.json(
      { ok: false, error: "Server not configured: LISTINGS_WEBHOOK_URL / LISTINGS_WEBHOOK_TOKEN missing." },
      { status: 500 }
    );
  }

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  try {
    if (body.action === "list") {
      const res = await fetch(`${url}?token=${encodeURIComponent(token)}`, { redirect: "follow" });
      const data = await res.json();
      return Response.json(data, { status: res.ok ? 200 : 502 });
    }

    if (body.action === "save" || body.action === "delete") {
      const payload = { token, action: body.action === "save" ? "upsert" : "delete" };
      if (body.action === "save") payload.listing = body.listing || {};
      else payload.id = body.id;

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "follow",
      });
      const data = await res.json();
      return Response.json(data, { status: res.ok ? 200 : 502 });
    }

    return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 502 });
  }
};
