# Handoff — receipts bookkeeper: make the model the director (2026-09-09)

Written in Cowork; continuing in Claude Code from this folder
(`~/Desktop/Claude/Recast-site`). Read `RECEIPTS.md` first (the 2026-09-09
change-log entry and the "Test the bookkeeper's READ" operating note).

## Why
A Tom Thumb pump-display photo (Gmail msg `1a07796cc6f0bfa8`, 09/06) sat in
Pending at $70.90 medium-confidence. The display actually reads **$78.98 for
22.318 gal** (22.318 x $3.539 = $78.98 to the cent; $70.90 would need an
impossible $3.177/gal — the model even wrote that in its own note). Paul
approved it by hand at $78.98 (RECAST BIZ AL16:AP16, Gas/Truck/Trailer, no
tax). Paul's standing principle, stated today: **the Claude API call should be
the director that reasons with tools, not a one-shot role player fed
hand-coded rules.** The old ingest gave the model one downscaled image, a
pre-chewed text dump of the books, and web search — no way to look closer or
look anything up. Same complaint applies to the title scraper (separate task,
later).

## What is already done (uncommitted on `main`, syntax-checked, NOT deployed)
- `netlify/functions/receipts-ingest-background.mjs`
  - `extractReceipt` is a real tool loop: adaptive extended thinking
    (`thinking: { type: "adaptive" }`), `MAX_TURNS` 20, client-side tools
    executed in-function + server-side web_search/web_fetch as before.
  - Tools: `zoom` (crop a fractional region of an image attachment with
    `jimp`, returned as an image block; small crops upscaled to >=800px,
    capped at 1568px), `read_books` (writer's `readRecent` maxPerBlock 200,
    filtered by vendor/category/days), `search_records` (queue envelopes,
    filtered by vendor/amount/days). Attachments are labeled
    `[attachment N: ...]` in the prompt so the model can name them.
  - Removed the pre-chewed `sheetBooksContext` / `recentItemsContext`
    dumps; the model pulls what it needs.
  - System prompt: new "method" section (zoom before deciding a blurry
    digit; check the books before any duplicate call; make arithmetic
    reconcile — items<->subtotal, gallons x a real x.xx9 price <-> total;
    say what you verified in notes). "high" now means "because I checked".
    All business rules unchanged (airport rides, tips, categories, tax).
  - All deterministic seatbelts kept (subtotal reconcile, txn-number
    verdicts, twin holds, RIDE-PAIR-HOLD, writer ScriptLock gate). Removing
    those is a LATER pass once the model has made them redundant.
  - New `dryRun: true` body flag: full read, no sheet write, result stored
    at `msg/dry-<id>` (envelope `dryRun: true`, msgId/sourceMsgId
    `dry-<id>`), every item Pending with note prefix
    `[DRY RUN would AUTO-FILE ... | would HOLD ... | would AUTO-DISMISS]`.
    Dry envelopes are skipped as evidence by `search_records` and the
    knownTxns/justFiled scans.
- `apps-script/receipts-poller.gs`: new `dryRunIngest()` with `MSG_IDS`
  preloaded with `1a07796cc6f0bfa8`. ASCII only (the doc warns pasting
  mangles UTF-8). Poller runs latest SAVED code, no redeploy.
- `package.json` / `package-lock.json`: `jimp@^1.6.1` added and installed
  (`node_modules/jimp` present). jimp 1.6 API used: `Jimp.read(buffer)`,
  `.clone().crop({x,y,w,h})`, `.resize({w,h})`, `.getBuffer("image/jpeg",
  {quality})` — smoke-tested in isolation, all paths incl. errors.
- `RECEIPTS.md`: architecture diagram, function table, poller row,
  operating notes, cost note, change log — all updated.
- `deploy-receipts.command`: a double-click wrapper for the deploy line,
  created only because Cowork can't type into Terminal. Not needed in
  Claude Code — delete it (or keep it if Paul likes it).

## Next steps (in order)
1. `git diff --stat` to confirm the 5 changed files + the .command file.
   `node --check netlify/functions/receipts-ingest-background.mjs`.
2. Deploy: `netlify deploy --no-build --alias receipts`
   (functions bundle from local node_modules; `--no-build` is correct).
3. Paste `dryRunIngest()` (lines ~181-212 of `receipts-poller.gs`) into the
   **Receipts Bookkeeper** Apps Script project
   (id `1c7Y3GZKeMUGltRco4-3lMzEDbw8Ykiqcw7x6aQCUK2vo422FyQ68Hei8`) and
   save. Or clasp-clone by id if that's easier — note clasp only lists
   projects it created, so use the id.
4. Run `dryRunIngest`. In ~1-2 min a card appears in the queue Pending tab
   (https://receipts--incomparable-raindrop-8f3d22.netlify.app/receipts/,
   password = ADMIN_PASSWORD). PASS = amount $78.98, Gas/Truck/Trailer,
   taxable false, high confidence, note shows it zoomed and reconciled
   (e.g. "22.318 gal x $3.539 = $78.98"), verdict "would AUTO-FILE".
   Check `netlify logs:function receipts-ingest-background` (or the
   Netlify UI) for `[ingest] tool zoom ...` / `extract done ... tools=N`
   lines and token counts.
5. If PASS: add 2-3 historically hard message ids to `MSG_IDS` (an Uber
   base/tip pair; one of the two LGS receipts held on subtotal mismatch;
   an original+"Fwd:" twin) and dry-run again. Judge by the notes.
6. Delete the dry-run cards from the queue (Pending -> the card's delete;
   `delete` truly removes them). Real records are untouched.
7. If the schema+tools+thinking combination 400s, the code already retries
   without `output_config` and loose-parses — check logs for
   "400 with output_config" and decide whether to keep the schema.
8. Commit: "receipts: model directs the read (thinking + zoom + books
   tools); dryRun test path". Update RECEIPTS.md STATUS if anything about
   the plan changed during testing.

## Things to know
- Old `MODEL` `claude-opus-5` unchanged. Expect ~3-5x tokens per receipt
  that needs zooming; fine at current volume. Paul watches token burn on
  bulk work — this is per-receipt, not bulk.
- The API downscales images to ~1568px long edge; the poller already
  shrinks >3 MB photos to ~2000px via Drive. `zoom` crops from the bytes
  the ingest holds (post-shrink), which is still far above what the model
  sees in the full frame.
- `blockHasRow_` / readRecent live in writer deployment v10 (verified live
  2026-09-03). No writer change in this work.
- Paul's working preferences: confirm plans before writing code, one task
  at a time, smallest change that completes the named task, flag scope
  drift. After this lands, the title scraper gets the same treatment as a
  separate task.
