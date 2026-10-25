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
4. **Every morning ~3 AM** you get a summary email of the previous day: what
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
receipt → receipts@ or travel@ (both aliases on paul@) ──►
                                   receipts-poller.gs   (Apps Script, 15-min trigger)
                                        │  • >3 MB photo → shrink via Drive rendition
                                        │  • each attachment → receipts-upload.mjs
                                        │      (SYNC fn, 6 MB cap) → Blobs upload/<msgId>/<i>
                                        │  • POST email + blob REFERENCES (channel-tagged)
                                        ▼            ⚠️ background fns cap requests at ~256 KB,
                        receipts-ingest-background.mjs   so bytes can never ride this POST
                         • writes a "processing" record FIRST (crash-safe)
                         • loads attachment bytes from Blobs; HEIC → JPEG
                         • reads the REAL sheet (receipts-sheet readRecent) so it can
                           spot charges already on the books — incl. hand-entered rows
                         • Claude Opus 5 DIRECTS the read (thinking + tool loop):
                           zoom (full-res crops), read_books (the real sheet),
                           search_records (queue history), web search (SKUs)
                           → itemize, categorize, per-item tax/confidence/duplicate
                         • HIGH confidence → files directly to the sheet ("filed")
                         • uncertain / duplicate → queued "pending" with a why-note
                                        │
                          ┌─────────────┴──────────────┐
                          ▼                            ▼
                /receipts queue page          receipts-sheet.gs (Apps Script web app)
                (review + manual approve)      • ScriptLock-serialized duplicate gate
                          │  Approve             (recent-append cache + sheet scan)
                          │  (force:true)       • write row into the category block
                          ▼                            ▼
                    receipts-data.mjs  ────────►  Google Sheet "RECAST BIZ" tab
                                        ▲
        receipts-daily-summary.gs ──►  receipts-summary.mjs (3 AM email data:
        (Apps Script daily trigger)     filed/review/lost-receipt reconciliation;
                                        also `legacyReset` for one-off re-ingests)
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

**Duplicate detection** is two-layered:
1. The extraction call is shown the last 60 days of recorded charges. A
   receipt that clearly documents an already-recorded charge (vendor invoice +
   receipt pair) auto-dismisses itself with an explanatory note; a
   plausible-but-unsure match waits in Pending.
2. **Filing-time store re-check** (Netlify-side): just before writing, the
   ingest re-reads the store; a same-vendor+amount item filed/approved by
   another message within 6h → held as a suspected duplicate. Cheap pre-filter
   — but NOT sufficient alone: twins (original + "Fwd:") extract in
   near-identical time and reach filing within 1–2s of each other (batch
   testing re-doubled 9 pairs despite this check).
3. **The airtight gate — the sheet writer itself** (2026-08-21, writer v6):
   `receipts-sheet.gs` `doPost` already serializes every append behind a
   ScriptLock, so its duplicate check cannot race. Inside the lock, a
   CacheService memory of recent appends (vendor|amount|date, 6h TTL) rejects
   a row already written by a DIFFERENT `msgId` with
   `{ duplicate:true, existing:<cell> }`; the ingest holds that item in
   Pending ("possible original/forward pair"). The same `msgId` may repeat a
   key (a receipt can list identical lines twice), and `force:true` — sent by
   the queue's human Approve — always writes.

**Transaction numbers are decisive (2026-09-03).** Every receipt's own
transaction / order / invoice / confirmation / trip number is extracted
(`transactionId`) and stored on each item as `txnId` (shown on the queue card
as `txn #…`). Before any twin hold fires, the ingest compares the item against
every non-dismissed record with the same vendor + amount:
- **same number** → this exact charge is already recorded → auto-dismissed
  (`TXN-SAME-DISMISS`), note names the sheet cell;
- **every prior record has a number and none is this one** → a separate charge
  (a recurring $5 top-up, two same-day orders) → filed, bypassing the twin
  holds and the writer's vendor|amount|date gate with `force` (`TXN-DISTINCT-FILE`);
- **either side lacks a number** → the holds below run exactly as before;
- **same number, DIFFERENT amount** on another email (2026-09-16) → one receipt read
  twice (a split per Paul's forwarding note, a re-read) → held with the other
  amount and cell named (`TXN-AMOUNT-MISMATCH-HOLD`); Paul keeps one. Before this,
  CoreLogic #1520-7474 filed as $435 and again as $235 + $200.
After a writer bounce, the record that won the race is matched on any non-dismissed
status — its "filed" flag may be a second behind the sheet (2026-09-16).
Rideshare is excluded: a ride's base and tipped receipts describe one trip,
so no number pulled from them proves anything either way. The model sees the
same numbers in its queue context and is told to treat a matching number as a
confirmed duplicate and differing numbers as separate charges without dropping
confidence. Residual gap: a row Paul typed onto the sheet by hand has no number,
so a distinct-number file can still twin a hand-entered row — the store only
knows what the bookkeeper wrote.

An item files automatically only when **all** hold: `confidence === "high"`,
valid category, amount > 0, vendor and date present — **and** the receipt
reconciles: the extracted line items must sum to the receipt's stated pre-tax
subtotal (±0.5%). A mismatch means something was missed or misread, so the
whole receipt is demoted to Pending with a ⚠️ note rather than filing an
incomplete set. Everything else waits in Pending with the bookkeeper's note
(which also records what a SKU decoded to).
If the sheet write fails (e.g. a full block returns `BLOCKED`), the item is
demoted to pending with the error in its note — never lost.

**Rideshare rules (2026-08-31).** Paul's standing rule, baked into the prompt:
an Uber/Lyft ride with an **airport** pickup or dropoff IS a business expense —
category Travel, and Uber's "[Personal]" subject tag alone no longer blocks
high confidence. Non-airport [Personal] rides still cap at medium and wait in
Pending. Ride descriptions now carry route + time so receipts for the same
ride can be matched later. **Tip pairs:** Uber sends a base-fare receipt and,
once the rider tips, an updated receipt for the SAME ride — the amounts differ,
so the exact-match twin gates never paired them. The model treats the
tip-included total as authoritative (untipped version of an already-recorded
tipped ride auto-dismisses; tipped version of an already-filed untipped row is
held with a fix-that-row note), and a 4th mechanical check holds a same-day
rideshare charge within a tip-sized ratio (≤1.6×) of one just filed by another
email (`RIDE-PAIR-HOLD`) — closing the same-poll-batch race the 60-day context
can't see. The writer can't edit existing rows, so the tipped-update case
surfaces as a Pending card telling you exactly which row to fix, not a silent
auto-repair.

**Supersede (2026-09-10):** when the model says a receipt *supersedes* a
recorded charge (Uber's tipped receipt after the base fare filed; an amended
invoice) and the read is high-confidence, the ingest updates that sheet row in
place through the writer's `update` action and dismisses the card with a note
naming the cell and both amounts. No human step. If the row can't be found or
confidence is lower, the card waits with the fix spelled out.

**Twins that race (2026-09-10):** when the writer's lock bounces a write as
"already written by another email", the ingest now reads the winning record's
transaction number before deciding: same number → auto-dismiss, different →
file with `force`, no numbers → hold as before.

### Netlify functions (`netlify/functions/`)

All Netlify v2 (`.mjs`, `export default`).

| Function | Auth | Purpose |
|---|---|---|
| `receipts-ping.mjs` | `x-admin-token` == `ADMIN_PASSWORD` | Login check for the queue page. |
| `receipts-upload.mjs` | body `token` == `RECEIPTS_SHEET_TOKEN` | **Synchronous** (6 MB cap) attachment drop: parks one attachment's base64 in Blobs at `upload/<msgId>/<i>`. Exists because the BACKGROUND ingest is an async invocation with a **~256 KB request cap** — attachment bytes can never ride the ingest POST (every photo 413-bounced until 2026-08-21). The poller uploads here first; the ingest gets blob references, loads the bytes, and deletes the transient keys. |
| `receipts-data.mjs` | `x-admin-token` == `ADMIN_PASSWORD` | Queue API: `list` / `seed` / `update` / `approve` / `dismiss` / `delete` / `clear` / `migrate` (one-time legacy `queue.json` split). Mutations locate the owning envelope via the item's `sourceMsgId`. **Approve** computes the tax-inclusive amount and POSTs to the sheet-writer; only marks approved if that write succeeds. |
| `receipts-ingest-background.mjs` | body `token` == `RECEIPTS_SHEET_TOKEN` | **Background function** (202 immediately, up to 15 min). The bookkeeper itself: processing-record-first, HEIC→JPEG, then Claude `claude-opus-5` via `@anthropic-ai/sdk` **as the director of the read** (2026-09-09): adaptive extended thinking + a client-side tool loop — `zoom` (crops any region of an image attachment via `jimp` and returns it at full resolution), `read_books` (queries the writer's `readRecent`, filtered by vendor/category/days), `search_records` (queries the queue's own 90-day history by vendor/amount) — plus server-side `web_search` (max 4) + `web_fetch` (max 6) for SKU lookups; up to 20 tool turns. Structured-output JSON (loose-parse fallback), refusal fallbacks enabled. Files high-confidence items to the sheet, queues the rest. **Idempotent** by Gmail message id; **never silently drops** (crash → `error` record + ⚠️ review item). `dryRun:true` runs the full read, writes nothing to the sheet, and stores the result under `msg/dry-<id>` as `[DRY RUN …]` Pending cards. |
| `receipts-summary.mjs` | body `token` == `RECEIPTS_SHEET_TOKEN` | Data for the morning email: yesterday's auto-filed items by category + totals, all pending review items, stuck-processing and errored ingests, and `lostMsgIds` reconciliation (receipts-done emails with no record). |

### The queue page (`receipts/index.html`)

Static HTML/JS. Login → four tabs: **Pending** (needs you; shows the
bookkeeper's confidence badge + why-note, pre-picked category, editable fields,
Approve/Dismiss — receipts still being read appear here as a passive
"Reading receipt…" row), **Filed** (what the bookkeeper filed on its own —
read-only, with category, `auto-filed` badge, sheet cell, travel chip),
**Approved**, **Dismissed**. The Pending tab also offers a **Twins** filter +
**"Dismiss all shown"** bulk action: it collects only the items the sheet
writer's gate refused because the same vendor+amount+date was already written
by another email (original + "Fwd:" pairs), so the whole group is safely
redundant. There is deliberately **no "[Personal]" bulk bucket** — Paul
confirmed 2026-08-23 that airport rideshares (PDX/DFW) carry that subject tag
and ARE business expenses, so every [Personal] item stays an individual call.
Every card carries **era badges** — "June backlog"
(items from the stalled June system, detected by their empty `confidence`
field), "Test item" (seed rows) — and the Pending tab gains an
**All / New / June backlog sub-filter** whenever both eras are present, so each
era can be reviewed as its own pass. `netlify.toml` sets `cache-control:
no-store` on `/receipts/*`.

### Apps Scripts (`apps-script/`)

Standalone projects running as **paul@**; the `.gs` files here are the source
of record. **Push with clasp, not paste** (since 2026-09-09 the Bookkeeper
project is byte-identical to the repo): `clasp clone <id>` into a scratch
folder, copy the repo files over the cloned ones (`receipts-poller.gs` →
`Code.js`, `receipts-daily-summary.gs` → `summary.js`, `receipts-backfill-scan.gs`
→ `backfill-scan.js`), `clasp push -f`, then re-clone and `cmp`. clasp only
*lists* projects it created, but clone-by-id works for all of them. Pasting
into the editor mangles em dashes; if the token has expired
(`invalid_grant / invalid_rapt`) Paul runs `clasp login`.

| Script | Type | Purpose |
|---|---|---|
| `receipts-poller.gs` | Time trigger (every 15 min); project **"Receipts Bookkeeper"**, id `1c7Y3GZKeMUGltRco4-3lMzEDbw8Ykiqcw7x6aQCUK2vo422FyQ68Hei8` | Searches Gmail `(to:receipts@… OR to:travel@… OR label:receipts OR label:travel) -label:receipts-done`, tags each message with its `channel` (travel@ in To/Cc → `travel`), POSTs to the background ingest, labels the thread `receipts-done` on **202** (accepted). **Hard guard:** a message is only ever ingested if it is actually addressed (To/Cc) to receipts@ or travel@, or its thread carries the explicit `receipts`/`travel` label — a search over-match can never feed other mail to the bookkeeper. `LockService` guard against overlapping runs. Oversized photos are shrunk via a Drive rendition; attachments are uploaded to Blobs first (see `receipts-upload.mjs`) and only references are POSTed. Also holds the maintenance entry points: **`setupTriggers()`** (creates both triggers from code — poll 15 min, summary 3–4 AM Central), **`reprocessLegacyDryRun()` / `reprocessLegacy()`** (one-off: release records+labels so a stalled-era batch can be re-read), `testPollBatch()` (process without labeling done), **`dryRunIngest()`** (re-read specific message ids through the bookkeeper with nothing written — results land as `[DRY RUN …]` cards in Pending; edit the `MSG_IDS` list in `sendIds_` first), and **`reingestIds()`** (same ids, for REAL — delete each message's existing record first or the ingest skips it). |
| `receipts-backfill-scan.gs` | Manual, one-off; lives as `backfill-scan.gs` in the **same project as the poller** (added to the repo 2026-09-09 — it had only ever existed live) | READ-ONLY pre-receipts@ backfill scan from 2026-08-24: searches Gmail and writes findings to a Drive JSON file. Never writes the sheet, labels, mails, or POSTs. Delete from the project when the backfill is done. `receipts-bookkeeper.appsscript.json` is that project's manifest. |
| `receipts-daily-summary.gs` | Time trigger (daily **3–4 AM Central**); lives as `summary.gs` in the **same project as the poller** | Collects yesterday's `receipts-done` message ids, POSTs to `receipts-summary`, formats + sends the morning email to paul@ via GmailApp. `dailySummary()` = yesterday (the trigger); `summaryToday()` = an on-demand "today so far" digest. Project timezone is America/Chicago. Keep user-facing strings ASCII (`\uXXXX` escapes) — pasting into the editor mangles UTF-8. |
| `receipts-sheet.gs` | Web app (`/exec`); project **"Receipts Sheet Writer"**, id `1HCWjBfXOAKwx0dWg5z7eW91L9eOji4orBPjBtnw4xZk0mK6JVNIqIs6u`; deployment `AKfycbyh2Y…BXxAGA` (bump with `clasp deploy -i <that id> -d "..."`) | Writes an approved/filed row into the matching category block; `update` (2026-09-10) rewrites the row a superseding receipt replaces (first empty row inside the block's 5 columns — never inserts a full sheet row). Serialized **duplicate gate** (see "The autofile gate"): rejects a vendor+amount+date already written by another `msgId` in the last 6h; `force:true` (human Approve) bypasses. `inspect` action reports block positions + headroom. Auth: body `token` == script property `WEBHOOK_SECRET`. Target tab `CONFIG.TAB_NAME` (**`RECAST BIZ`**; use `TEST` while verifying changes). |
| `receipts-sheet-sort.gs` | Manual run; project **"RECAST BIZ Sorter"**, id `1dE6KeuDNNkto-9XTDvgRAk1M6k710k4Bdl7voht1wzoJYKxbW3ObaMNa` | Maintenance: sorts the rows inside every category block by date, oldest at top, and normalizes the date column to `MM/dd/yy`. Rows land in PROCESSED order, not DATED order, so blocks drift — re-run whenever one looks out of order. Locates blocks by NAME in row 1 (never hardcoded columns), backs the tab up first, carries HYPERLINK formulas and per-cell number formats with their rows, aborts if the poller appends mid-run, and refuses to finish if any block's row count or total moved. ONE entry point (`sortRecastBizByDate`) so the editor preselects it; `SORT_CFG.DRY_RUN` picks report-only vs apply, and is left **true** in the repo. |

### Configuration

**Netlify environment variables** (dashboard / `netlify env:set`; none new):

| Var | Used by | What |
|---|---|---|
| `ADMIN_PASSWORD` | `/receipts` + `/admin` | Login password (shared with the admin tool). |
| `ANTHROPIC_API_KEY` | ingest | Claude API key. |
| `RECEIPTS_SHEET_TOKEN` | ingest, data, summary | Shared secret == the `WEBHOOK_SECRET` script property in the Apps Scripts. |
| `RECEIPTS_SHEET_URL` | ingest, data | The `receipts-sheet.gs` web-app `/exec` URL. |

**travel@**: since 2026-10-25 a **Workspace alias on paul@** (made with
`/admin/email/`, so paul@ also has a "travel" label and a `to:travel@` →
label, skip-inbox filter). Mail keeps its original `To: travel@` header —
which is how the poller detects the travel channel. Travel receipts get a
soft hint toward the Travel category — not forced. History: until 2026-10-25
travel@ was its own paid Workspace mailbox, pulled into paul@ by a Gmail POP
import; that import had copied its whole history (back to the mailbox's
2026-02-23 start) into paul@, so the mailbox was renamed travel-old@, the
alias moved to paul@, the mailbox deleted (via Squarespace, which bills the
Workspace seats) and the POP entry removed.

**The sheet:** id `1isEbfNKPO32Wpf08EtLkNHX85c0rTIl8tpH9bUdgQbs`, tab `RECAST
BIZ`. Each category is a 5-column block (Vendor | Date | Description | Link |
Price) under a header row carrying the running total; Link is a `HYPERLINK` to
the **Gmail message itself** (`mail.google.com/mail/u/0/#all/<messageId>`) —
Paul's call 2026-09-03; the stored-copy viewer at `receipts/view.html` is now
only the fallback for a record with no Gmail URL. ⚠️ The June-2026 Link-column migration missed the **Tools**
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

### Repoint old Link cells at Gmail — DONE 2026-09-03
Rows filed 2026-08-22 → 09-03 linked to the stored-copy viewer; Paul ran
`relinkToGmail_DRYRUN` then `relinkToGmail_LIVE` in the **Receipts Sheet
Writer** project and every Link now opens Gmail. The functions stay in the
writer: they rewrite only `HYPERLINK` formulas containing `view.html?m=`, so a
re-run is a safe no-op (finds 0) if a viewer link ever reappears.

### Re-sort a block that has drifted out of date order
Rows are appended in the order receipts are PROCESSED, so a backfill or a
reprocessed batch leaves blocks out of order. Open the **RECAST BIZ Sorter**
project, run `sortRecastBizByDate` with `DRY_RUN: true` to see what would move,
then set it `false` and run again. It backs the tab up first and verifies every
block's total is unchanged. Re-running when nothing has drifted is a no-op.

### Verify the sheet layout
POST `{token, action:"inspect"}` to the sheet-writer `/exec` URL for each
block's position, item count, next-write cell, and headroom.

### Test the bookkeeper's READ without touching the books (dry run)
Put the Gmail message id(s) in `MSG_IDS` inside `dryRunIngest()` (Receipts
Bookkeeper project) and run it. Each email is re-read by the full bookkeeper —
thinking, zoom, books lookup — but nothing is written to the sheet and the
real record is untouched; the result appears in the queue's **Pending** tab as
a card whose note starts `[DRY RUN would AUTO-FILE … / would HOLD … / would
AUTO-DISMISS]`. Judge the read, then delete the dry-run card (the queue's
delete, or `netlify blobs:delete receipts-data msg/dry-<id>` — same effect; the
`file/<id>/*` blobs are shared with the real record and are left alone either
way). Dry-run records are ignored as duplicate evidence by real ingests.
Editor gotcha (2026-09-09): the function dropdown only honors a selection
after a real click on the dropdown, arrow keys to the name, then a
mouse-drag from the dropdown button onto the option — a plain click or Enter
changes the label but Run still executes the previously selected function.
Confirm on the Executions page which function actually ran.
No-editor alternative (2026-09-10): the ingest accepts a direct POST — build the
payload from the stored copy (`netlify blobs:get receipts-data file/<id>/body`,
attachments as `dataBase64` from `file/<id>/<n>`; `token` =
`RECEIPTS_SHEET_TOKEN`, plus `gmailMessageId`, `subject`, `from`,
`receivedDate`, `channel`, `dryRun:true`) and `curl` it at
`/.netlify/functions/receipts-ingest-background` on the alias. Same payload with
`dryRun:false` (after deleting `msg/<id>`) is a real re-ingest.

### Tune cost vs accuracy
Extraction runs `claude-opus-5` with adaptive thinking and a tool loop (zoom /
read_books / search_records; web search capped at 4 searches / 6 fetches per
receipt; 20 tool turns max). Expect roughly 3–5× the tokens of the old one-shot
read on a receipt that needs zooming — single-digit dollars a month at current
volume. Switch the `MODEL` constant in `receipts-ingest-background.mjs` to a
cheaper model to cut cost (expect more pending items).

---

## Known limits / backlog

- **Large photos (> ~3 MB)** are automatically **shrunk via a Drive
  round-trip** in the poller (temp upload → ~2000px JPEG rendition → trash
  temp; also renders HEIC) so every already-received email works as-is at any
  size — nothing needs re-sending. Background: base64 ×4/3 must fit Netlify's
  request cap; a ~4 MB photo 413-bounced the whole email on 2026-08-21. Only
  if the shrink itself fails is the photo skipped → ⚠️ review item. PDFs over
  3 MB are still skipped (a Drive "thumbnail" would keep page 1 only).
- **Block capacity:** when a category block fills, the writer refuses
  (`BLOCKED`) and the item waits in Pending — add blank rows under that block,
  then approve it manually.
- **Poller labels done on 202** (background function): a crash *before* the
  processing record is written could lose a receipt silently — that exact
  window is what the morning email's `lostMsgIds` reconciliation catches.
- **The poller's 90-day window (`SEARCH_WINDOW: 'newer_than:90d'`) is a
  deliberate safety boundary, not an arbitrary default.** Widening it is
  DANGEROUS: receipts older than that were either hand-entered into RECAST BIZ
  or handled by the June system, and their emails are unlabeled — a wider
  window would re-ingest and re-file them as duplicates the writer's gate
  cannot catch (its cache is 6h, and the model's 60-day context wouldn't show
  a January charge). Coverage is complete without it: pre-2026-05-25 =
  hand-entered/June backlog, 2026-05-25→go-live = swept by hand at go-live,
  go-live onward = the 15-min poller. The window only ever needs to span the
  gap since the last successful poll.
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
npm install                                  # bundles @anthropic-ai/sdk + heic-convert + jimp
netlify deploy --no-build --alias receipts   # from /Users/paulbjork/Desktop/Claude/Recast-site
```

Serves `https://receipts--incomparable-raindrop-8f3d22.netlify.app/receipts/`
and the receipts functions. The poller's `CONFIG.INGEST_URL` and the summary
script's URLs point at this alias.

**Apps Script changes:** poller + daily-summary scripts run latest *saved*
code (a `clasp push` counts as saved — no redeploy); `receipts-sheet.gs` serves
the *deployed* version — after edits do Deploy → Manage deployments → ✏️ → New
version. See the Apps Scripts section for the clasp push recipe.

---

## STATUS — LIVE since 2026-08-22 (~3:30 PM Central)

**2026-09-09 — the model-directed read is live on the alias** (thinking + zoom +
read_books + search_records; see the change log). Verified by dry run before
anything else touched it: the Tom Thumb pump photo now reads **$78.98** (zoomed,
22.318 × $3.539 reconciled, high) and is recognized as already on the sheet; both
legs of the 08/30 Uber base/tip pair reconcile to the cent and come back
"confirmed duplicate"; the Local Government Solutions receipt that was held on
"items $10.00 ≠ subtotal $10.30" now finds the $0.30 fee line (10.00 + 0.30 =
10.30) and would file it; the 09/02 Home Depot "Fwd:" twin is a confirmed
duplicate. No schema/tool/thinking 400 seen — the schema stays. Text receipts
took 2–3 turns and 2–6 tool calls each; only the photo needed zoom.

**2026-09-10 — the model's verdict is the action.** First live day surfaced two
Pending cards the model had already solved in its notes; now a tipped Uber
receipt updates the filed row in place (`supersedes` → writer v11 `update`) and
a twin that loses the race is dismissed on its transaction number instead of
held. Both fixed live and verified on the sheet the same day (change log).

**The bookkeeper is in production.** Writer **v11** (same deployment id as
`@10`, bumped 2026-09-10 for the `update` action; v10 was the first version
with the sheet-based duplicate check live — see 2026-09-03 in the change log) points at **RECAST BIZ**; every receipt link
opens the Gmail message;
triggers: `pollReceipts` every 15 min, `dailySummary` daily 3–4 AM Central
(Paul wants the digest waiting first thing). Go-live drain: the live poller
was run by hand until empty — ~190 messages across receipts@ + travel@ within
the 90-day window, 0 failures; everything ingested is labeled `receipts-done`.

**How to operate it now** — see "In plain terms" at the top. Testing method
stays: judge by reading the sheet; the queue is the exception lane.

**Left for Paul**
- **Backfill tail (added 2026-08-24):** 24 Pending items dated Jan–May. The Uber
  rides are individual calls (airport = business); Adobe $34.49 ×2 and Microsoft
  $9.99 ×2 are legitimate separate monthly charges held only because vendor+amount
  repeat — approve them. VistaPrint was deliberately left out (see change log);
  Marketing stays empty for this window on purpose.
- Queue triage: the New pending items (held twins → Dismiss; [Personal]
  Ubers → judge; the second same-day Netlify $20 → Approve; photo holds
  like the JP-court packet → Approve/fix).
- ~~The 59 June-backlog items~~ **DONE 2026-08-24** — reprocessed through the
  current bookkeeper (see change log). The "June backlog" era no longer
  exists; every pending card now carries a confidence badge and a why-note.
- The June-era "seed" fakes are gone (deleted with the test reset).

**Known behaviors to expect**
- Same vendor + amount + date from two different emails on the same day is
  held as a possible twin even when legit (e.g. two $20 Netlify invoices) —
  Approve the second one; human Approve bypasses the gate.
- Photos > 3 MB are shrunk via Drive; PDFs > 3 MB are skipped → review item.
- A full category block returns BLOCKED → item waits in Pending; add rows
  under the block and Approve.
- A tipped Uber receipt arriving after the base fare filed updates that row
  in place (since 2026-09-10) — you'll see it in the Dismissed tab as
  "Updated Z65:AD65 from $103.61 to $122.33". Only when the model is unsure
  does the old hold fire: fix the filed row or Approve, per the note.

**If something looks wrong**: Reprocess a receipt (Operating notes above);
`summaryToday` in the Receipts Bookkeeper project emails an on-demand digest;
"Reset test records" on the queue page deletes ALL bookkeeper-era records —
do NOT use it in production (unlabeled emails would re-file; labeled-done
ones would simply vanish from the queue).

## Change log

- **2026-09-16** — **Two duplicate-gate gaps found by the parallel-run audit.**
  Comparing every envelope both bookkeepers wrote 09-11 → 09-16: (1) CoreLogic
  09-15 arrived as a $435 Stripe receipt and, forwarded with Paul's two-invoice
  note, as $235 + $200 — the transaction-number check is keyed on vendor|amount, so
  the numbers never met and both filed ($870 on the sheet; Paul deleted the $435
  row by hand, and its queue record still says filed at AR69). Now a same-number,
  different-amount record from another email holds the item (`TXN-AMOUNT-MISMATCH-HOLD`).
  (2) Netlify 09-14: both copies carried SFWGOE-00008, yet the original went to
  Pending — the writer bounced it about a second before the winning copy had
  persisted its `filed` status, and `findCompetitor` only accepted filed/approved
  records; it now accepts any non-dismissed record. The mismatch check is the exported
  `txnAmountMismatch` with `tests/receipts-txn-mismatch.test.js`; deployed to the alias
  the same day and smoke-tested with a dry run of the CoreLogic forward. Also noted, not changed: the
  poller's `label:receipts OR label:travel` clause is why originals Paul never sent
  to receipts@ get ingested (they are only in this system's store, never the new
  one's), which is the source of most original+Fwd twins.

- **2026-09-10** — **The model's verdict is the action: "supersedes" + number
  check after a bounce.** First live day of the director read produced two
  Pending cards whose notes had already solved the problem — the tipped Uber
  receipt ("fix Z65 to $122.33, then dismiss this card") and an Anthropic
  original whose "Fwd:" twin had filed seconds earlier with the same receipt
  number. Paul: "if it caught and adjusted the Uber ride then why does it need
  my review? … I'm paying for the API to reason this stuff out." Root causes:
  (1) the schema had no verdict meaning "this replaces a row you already
  filed" and the writer had no update action, so the model said "suspected"
  and the card went to Pending; (2) when the writer's serialized gate bounced
  a twin, the ingest held it without looking at the record that won the race,
  even though that record carried the same transaction number. Now:
  `duplicate: "supersedes"` (+ `supersedesAmount`, `supersedesCell`) — on a
  high-confidence read the ingest finds the recorded charge (queue record by
  cell/vendor/date/amount, else the model's own pointer), calls the writer's
  new **`update`** action (writer **v11**: locates the row by vendor + date in
  the block, amount disambiguates; rewrites description/link/price, never adds
  a row), retires the new card as dismissed with "Updated Z65:AD65 from
  $103.61 to $122.33", and keeps the queue's record of the old row in step.
  Not high confidence / row not found → Pending with the instruction in the
  note (the old behavior). And after a writer bounce the ingest re-reads the
  rival record: same number → auto-dismiss; different numbers → write with
  `force`; no numbers → the old hold. Prompt: rideshare rule now says the
  tipped receipt supersedes the base row. Poller: `reingestIds()` (real
  re-ingest of `MSG_IDS`; delete the record first). Dry-run verdict label
  "would UPDATE the recorded row to $X". Verified by dry run on both live
  cards before deploy, then for real: the Uber card re-ingested and rewrote
  Z65:AD65 from $103.61 to $122.33 (the other same-day Uber row was left
  alone — the writer disambiguated by amount), the Anthropic original
  auto-dismissed on its receipt number; both confirmed on the sheet via
  `readRecent`. Writer deployed as v11 by Paul (`clasp deploy` is blocked for
  Claude Code's auto mode — the push/deploy command is in the Apps Scripts
  section).

- **2026-09-09** — **The model directs the read: thinking + zoom + books
  lookup.** Trigger: a Tom Thumb pump-display photo (09/06) sat in Pending at
  $70.90 medium-confidence; the display actually read **$78.98** for 22.318
  gal, and 22.318 × $3.539 = $78.98 to the cent — the bookkeeper had even
  written the tell-tale "$3.177/gal" in its own note without being able to
  act on it. Paul: "every time I ask you to look at it you solve it. I want
  the API to solve it." Root cause: the ingest was a one-shot form-filler —
  one downscaled image, a pre-chewed text dump of the books, no way to look
  closer or look anything up (the only tool it ever had was web search).
  Now `extractReceipt` is a real tool loop with adaptive extended thinking:
  `zoom` (crop any region of an image attachment at full resolution, via
  `jimp`; small crops upscaled to ≥800px), `read_books` (the writer's
  `readRecent`, filtered), `search_records` (queue history, filtered) — and
  the prompt tells it the METHOD: zoom before deciding what a blurry digit
  says, check the books before calling anything a duplicate, make the
  arithmetic reconcile (line items ↔ subtotal; gallons × a real x.xx9 pump
  price ↔ total), and say in the note what it verified. Business rules are
  unchanged. Every deterministic seatbelt stays (subtotal reconcile, txn
  numbers, twin holds, ride-pair hold, the writer's ScriptLock gate) — ripping
  those out is a later pass once the model has made them redundant.
  Added `dryRun` to the ingest + `dryRunIngest()` to the poller so the read
  can be judged in the queue with nothing written (see Operating notes).
  Deps: `jimp@^1.6`. Poller change is a paste into the Bookkeeper project;
  no writer change. **Deployed to the alias and verified by dry run the same
  day** — five historically hard emails (pump photo, Uber base/tip pair, LGS
  subtotal hold, Fwd twin) all read correctly; details under STATUS.

- **2026-09-03** — **Transaction numbers settle duplicates.** Paul, looking at
  two Telnyx $5 receipts held in Pending: "you should be smart enough to check
  the transaction numbers." The model had in fact written *"distinct txn ID …
  so not a duplicate"* in its own note — and the deterministic vendor+amount
  gate held the card anyway, because nothing stored or compared the number.
  Now the receipt's number is extracted (`transactionId` in the schema), kept
  on the item (`txnId`), shown to the model for every recent queue record, and
  compared by the ingest before any hold: same number → auto-dismiss; all
  priors numbered and none match → file with `force`; otherwise the old holds.
  Two prompt rules added: a matching number is a confirmed duplicate and
  differing numbers are separate charges (confidence unaffected); and when the
  books already show a vendor under a category, that category is certain — the
  other Telnyx card was held only because Marketing vs Subscriptions was
  "arguable". Full rule under *The autofile gate → Transaction numbers*.
  Records filed before today have no `txnId`, so comparisons against them
  fall back to the old behavior until the history fills in.

- **2026-09-03** — **Receipt links now open the Gmail message, not the
  stored-copy viewer.** Paul's call: the viewer (`receipts/view.html`) rendered
  an emailed receipt as its plain-text body, which is not the receipt he wants
  to see. Every link — the sheet's Link column, the queue's 🧾, the review
  placeholder — now carries `envelope.gmailUrl`
  (`mail.google.com/mail/u/0/#all/<messageId>`), with the viewer kept only as
  the fallback when a record has no Gmail URL. Old queue records need no
  migration: `receipts-data` prefers the envelope's Gmail URL over the item's
  stored `sourceUrl` on both list and Approve. Old **sheet** rows do —
  `relinkToGmail_DRYRUN` / `relinkToGmail_LIVE` in the writer — **run by Paul
  the same day; all existing rows now open Gmail.** The stored copies under
  `file/<msgId>/*` are still written.

- **2026-09-03** — **The sheet-based duplicate check was never actually live —
  now deployed (writer v10).** The 2026-08-25 note suspected the deployed
  writer didn't match local `receipts-sheet.gs`. Verified with clasp: the
  remote **source** is byte-identical to local (MD5 `d32db22…`), and a
  version 9 titled "restore readRecent + blockHasRow_ via clasp" already
  existed — but the **web-app deployment was still pinned to version 8**.
  An Apps Script `/exec` URL serves a pinned version, not HEAD, so production
  had been running v8 since the v8 work landed on 2026-08-24: no `readRecent_`,
  no `blockHasRow_`.

  What that meant in practice: every ingest's `sheetBooksContext()` POSTed
  `action:"readRecent"` to a deployment that doesn't implement it, so the call
  fell through to `append_` and came back `Missing category` (400). That
  function catches and returns `""`, so the failure was silent — Claude judged
  duplicates on the **queue-only** view for ten days, blind to every row typed
  onto the sheet by hand (exactly the case v8 was built to cover). The
  deterministic `blockHasRow_` backstop never ran either. Plausibly explains
  part of the Jan–May backfill duplicate noise in STATUS.

  Fix: cut version 10 from HEAD (identical to local) and repointed deployment
  `AKfycbyh2Yc…` from `@8` to `@10`. Reversible with `-V 8`.

  **Expect more Pending cards for a few days** — the sheet check is now
  catching charges it previously couldn't see. It fails safe: `blockHasRow_`
  only ever returns 409, which the ingest turns into a held Pending item, never
  a dropped one; human Approve sends `force:true` and bypasses it.

  **Lesson for next time: `clasp push` is not a deploy.** Pushing updates HEAD;
  the live `/exec` URL keeps serving whatever version its deployment is pinned
  to. After any writer change, run `clasp list-deployments` and confirm the
  versioned deployment moved — a push alone is inert.

  Also noted: `clasp list-scripts` shows only the "RECAST BIZ Sorter" project,
  because clasp's `drive.file` scope only sees projects clasp itself created.
  The hand-made projects are invisible to it, so their Script IDs have to come
  from script.google.com. Receipts Sheet Writer is
  `1HCWjBfXOAKwx0dWg5z7eW91L9eOji4orBPjBtnw4xZk0mK6JVNIqIs6u`.

- **2026-08-31** — **Rideshare rules: airport = business; tip-updated
  receipts.** Prompt now carries Paul's rule that any Uber/Lyft ride with an
  airport pickup or dropoff is a business expense — Travel, high confidence
  allowed despite the "[Personal]" tag (non-airport [Personal] rides still cap
  at medium). Ride descriptions carry route + time for same-ride matching.
  Tip pairs (base-fare receipt + later tip-included receipt for one ride) dodge
  every exact-match gate because the amounts differ — the 06/03 Uber had to be
  hand-fixed to its tipped $113.98 on 2026-08-23. Now the model treats the
  tipped total as authoritative (untipped duplicate of a recorded tipped ride
  auto-dismisses; tipped update of an already-filed untipped row pends with a
  fix-that-row note), and the ingest's pre-filing re-check holds a same-day
  rideshare charge within ≤1.6× of one just filed by another email
  (`RIDE-PAIR-HOLD`), closing the same-batch race. See "Rideshare rules" under
  the autofile gate. Deployed to the alias.

- **2026-08-25** — **RECAST BIZ sorted by date.** Every category block's rows
  reordered oldest-at-top, newest-at-bottom, via a new `receipts-sheet-sort.gs`
  ("RECAST BIZ Sorter" project, pushed with clasp — NOT pasted, so the em dashes
  survived). Moved 51/72 Tools, 63/63 Travel, 62/62 Subscriptions, 12/13
  Business, 10/12 Gas, 8/8 Website, 4/5 Marketing; Materials, Meals, Office and
  Interest were already in order. All 11 block totals unchanged to the cent
  (verified twice — once by the script, once by reading the sheet back through
  `gviz` and re-summing against each block's own header total), all 158
  HYPERLINK formulas preserved as formulas, row counts identical.
  The Tools date column had three display formats (`1/11/26`, `01/08/26`,
  `2/18/2026`) — all genuine date VALUES, just inconsistently formatted, which
  `year(C)` resolving on all 72 rows confirmed before anything was touched.
  Normalized to `MM/dd/yy` per Paul's call. The two undated rows (Website/Apify
  $29.00, Interest/420 Alyssa) sit at the bottom of their blocks.
  Backup tab **"RECAST BIZ backup 2026-08-25 1350"** left in place — delete it
  once the result looks right. A re-run now reports 0 moves in every block.
  Noticed in passing, NOT fixed: the deployed sheet-writer project does not
  match local `receipts-sheet.gs` — the remote is missing `readRecent_` and
  `blockHasRow_` (the writer v8 changes the 2026-08-24 entry describes) and its
  comments are UTF-8-mangled from a hand-paste. Worth verifying whether the
  sheet-based duplicate check is actually live.

- **2026-08-24 (PM)** — **Pre-receipts@ backfill (Jan 1 – May 24).** Established
  that `receipts@` only ever received mail from **2026-06-22**, and that
  ingestion effectively starts **2026-05-25** (the 90-day lookback at go-live),
  leaving Jan 1 – May 24 uncovered. A read-only `backfill-scan.gs` in the
  Bookkeeper project swept **1,999 messages** across that window (deliberately
  NOT keyword-filtered) and dumped them to Drive for off-script review; RECAST
  BIZ was read in full via the sheet's `gviz` endpoint and verified block-by-block
  against its header totals.
  Key finding: inside the gap the tab held **only 61 Tools + 6 Meals rows, all
  hand-entered** — the other eight categories were empty, each starting only when
  the automation did. Paul reviewed the findings doc and approved: property/rehab
  costs stay OFF RECAST BIZ (they belong on the property tabs), Tools + Meals
  untouched, CoreLogic Stripe payments in, the $7,800 Matthew Beard payment,
  AcesPhoto and Sunstate all skipped.
  `backfillRun()` then posted an **explicit list of 47 Gmail message ids** to the
  ingest — *never* by widening `SEARCH_WINDOW`, whose 90-day boundary this
  exercise confirms is load-bearing (those 61 Tools rows are exactly the
  collision it prevents). All 47 accepted (202), 0 failed, 0 errored, 0 stuck.
  **Filed: 24 rows / $2,077.19** — Travel +11/$1,826.29, Subscriptions
  +6/$138.00, Business +7/$112.90. Tools and Meals unchanged to the cent.
  24 items parked in Pending for individual judgement (mostly `[Personal]` Uber
  rides, plus Adobe/Microsoft held as suspected recurring-amount twins and two
  LGS receipts held on a subtotal mismatch).
  Notable: the four Driversnote invoices, unpriceable from previews, resolved to
  **$12.00/mo** once the bodies were read. Both VistaPrint orders (05-08 $179.98,
  05-13 $194.83) were pulled from the run before it started — the same day carries
  two cancellation notices for order `VP_WX7TV54F` and a **$406.04 merchandise
  credit**, which nets ambiguously. **Paul's call 2026-08-24: leave VistaPrint
  alone.** Marketing therefore stays empty for Jan–May by decision, not by
  oversight — don't "fix" it in a later pass.
  Threads were **not** labelled `receipts-done`: the ingest is idempotent by
  message id, and labelling ordinary inbox mail would pollute the poller's view.
  `backfill-scan.gs` is still in the project (entry point parked on the
  read-only `backfillVerify`) — delete it once the Pending tail is triaged.

- **2026-08-24** — **June backlog reprocessed + duplicate checking now reads
  the REAL sheet.** The 59 leftovers from the stalled June system had never
  been read by the current bookkeeper (no category, tax call, SKU lookup or
  duplicate check) and their emails were labeled `receipts-done`, so the
  poller skipped them permanently. Released via `reprocessLegacy()`:
  59 records across 39 emails cleared and unlabeled, then re-ingested —
  12 more items auto-filed, the rest returned as real review items, and
  several archived photo receipts finally read (Drive shrink handled
  3.9 MB → 319 KB). Tools total unchanged at $4,690.15, confirming no
  collision with Paul's hand-entered rows.
  Prerequisite shipped first: the bookkeeper now checks duplicates against
  the **actual sheet** (writer v8 `readRecent` + `blockHasRow_`), not just the
  queue — closing the blind spot for anything typed straight onto the tab.

- **2026-08-23** — **Post-go-live queue triage.** Swept the first-day backlog:
  approved airport rideshares (Paul: PDX/DFW Ubers ARE business, despite the
  [Personal] subject tag), corrected the 06/03 Uber on the sheet to the tipped
  total $113.98, dismissed food-delivery [Personal] orders and the
  original/forward twins. Queue UI gained a **Twins filter + "Dismiss all
  shown"** bulk action (14 twins cleared in one click); the earlier
  "[Personal]" bulk bucket was REMOVED as unsafe per Paul's correction.
  New-pending 95 → 49.

- **2026-08-22 (PM)** — **GO-LIVE.** Writer v7 → RECAST BIZ; bookkeeper
  project files refreshed (poller w/ upload path + `setupTriggers()`,
  summary w/ June-backlog count line); test records reset; triggers created
  from code (poll 15 min, summary 3–4 AM Central); both inboxes drained by
  hand (~190 messages, 0 failures) onto the live tab.

- **2026-08-22 (AM)** — **Morning email live-tested.** `summary.gs` added to
  the Receipts Bookkeeper project (+ `summaryToday()` on-demand digest);
  real `dailySummary` run emailed Paul the Aug 21 digest: $3,053.72 filed,
  99 to review. Gotcha logged: the editor's function dropdown never accepts
  synthetic clicks — paste a variant whose currently-selected function calls
  the target, run, re-paste clean.

- **2026-08-21 (PM 4)** — **Attachments ride Blobs; photo backlog unlocked;
  PROOF PASS PASSED.** Root-caused why photos never worked: background
  functions have a ~256 KB async-invocation request cap (regular functions:
  6 MB) — every photo 413-bounced at the edge, silently, forever. New
  `receipts-upload.mjs` (sync) parks attachment bytes in Blobs; poller
  uploads first and sends the ingest blob references; ingest loads + deletes
  them. Poller also shrinks >3 MB photos via a Drive round-trip (Drive scope
  granted). Final rerun: zero doubled rows (writer gate verified under ~11
  simultaneous twin pairs), Home Depot photo itemized 6/6 with per-line tax,
  ~7 previously-invisible photo receipts surfaced (tools, gas, thermostat,
  court packet w/ handwriting). Paul's "test" email trashed per instruction.
- **2026-08-21 (PM 3)** — **Duplicate race fix v2: writer-side serialized
  gate.** Run-2 rerun showed fix v1 insufficient (twins race within seconds;
  9 pairs re-doubled). Moved the gate into `receipts-sheet.gs` inside its
  ScriptLock (CacheService 6h memory, msgId-aware, force for human Approve) —
  writer **v6** deployed; ingest holds writer-rejected twins; approve sends
  force. Poller attachment cap 4→3 MB (a ~4 MB photo 413-bounced). Projects
  renamed: "Receipts Sheet Writer" (id recorded). Proof pass pending.
- **2026-08-21 (PM 2)** — **Concurrent-duplicate race fixed.** Filing-time
  just-filed guard (same vendor+amount recorded by another message within 6h
  → held as suspected duplicate), envelopes persisted immediately after each
  sheet write, model-note sanitization (strips leaked schema-error/JSON
  fragments). Queue page: "Reset test records" button deletes all
  bookkeeper-era records for a fresh rerun. Deployed to the alias; proof pass
  (with a big Home Depot receipt from Paul) pending.
- **2026-08-21 (PM)** — **TEST-tab testing method + full-backlog test run.**
  Testing reframed per Paul: the TEST tab is the verification surface; the
  queue is the exception lane only. `testPollBatch` `BATCH` 10→50; ran the
  whole backlog (64 msgs) → 19 rows/$1,687.91 auto-filed to TEST, all
  personal/uncertain items held. Found the concurrent-ingest duplicate race
  (6 double-filed pairs). Queue UI: era badges ("June backlog"/"Test item"),
  All/New/June sub-filter on Pending, confidence badge + why-note rendering,
  sheet-cell/auto-filed/travel chips; seed button removed. Apps Script
  project renamed "Receipts Bookkeeper".
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
