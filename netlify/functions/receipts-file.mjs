// Serves a stored receipt (attachments + email text) to the viewer page
// (receipts/view.html). The ingest function saves every receipt's files to
// Blobs under file/<msgId>/<n> so links keep working forever, independent of
// Gmail. Auth: x-admin-token == ADMIN_PASSWORD (same as the queue).
//
// POST JSON: { msgId } -> { ok, subject, from, receivedAt, vendor,
//                           files: [{ name, mime, dataBase64 }] }
import { getStore } from "@netlify/blobs";

const clean = (v) => (v == null ? "" : String(v).trim());

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected || (req.headers.get("x-admin-token") || "") !== expected) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  const msgId = clean(body.msgId);
  if (!msgId) return Response.json({ ok: false, error: "Missing msgId" }, { status: 400 });

  try {
    const store = getStore({ name: "receipts-data", consistency: "strong" });
    const env = await store.get("msg/" + msgId, { type: "json" });
    if (!env) return Response.json({ ok: false, error: "No record for this receipt" }, { status: 404 });

    const files = [];
    for (const f of env.files || []) {
      const res = await store.getWithMetadata(f.key, { type: "text" });
      if (!res || res.data == null) continue;
      const mime = clean((res.metadata && res.metadata.contentType) || f.mime) || "application/octet-stream";
      files.push({
        name: clean(f.name) || "receipt",
        mime,
        // Attachments are stored as base64 already; the email body is plain text.
        dataBase64: mime === "text/plain" ? Buffer.from(res.data, "utf8").toString("base64") : res.data,
      });
    }

    return Response.json({
      ok: true,
      subject: clean(env.subject), from: clean(env.from),
      receivedAt: clean(env.receivedAt), vendor: clean(env.vendor),
      gmailUrl: clean(env.gmailUrl), channel: clean(env.channel),
      files,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
  }
};
