# Receipts — auto-itemize & file expenses

How receipts emailed to **receipts@recast-properties.com** get read, queued for
review, and filed into the expense sheet.

This is separate from the phone/website **scheduler** (`CLAUDE.md`) and the
**listings/admin** tool (`ADMIN.md`). All three share this Netlify site and the
`netlify/functions/` folder but nothing else.

---

## In plain terms (how to use it)

1. **Email or forward a receipt** (text, PDF, or a **photo**) to
   **receipts@recast-properties.com**. Phone photos are fine — iPhone HEIC is
   converted automatically.
2. Every ~15 minutes the system reads new receipts, has Claude pull out the
   line items, and drops them into a **review queue**.
3. Open the queue (see URL below), **pick a Category** for each item, adjust the
   **8.25% tax** toggle if needed, and click **Approve → sheet**. The row lands
   in the matching block on the **RECAST BIZ** tab, tax included.
4. Anything Claude couldn't read shows up as a **⚠️ "Couldn't auto-read"** item
   with a 🧾 link to the original email — open it and type the values in, or
   Dismiss it. Nothing is ever silently dropped.

**Queue URL** (bookmark it): the page is served at **`/receipts`** and is
password-gated with the same password as `/admin` (`ADMIN_PASSWORD`). It is
currently published to a stable Netlify **alias** (see *Deploy* below), not the
production domain.

**Categories** (the 4-column blocks on the sheet): Tools, Materials, Marketing,
Meals, Travel, Office, Gas/Truck/Trailer, Subscriptions, Website, Business.
*Interest* is intentionally **not** offered — those are entered by hand.

---

## How it works (architecture)

```
receipt → receipts@  ──(Gmail)──►  receipts-poller.gs   (Apps Script, 15-min trigger)
                                        │  POST email + attachments
                                        ▼
                                  receipts-ingest.mjs    (Netlify function)
                                   • HEIC → JPEG
                                   • Claude extracts line items
                                   • append to queue (Netlify Blobs)
                                        │
                                        ▼
                            /receipts queue page  ◄── you tag Category, set tax
                                        │  Approve
                                        ▼
                                  receipts-data.mjs       (Netlify function)
                                   • compute tax-inclusive amount
                                   • POST to ↓
                                        ▼
                                  receipts-sheet.gs       (Apps Script web app)
                                   • write row into the category block
                                        ▼
                                 Google Sheet  "RECAST BIZ" tab
```

The queue lives entirely in **Netlify Blobs** (store `receipts-data`, key
`queue.json`) — no database. Each item:

```
{ id, vendor, date, item, amount, category, taxable, status,
  source, sourceMsgId, sourceUrl, receivedAt, approvedAt }
```
`status` is `pending | approved | dismissed`. `amount` is stored **pre-tax**;
the tax-inclusive value (`amount × 1.0825` when `taxable`) is what gets written
to the sheet.

### Netlify functions (`netlify/functions/`)

All are Netlify v2 (`.mjs`, `export default`). The queue functions reuse the
admin login.

| Function | Auth | Purpose |
|---|---|---|
| `receipts-ping.mjs` | `x-admin-token` == `ADMIN_PASSWORD` | Login check for the queue page. |
| `receipts-data.mjs` | `x-admin-token` == `ADMIN_PASSWORD` | Queue API: `list` / `seed` / `update` / `approve` / `dismiss` / `delete` / `clear`. **Approve** computes the tax-inclusive amount and POSTs it to the sheet-writer (`RECEIPTS_SHEET_URL`); it only marks the item approved if that write succeeds. |
| `receipts-ingest.mjs` | body `token` == `RECEIPTS_SHEET_TOKEN` | Receives one email from the poller, converts HEIC→JPEG, calls Claude (`ANTHROPIC_API_KEY`, model `claude-opus-4-8`) to extract `{vendor, date, taxApplies, items[]}`, and appends pending items. **Idempotent** by Gmail message id. **Never silently drops** — if Claude returns no items it queues one ⚠️ review placeholder. Logs `[ingest] OK/NO-ITEMS/PARSE-FAIL` with attachment mimes/sizes. |

### The queue page (`receipts/index.html`)

Static HTML/JS (same kit as `/admin`). Login → three tabs (Pending / Approved /
Dismissed). Each pending row: editable Vendor / Date / Item / Amount, a Category
dropdown, a 🧾 **Receipt** link to the source email, a **+8.25% tax** checkbox
(default on; uncheck for out-of-state / non-taxable), a live **→ Sheet: $X.XX**
readout, and **Dismiss** / **Approve** buttons. `netlify.toml` sets
`cache-control: no-store` on `/receipts/*` so the page is never stale.

### Apps Scripts (`apps-script/`)

Two **standalone** Apps Script projects, both running as **paul@**. They are not
in this repo's deploy — the `.gs` files here are the source of record; the live
copies are pasted into script.google.com.

| Script | Type | Purpose |
|---|---|---|
| `receipts-sheet.gs` | Web app (`/exec`) | Writes an approved row into the matching category block. `doPost` actions: `inspect` (reports each block's position + headroom) and `append`. Finds a block by its header text, writes Vendor/Date/Item/Amount into the **first empty row inside that block's 4 columns** — it never inserts a full sheet row (that would shift neighboring blocks). Auth: body `token` == script property `WEBHOOK_SECRET`. Target tab is `CONFIG.TAB_NAME` (**`RECAST BIZ`**; was `TEST` during build). |
| `receipts-poller.gs` | Time trigger (every 15 min) | Searches Gmail `(to:receipts@… OR label:receipts) -label:receipts-done`, POSTs each message (with PDF/photo attachments, inline images included) to `receipts-ingest`, and labels the thread `receipts-done` on success. A `LockService` guard prevents a manual run and the scheduled run from overlapping. |

### Configuration

**Netlify environment variables** (set in the dashboard / `netlify env:set` — not
stored in the repo):

| Var | Used by | What |
|---|---|---|
| `ADMIN_PASSWORD` | `/receipts` + `/admin` | Login password (shared with the admin tool). |
| `ANTHROPIC_API_KEY` | `receipts-ingest` | Claude API key for extraction. |
| `RECEIPTS_SHEET_TOKEN` | `receipts-data`, `receipts-ingest` | Shared secret. Must equal the `WEBHOOK_SECRET` script property in **both** Apps Scripts. |
| `RECEIPTS_SHEET_URL` | `receipts-data` | The `receipts-sheet.gs` web-app `/exec` URL. |

**Apps Script properties:** each script has `WEBHOOK_SECRET` = `RECEIPTS_SHEET_TOKEN`.
The poller has the ingest URL hard-coded in `CONFIG.INGEST_URL`.

**The sheet:** id `1isEbfNKPO32Wpf08EtLkNHX85c0rTIl8tpH9bUdgQbs`, tab `RECAST BIZ`.
Each category is a 4-column block (Vendor | Date | Item | Amount) under a header
row that carries the running total.

---

## Operating notes

### Reprocess a receipt that was dropped or misread
A receipt's email is labeled `receipts-done` once handled, so it won't be
re-pulled. To force a re-read:
1. Delete its queue item (the ⚠️ placeholder or wrong row) — a *dismissed* item
   still blocks re-ingest, so it must be truly removed (`receipts-data` `delete`).
2. In Gmail, remove the `receipts-done` label from that email.
3. Run `pollReceipts` (or wait for the trigger).

### Switch the destination tab
Edit `CONFIG.TAB_NAME` in **`receipts-sheet.gs`**, Save, then **Deploy → Manage
deployments → ✏️ → New version → Deploy** (the `/exec` URL serves the deployed
version, not the latest saved code). The poller needs no redeploy — trigger
scripts always run the latest saved code.

### Verify the sheet layout
POST `{token, action:"inspect"}` to the sheet-writer `/exec` URL to get each
block's header cell, columns, current item count, next-write cell, and headroom.

---

## Known limits / backlog

- **Large photos (> ~4 MB)** are skipped (Netlify's ~6 MB function-body cap) and
  become a ⚠️ review item. Fix if it becomes common: downscale before/after upload.
- **Block capacity:** each block has finite empty rows before the next section
  below it. When a block fills, the writer safely **refuses** (returns
  `BLOCKED`) rather than overwrite — add blank rows under that block.
- **Model cost:** extraction uses `claude-opus-4-8` (best accuracy). Switch the
  `MODEL` constant in `receipts-ingest.mjs` to `claude-haiku-4-5` to cut cost.
- **Interest** category is manual by design (its sheet entries are name+amount
  only, which the block-writer can't disambiguate).

---

## Deploy

Currently published to a **stable Netlify alias** so the page has one permanent,
no-cache URL while it's iterated on:

```
netlify deploy --no-build --alias receipts   # from /Users/paulbjork/Desktop/recast-site
```

This serves `https://receipts--incomparable-raindrop-8f3d22.netlify.app/receipts/`
and the receipts functions, **separate from the production deploy**. The
poller's `CONFIG.INGEST_URL` points at this alias. To move receipts onto the
production domain later: deploy to prod (`netlify deploy --prod`) and update
`CONFIG.INGEST_URL` + `RECEIPTS_SHEET_URL` accordingly.

`package.json` gained `heic-convert` (for iPhone HEIC photos); run `npm install`
before deploying so it's bundled into the function.

---

## Change log

- **2026-06-26** — Built the receipts system end to end: queue page on Netlify
  Blobs, Gmail poller + Claude extractor, and the Apps Script sheet-writer that
  files approved rows into the `RECAST BIZ` blocks. Went live on `RECAST BIZ`
  (built/verified on a `TEST` copy first).
- **2026-06-26** — Image-receipt hardening: include inline images, HEIC→JPEG
  conversion, never-silently-drop review placeholders, a poller lock against
  overlapping runs, and `[ingest]` diagnostic logging.
