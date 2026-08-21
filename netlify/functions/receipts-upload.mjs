// Receipts attachment upload — SYNCHRONOUS function (6 MB request cap).
//
// Background functions (receipts-ingest-background) are async invocations
// with a ~256 KB request limit, so photo/PDF attachments can never ride the
// ingest POST itself (discovered 2026-08-21: every photo receipt 413-bounced).
// The poller instead POSTs each attachment here first; this function parks
// the bytes in Netlify Blobs at "upload/<msgId>/<index>" and the ingest is
// then invoked with tiny blob REFERENCES, reading the bytes back from Blobs.
//
// POST JSON: { token, msgId, index, filename, mimeType, dataBase64 }
//   -> { ok: true, key: "upload/<msgId>/<index>" }
// Auth: body token == RECEIPTS_SHEET_TOKEN (same secret as the ingest).
import { getStore } from "@netlify/blobs";

const clean = (v) => (v == null ? "" : String(v).trim());

export default async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const expected = process.env.RECEIPTS_SHEET_TOKEN || "";
  if (!expected || clean(body.token) !== expected) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const msgId = clean(body.msgId);
  const index = parseInt(body.index, 10);
  const data = clean(body.dataBase64);
  if (!msgId || !Number.isInteger(index) || index < 0 || !data) {
    return Response.json({ ok: false, error: "Missing msgId/index/dataBase64" }, { status: 400 });
  }

  const key = "upload/" + msgId + "/" + index;
  const store = getStore({ name: "receipts-data", consistency: "strong" });
  await store.set(key, data, {
    metadata: { contentType: clean(body.mimeType) || "application/octet-stream", filename: clean(body.filename) },
  });
  return Response.json({ ok: true, key, bytes: data.length });
};
