// Admin sign-in. Every admin page sends one key as the x-admin-token header:
//  - the shared ADMIN_PASSWORD (Paul — the only key that can add or remove people), or
//  - a person's own sign-in key from their emailed link. Blobs store "admin-users",
//    ONE KEY PER PERSON (key = their sign-in key, value = { name, email, addedAt }).
//    Deleting the record signs them out everywhere.
import { getStore } from "@netlify/blobs";

export const usersStore = () => getStore({ name: "admin-users", consistency: "strong" });

export function isOwner(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  return !!expected && (req.headers.get("x-admin-token") || "") === expected;
}

export async function authed(req) {
  if (isOwner(req)) return true;
  const key = req.headers.get("x-admin-token") || "";
  return /^[a-f0-9]{64}$/.test(key) && !!(await usersStore().get(key));
}
