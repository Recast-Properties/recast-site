/****************************************************************
 * Recast Properties — Bookkeeper morning summary
 *
 * Paste into the SAME Apps Script project as receipts-poller.gs (it reuses that
 * project's Gmail authorization and WEBHOOK_SECRET script property).
 *
 * Runs on a daily time trigger (3-4 AM America/Chicago) and emails paul@ a
 * summary of the previous day:
 *   • what the bookkeeper auto-filed, grouped by category, with totals
 *   • items waiting for review (with a link to the /receipts queue)
 *   • ⚠️ reconciliation: receipts labeled receipts-done yesterday that never
 *     produced a queue record, stuck "processing" ingests, and ingest errors
 *
 * Setup:
 *   1. Paste this file into the receipts poller project. Set the project
 *      timezone to America/Chicago (Project Settings).
 *   2. Triggers -> Add Trigger -> function `dailySummary`, time-driven,
 *      day timer, 7am–8am.
 *   3. Run `summaryToday` (today so far) or `dailySummary` (yesterday) once
 *      manually to verify the email.
 ****************************************************************/

const SUMMARY_CONFIG = {
  SUMMARY_URL: 'https://receipts--incomparable-raindrop-8f3d22.netlify.app/.netlify/functions/receipts-summary',
  QUEUE_URL: 'https://receipts--incomparable-raindrop-8f3d22.netlify.app/receipts/',
  NOTIFY_EMAIL: 'paul@recast-properties.com',
  SENDER_NAME: 'Recast Bookkeeper',
  TIMEZONE: 'America/Chicago'
};

// Trigger entry point: yesterday, midnight to midnight, in local
// (America/Chicago) time.
function dailySummary() {
  const now = new Date();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayStart = new Date(dayEnd.getTime() - 24 * 60 * 60 * 1000);
  sendSummary_(dayStart, dayEnd, Utilities.formatDate(dayStart, SUMMARY_CONFIG.TIMEZONE, 'EEE MMM d'));
}

// On-demand: today so far (midnight to now). Same email; subject says
// "so far". Run from the editor any time — used to exercise the email during
// rollout testing, and handy whenever you want a mid-day digest.
function summaryToday() {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  sendSummary_(dayStart, now, Utilities.formatDate(dayStart, SUMMARY_CONFIG.TIMEZONE, 'EEE MMM d') + ' (so far)');
}

function sendSummary_(dayStart, dayEnd, dayLabel) {
  const token = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!token) throw new Error('Missing script property WEBHOOK_SECRET');

  const doneMsgIds = collectDoneMsgIds_(dayStart, dayEnd);

  const res = UrlFetchApp.fetch(SUMMARY_CONFIG.SUMMARY_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({
      token: token, action: 'summary',
      dayStartIso: dayStart.toISOString(), dayEndIso: dayEnd.toISOString(),
      doneMsgIds: doneMsgIds
    })
  });
  if (res.getResponseCode() !== 200) throw new Error('Summary endpoint HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const j = JSON.parse(res.getContentText());
  if (!j.ok) throw new Error('Summary endpoint error: ' + (j.error || 'unknown'));

  const reviewCount = (j.needsReview || []).filter(function (r) { return !r.legacy; }).length;
  const problems = (j.lostMsgIds || []).length + (j.staleProcessing || []).length + (j.errors || []).length;

  let subject = 'Bookkeeper | ' + dayLabel + ' | $' + (j.totals && j.totals.grand || '0.00') + ' filed';
  if (reviewCount) subject += ' | ' + reviewCount + ' to review';
  if (problems) subject += ' | \u26A0\uFE0F ' + problems + ' problem' + (problems > 1 ? 's' : '');

  GmailApp.sendEmail(SUMMARY_CONFIG.NOTIFY_EMAIL, subject, buildPlain_(j, dayLabel), {
    htmlBody: buildSummaryHtml_(j, dayLabel),
    name: SUMMARY_CONFIG.SENDER_NAME
  });
  console.log('Summary sent: ' + subject);
}

// gmailMessageIds of receipts the poller marked done during the window — the
// summary endpoint diffs these against its records to catch lost receipts.
function collectDoneMsgIds_(dayStart, dayEnd) {
  const ids = [];
  const threads = GmailApp.search('label:receipts-done newer_than:3d', 0, 100);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      const d = message.getDate();
      if (d && d >= dayStart && d < dayEnd) ids.push(message.getId());
    });
  });
  return ids;
}

// ---- email rendering --------------------------------------------------------

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSummaryHtml_(j, dayLabel) {
  const H = escapeHtml_;
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#18191c;max-width:640px">';
  html += '<h2 style="margin:0 0 2px">Bookkeeper \u2014 ' + H(dayLabel) + '</h2>';
  html += '<p style="margin:0 0 16px;color:#53575f">Auto-filed <b>$' + H(j.totals.grand) + '</b>';
  if (j.manuallyApproved) html += ' \u00B7 ' + j.manuallyApproved + ' manually approved';
  html += '</p>';

  // Auto-filed, by category
  const cats = Object.keys(j.autoFiled || {}).sort();
  if (cats.length) {
    html += '<h3 style="margin:14px 0 6px">Filed to the sheet</h3>';
    cats.forEach(function (cat) {
      html += '<p style="margin:10px 0 4px;font-weight:bold">' + H(cat) + ' \u2014 $' + H(j.totals.byCategory[cat]) + '</p>';
      html += '<table cellpadding="5" style="border-collapse:collapse;font-size:13px;width:100%">';
      j.autoFiled[cat].forEach(function (r) {
        html += '<tr style="border-bottom:1px solid #e1e4e9">' +
          '<td>' + H(r.vendor) + '</td><td>' + H(r.date) + '</td>' +
          '<td>' + H(r.item) + (r.channel === 'travel' ? ' <span style="color:#71757e;font-size:11px">(travel)</span>' : '') + '</td>' +
          '<td align="right"><b>$' + H(r.amount) + '</b>' + (r.taxable ? '' : '<span style="color:#71757e;font-size:11px"> no tax</span>') + '</td>' +
          '<td style="color:#71757e;font-size:11px">' + H(r.sheetCell) + '</td></tr>';
      });
      html += '</table>';
    });
  } else {
    html += '<p style="color:#53575f">Nothing auto-filed yesterday.</p>';
  }

  // Needs review (bookkeeper-era items listed; June-backlog leftovers as one line)
  const allReview = j.needsReview || [];
  const review = allReview.filter(function (r) { return !r.legacy; });
  const legacyCount = allReview.length - review.length;
  if (review.length) {
    html += '<h3 style="margin:18px 0 6px;color:#b3261e">Needs your review (' + review.length + ')</h3>';
    html += '<table cellpadding="5" style="border-collapse:collapse;font-size:13px;width:100%">';
    review.forEach(function (r) {
      html += '<tr style="border-bottom:1px solid #e1e4e9">' +
        '<td>' + (r.newToday ? '<b>NEW</b> ' : '') + H(r.vendor) + '</td>' +
        '<td>' + H(r.item) + '</td>' +
        '<td align="right">' + (r.amount ? '$' + H(r.amount) : '\u2014') + '</td>' +
        '<td style="color:#71757e;font-size:12px">' + H(r.notes || r.confidence) + '</td></tr>';
    });
    html += '</table>';
    html += '<p style="margin:10px 0"><a href="' + SUMMARY_CONFIG.QUEUE_URL + '" style="font-weight:bold">Open the receipts queue \u2192</a></p>';
  }
  if (legacyCount) {
    html += '<p style="margin:6px 0;color:#71757e;font-size:12px">+ ' + legacyCount + ' older item' + (legacyCount > 1 ? 's' : '') + ' from the June backlog still pending (queue &rarr; June backlog filter).</p>';
  }

  // Problems: lost / stale / errored ingests
  const lost = j.lostMsgIds || [], stale = j.staleProcessing || [], errs = j.errors || [];
  if (lost.length || stale.length || errs.length) {
    html += '<h3 style="margin:18px 0 6px;color:#b3261e">\u26A0\uFE0F Problems</h3><ul style="margin:4px 0;padding-left:20px">';
    lost.forEach(function (id) {
      html += '<li>Receipt marked done but never recorded \u2014 <a href="https://mail.google.com/mail/u/0/#all/' + H(id) + '">open the email</a>, remove its receipts-done label to re-ingest.</li>';
    });
    stale.forEach(function (s) {
      html += '<li>Stuck processing since ' + H(s.startedAt) + ': \u201C' + H(s.subject) + '\u201D \u2014 <a href="' + H(s.gmailUrl) + '">email</a></li>';
    });
    errs.forEach(function (s) {
      html += '<li>Ingest error on \u201C' + H(s.subject) + '\u201D: ' + H(s.error) + ' \u2014 <a href="' + H(s.gmailUrl) + '">email</a> (a review item was queued)</li>';
    });
    html += '</ul>';
  }

  html += '<p style="margin:18px 0 0;color:#a0a3ab;font-size:11px">Recast bookkeeper \u00B7 window ' + H(j.window.start) + ' \u2192 ' + H(j.window.end) + '</p></div>';
  return html;
}

function buildPlain_(j, dayLabel) {
  const lines = ['Bookkeeper \u2014 ' + dayLabel, 'Auto-filed: $' + j.totals.grand, ''];
  Object.keys(j.autoFiled || {}).sort().forEach(function (cat) {
    lines.push(cat + ' \u2014 $' + j.totals.byCategory[cat]);
    j.autoFiled[cat].forEach(function (r) { lines.push('  ' + r.vendor + ' | ' + r.item + ' | $' + r.amount + ' | ' + r.sheetCell); });
  });
  const allReview = j.needsReview || [];
  const review = allReview.filter(function (r) { return !r.legacy; });
  const legacyCount = allReview.length - review.length;
  if (legacyCount) lines.push('', '+ ' + legacyCount + ' older June-backlog item(s) still pending: ' + SUMMARY_CONFIG.QUEUE_URL);
  if (review.length) {
    lines.push('', 'NEEDS REVIEW (' + review.length + ') \u2014 ' + SUMMARY_CONFIG.QUEUE_URL);
    review.forEach(function (r) { lines.push('  ' + (r.newToday ? '[NEW] ' : '') + r.vendor + ' | ' + r.item + (r.notes ? ' | ' + r.notes : '')); });
  }
  (j.lostMsgIds || []).forEach(function (id) { lines.push('', 'LOST RECEIPT (re-ingest): https://mail.google.com/mail/u/0/#all/' + id); });
  (j.staleProcessing || []).forEach(function (s) { lines.push('STUCK PROCESSING: ' + s.subject); });
  (j.errors || []).forEach(function (s) { lines.push('INGEST ERROR: ' + s.subject + ' \u2014 ' + s.error); });
  return lines.join('\n');
}
