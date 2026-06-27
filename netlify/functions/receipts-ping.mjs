// Lightweight auth check for the receipts queue login screen. Returns ok only
// when the supplied x-admin-token matches ADMIN_PASSWORD (shared with /admin).
// No side effects.
export default async (req) => {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) {
    return Response.json({ ok: false, error: "Admin password not set on server." }, { status: 500 });
  }
  const ok = (req.headers.get("x-admin-token") || "") === expected;
  return Response.json({ ok }, { status: ok ? 200 : 401 });
};
