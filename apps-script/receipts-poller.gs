/****************************************************************
 * Recast Properties — Receipts Gmail poller
 *
 * Standalone Apps Script. Runs on a time trigger, finds receipt emails sent to
 * receipts@recast-properties.com that haven't been processed, and POSTs each one
 * (including photo/PDF attachments) to the receipts-ingest Netlify function,
 * which uses Claude to extract the line items. Processed threads get a
 * "receipts-done" label so they're never handled twice.
 *
 * This script only READS Gmail and labels threads — it never writes the sheet.
 *
 * Setup:
 *   1. New standalone Apps Script project (script.google.com), signed in as
 *      paul@recast-properties.com.
 *   2. Project Settings -> Script Properties -> WEBHOOK_SECRET = <the receipts token>.
 *   3. Run `authorize` once and grant Gmail + external-request access.
 *   4. Triggers (clock icon) -> Add Trigger -> function `pollReceipts`,
 *      time-driven, every 15 minutes.
 ****************************************************************/

const CONFIG = {
  INGEST_URL: 'https://receipts--incomparable-raindrop-8f3d22.netlify.app/.netlify/functions/receipts-ingest-background',
  // Attachments can NEVER ride the ingest POST — background functions have a
  // ~256 KB async-invocation request cap (every photo 413-bounced until
  // 2026-08-21). Bytes go to this SYNCHRONOUS function (6 MB cap) which parks
  // them in Blobs; the ingest gets blob references only.
  UPLOAD_URL: 'https://receipts--incomparable-raindrop-8f3d22.netlify.app/.netlify/functions/receipts-upload',
  RECEIPT_ADDRESS: 'receipts@recast-properties.com',
  TRAVEL_ADDRESS: 'travel@recast-properties.com',   // its own mailbox, POP-imported into paul@
  DONE_LABEL: 'receipts-done',
  SEARCH_WINDOW: 'newer_than:90d',
  MAX_THREADS: 15,
  // Payload guard: base64 inflates by 4/3 and the JSON upload must stay under
  // Netlify's request cap — a ~4 MB photo bounced the whole email with HTTP
  // 413 on 2026-08-21. Photos over this limit are SHRUNK via a Drive
  // round-trip (shrinkImageViaDrive_) so every already-received email works
  // as-is; only if the shrink fails is the attachment skipped (the email
  // still sends body-only and surfaces as a review placeholder, never a
  // silent forever-retry).
  MAX_ATTACH_BYTES: 3 * 1024 * 1024,
  MAX_ATTACH_COUNT: 6                 // at most N attachments per email
};

function authorize() {
  GmailApp.getInboxUnreadCount();
  UrlFetchApp.getRequest(CONFIG.INGEST_URL);
  DriveApp.getRootFolder(); // Drive scope — used to shrink oversized photos
}

// One-time (re)setup of the production triggers — run from the editor.
// Idempotent: clears this project's existing triggers first.
//   • pollReceipts  every 15 minutes
//   • dailySummary  daily in the 3–4 AM America/Chicago window (Paul wants the
//                   digest waiting first thing in the morning)
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pollReceipts').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(3).inTimezone('America/Chicago').create();
  console.log('Triggers set: pollReceipts every 15 min; dailySummary daily 3-4 AM America/Chicago');
}

function pollReceipts() {
  // Prevent two runs (manual + scheduled) from overlapping and racing the queue.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Another poll is already running; skipping this run.');
    return;
  }
  try {
    const token = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    if (!token) throw new Error('Missing script property WEBHOOK_SECRET');

    const doneLabel = GmailApp.getUserLabelByName(CONFIG.DONE_LABEL) || GmailApp.createLabel(CONFIG.DONE_LABEL);
    const query = '(to:' + CONFIG.RECEIPT_ADDRESS + ' OR to:' + CONFIG.TRAVEL_ADDRESS +
      ' OR label:receipts OR label:travel) -label:' + CONFIG.DONE_LABEL + ' ' + CONFIG.SEARCH_WINDOW;
    const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);

    let ingested = 0, items = 0, failed = 0, skipped = 0;
    threads.forEach(function (thread) {
      let threadOk = true;
      // HARD GUARD: only threads explicitly labeled receipts/travel, or whose
      // messages are actually addressed to one of the receipt inboxes, may be
      // ingested. If a Gmail search quirk ever over-matches (e.g. an alias
      // resolving to the whole mailbox), unrelated mail is skipped and left
      // unlabeled — never read into the bookkeeper.
      const threadLabeled = thread.getLabels().some(function (l) {
        const n = l.getName().toLowerCase();
        return n === 'receipts' || n === 'travel';
      });
      let anyEligible = false;
      thread.getMessages().forEach(function (message) {
        if (!threadLabeled && !isAddressedToInbox_(message)) { skipped++; return; }
        anyEligible = true;
        try {
          const payload = buildPayload_(message, token);
          const res = UrlFetchApp.fetch(CONFIG.INGEST_URL, {
            method: 'post', contentType: 'application/json',
            payload: JSON.stringify(payload), muteHttpExceptions: true
          });
          const code = res.getResponseCode();
          let data = {};
          try { data = JSON.parse(res.getContentText()); } catch (e) {}
          // The ingest is a Netlify BACKGROUND function: 202 = accepted, work
          // continues async (it records a processing marker first thing, and the
          // morning summary reconciles anything that later goes missing).
          if (code === 202 || (code === 200 && data.ok)) { ingested++; items += (data.added || 0); }
          else { threadOk = false; failed++; console.error('Ingest failed (' + code + '): ' + res.getContentText().slice(0, 300)); }
        } catch (err) {
          threadOk = false; failed++; console.error('Poller error: ' + String(err));
        }
      });
      if (threadOk && anyEligible) thread.addLabel(doneLabel);
    });

    console.log('Receipts poll: ' + ingested + ' email(s) ingested, ' + failed + ' failure(s), ' + skipped + ' non-inbox message(s) skipped.');
  } finally {
    lock.releaseLock();
  }
}

// ---- TEST HARNESS: process a small batch of REAL receipts WITHOUT marking
// them receipts-done. Used while the sheet-writer points at the TEST tab to
// judge itemization on real receipts. Because nothing is labeled, the same
// receipts are re-processed to the live tab at go-live (their queue records
// must be deleted first — the delete/clear action in receipts-data does that).
function testPollBatch() {
  const BATCH = 60; // threads per run (above the unlabeled-backlog thread count) — the ingest skips already-processed messages, so re-running is safe
  const token = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!token) throw new Error('Missing script property WEBHOOK_SECRET');
  const query = '(to:' + CONFIG.RECEIPT_ADDRESS + ' OR to:' + CONFIG.TRAVEL_ADDRESS +
    ' OR label:receipts OR label:travel) -label:' + CONFIG.DONE_LABEL + ' ' + CONFIG.SEARCH_WINDOW;
  const threads = GmailApp.search(query, 0, BATCH);
  let sent = 0, skipped = 0;
  threads.forEach(function (thread) {
    const threadLabeled = thread.getLabels().some(function (l) {
      const n = l.getName().toLowerCase();
      return n === 'receipts' || n === 'travel';
    });
    thread.getMessages().forEach(function (message) {
      if (!threadLabeled && !isAddressedToInbox_(message)) { skipped++; return; }
      try {
        const payload = buildPayload_(message, token);
        const res = UrlFetchApp.fetch(CONFIG.INGEST_URL, {
          method: 'post', contentType: 'application/json',
          payload: JSON.stringify(payload), muteHttpExceptions: true
        });
        console.log('test-ingest ' + message.getId() + ' -> ' + res.getResponseCode() + ' "' + message.getSubject() + '"');
        sent++;
      } catch (err) {
        console.error('test-ingest ' + message.getId() + ' FAILED: ' + String(err));
      }
    });
  });
  console.log('Test batch: ' + sent + ' message(s) sent (NOT labeled done), ' + skipped + ' skipped.');
}

// Upload one attachment's bytes to Netlify Blobs via receipts-upload
// (synchronous, 6 MB cap). Returns the blob key for the ingest payload.
function uploadAttachment_(token, msgId, index, filename, mimeType, bytes) {
  const res = UrlFetchApp.fetch(CONFIG.UPLOAD_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({
      token: token, msgId: msgId, index: index,
      filename: filename, mimeType: mimeType,
      dataBase64: Utilities.base64Encode(bytes)
    })
  });
  const code = res.getResponseCode();
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) {}
  if (code !== 200 || !data.ok || !data.key) {
    throw new Error('Attachment upload failed (' + code + ') for "' + filename + '": ' + res.getContentText().slice(0, 200));
  }
  return data.key;
}

// Shrink an oversized photo by round-tripping it through Drive: upload a temp
// copy, ask Drive for its ~2000px thumbnail rendition (a server-side-resized
// JPEG — Drive renders HEIC too), download that, trash the temp file. Returns
// the JPEG bytes, or null if anything fails (caller then skips the photo and
// the receipt surfaces as a review placeholder instead). Works on every
// already-received email — nothing needs re-sending at a smaller size.
function shrinkImageViaDrive_(att) {
  let fileId = null;
  try {
    const file = DriveApp.createFile(att.copyBlob().setName('receipt-shrink-tmp'));
    fileId = file.getId();
    // Drive generates thumbnails asynchronously — poll briefly.
    for (let attempt = 0; attempt < 6; attempt++) {
      const metaRes = UrlFetchApp.fetch(
        'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=thumbnailLink',
        { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      if (metaRes.getResponseCode() === 200) {
        const meta = JSON.parse(metaRes.getContentText());
        if (meta.thumbnailLink) {
          const url = meta.thumbnailLink.replace(/=s\d+(-[a-z]+)?$/, '=s2000');
          const imgRes = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
          if (imgRes.getResponseCode() === 200) {
            const bytes = imgRes.getContent();
            if (bytes.length > 0 && bytes.length <= CONFIG.MAX_ATTACH_BYTES) return bytes;
          }
        }
      }
      Utilities.sleep(1500);
    }
    console.warn('Drive thumbnail never became available for "' + att.getName() + '"');
    return null;
  } catch (err) {
    console.warn('shrinkImageViaDrive_ failed: ' + String(err));
    return null;
  } finally {
    if (fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) {} }
  }
}

// True only when the message is actually addressed to one of the receipt
// inboxes (To or Cc). This is the eligibility guard for unlabeled threads.
function isAddressedToInbox_(message) {
  const hdrs = ((message.getTo() || '') + ',' + (message.getCc() || '')).toLowerCase();
  return hdrs.indexOf(CONFIG.RECEIPT_ADDRESS) !== -1 || hdrs.indexOf(CONFIG.TRAVEL_ADDRESS) !== -1;
}

// Which inbox this receipt came through: travel@ (POP-imported into this
// mailbox, To/Cc headers preserved) files with a Travel-category hint.
function channelOf_(message) {
  const hdrs = ((message.getTo() || '') + ',' + (message.getCc() || '')).toLowerCase();
  return hdrs.indexOf(CONFIG.TRAVEL_ADDRESS) !== -1 ? 'travel' : 'receipts';
}

function buildPayload_(message, token) {
  const attachments = [];
  // include inline images too — phone photos are often embedded, not attached
  const atts = message.getAttachments({ includeInlineImages: true, includeAttachments: true });
  for (let i = 0; i < atts.length && attachments.length < CONFIG.MAX_ATTACH_COUNT; i++) {
    const att = atts[i];
    const type = (att.getContentType() || '').toLowerCase();
    const lname = (att.getName() || '').toLowerCase();
    const isPdf = type === 'application/pdf' || /\.pdf$/.test(lname);
    const isImg = /^image\//.test(type) || /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/.test(lname);
    if (!isPdf && !isImg) continue;

    let bytes = att.getBytes();
    let shrunk = false;
    if (bytes.length > CONFIG.MAX_ATTACH_BYTES) {
      // Oversized photo (common for full-resolution phone photos, incl. every
      // pre-existing receipt email in the archive): have Drive render a
      // smaller JPEG rather than skipping the receipt.
      const small = isImg ? shrinkImageViaDrive_(att) : null;
      if (!small) {
        console.warn('Skipping large attachment "' + att.getName() + '" (' + bytes.length + ' bytes) on msg ' + message.getId());
        continue;
      }
      bytes = small;
      shrunk = true;
      console.log('Shrunk "' + att.getName() + '" ' + att.getBytes().length + ' -> ' + bytes.length + ' bytes via Drive');
    }

    // Normalize the mime type (some clients send octet-stream); decide by extension.
    let mime = type;
    if (isPdf) {
      mime = 'application/pdf';
    } else if (/\.(jpe?g)$/.test(lname)) {
      mime = 'image/jpeg';
    } else if (/\.png$/.test(lname)) {
      mime = 'image/png';
    } else if (/\.webp$/.test(lname)) {
      mime = 'image/webp';
    } else if (/\.gif$/.test(lname)) {
      mime = 'image/gif';
    } else if (/\.(heic|heif)$/.test(lname) || /heic|heif/.test(type)) {
      mime = 'image/heic'; // Claude can't read HEIC -> ingest flags it for review
    } else if (!/^image\//.test(mime)) {
      mime = 'image/jpeg';
    }
    if (shrunk) mime = 'image/jpeg'; // Drive renditions are always JPEG

    // Park the bytes in Blobs via the synchronous upload function; the
    // ingest payload carries only the reference. An upload failure throws →
    // the poller counts the message failed and retries it next run.
    const blobKey = uploadAttachment_(token, message.getId(), attachments.length, att.getName(), mime, bytes);
    attachments.push({
      filename: att.getName(),
      mimeType: mime,
      bytes: bytes.length,
      blobKey: blobKey
    });
  }

  return {
    token: token,
    channel: channelOf_(message),
    gmailMessageId: message.getId(),
    gmailUrl: 'https://mail.google.com/mail/u/0/#all/' + message.getId(),
    subject: message.getSubject(),
    from: message.getFrom(),
    receivedDate: message.getDate() ? message.getDate().toISOString() : '',
    body: (message.getPlainBody() || '').slice(0, 20000),
    attachments: attachments
  };
}
