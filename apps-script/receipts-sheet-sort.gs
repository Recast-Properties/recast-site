/****************************************************************
 * Recast Properties — RECAST BIZ block sorter
 *
 * Maintenance tool for the expense sheet written by receipts-sheet.gs.
 * Sorts the rows INSIDE each category block by date, oldest at the top,
 * newest at the bottom — then normalizes the date column's display format.
 *
 * Why this is needed: the bookkeeper appends each row to the first empty
 * row in its block, so rows land in the order they were PROCESSED, not the
 * order they were DATED. Backfills and reprocessed batches make that drift
 * badly. Re-run this whenever a block looks out of order.
 *
 * Layout it assumes (verified 2026-08-25 against the live tab):
 *   Row 1 is the only header row: [ Category , _ , _ , _ , Total ].
 *   Blocks sit side by side, 5 columns each, separated by a spacer column:
 *   Tools B:F, Materials H:L, Marketing N:R, Meals T:X, Travel Z:AD,
 *   Office AF:AJ, Gas/Truck/Trailer AL:AP, Subscriptions AR:AV,
 *   Website AX:BB, Business BD:BH, Interest BJ:BN.
 *   Block columns are located by NAME in row 1, never hardcoded, so an
 *   inserted column can't silently shift the sorter onto the wrong data.
 *   Data rows are [ Vendor , Date , Description , Link , Price ]; Link is a
 *   HYPERLINK formula and is carried across the sort as a formula.
 *
 * Safety rails:
 *   - Duplicates the whole tab as a timestamped backup before writing.
 *   - Per-cell number formats travel WITH their row (the Price column has
 *     mixed currency/plain formatting that would otherwise get reshuffled).
 *   - Re-reads each block immediately before writing and aborts if anything
 *     changed since the read — the 15-minute poller can append mid-run.
 *   - Verifies the price total and row count of every block are identical
 *     after the sort, and throws if any block moved by more than a cent.
 *   - Rows with no date are parked at the BOTTOM of their block, keeping
 *     their existing relative order.
 *
 * HOW TO RUN: there is deliberately ONE entry point, sortRecastBizByDate(),
 * so the editor always preselects the right function (its function dropdown
 * ignores synthetic clicks — see RECEIPTS.md). Flip SORT_CFG.DRY_RUN to
 * choose the mode: leave it true to get a full report of what WOULD move
 * without writing anything, then set it false and run again for real.
 ****************************************************************/

const SORT_CFG = {
  SPREADSHEET_ID: '1isEbfNKPO32Wpf08EtLkNHX85c0rTIl8tpH9bUdgQbs',
  TAB_NAME: 'RECAST BIZ',
  HEADER_ROW: 1,
  WIDTH: 5,          // Vendor | Date | Description | Link | Price
  DATE_OFFSET: 1,    // 0-based offset of Date within the block
  PRICE_OFFSET: 4,   // 0-based offset of Price within the block
  DATE_FORMAT: 'MM/dd/yy',
  BACKUP: true,
  DRY_RUN: true,    // <-- true = report only, nothing written. Set false to apply.
  CATEGORIES: ['Tools', 'Materials', 'Marketing', 'Meals', 'Travel', 'Office',
               'Gas/Truck/Trailer', 'Subscriptions', 'Website', 'Business', 'Interest']
};

// ---- entry point ------------------------------------------------------------
// Keep this the FIRST function in the file: the Apps Script editor preselects
// it, and its dropdown cannot be driven programmatically.

function sortRecastBizByDate() { return runSort_(SORT_CFG.DRY_RUN); }

// ---- main -------------------------------------------------------------------

function runSort_(dryRun) {
  const ss = SpreadsheetApp.openById(SORT_CFG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SORT_CFG.TAB_NAME);
  if (!sheet) throw new Error('Tab "' + SORT_CFG.TAB_NAME + '" not found');

  const blocks = findBlocks_(sheet);
  const missing = SORT_CFG.CATEGORIES.filter(function (c) {
    return !blocks.some(function (b) { return b.name === c; });
  });
  if (missing.length) throw new Error('Category header(s) not found in row 1: ' + missing.join(', '));

  log_('=== RECAST BIZ sort by date ' + (dryRun ? '(DRY RUN — nothing will be written)' : '(LIVE)') + ' ===');
  log_('Found ' + blocks.length + ' blocks: ' + blocks.map(function (b) {
    return b.name + '@' + colLetter_(b.col);
  }).join(', '));

  let backupName = null;
  if (!dryRun && SORT_CFG.BACKUP) {
    backupName = SORT_CFG.TAB_NAME + ' backup ' +
      Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HHmm');
    sheet.copyTo(ss).setName(backupName);
    log_('Backup tab created: "' + backupName + '"');
  }

  const report = blocks.map(function (b) { return sortBlock_(sheet, b, dryRun); });

  log_('');
  log_('--- summary ---');
  report.forEach(function (r) {
    log_(pad_(r.name, 20) + pad_(r.rows + ' rows', 10) +
         pad_(r.moved + ' moved', 12) +
         'total ' + r.totalBefore.toFixed(2) +
         (r.totalAfter === null ? '' : ' -> ' + r.totalAfter.toFixed(2)) +
         (r.undated ? '   (' + r.undated + ' undated -> bottom)' : '') +
         (r.warning ? '   !! ' + r.warning : ''));
  });
  if (backupName) log_('Backup: "' + backupName + '" — delete it once you are happy with the result.');
  log_(dryRun ? 'DRY RUN complete. Nothing was written.' : 'Sort complete.');
  return report;
}

// ---- one block --------------------------------------------------------------

function sortBlock_(sheet, block, dryRun) {
  const firstRow = SORT_CFG.HEADER_ROW + 1;
  const lastRow = sheet.getLastRow();
  const height = lastRow - firstRow + 1;
  const name = block.name;

  if (height < 1) return { name: name, rows: 0, moved: 0, undated: 0, totalBefore: 0, totalAfter: 0, warning: '' };

  const range = sheet.getRange(firstRow, block.col, height, SORT_CFG.WIDTH);
  const values = range.getValues();
  const formulas = range.getFormulas();
  const formats = range.getNumberFormats();

  // Keep only rows that actually hold something; blanks are dropped to the end.
  const rows = [];
  let sawBlank = false, gapWarning = '';
  for (let i = 0; i < values.length; i++) {
    if (isBlankRow_(values[i])) { sawBlank = true; continue; }
    if (sawBlank) gapWarning = 'had blank rows mid-block (compacted)';
    rows.push({
      values: values[i].slice(),
      formulas: formulas[i].slice(),
      formats: formats[i].slice(),
      date: toDate_(values[i][SORT_CFG.DATE_OFFSET]),
      order: rows.length
    });
  }

  const totalBefore = sumPrice_(rows);
  const undated = rows.filter(function (r) { return !r.date; }).length;

  // Oldest first. Undated rows keep their relative order and sink to the bottom.
  const sorted = rows.slice().sort(function (a, b) {
    if (!a.date && !b.date) return a.order - b.order;
    if (!a.date) return 1;
    if (!b.date) return -1;
    const d = a.date.getTime() - b.date.getTime();
    return d !== 0 ? d : a.order - b.order;
  });

  let moved = 0;
  sorted.forEach(function (r, i) { if (r.order !== i) moved++; });

  if (dryRun) {
    log_('');
    const nFormulas = rows.filter(function (r) { return !!r.formulas[3]; }).length;
    log_('[' + name + '] ' + rows.length + ' rows, ' + moved + ' would move, total ' + totalBefore.toFixed(2) +
         ', ' + nFormulas + ' HYPERLINK formulas intact');
    previewFirstLast_(sorted);
    return { name: name, rows: rows.length, moved: moved, undated: undated,
             totalBefore: totalBefore, totalAfter: null, warning: gapWarning };
  }

  if (moved === 0 && !needsDateReformat_(sheet, block, rows.length)) {
    return { name: name, rows: rows.length, moved: 0, undated: undated,
             totalBefore: totalBefore, totalAfter: totalBefore, warning: gapWarning };
  }

  // Guard against the 15-minute poller appending between our read and write.
  const recheck = range.getValues();
  if (JSON.stringify(recheck) !== JSON.stringify(values)) {
    throw new Error('[' + name + '] block changed while sorting (an ingest probably landed). ' +
                    'Nothing was written for this block — re-run.');
  }

  const outValues = [], outFormats = [];
  for (let i = 0; i < height; i++) {
    if (i < sorted.length) {
      const r = sorted[i];
      outValues.push(r.values.map(function (v, c) { return r.formulas[c] ? r.formulas[c] : v; }));
      outFormats.push(r.formats.slice());
    } else {
      outValues.push(new Array(SORT_CFG.WIDTH).fill(''));
      outFormats.push(formats[i] ? formats[i].slice() : new Array(SORT_CFG.WIDTH).fill('General'));
    }
  }

  range.setValues(outValues);
  range.setNumberFormats(outFormats);

  // Normalize the date column so every row in every block reads the same way.
  if (rows.length) {
    sheet.getRange(firstRow, block.col + SORT_CFG.DATE_OFFSET, rows.length, 1)
         .setNumberFormat(SORT_CFG.DATE_FORMAT);
  }
  SpreadsheetApp.flush();

  // Prove nothing was lost: same row count, same money.
  const after = sheet.getRange(firstRow, block.col, height, SORT_CFG.WIDTH).getValues();
  const afterRows = after.filter(function (v) { return !isBlankRow_(v); });
  const totalAfter = sumPrice_(afterRows.map(function (v) { return { values: v }; }));

  if (afterRows.length !== rows.length) {
    throw new Error('[' + name + '] row count changed ' + rows.length + ' -> ' + afterRows.length +
                    ' — RESTORE FROM THE BACKUP TAB.');
  }
  if (Math.abs(totalAfter - totalBefore) > 0.005) {
    throw new Error('[' + name + '] total changed ' + totalBefore.toFixed(2) + ' -> ' + totalAfter.toFixed(2) +
                    ' — RESTORE FROM THE BACKUP TAB.');
  }

  return { name: name, rows: rows.length, moved: moved, undated: undated,
           totalBefore: totalBefore, totalAfter: totalAfter, warning: gapWarning };
}

// ---- helpers ----------------------------------------------------------------

function findBlocks_(sheet) {
  const lastCol = sheet.getLastColumn();
  const header = sheet.getRange(SORT_CFG.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const wanted = {};
  SORT_CFG.CATEGORIES.forEach(function (c) { wanted[c.trim().toLowerCase()] = c; });

  const blocks = [];
  for (let i = 0; i < header.length; i++) {
    const key = String(header[i] || '').trim().toLowerCase();
    if (wanted[key] && !blocks.some(function (b) { return b.name === wanted[key]; })) {
      blocks.push({ name: wanted[key], col: i + 1 });
    }
  }
  return blocks;
}

function isBlankRow_(row) {
  return row.every(function (v) { return v === '' || v === null || v === undefined; });
}

function toDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const d = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    return isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function sumPrice_(rows) {
  return rows.reduce(function (t, r) { return t + toNumber_(r.values[SORT_CFG.PRICE_OFFSET]); }, 0);
}

// True when any date cell in the block is not already on the canonical format.
function needsDateReformat_(sheet, block, count) {
  if (!count) return false;
  const fmts = sheet.getRange(SORT_CFG.HEADER_ROW + 1, block.col + SORT_CFG.DATE_OFFSET, count, 1)
                    .getNumberFormats();
  return fmts.some(function (f) { return f[0] !== SORT_CFG.DATE_FORMAT; });
}

function previewFirstLast_(sorted) {
  const show = function (r) {
    return '   ' + pad_(r.date ? Utilities.formatDate(r.date, 'America/Chicago', 'MM/dd/yy') : '(no date)', 12) +
           pad_(String(r.values[0]).slice(0, 30), 32) +
           String(r.values[SORT_CFG.PRICE_OFFSET]);
  };
  sorted.slice(0, 3).forEach(function (r) { log_(show(r)); });
  if (sorted.length > 6) log_('   ...');
  sorted.slice(Math.max(3, sorted.length - 3)).forEach(function (r) { log_(show(r)); });
}

function pad_(s, n) {
  s = String(s);
  return s.length >= n ? s + '  ' : s + new Array(n - s.length + 1).join(' ');
}

function colLetter_(col) {
  let s = '';
  while (col > 0) { const m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

function log_(msg) { console.log(msg); }
