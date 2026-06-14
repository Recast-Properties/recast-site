/****************************************************************
 * Recast Properties — Call Summary sink (Nylas era)
 *
 * Standalone Apps Script web app. Receives ONE POST per ended call from
 * netlify/functions/call-completed.js and:
 *   1. Appends a row to the "Call Intake" tab of the Call Sheet.
 *   2. Emails Paul an internal summary.
 *
 * Deliberately does NOT touch the calendar (Nylas/appointment-action owns it),
 * does NOT handle website leads, and shares nothing with the frozen legacy
 * script. Auth is a shared token (Script Property WEBHOOK_SECRET) sent in the
 * POST body, matching CALL_SUMMARY_TOKEN on the Netlify side.
 *
 * Setup:
 *   1. New standalone Apps Script project (script.google.com).
 *   2. Project Settings -> Script Properties -> add WEBHOOK_SECRET = <same as
 *      Netlify CALL_SUMMARY_TOKEN>.
 *   3. Deploy -> New deployment -> Web app -> Execute as: me,
 *      Who has access: Anyone. Copy the /exec URL -> Netlify CALL_SUMMARY_WEBHOOK_URL.
 ****************************************************************/

const CONFIG = {
  SPREADSHEET_ID: '1JqySmzz_Vcogz66CDHlSaG5PJf987vLb5WjtRqSsd60',
  TAB_NAME: 'Call Intake',
  NOTIFY_EMAIL: 'paul@recast-properties.com',
  FROM_ALIAS: 'info@recast-properties.com',
  REPLY_TO: 'info@recast-properties.com',
  CONTACT_PHONE: '945-245-8458',
  DEFAULT_TIMEZONE: 'America/Chicago'
};

// Must match the existing "Call Intake" tab column order.
const CALL_HEADERS = [
  'Timestamp',
  'Inbound Caller ID',
  'Callback Number',
  'Caller Name',
  'Property Address',
  'Reason For Selling',
  'Timeline',
  'Best Callback Time',
  'Owed Amount',
  'Lien Details',
  'SMS Consent',
  'Notes',
  'Raw Payload'
];

const WEBSITE_TAB_NAME = 'Website Leads';
const WEBSITE_HEADERS = [
  'Timestamp',
  'Name',
  'Phone',
  'Email',
  'Property Address',
  'Owner Relationship',
  'Reason',
  'Timeline',
  'Mortgage Balance',
  'Other Liens',
  'Scheduled Callback',
  'Raw Payload'
];

function doGet() {
  return jsonResponse_({ ok: true, message: 'Recast call-summary sink is live.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    const expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    if (!expected) {
      return jsonResponse_({ ok: false, error: 'Missing script property WEBHOOK_SECRET' }, 500);
    }

    const bodyText = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
    let data = {};
    try {
      data = bodyText ? JSON.parse(bodyText) : {};
    } catch (err) {
      return jsonResponse_({ ok: false, error: 'Invalid JSON' }, 400);
    }

    const token = data.token || (e && e.parameter && e.parameter.token) || '';
    if (token !== expected) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' }, 401);
    }

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

    // Website intake (from web-booking.js) -> Website Leads tab + email.
    if (data.type === 'website_lead') {
      return handleWebsiteLead_(data, ss);
    }

    const sheet = getOrCreateSheet_(ss, CONFIG.TAB_NAME, CALL_HEADERS);

    sheet.appendRow([
      clean_(data.timestamp || nowStamp_(ss)),
      clean_(data.inboundCallerId),
      clean_(data.callbackNumber),
      clean_(data.callerName),
      clean_(data.propertyAddress),
      clean_(data.reasonForSelling),
      clean_(data.timeline),
      clean_(data.bestCallbackTime),
      clean_(data.owedAmount),
      clean_(data.lienDetails),
      clean_(data.smsConsent),
      clean_(data.notes),
      safeJson_(data)
    ]);

    sendSummaryEmail_(data, ss);

    return jsonResponse_({ ok: true, message: 'Call summary appended and emailed.' });
  } catch (err) {
    console.error('CALL-SUMMARY ERROR: ' + String(err && err.stack ? err.stack : err));
    throw err;
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function handleWebsiteLead_(data, ss) {
  const sheet = getOrCreateSheet_(ss, WEBSITE_TAB_NAME, WEBSITE_HEADERS);
  sheet.appendRow([
    clean_(data.timestamp || nowStamp_(ss)),
    clean_(data.name),
    clean_(data.phone),
    clean_(data.email),
    clean_(data.propertyAddress),
    clean_(data.ownerRelationship),
    clean_(data.reason),
    clean_(data.timeline),
    clean_(data.mortgageBalance),
    clean_(data.otherLiens),
    clean_(data.scheduledCallback),
    safeJson_(data)
  ]);
  sendWebsiteEmail_(data, ss);
  if (isValidEmail_(data.email)) sendWebsiteConfirmation_(data);
  return jsonResponse_({ ok: true, message: 'Website lead appended and emailed.' });
}

// Confirmation email to the seller (from the info@ alias), restoring the legacy behavior.
function sendWebsiteConfirmation_(data) {
  const first = (clean_(data.name) || 'there').split(' ')[0];
  const whenLabel = formatScheduled_(data.scheduledCallback);
  const addr = clean_(data.propertyAddress);
  const subject = addr ? ('We received your info on ' + cleanForSubject_(addr)) : 'Thanks for reaching out to Recast Properties';
  const callLine = whenLabel ? ('We have you down for a call on ' + whenLabel + '.') : '';

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#18191C">' +
      '<p style="margin:0 0 14px">Hi ' + escapeHtml_(first) + ',</p>' +
      '<p style="margin:0 0 14px">Thanks for reaching out to Recast Properties. We received your information' + (addr ? ' about ' + escapeHtml_(addr) : '') + '.</p>' +
      (callLine ? '<p style="margin:0 0 14px">' + escapeHtml_(callLine) + '</p>' : '') +
      '<p style="margin:0 0 14px">If you need to reschedule, call ' + escapeHtml_(CONFIG.CONTACT_PHONE) + '.</p>' +
      '<p style="margin:0">Talk soon,<br>Recast Properties<br>' +
        '<span style="color:#71757E">We buy houses and land for cash. No agents. No fees. No repairs.</span></p>' +
    '</div>';

  const plain =
    'Hi ' + first + ',\n\n' +
    'Thanks for reaching out to Recast Properties. We received your information' + (addr ? ' about ' + addr : '') + '.\n\n' +
    (callLine ? callLine + '\n\n' : '') +
    'If you need to reschedule, call ' + CONFIG.CONTACT_PHONE + '.\n\n' +
    'Talk soon,\nRecast Properties\nWe buy houses and land for cash. No agents. No fees. No repairs.';

  const options = { htmlBody: html, name: 'Recast Properties', replyTo: CONFIG.REPLY_TO };
  if (GmailApp.getAliases().indexOf(CONFIG.FROM_ALIAS) !== -1) options.from = CONFIG.FROM_ALIAS;
  GmailApp.sendEmail(clean_(data.email), subject, plain, options);
}

function isValidEmail_(email) {
  return /\S+@\S+\.\S+/.test(String(email || ''));
}

function formatScheduled_(iso) {
  const s = String(iso || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, CONFIG.DEFAULT_TIMEZONE, "EEE, MMM d 'at' h:mm a") + ' Central';
}

function sendWebsiteEmail_(data, ss) {
  const subjectParts = ['Website lead'];
  if (data.name) subjectParts.push(cleanForSubject_(data.name));
  if (data.propertyAddress) subjectParts.push(cleanForSubject_(data.propertyAddress));
  const subject = subjectParts.join(' | ');

  const rows = [
    ['Name', data.name],
    ['Phone', data.phone],
    ['Email', data.email],
    ['Property address', data.propertyAddress],
    ['Owner relationship', data.ownerRelationship],
    ['Reason', data.reason],
    ['Timeline', data.timeline],
    ['Mortgage balance', data.mortgageBalance],
    ['Other liens', data.otherLiens],
    ['Scheduled callback', data.scheduledCallback],
    ['Spreadsheet', '<a href="' + ss.getUrl() + '">Open Call Sheet</a>']
  ];

  const plain = rows
    .map(function (r) { return r[0] + ': ' + clean_(String(r[1]).replace(/<[^>]+>/g, '')); })
    .join('\n');

  const options = {
    htmlBody: buildHtmlTable_('Website lead', rows),
    name: 'Recast Properties Intake',
    replyTo: CONFIG.REPLY_TO
  };
  if (GmailApp.getAliases().indexOf(CONFIG.FROM_ALIAS) !== -1) {
    options.from = CONFIG.FROM_ALIAS;
  }
  GmailApp.sendEmail(CONFIG.NOTIFY_EMAIL, subject, plain, options);
}

function sendSummaryEmail_(data, ss) {
  const status = clean_(data.callStatus) || 'unknown';
  const subjectParts = ['Call summary'];
  if (data.callerName) subjectParts.push(cleanForSubject_(data.callerName));
  if (data.propertyAddress) subjectParts.push(cleanForSubject_(data.propertyAddress));
  subjectParts.push('[' + status + ']');
  const subject = subjectParts.join(' | ');

  const rows = [
    ['Status', status],
    ['Caller name', data.callerName],
    ['Inbound caller ID', data.inboundCallerId],
    ['Callback number', data.callbackNumber],
    ['Property address', data.propertyAddress],
    ['Reason for selling', data.reasonForSelling],
    ['Timeline', data.timeline],
    ['Scheduled callback', data.bestCallbackTime],
    ['Owed amount', data.owedAmount],
    ['Lien details', data.lienDetails],
    ['SMS consent', data.smsConsent],
    ['Summary', data.notes],
    ['Spreadsheet', '<a href="' + ss.getUrl() + '">Open Call Sheet</a>']
  ];

  const plain = rows
    .map(function (r) { return r[0] + ': ' + clean_(String(r[1]).replace(/<[^>]+>/g, '')); })
    .join('\n');

  const options = {
    htmlBody: buildHtmlTable_('Call summary (' + status + ')', rows),
    name: 'Recast Properties Intake',
    replyTo: CONFIG.REPLY_TO
  };
  if (GmailApp.getAliases().indexOf(CONFIG.FROM_ALIAS) !== -1) {
    options.from = CONFIG.FROM_ALIAS;
  }

  GmailApp.sendEmail(CONFIG.NOTIFY_EMAIL, subject, plain, options);
}

function getOrCreateSheet_(ss, tabName, headers) {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function nowStamp_(ss) {
  const tz = ss.getSpreadsheetTimeZone() || CONFIG.DEFAULT_TIMEZONE;
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
}

function clean_(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  if (/^[=+\-@]/.test(text)) text = "'" + text; // prevent Sheets formula injection
  return text;
}

function cleanForSubject_(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function safeJson_(obj) {
  try { return JSON.stringify(obj || {}); } catch (err) { return ''; }
}

function buildHtmlTable_(title, rows) {
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#18191C">';
  html += '<h2 style="margin:0 0 14px;font-size:18px">' + escapeHtml_(title) + '</h2>';
  html += '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse">';
  rows.forEach(function (row) {
    const value = row[1];
    const isHtmlValue = String(value || '').indexOf('<a ') !== -1;
    html += '<tr>' +
      '<td style="border:1px solid #ddd;font-weight:bold;vertical-align:top">' + escapeHtml_(row[0]) + '</td>' +
      '<td style="border:1px solid #ddd;vertical-align:top">' + (isHtmlValue ? value : escapeHtml_(clean_(value))) + '</td>' +
      '</tr>';
  });
  html += '</table></div>';
  return html;
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse_(obj, statusCode) {
  if (statusCode) obj.statusCode = statusCode;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
