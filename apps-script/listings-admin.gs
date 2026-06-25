/****************************************************************
 * Recast Properties — Listings admin sink
 *
 * Standalone Apps Script web app. Lets the website admin page (via
 * netlify/functions/admin-listings.js) READ and WRITE rows in the listings
 * Google Sheet the public site already reads. Same shared-secret pattern as
 * call-summary.gs — auth is a token (Script Property WEBHOOK_SECRET) that must
 * match LISTINGS_WEBHOOK_TOKEN on the Netlify side.
 *
 * It only touches the listings tab; it never emails or touches the calendar.
 *
 * Setup:
 *   1. New standalone Apps Script project (script.google.com).
 *   2. Paste this file in.
 *   3. Project Settings -> Script Properties -> add WEBHOOK_SECRET = <a long
 *      random string> (this same value goes in Netlify as LISTINGS_WEBHOOK_TOKEN).
 *   4. Deploy -> New deployment -> Web app -> Execute as: Me,
 *      Who has access: Anyone. Copy the /exec URL -> Netlify LISTINGS_WEBHOOK_URL.
 *   5. First run will prompt for authorization to edit the spreadsheet — allow it.
 ****************************************************************/

const LISTINGS_CONFIG = {
  SPREADSHEET_ID: '1lpCONle2BfovuOu7_9k17hYwCuDKxnvE0ddeQLdGI5k',
  SHEET_GID: 701320222, // the published listings tab
  ID_COLUMN: 'id'
};

function doGet(e) {
  const expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  const token = (e && e.parameter && e.parameter.token) || '';
  if (!expected || token !== expected) {
    return jsonOut_({ ok: false, error: 'Unauthorized' });
  }
  try {
    const { headers, rows } = readAll_();
    return jsonOut_({ ok: true, headers: headers, rows: rows });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    const expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    const bodyText = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
    let data = {};
    try { data = bodyText ? JSON.parse(bodyText) : {}; }
    catch (err) { return jsonOut_({ ok: false, error: 'Invalid JSON' }); }

    const token = data.token || (e && e.parameter && e.parameter.token) || '';
    if (!expected || token !== expected) return jsonOut_({ ok: false, error: 'Unauthorized' });

    if (data.action === 'delete') return deleteById_(data.id);
    if (data.action === 'upsert') return upsert_(data.listing || {});
    return jsonOut_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.stack ? err.stack : err) });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(LISTINGS_CONFIG.SPREADSHEET_ID);
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === LISTINGS_CONFIG.SHEET_GID) return sheets[i];
  }
  return ss.getSheets()[0]; // fallback: first tab
}

function readAll_() {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  if (!values.length) return { headers: [], rows: [] };
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(function (c) { return String(c).trim() === ''; })) continue; // skip blank
    const o = {};
    headers.forEach(function (h, i) { o[h] = row[i] == null ? '' : String(row[i]); });
    rows.push(o);
  }
  return { headers: headers, rows: rows };
}

function upsert_(listing) {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const idCol = headers.indexOf(LISTINGS_CONFIG.ID_COLUMN);
  if (idCol === -1) return jsonOut_({ ok: false, error: 'No "id" column in sheet' });

  const id = clean_(listing[LISTINGS_CONFIG.ID_COLUMN]);
  if (!id) return jsonOut_({ ok: false, error: 'Listing is missing an id' });

  // Build the row in the sheet's existing column order.
  const rowArr = headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(listing, h) ? clean_(listing[h]) : '';
  });

  // Find an existing row with this id.
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]).trim() === id) {
      // Preserve any columns the admin didn't send (only overwrite provided keys).
      const merged = headers.map(function (h, i) {
        return Object.prototype.hasOwnProperty.call(listing, h) ? clean_(listing[h]) : values[r][i];
      });
      sheet.getRange(r + 1, 1, 1, headers.length).setValues([merged]);
      return jsonOut_({ ok: true, id: id, updated: true });
    }
  }

  sheet.appendRow(rowArr);
  return jsonOut_({ ok: true, id: id, created: true });
}

function deleteById_(id) {
  id = clean_(id);
  if (!id) return jsonOut_({ ok: false, error: 'Missing id' });
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const idCol = headers.indexOf(LISTINGS_CONFIG.ID_COLUMN);
  if (idCol === -1) return jsonOut_({ ok: false, error: 'No "id" column' });
  for (let r = values.length - 1; r >= 1; r--) {
    if (String(values[r][idCol]).trim() === id) {
      sheet.deleteRow(r + 1);
      return jsonOut_({ ok: true, id: id, deleted: true });
    }
  }
  return jsonOut_({ ok: false, error: 'id not found' });
}

function clean_(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  if (/^[=+\-@]/.test(text)) text = "'" + text; // block Sheets formula injection
  return text;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
