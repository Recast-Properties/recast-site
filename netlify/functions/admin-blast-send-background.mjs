// Sends one email blast, started by admin-blast.mjs ("send" / "resume").
// A background function: runs up to 15 minutes and keeps going if the admin
// page is closed. Saves progress after every email (`next` = how far it got),
// so the page can show "Sent 20 of 37" and a resume never re-sends anyone.
// ponytail: ~1 email/sec, so ~900 people per run; past that, Resume continues.
import { blastsStore, buildEmail, sendOne } from "../lib/blast.mjs";
import { authed } from "../lib/admin-auth.mjs";

export default async (req) => {
  if (!(await authed(req))) return;
  const { id } = await req.json();
  const store = blastsStore();
  const b = await store.get(String(id), { type: "json" });
  if (!b || b.status !== "sending") return;

  const template = await buildEmail(b);
  while (b.next < b.recipients.length) {
    const r = b.recipients[b.next];
    const res = await sendOne(r.email, b.subject, template, r.id);
    if (!res.ok) b.failed.push({ email: r.email, error: res.error });
    b.next++;
    b.updatedAt = new Date().toISOString();
    await store.setJSON(b.id, b);
  }
  b.status = "done";
  await store.setJSON(b.id, b);
  console.log(`[blast] ${b.id} done: ${b.next - b.failed.length} sent, ${b.failed.length} failed`);
};
