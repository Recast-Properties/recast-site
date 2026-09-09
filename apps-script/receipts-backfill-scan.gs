/****************************************************************
 * ONE-OFF: pre-receipts@ backfill scan  (added 2026-08-24)
 *
 * READ-ONLY. Searches Gmail and writes findings to a Drive JSON file.
 * It never writes the sheet, never labels a thread, never sends mail,
 * and never POSTs to the ingest. Delete this file when the backfill is done.
 *
 * Scopes used: GmailApp (read) + DriveApp (create) -- both already granted to
 * this project, so running this triggers no new authorization prompt.
 ****************************************************************/

var BF_OUT = 'backfill-scan-step1.json';

// STEP 1 -- how far back does receipts@/travel@ actually go, and how much mail
// sits in the Jan 1 -> that-date gap? Cheap probe; sizes the real sweep.
function backfillStep1() {
  var t0 = new Date().getTime();
  var out = { generatedAt: new Date().toISOString(), earliest: {}, sizing: [] };

  ['receipts', 'travel'].forEach(function (chan) {
    var addr = chan + '@recast-properties.com';
    var threads = GmailApp.search('to:' + addr, 0, 500);
    // Results are newest-first, so the oldest messages live in the tail.
    var tail = threads.slice(Math.max(0, threads.length - 40));
    var oldest = null, matched = 0, samples = [];
    tail.forEach(function (th) {
      th.getMessages().forEach(function (m) {
        var to = (m.getTo() + ' ' + m.getCc()).toLowerCase();
        if (to.indexOf(addr) < 0) return;
        matched++;
        var d = m.getDate();
        if (!oldest || d.getTime() < oldest.getTime()) oldest = d;
        samples.push({
          date: Utilities.formatDate(d, 'America/Chicago', 'yyyy-MM-dd HH:mm'),
          from: m.getFrom().slice(0, 80),
          subject: m.getSubject().slice(0, 90)
        });
      });
    });
    samples.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    out.earliest[chan] = {
      threadsFound: threads.length,
      threadsInspected: tail.length,
      matchingMsgsInTail: matched,
      oldest: oldest ? Utilities.formatDate(oldest, 'America/Chicago', 'yyyy-MM-dd HH:mm') : null,
      oldestSamples: samples.slice(0, 12)
    };
  });

  // How much candidate mail is in the gap, month by month?
  var KEY = '(receipt OR invoice OR "order confirmation" OR "your order" OR ' +
            'payment OR purchase OR charged OR subscription OR renewal OR ' +
            'billing OR statement OR "order #" OR "thank you for your")';
  var months = [
    ['2026/01/01', '2026/02/01'], ['2026/02/01', '2026/03/01'],
    ['2026/03/01', '2026/04/01'], ['2026/04/01', '2026/05/01'],
    ['2026/05/01', '2026/06/01']
  ];
  months.forEach(function (m) {
    var win = ' after:' + m[0] + ' before:' + m[1];
    out.sizing.push({
      from: m[0], to: m[1],
      allThreads: GmailApp.search('-in:chats' + win, 0, 500).length,   // 500 == "at least 500"
      candidateThreads: GmailApp.search(KEY + ' -in:chats' + win, 0, 500).length
    });
  });

  out.elapsedSec = (new Date().getTime() - t0) / 1000;
  return bfWrite_(BF_OUT, out);
}

// ---- helpers ---------------------------------------------------------------

function bfWrite_(name, obj) {
  var old = DriveApp.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  var f = DriveApp.createFile(name, JSON.stringify(obj, null, 2), MimeType.PLAIN_TEXT);
  console.log('WROTE ' + name + '  id=' + f.getId() + '  bytes=' + f.getSize());
  console.log(JSON.stringify(obj.earliest || {}, null, 2));
  console.log(JSON.stringify(obj.sizing || [], null, 2));
  return f.getId();
}

// ---- STEP 2: sweep the gap ------------------------------------------------
// Captures EVERY non-chat message between Jan 1 and the receipts@ start date
// (2026-06-22), with any dollar amounts pulled out of the body. Deliberately
// not keyword-filtered: a receipt that never says "receipt" still has to show
// up. Filtering happens later, off-script, where it can be reviewed.
//
// Resumable: each Run processes what it can inside ~4 minutes, writes a part
// file, and records a cursor. Click Run again until it logs done=true.

var BF_WINDOWS = [
  ['2026/01/01', '2026/02/01', 'jan'],
  ['2026/02/01', '2026/03/01', 'feb'],
  ['2026/03/01', '2026/04/01', 'mar'],
  ['2026/04/01', '2026/05/01', 'apr'],
  ['2026/05/01', '2026/06/01', 'may'],
  ['2026/06/01', '2026/06/23', 'jun1_22']
];

function backfillStep2() {
  var t0 = Date.now();
  var LIMIT_MS = 230000;          // stay well inside the 6-minute ceiling
  var props = PropertiesService.getScriptProperties();
  var cur = JSON.parse(props.getProperty('bf_cursor') || '{"w":0,"off":0,"part":0}');
  var rows = [];
  var stopped = false;

  while (cur.w < BF_WINDOWS.length && !stopped) {
    var w = BF_WINDOWS[cur.w];
    var threads = GmailApp.search('-in:chats after:' + w[0] + ' before:' + w[1], cur.off, 50);
    if (!threads.length) { cur.w++; cur.off = 0; continue; }
    for (var i = 0; i < threads.length; i++) {
      try { rows.push.apply(rows, bfRowsForThread_(threads[i], w[2])); }
      catch (e) { rows.push({ win: w[2], err: String(e).slice(0, 120) }); }
      cur.off++;
      if (Date.now() - t0 > LIMIT_MS || rows.length > 3000) { stopped = true; break; }
    }
  }

  cur.part++;
  var done = cur.w >= BF_WINDOWS.length;
  var name = 'backfill-mail-part-' + cur.part + '.json';
  var f = DriveApp.createFile(name, JSON.stringify({ cursor: cur, done: done, rows: rows }),
                              MimeType.PLAIN_TEXT);
  props.setProperty('bf_cursor', JSON.stringify(cur));
  console.log('WROTE ' + name + '  id=' + f.getId() + '  rows=' + rows.length +
              '  window=' + (BF_WINDOWS[cur.w] ? BF_WINDOWS[cur.w][2] : 'END') +
              '  offset=' + cur.off + '  done=' + done +
              '  elapsed=' + ((Date.now() - t0) / 1000) + 's');
  return { part: cur.part, rows: rows.length, done: done, fileId: f.getId() };
}

function bfRowsForThread_(th, win) {
  var labels = th.getLabels().map(function (l) { return l.getName(); }).join(',');
  return th.getMessages().map(function (m) {
    var body = '';
    try { body = m.getPlainBody() || ''; } catch (e) { body = ''; }
    var flat = body.replace(/\s+/g, ' ');
    var amts = (flat.match(/\$\s?[\d,]+\.\d{2}/g) || []);
    var uniq = [];
    amts.forEach(function (a) { a = a.replace(/\s/g, ''); if (uniq.indexOf(a) < 0) uniq.push(a); });
    var att = [];
    try {
      att = m.getAttachments({ includeInlineImages: false }).map(function (a) {
        return a.getName().slice(0, 40);
      }).slice(0, 4);
    } catch (e) {}
    return {
      id: m.getId(),
      d: Utilities.formatDate(m.getDate(), 'America/Chicago', 'yyyy-MM-dd'),
      from: (m.getFrom() || '').slice(0, 70),
      to: (m.getTo() || '').slice(0, 60),
      subj: (m.getSubject() || '').slice(0, 110),
      amts: uniq.slice(0, 8),
      att: att,
      lbl: labels,
      win: win,
      head: flat.slice(0, 180)
    };
  });
}

// Start the sweep over from scratch (clears the cursor, leaves part files).
function backfillReset() {
  PropertiesService.getScriptProperties().deleteProperty('bf_cursor');
  console.log('cursor cleared');
}

// ---- STEP 3: run the approved backfill -------------------------------------
// Sends an EXPLICIT list of Gmail message ids to the ingest. This deliberately
// does NOT widen the poller's newer_than:90d window -- that boundary is a
// safety feature (RECEIPTS.md), and the 61 hand-entered Tools rows in this
// window are exactly the collision it protects against. Nothing outside this
// list is touched, and no thread is labeled: the ingest is idempotent by Gmail
// message id, so re-running is safe.
//
// Approved by Paul 2026-08-24. Excluded on his instruction: property/rehab
// costs (they belong on the property tabs), Tools + Meals (hand-entered for
// this window), the $7,800 Matthew Beard payment, AcesPhoto, Sunstate.

var BF_RUN = [
  // --- Travel: air (channel travel -> soft Travel-category hint) ---
  { id: '19b7f78e16ffe521', ch: 'travel' },  // 01-02 AA purchase receipt GPMGCC   66.68
  { id: '19b8471a1e2e4b6c', ch: 'travel' },  // 01-03 AA in-flight Wi-Fi           25.00
  { id: '19be69823c636c61', ch: 'travel' },  // 01-22 AA purchase receipt KAIZZQ   40.28
  { id: '19c879c07b21a2cb', ch: 'travel' },  // 02-22 AA trip PDX-DFW             380.39
  { id: '19d7fc50ea88346b', ch: 'travel' },  // 04-11 AA trip DFW-PDX             357.78
  { id: '19db58b5f04785a3', ch: 'travel' },  // 04-22 AA trip PDX-DFW             584.36
  { id: '19dd93e31070b594', ch: 'travel' },  // 04-29 Wi-Fi Onboard                 8.00
  { id: '19dea69d38d734dd', ch: 'travel' },  // 05-02 AA purchase receipt OLNTKU   37.00
  { id: '19e405b93f31acd0', ch: 'travel' },  // 05-19 AA trip DFW-PDX             275.20
  { id: '19e405194f5a413e', ch: 'travel' },  // 05-19 AA trip PDX-DFW              51.60
  // --- Travel: Uber rides (Eats deliberately excluded; tipped total kept) ---
  { id: '19bed40e1c196d6f', ch: 'travel' },  // 01-23 Uber                        101.43
  { id: '19beb19737439448', ch: 'travel' },  // 01-23 Uber                         45.98
  { id: '19c19857065d6852', ch: 'travel' },  // 02-01 Uber                         48.99
  { id: '19c42eec79085e99', ch: 'travel' },  // 02-09 Uber                         49.98
  { id: '19ca95a3b7d80ed7', ch: 'travel' },  // 03-01 Uber (tipped)                51.98
  { id: '19cd2e224f6f1a62', ch: 'travel' },  // 03-09 Uber                         20.64
  { id: '19cfc84803ba58b2', ch: 'travel' },  // 03-17 Uber (tipped)                18.99
  { id: '19d018c094ba828a', ch: 'travel' },  // 03-18 Uber                         14.13
  { id: '19dd8b6fdc1e6675', ch: 'travel' },  // 04-29 Uber (tipped)               103.18
  { id: '19dedd5146ee87ad', ch: 'travel' },  // 05-03 Uber (tipped)                63.24
  { id: '19e575bcb9c67408', ch: 'travel' },  // 05-23 Uber                         33.98

  // --- Subscriptions ---
  { id: '19b95bd9421b177a', ch: 'receipts' }, // 01-06 Twilio recharge             20.00
  { id: '19bed96836d525c1', ch: 'receipts' }, // 01-23 Adobe                       34.49
  { id: '19c04f7096f10f6a', ch: 'receipts' }, // 01-28 Microsoft 365                9.99
  { id: '19c5345600aec21b', ch: 'receipts' }, // 02-12 CoreLogic via Stripe       400.00
  { id: '19ca48d4952784bc', ch: 'receipts' }, // 02-28 Microsoft 365                9.99
  { id: '19dbb6f1acd728e1', ch: 'receipts' }, // 04-23 Adobe                       34.49
  { id: '19ddf2689d937359', ch: 'receipts' }, // 04-30 Virtual Staging AI          79.00
  { id: '19e1cdf18dce2496', ch: 'receipts' }, // 05-12 CoreLogic via Stripe       200.00
  { id: '19e2bdde2e385830', ch: 'receipts' }, // 05-15 Anthropic                   45.00
  { id: '19e365636b15b003', ch: 'receipts' }, // 05-17 Anthropic                   45.00
  { id: '19e3b81b6e4b02c3', ch: 'receipts' }, // 05-18 Apify platform usage         5.00
  { id: '19e5314e0f9e427d', ch: 'receipts' }, // 05-22 gptforwork.com              29.00

  // --- Business ---
  { id: '19c1eedb38c22d7c', ch: 'receipts' }, // 02-02 LGS records search          10.30
  { id: '19c976016b5f86ab', ch: 'receipts' }, // 02-25 LGS records search          10.30
  { id: '19cb8fc101144ecd', ch: 'receipts' }, // 03-04 LGS records search           4.30
  { id: '19df0779b2ab5adc', ch: 'receipts' }, // 05-03 LGS records search           6.30
  { id: '19df59f328692144', ch: 'receipts' }, // 05-04 LGS records search           2.30
  { id: '19e3baaed0e83190', ch: 'receipts' }, // 05-18 Oregon Business Filing     100.00

  // --- Held: real vendors, amount/category not settleable from the preview.
  //     The bookkeeper reads the full body and either files or parks them.
  { id: '19bcef5fb76f4631', ch: 'receipts' }, // 01-17 Driversnote invoice
  { id: '19c6ea0e0cca9e2c', ch: 'receipts' }, // 02-17 Driversnote invoice
  { id: '19cfecb45363daa4', ch: 'receipts' }, // 03-17 Driversnote invoice
  { id: '19d9e70c7d6f480a', ch: 'receipts' }, // 04-17 Driversnote invoice
  { id: '19d22ca4b03ed48b', ch: 'receipts' }, // 03-24 PayPal receipt             594.00
  { id: '19e2304da7a4f587', ch: 'receipts' }, // 05-13 Zoom / HighLevel AI Studio
  { id: '19e3b88cf75b8f2b', ch: 'receipts' }, // 05-18 Apify invoice (the one NOT cancelled)
  { id: '19ba3918a1958194', ch: 'receipts' }  // 01-09 Yelp 450.00 -- likely a lead notice, not a charge
];

function backfillRun() {
  var t0 = Date.now();
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('WEBHOOK_SECRET');
  if (!token) throw new Error('Missing script property WEBHOOK_SECRET');

  var i = parseInt(props.getProperty('bf_run_idx') || '0', 10);
  var log = [], ok = 0, bad = 0;

  for (; i < BF_RUN.length; i++) {
    if (Date.now() - t0 > 240000) break;          // resume on the next Run
    var it = BF_RUN[i];
    try {
      var m = GmailApp.getMessageById(it.id);
      var payload = buildPayload_(m, token);      // reuses the poller's own builder
      payload.channel = it.ch;                    // these are not addressed to travel@
      var res = UrlFetchApp.fetch(CONFIG.INGEST_URL, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 202 || code === 200) { ok++; } else { bad++; }
      log.push(i + ' ' + it.id + ' -> ' + code + '  ' + (m.getSubject() || '').slice(0, 46));
    } catch (e) {
      bad++;
      log.push(i + ' ' + it.id + ' -> ERROR ' + String(e).slice(0, 90));
    }
    Utilities.sleep(400);                          // don't stampede the ingest
  }

  props.setProperty('bf_run_idx', String(i));
  var done = i >= BF_RUN.length;
  console.log('BACKFILL sent=' + ok + ' failed=' + bad + '  through ' + i + '/' + BF_RUN.length +
              '  done=' + done + '  elapsed=' + ((Date.now() - t0) / 1000) + 's');
  console.log(log.join('\n'));
  return { sent: ok, failed: bad, idx: i, done: done };
}

function backfillRunReset() {
  PropertiesService.getScriptProperties().deleteProperty('bf_run_idx');
  console.log('backfill run index cleared');
}

// ---- STEP 4: verify what the backfill actually did --------------------------
// Reads the store through receipts-summary. Sends no email; logs only.
function backfillVerify() {
  var token = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  var now = new Date();
  var start = new Date(now.getTime() - 6 * 3600 * 1000);
  var res = UrlFetchApp.fetch(CONFIG.SUMMARY_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({
      token: token, action: 'summary',
      dayStartIso: start.toISOString(), dayEndIso: now.toISOString(), doneMsgIds: []
    })
  });
  var d = JSON.parse(res.getContentText());
  console.log('HTTP ' + res.getResponseCode());
  console.log('AUTO-FILED in last 6h -- grand $' + d.totals.grand);
  console.log(JSON.stringify(d.totals.byCategory));
  var inGap = function (s) { var m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{2})$/); if (!m) return false; var iso = '20' + m[3] + '-' + m[1] + '-' + m[2]; return iso >= '2026-01-01' && iso <= '2026-05-24'; };
  var fresh = (d.needsReview || []).filter(function (x) { return x.newToday && inGap(x.date); });
  console.log('NEEDS REVIEW (new in window): ' + fresh.length +
              '   | total pending overall: ' + (d.needsReview || []).length);
  fresh.forEach(function (x) {
    console.log('  ' + x.date + '  ' + x.vendor + '  $' + x.amount +
                '  [' + x.confidence + ']  ' + String(x.notes).slice(0, 95));
  });
  console.log('errors=' + (d.errors || []).length + '  stale=' + (d.staleProcessing || []).length);
  return { filed: d.totals.grand, pendingNew: fresh.length };
}

// The editor's function dropdown is unreliable to drive, so the entry point the
// Run button already has selected simply delegates to the step we want to run.
function myFunction() {
  return backfillVerify();
}
