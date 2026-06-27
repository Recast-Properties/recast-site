/****************************************************************
 * Recast Properties — Receipts sheet writer
 *
 * Standalone Apps Script web app. Receives POSTs from
 * netlify/functions/receipts-data.mjs (the receipts queue Approve action) and
 * appends an approved line item into the matching CATEGORY BLOCK on the
 * expense sheet.
 *
 * The sheet is a grid of 4-column blocks: each block has a header row
 * [ Category , (blank) , (blank) , Total ] and data rows
 * [ Vendor , Date , Item , Amount ]. We locate a block by its header text and
 * write into the first empty row inside that block's 4 columns — we NEVER
 * insert a full sheet row (that would shove neighboring blocks sideways).
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
 *   { action:"append", category, vendor, date, item, amount }  -> writes a row
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

// ---- append -----------------------------------------------------------------

function append_(sheet, data) {
  const category = String(data.category || '').trim();
  if (!category) return jsonResponse_({ ok: false, error: 'Missing category' }, 400);

  const values = sheet.getDataRange().getValues();
  const hdr = findHeader_(values, category);
  if (!hdr) return jsonResponse_({ ok: false, error: 'Category block "' + category + '" not found on tab ' + CONFIG.TAB_NAME }, 404);

  const target = nextWriteRow_(values, hdr.row, hdr.col);
  if (target.error) return jsonResponse_({ ok: false, error: 'Block "' + category + '": ' + target.error }, 409);

  const writeRow = target.row + 1;   // to 1-indexed
  const writeCol = hdr.col + 1;      // to 1-indexed (vendor column)

  const amountNum = parseFloat(String(data.amount).replace(/[^0-9.\-]/g, ''));
  const amountCell = isFinite(amountNum) ? amountNum : clean_(data.amount);

  sheet.getRange(writeRow, writeCol, 1, 4).setValues([[
    clean_(data.vendor), clean_(data.date), clean_(data.item), amountCell
  ]]);

  const a1 = sheet.getRange(writeRow, writeCol, 1, 4).getA1Notation();
  return jsonResponse_({ ok: true, wrote: a1, category: category });
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
      columns: colLetter(hdr.col) + '–' + colLetter(hdr.col + 3),
      existingItems: dataRows,
      nextWrite: target.error ? ('BLOCKED: ' + target.error) : (colLetter(hdr.col) + (target.row + 1)),
      headroom: headroom
    });
  });
  return jsonResponse_({ ok: true, tab: CONFIG.TAB_NAME, blocks: out });
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
