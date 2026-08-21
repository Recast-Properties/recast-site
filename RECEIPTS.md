# Receipts — the autonomous bookkeeper

How receipts emailed to **receipts@recast-properties.com** and
**travel@recast-properties.com** get read, itemized, categorized, and **filed
into the expense sheet automatically** — with only the uncertain ones left for
human review, and a morning summary email of everything that happened.

This is separate from the phone/website **scheduler** (`CLAUDE.md`) and the
**listings/admin** tool (`ADMIN.md`). All three share this Netlify site and the
`netlify/functions/` folder but nothing else.

---

## In plain terms (how to use it)

1. **Email or forward a receipt** (text, PDF, or a **photo**) to
   **receipts@recast-properties.com** — or **travel@recast-properties.com** for
   travel expenses. Phone photos are fine — iPhone HEIC is converted
   automatically.
2. Every ~15 minutes the bookkeeper reads new receipts. Claude (Opus 5)
   itemizes each one — looking up cryptic SKUs on retailer websites when
   needed — assigns each line item a category and per-item 8.25% sales tax,
   and **files confident items straight into the matching block on the RECAST
   BIZ tab**. No approval step.
3. Anything it isn't sure about (unreadable photo, ambiguous product, unclear
   amount) waits in the **Pending** tab of the queue page with a note
   explaining why. You fix the fields, pick a category, and Approve — same
   flow as before.
4. **Every morning ~7 AM** you get a summary email of the previous day: what
   was filed (by category, with totals and sheet cells), what needs review,
   and ⚠️ any receipt that got lost or stuck (with a link to re-ingest it).

**Queue URL** (bookmark it): served at **`/receipts`**, password-gated with the
same password as `/admin` (`ADMIN_PASSWORD`), published to the stable Netlify
**alias** (see *Deploy*).

**Categories** (the 5-column blocks on the sheet): Tools, Materials, Marketing,
Meals, Travel, Office, Gas/Truck/Trailer, Subscriptions, Website, Business.
*Interest* is intentionally **not** offered — those are entered by hand.

---

## How it works (architecture)

```
receipt → receipts@ or travel@ ──(Gmail: travel@ POP-imported into paul@)──►
                                   receipts-poller.gs   (Apps Script, 15-min trigger)
                                        │  POST email + attachments (channel-tagged)
                                        ▼
                        receipts-ingest-background.mjs   (Netlify BACKGROUND function)
                         • writes a "processing" record FIRST (crash-safe)
                         • HEIC → JPEG
                         • Claude Opus 5 + web search: itemize, decode SKUs,
                           categorize, per-item tax, per-item confidence
                         • HIGH confidence → files directly to the sheet ("filed")
                         • uncertain → queued "pending" with a why-note
                                        │
                          ┌─────────────┴──────────────┐
                          ▼                            ▼
                /receipts queue page          receipts-sheet.gs (Apps Script web app)
                (review + manual approve)      • write row into the category block
                          │  Approve                   ▼
                          ▼                    Google Sheet "RECAST BIZ" tab
                    receipts-data.mjs  ────────────────┘
                                        ▲
        receipts-daily-summary.gs ──►  receipts-summary.mjs (7 AM email data:
        (Apps Script daily trigger)     filed/review/lost-receipt reconciliation)
```

### Storage: one blob per receipt email

Netlify Blobs store **`receipts-data`**, key **`msg/<gmailMessageId>`** (manual
and seed items use `msg/manual-...`). No database. Background ingests run
concurrently; each one writes only its own key, so there are no races. Each
blob is an envelope:

```
{ msgId, channel: "receipts"|"travel", gmailUrl, subject, from, receivedAt,
  status: "processing" | "done" | "error", startedAt, processedAt, error,
  items: [{ id, vendor, date, item, amount (PRE-tax), category, taxable,
            confidence: "high"|"medium"|"low", notes, channel, sourceUrl,
            status, autoFiled, sheetCell, source, sourceMsgId,
            receivedAt, approvedAt }] }
```

Item `status`: `pending` (needs review) | `filed` (auto-filed by the
bookkeeper) | `approved` (manually) | `dismissed`. `amount` is stored
**pre-tax**; the tax-inclusive value (`amount × 1.0825` when `taxable`) is what
gets written to the sheet — tax is decided **per line item** (a no-tax line on
an otherwise-taxed receipt stays un-taxed).

### The autofile gate

**Amounts are what was actually paid** — shipping, delivery fees, airline
taxes, out-of-state taxes are all included; only TX sales tax is excluded
(stored pre-tax, re-added at 8.25% per taxable item on write).

**Duplicate detection:** the extraction call is shown the last 60 days of
recorded charges. A receipt that clearly documents an already-recorded charge
(vendor invoice + receipt pair) auto-dismisses itself with an explanatory
note; a plausible-but-unsure match waits in Pending.

An item files automatically only when **all** hold: `confidence === "high"`,
valid category, amount > 0, vendor and date present — **and** the receipt
reconciles: the extracted line items must sum to the receipt's stated pre-tax
subtotal (±0.5%). A mismatch means something was missed or misread, so the
whole receipt is demoted to Pending with a ⚠️ note rather than filing an
incomplete set. Everything else waits in Pending with the bookkeeper's note
(which also records what a SKU decoded to).
If the sheet write fails (e.g. a full block returns `BLOCKED`), the item is
demoted to pending with the error in its note — never lost.

### Netlify functions (`netlify/functions/`)

All Netlify v2 (`.mjs`, `export default`).

| Function | Auth | Purpose |
|---|---|---|
| `receipts-ping.mjs` | `x-admin-token` == `ADMIN_PASSWORD` | Login check for the queue page. |
| `receipts-data.mjs` | `x-admin-token` == `ADMIN_PASSWORD` | Queue API: `list` / `seed` / `update` / `approve` / `dismiss` / `delete` / `clear` / `migrate` (one-time legacy `queue.json` split). Mutations locate the owning envelope via the item's `sourceMsgId`. **Approve** computes the tax-inclusive amount and POSTs to the sheet-writer; only marks approved if that write succeeds. |
| `receipts-ingest-background.mjs` | body `token` == `RECEIPTS_SHEET_TOKEN` | **Background function** (202 immediately, up to 15 min). The bookkeeper itself: processing-record-first, HEIC→JPEG, Claude `claude-opus-5` via `@anthropic-ai/sdk` with server-side `web_search` (max 4) + `web_fetch` (max 6) for SKU lookups, structured-output JSON (loose-parse fallback), `pause_turn` resume loop, refusal fallbacks enabled. Files high-confidence items to the sheet, queues the rest. **Idempotent** by Gmail message id; **never silently drops** (crash → `error` record + ⚠️ review item). |
| `receipts-summary.mjs` | body `token` == `RECEIPTS_SHEET_TOKEN` | Data for the morning email: yesterday's auto-filed items by category + totals, all pending review items, stuck-processing and errored ingests, and `lostMsgIds` reconciliation (receipts-done emails with no record). |

### The queue page (`receipts/index.html`)

Static HTML/JS. Login → four tabs: **Pending** (needs you; shows the
bookkeeper's confidence badge + why-note, pre-picked category, editable fields,
Approve/Dismiss — receipts still being read appear here as a passive
"Reading receipt…" row), **Filed** (what the bookkeeper filed on its own —
read-only, with category, `auto` badge, sheet cell, travel chip), **Approved**,
**Dismissed**. `netlify.toml` sets `cache-control: no-store` on `/receipts/*`.

### Apps Scripts (`apps-script/`)

Standalone projects running as **paul@**; the `.gs` files here are the source
of record — live copies are pasted into script.google.com.

| Script | Type | Purpose |
|---|---|---|
| `receipts-poller.gs` | Time trigger (every 15 min) | Searches Gmail `(to:receipts@… OR to:travel@… OR label:receipts OR label:travel) -label:receipts-done`, tags each message with its `channel` (travel@ in To/Cc → `travel`), POSTs to the background ingest, labels the thread `receipts-done` on **202** (accepted). **Hard guard:** a message is only ever ingested if it is actually addressed (To/Cc) to receipts@ or travel@, or its thread carries the explicit `receipts`/`travel` label — a search over-match can never feed other mail to the bookkeeper. `LockService` guard against overlapping runs. |
| `receipts-daily-summary.gs` | Time trigger (daily 7–8 AM, **same project as the poller**) | Collects yesterday's `receipts-done` message ids, POSTs to `receipts-summary`, formats + sends the morning email to paul@ via GmailApp. Project timezone must be America/Chicago. |
| `receipts-sheet.gs` | Web app (`/exec`) | Writes an approved/filed row into the matching category block (first empty row inside the block's 5 columns — never inserts a full sheet row). `inspect` action reports block positions + headroom. Auth: body `token` == script property `WEBHOOK_SECRET`. Target tab `CONFIG.TAB_NAME` (**`RECAST BIZ`**; use `TEST` while verifying changes). |

### Configuration

**Netlify environment variables** (dashboard / `netlify env:set`; none new):

| Var | Used by | What |
|---|---|---|
| `ADMIN_PASSWORD` | `/receipts` + `/admin` | Login password (shared with the admin tool). |
| `ANTHROPIC_API_KEY` | ingest | Claude API key. |
| `RECEIPTS_SHEET_TOKEN` | ingest, data, summary | Shared secret == the `WEBHOOK_SECRET` script property in the Apps Scripts. |
| `RECEIPTS_SHEET_URL` | ingest, data | The `receipts-sheet.gs` web-app `/exec` URL. |

**travel@**: its own Workspace mailbox, pulled into paul@ via **Gmail POP
import** (paul@ → Settings → Accounts and import → "Check mail from other
accounts" → add travel@, server `pop.gmail.com:995` SSL; travel@ needs POP
enabled and, with 2-step verification, an app password). POP import brings in
the **existing** travel@ history as well as new mail, and preserves the
original `To: travel@` header — which is how the poller detects the travel
channel. Recommended fetch options: "Leave a copy on the server" (travel@
keeps its archive) and "Label incoming messages: travel". Note Gmail decides
the fetch cadence (can be up to ~an hour). Travel receipts get a soft hint
toward the Travel category — not forced.

**The sheet:** id `1isEbfNKPO32Wpf08EtLkNHX85c0rTIl8tpH9bUdgQbs`, tab `RECAST
BIZ`. Each category is a 5-column block (Vendor | Date | Description | Link |
Price) under a header row carrying the running total; Link is a `HYPERLINK` to
the source email. ⚠️ The June-2026 Link-column migration missed the **Tools**
block on RECAST BIZ (it is still 4-wide, price in its 4th column) — the writer
assumes 5-wide, so **at go-live insert one column left of Tools' price column**
(done on TEST 2026-08-21: right-click the price column → Insert 1 column left;
totals and neighboring blocks shift automatically).

---

## Operating notes

### Reprocess a receipt that was dropped or misread
1. Delete its queue items (`delete` truly removes them — a *dismissed* item
   still blocks re-ingest) so the envelope disappears; for a lost/errored
   receipt there may be nothing to delete.
2. In Gmail, remove the `receipts-done` label from that email.
3. Run `pollReceipts` (or wait for the trigger). An `error`-status envelope is
   also re-ingestable without deleting anything.

### Fix a wrongly auto-filed item
The morning email and the Filed tab show the sheet cell each item landed in —
edit the row on the sheet directly. (Filed items are read-only in the queue.)

### Verify the sheet layout
POST `{token, action:"inspect"}` to the sheet-writer `/exec` URL for each
block's position, item count, next-write cell, and headroom.

### Tune cost vs accuracy
Extraction runs `claude-opus-5` with web search capped (4 searches / 6 fetches
per receipt). Switch the `MODEL` constant in `receipts-ingest-background.mjs`
to `claude-haiku-4-5` to cut cost (expect more pending items).

---

## Known limits / backlog

- **Large photos (> ~4 MB)** are skipped (Netlify body cap) and become a ⚠️
  review item.
- **Block capacity:** when a category block fills, the writer refuses
  (`BLOCKED`) and the item waits in Pending — add blank rows under that block,
  then approve it manually.
- **Poller labels done on 202** (background function): a crash *before* the
  processing record is written could lose a receipt silently — that exact
  window is what the morning email's `lostMsgIds` reconciliation catches.
- **Interest** category stays manual by design.
- **Next: per-property receipts.** The `channel` field is a free string and the
  admin email-setup tool already creates per-property inboxes; the extension is
  a channel→tab map in the ingest function plus a `tab` parameter on
  `receipts-sheet.gs` `append`.

---

## Deploy

Published to the stable Netlify **alias** (permanent no-cache URL, separate
from the production deploy):

```
npm install                                  # bundles @anthropic-ai/sdk + heic-convert
netlify deploy --no-build --alias receipts   # from /Users/paulbjork/Desktop/Claude/Recast-site
```

Serves `https://receipts--incomparable-raindrop-8f3d22.netlify.app/receipts/`
and the receipts functions. The poller's `CONFIG.INGEST_URL` and the summary
script's URLs point at this alias.

**Apps Script changes:** poller + daily-summary scripts run latest *saved*
code (no redeploy); `receipts-sheet.gs` serves the *deployed* version — after
edits do Deploy → Manage deployments → ✏️ → New version.

---

## ROLLOUT STATUS — resume here (as of 2026-08-21, mid-rollout)

The bookkeeper is **built, deployed to the receipts alias, and verified on real
receipts against the TEST tab — but NOT yet live**. No triggers exist; nothing
runs automatically yet.

**What is done and verified**
- All functions deployed to the alias: `receipts-ingest-background` (Opus 5 +
  web search, per-item tax, confidence gate, subtotal reconciliation,
  duplicate self-detection, receipt-file storage), `receipts-data` (per-message
  store + `migrate` done — legacy queue.json split), `receipts-summary`,
  `receipts-file` + `receipts/view.html` (🧾 links open the stored receipt).
- Apps Script project **"Untitled project"** (rename to "Receipts Bookkeeper"
  pending; script id `1c7Y3GZKeMUGltRco4-3lMzEDbw8Ykiqcw7x6aQCUK2vo422FyQ68Hei8`)
  holds the updated poller (travel@ + hard guard + `testPollBatch`),
  WEBHOOK_SECRET set, **Gmail authorization granted** by Paul.
  `receipts-daily-summary.gs` is NOT yet pasted in (second file, still to do).
- Sheet writer (separate June project) points at **TEST** (v5). Flip
  `TAB_NAME` back to `'RECAST BIZ'` + deploy New version at go-live.
- **RECAST BIZ already got the Tools Link-column migration** (2026-08-21,
  inadvertently early but correct + data-intact) — all blocks are 5-wide now;
  no layout work left at go-live.
- travel@: POP-imported into paul@ (history + ongoing, label `travel`).
  Real test batch (11 emails incl. travel@) verified: AA airfare auto-filed
  $541.40 to TEST Travel, personal Uber Eats held with [Personal] notes,
  security alerts/marketing → nothing, Apify invoice+receipt pair → both held
  (no double-file).
- Bookkeeping rules confirmed with Paul: amounts = what was actually paid
  (only TX sales tax excluded/re-added); receipts with shipping → one line;
  restaurants → one line incl. tip; confirmed duplicates auto-dismiss.

**Open problem (next session):** the queue mixes three eras with no visual
distinction — 61 legacy pending items from the stalled June system (their
emails are labeled receipts-done, so dismissing them means they never reach
the books), this week's test items, and fresh batch items. Paul finds this
confusing. Plan: era/source badges in the UI and/or a supervised sweep of the
legacy 61 (bulk-merge same-vendor-same-date groups per the new one-line rules,
then triage or unlabel-and-reprocess — note reprocessing can't see hand-entered
sheet rows, so it risks double-filing anything Paul typed in himself).

**Go-live checklist (in order)**
1. Resolve the legacy-61 question and finish Paul's queue review.
2. Flip sheet writer `TAB_NAME` → `'RECAST BIZ'`, Deploy → New version.
3. Delete the test-batch queue records (`msg/1a0*`) so those emails re-file to
   the live tab; wipe/keep TEST as desired.
4. Paste `receipts-daily-summary.gs` into the bookkeeper project; set project
   timezone America/Chicago.
5. Create triggers: `pollReceipts` every 15 min; `dailySummary` daily 7–8 AM.
   (Account currently has ZERO triggers — this is what turns it on.)
6. Backlog (~30 unlabeled receipts) processes over the next hours; verify the
   first morning email.

## Change log

- **2026-08-21** — **The bookkeeper.** Went autonomous: ingest rebuilt as a
  background function on Claude Opus 5 (`@anthropic-ai/sdk`) with server-side
  web search for SKU lookups, per-item tax + category + confidence, and
  auto-filing of high-confidence items (`filed` status). Storage moved from a
  single `queue.json` to one blob per email (`msg/<id>`, race-free concurrent
  ingest; `migrate` action splits legacy data). Added travel@ channel (own
  mailbox forwarded into paul@), `receipts-summary.mjs` +
  `receipts-daily-summary.gs` morning email (filed/review/lost-receipt
  reconciliation), and a Filed tab on the queue page.
- **2026-06-27** — Added a **Link** column to each block; approving writes a
  clickable `HYPERLINK` to the source email.
- **2026-06-26** — Image-receipt hardening: inline images, HEIC→JPEG,
  never-silently-drop review placeholders, poller lock, `[ingest]` logging.
- **2026-06-26** — Built the receipts system end to end: queue page on Netlify
  Blobs, Gmail poller + Claude extractor, Apps Script sheet-writer. Went live
  on `RECAST BIZ`.
