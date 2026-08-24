/****************************************************************
 * Recast Properties — Receipts sheet writer
 *
 * Standalone Apps Script web app. Receives POSTs from
 * netlify/functions/receipts-data.mjs (the receipts queue Approve action) and
 * appends an approved line item into the matching CATEGORY BLOCK on the
 * expense sheet.
 *
 * The sheet is a grid of 5-column blocks: each block has a header row
 * [ Category , (blank) , (blank) , (blank) , Total ] and data rows
 * [ Vendor , Date , Description , Link , Price ]. We locate a block by its header
 * text and write into the first empty row inside that block's 5 columns — we
 * NEVER insert a full sheet row (that would shove neighboring blocks sideways).
 * "Link" is a clickable HYPERLINK to the source email.
 *
 * Auth: a shared token (Script Property WEBHOOK_SECRET) sent in the POST body,
 * matching RECEIPTS_SHEET_TOKEN on the Netlify side.
 *
 * Setup:
 *   1. New standalone Apps Script project (script.google.com).
 *   2. Project Settings -> Script Properties -> add WEBHOOK_SECRET = <the token>.
 *   3. Deploy -> New deployment -> Web app -> Execute as: me,
 *      Who has access: Anyone. Copy the /exec URL -> Netlify RECEIPTS_SHEET_URL.
 *
 * Actions (POST JSON, body.token must match WEBHOOK_SECRET):
 *   { action:"inspect" }  -> layout of every category block (for setup/debug)
 *   { action:"append", category, vendor, date, item, link, amount,
 *     msgId?, force? } -> writes a row
 *
 * Duplicate gate (2026-08-21): doPost already serializes on a ScriptLock, so
 * this is the ONE place concurrent ingests can be reliably deduplicated —
 * Netlify-side checks proved insufficient (twin emails extract in near-
 * identical time and race each other; 9 pairs double-filed in batch testing).
 * Inside the lock, a CacheService memory of recent appends (vendor|amount|date,
 * 6h TTL) rejects a row already written by a DIFFERENT msgId with
 * { duplicate:true, existing:<cell> } — the ingest holds that item for review.
 * The same msgId may repeat a key (one receipt legitimately listing identical
 * lines), and force:true (human Approve) always writes.
 ****************************************************************/

const CONFIG = {
  SPREADSHEET_ID: '1isEbfNKPO32Wpf08EtLkNHX85c0rTIl8tpH9bUdgQbs',
  TAB_NAME: 'RECAST BIZ'   // live tab (was 'TEST' during build/verify)
};

// The destination category blocks (must match the queue dropdown).
const CATEGORIES = ['Tools','Materials','Marketing','Meals','Travel','Office','Gas/Truck/Trailer','Subscriptions','Website','Business','Interest'];

function doGet() {
  return jsonResponse_({ ok: true, message: 'Recast receipts sheet writer is live.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    const expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    if (!expected) return jsonResponse_({ ok: false, error: 'Missing script property WEBHOOK_SECRET' }, 500);

    const bodyText = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
    let data = {};
    try { data = bodyText ? JSON.parse(bodyText) : {}; }
    catch (err) { return jsonResponse_({ ok: false, error: 'Invalid JSON' }, 400); }

    const token = data.token || (e && e.parameter && e.parameter.token) || '';
    if (token !== expected) return jsonResponse_({ ok: false, error: 'Unauthorized' }, 401);

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.TAB_NAME);
    if (!sheet) return jsonResponse_({ ok: false, error: 'Tab "' + CONFIG.TAB_NAME + '" not found' }, 404);

    if (data.action === 'inspect') return inspect_(sheet);
    if (data.action === 'readRecent') return readRecent_(sheet, data);
    return append_(sheet, data);
  } catch (err) {
    console.error('RECEIPTS-SHEET ERROR: ' + String(err && err.stack ? err.stack : err));
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

// ---- helpers ----------------------------------------------------------------

function isEmpty_(v) { return v === '' || v === null || v === undefined; }

// A "block header" row: name in the vendor column, but the Date and Item cells
// empty (data rows always have a Date and Item). Used to detect where one block
// ends and the next begins.
function isHeaderRow_(values, r, col) {
  return !isEmpty_(values[r][col]) && isEmpty_(getCell_(values, r, col + 1)) && isEmpty_(getCell_(values, r, col + 2));
}

function getCell_(values, r, c) {
  const row = values[r];
  return (row && c < row.length) ? row[c] : '';
}

// Find the header cell (0-indexed row/col) for a category, matched case-insensitively.
function findHeader_(values, category) {
  const target = String(category || '').trim().toLowerCase();
  if (!target) return null;
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      if (String(values[r][c]).trim().toLowerCase() === target) return { row: r, col: c };
    }
  }
  return null;
}

// Find the row (0-indexed) to write the next item into for a block whose header
// is at (hRow, col). Returns { row } or { error }.
function nextWriteRow_(values, hRow, col) {
  for (let r = hRow + 1; r < values.length; r++) {
    const vEmpty = isEmpty_(getCell_(values, r, col));
    const dEmpty = isEmpty_(getCell_(values, r, col + 1));
    const iEmpty = isEmpty_(getCell_(values, r, col + 2));
    if (vEmpty && dEmpty && iEmpty) return { row: r };          // an empty row in the block
    if (isHeaderRow_(values, r, col)) {                          // next block, no gap left
      return { error: 'No empty row before the next block — add a blank row under this block.' };
    }
    // otherwise a data row: keep scanning down
  }
  return { row: values.length };  // block runs to the bottom of the used range; write just below
}

// Normalize a date cell to MMDDYY digits so a hand-typed "07/14/26", a real
// Date object, and an incoming "07/14/26" all compare equal.
function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MMddyy');
  const digits = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  if (digits.length === 8) return digits.slice(0, 4) + digits.slice(6);  // MMDDYYYY -> MMDDYY
  return digits;
}

function normVendor_(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function normAmount_(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n.toFixed(2) : '';
}

// Does this category block ALREADY contain a row with the same vendor + date +
// amount? This is the deterministic backstop that catches rows the queue never
// knew about — above all the ones Paul typed into the sheet by hand (confirmed
// 2026-08-23: a fair number of Tools purchases were entered directly during the
// June-system stall). The CacheService gate only remembers this run; the sheet
// remembers everything.
function blockHasRow_(values, hRow, col, vendor, date, amount) {
  const wantV = normVendor_(vendor), wantD = normDate_(date), wantA = normAmount_(amount);
  if (!wantV || !wantA) return null;
  for (let r = hRow + 1; r < values.length; r++) {
    if (isHeaderRow_(values, r, col)) break;
    const v = getCell_(values, r, col);
    if (isEmpty_(v) && isEmpty_(getCell_(values, r, col + 1))) continue;
    if (normVendor_(v) === wantV &&
        normAmount_(getCell_(values, r, col + 4)) === wantA &&
        (!wantD || normDate_(getCell_(values, r, col + 1)) === wantD)) {
      return { row: r + 1 };
    }
  }
  return null;
}

// ---- append -----------------------------------------------------------------

// Cache key identifying a written charge: vendor + amount + date. Twins (an
// original and its Fwd:) extract to identical values; distinct charges differ.
function dupKey_(data) {
  const vendor = String(data.vendor || '').trim().toLowerCase().slice(0, 120);
  const amount = parseFloat(String(data.amount).replace(/[^0-9.\-]/g, ''));
  const date = String(data.date || '').replace(/[^0-9]/g, '');
  if (!vendor || !isFinite(amount)) return '';
  return 'dup:' + vendor + '|' + amount.toFixed(2) + '|' + date;
}

function append_(sheet, data) {
  const category = String(data.category || '').trim();
  if (!category) return jsonResponse_({ ok: false, error: 'Missing category' }, 400);

  // Duplicate gate — runs inside doPost's ScriptLock, so concurrent appends
  // are checked strictly one at a time.
  const dupKey = dupKey_(data);
  const msgId = String(data.msgId || '').trim();
  const force = data.force === true || data.force === 'true';
  if (dupKey && !force) {
    const prior = CacheService.getScriptCache().get(dupKey);
    if (prior) {
      const sep = prior.indexOf('|');
      const priorMsgId = sep === -1 ? '' : prior.slice(0, sep);
      const priorCell = sep === -1 ? prior : prior.slice(sep + 1);
      if (!msgId || priorMsgId !== msgId) {
        return jsonResponse_({
          ok: false, duplicate: true, existing: priorCell,
          error: 'Same vendor + amount + date already written' + (priorCell ? ' at ' + priorCell : '') + ' by another receipt'
        }, 409);
      }
      // Same message repeating an identical line (a receipt can legitimately
      // list the same product twice) -> allow.
    }
  }

  const values = sheet.getDataRange().getValues();
  const hdr = findHeader_(values, category);
  if (!hdr) return jsonResponse_({ ok: false, error: 'Category block "' + category + '" not found on tab ' + CONFIG.TAB_NAME }, 404);

  // Deterministic duplicate check against what is ACTUALLY on the sheet
  // (covers hand-entered rows the queue never saw). force:true = human Approve.
  if (!force) {
    const existingRow = blockHasRow_(values, hdr.row, hdr.col, data.vendor, data.date, data.amount);
    if (existingRow) {
      return jsonResponse_({
        ok: false, duplicate: true, existing: category + ' row ' + existingRow.row,
        error: 'This vendor + date + amount is already on the sheet at row ' + existingRow.row + ' of the ' + category + ' block'
      }, 409);
    }
  }

  const target = nextWriteRow_(values, hdr.row, hdr.col);
  if (target.error) return jsonResponse_({ ok: false, error: 'Block "' + category + '": ' + target.error }, 409);

  const writeRow = target.row + 1;   // to 1-indexed
  const writeCol = hdr.col + 1;      // to 1-indexed (vendor column)

  const amountNum = parseFloat(String(data.amount).replace(/[^0-9.\-]/g, ''));
  const amountCell = isFinite(amountNum) ? amountNum : clean_(data.amount);

  // Link column: a clickable HYPERLINK to the source email (blank if none).
  const url = String(data.link || '').trim().replace(/"/g, '');
  const linkCell = url ? '=HYPERLINK("' + url + '","Receipt")' : '';

  // Block columns: Vendor | Date | Description | Link | Price
  sheet.getRange(writeRow, writeCol, 1, 5).setValues([[
    clean_(data.vendor), clean_(data.date), clean_(data.item), linkCell, amountCell
  ]]);

  const a1 = sheet.getRange(writeRow, writeCol, 1, 5).getA1Notation();
  if (dupKey) {
    try { CacheService.getScriptCache().put(dupKey, msgId + '|' + a1, 21600); } catch (err) {}
  }
  return jsonResponse_({ ok: true, wrote: a1, category: category });
}

// ---- readRecent -------------------------------------------------------------
// Return what is actually recorded in the books, so the ingest can show Claude
// the REAL sheet (not just the queue) when it reasons about duplicates. Without
// this, anything entered on the sheet by hand is invisible to the bookkeeper.
function readRecent_(sheet, data) {
  const maxPerBlock = Math.max(1, Math.min(parseInt(data.maxPerBlock, 10) || 40, 200));
  const values = sheet.getDataRange().getValues();
  const out = [];
  CATEGORIES.forEach(function (cat) {
    const hdr = findHeader_(values, cat);
    if (!hdr) return;
    const rows = [];
    for (let r = hdr.row + 1; r < values.length; r++) {
      if (isHeaderRow_(values, r, hdr.col)) break;
      const v = getCell_(values, r, hdr.col);
      if (isEmpty_(v) && isEmpty_(getCell_(values, r, hdr.col + 1))) continue;
      rows.push({
        category: cat,
        vendor: String(v == null ? '' : v).trim(),
        date: normDate_(getCell_(values, r, hdr.col + 1)),
        item: String(getCell_(values, r, hdr.col + 2) || '').slice(0, 70),
        amount: normAmount_(getCell_(values, r, hdr.col + 4))
      });
    }
    // Newest entries sit at the bottom of a block; keep the tail.
    out.push.apply(out, rows.slice(-maxPerBlock));
  });
  return jsonResponse_({ ok: true, tab: CONFIG.TAB_NAME, rows: out });
}

// ---- inspect ----------------------------------------------------------------

function inspect_(sheet) {
  const values = sheet.getDataRange().getValues();
  const colLetter = function (c0) { return sheet.getRange(1, c0 + 1).getA1Notation().replace(/\d+/g, ''); };
  const out = [];
  CATEGORIES.forEach(function (cat) {
    const hdr = findHeader_(values, cat);
    if (!hdr) { out.push({ category: cat, found: false }); return; }
    // count existing contiguous data rows
    let dataRows = 0;
    for (let r = hdr.row + 1; r < values.length; r++) {
      if (isHeaderRow_(values, r, hdr.col)) break;
      if (isEmpty_(getCell_(values, r, hdr.col)) && isEmpty_(getCell_(values, r, hdr.col + 1))) break;
      dataRows++;
    }
    const target = nextWriteRow_(values, hdr.row, hdr.col);
    // headroom: empty rows from the target down before the next header / used-range end
    let headroom = 0;
    if (!target.error) {
      for (let r = target.row; r < values.length; r++) {
        if (isHeaderRow_(values, r, hdr.col)) break;
        if (!isEmpty_(getCell_(values, r, hdr.col))) break;
        headroom++;
      }
      if (target.row >= values.length) headroom = 1000; // open space below the used range
    }
    out.push({
      category: cat,
      found: true,
      headerCell: colLetter(hdr.col) + (hdr.row + 1),
      columns: colLetter(hdr.col) + '–' + colLetter(hdr.col + 4),
      existingItems: dataRows,
      nextWrite: target.error ? ('BLOCKED: ' + target.error) : (colLetter(hdr.col) + (target.row + 1)),
      headroom: headroom
    });
  });
  return jsonResponse_({ ok: true, tab: CONFIG.TAB_NAME, blocks: out });
}

// ---- one-time migration: add the "Link" column to every block ---------------
// Inserts a blank column between Description and Price in each category block,
// turning 4-column blocks (Vendor|Date|Description|Price) into 5-column blocks
// (Vendor|Date|Description|Link|Price). Run from the editor. TEST FIRST, then
// eyeball the tab (totals + header bars) before running on the live tab.

function addLinkColumns_TEST() { return addLinkColumns_('TEST'); }
function addLinkColumns_LIVE() { return addLinkColumns_('RECAST BIZ'); }

function addLinkColumns_(tabName) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);

  const values = sheet.getDataRange().getValues();
  const blocks = [];
  CATEGORIES.forEach(function (cat) {
    if (cat === 'Interest') return; // Interest stays manual / untouched
    const hdr = findHeader_(values, cat);
    if (hdr) blocks.push({ category: cat, col: hdr.col });
  });

  // Insert right-to-left so each insert doesn't shift the blocks we haven't done.
  blocks.sort(function (a, b) { return b.col - a.col; });

  const done = [];
  blocks.forEach(function (b) {
    // Price is the 4th column of the current 4-wide block: 1-indexed = col + 4.
    // Insert a blank column before it -> that blank becomes the Link column.
    sheet.insertColumnBefore(b.col + 4);
    done.push(b.category);
  });
  SpreadsheetApp.flush();
  console.log('Added Link column on "' + tabName + '" for: ' + done.join(', '));
  return done;
}

// ---- shared -----------------------------------------------------------------

function clean_(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  if (/^[=+\-@]/.test(text)) text = "'" + text; // block Sheets formula injection
  return text;
}

function jsonResponse_(obj, statusCode) {
  if (statusCode) obj.statusCode = statusCode;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
