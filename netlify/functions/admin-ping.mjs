// Lightweight auth check for the admin login screen. Returns ok when the
// supplied x-admin-token is the admin password or a person's sign-in key
// (lib/admin-auth.mjs); owner = true only for the password. No side effects.
import { authed, isOwner } from "../lib/admin-auth.mjs";

export default async (req) => {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ ok: false, error: "Admin password not set on server." }, { status: 500 });
  }
  const ok = await authed(req);
  return Response.json({ ok, owner: ok && isOwner(req) }, { status: ok ? 200 : 401 });
};
