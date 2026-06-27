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
  INGEST_URL: 'https://receipts--incomparable-raindrop-8f3d22.netlify.app/.netlify/functions/receipts-ingest',
  RECEIPT_ADDRESS: 'receipts@recast-properties.com',
  DONE_LABEL: 'receipts-done',
  SEARCH_WINDOW: 'newer_than:90d',
  MAX_THREADS: 15,
  MAX_ATTACH_BYTES: 4 * 1024 * 1024, // skip attachments larger than ~4 MB (Netlify body cap)
  MAX_ATTACH_COUNT: 6                 // at most N attachments per email
};

function authorize() {
  GmailApp.getInboxUnreadCount();
  UrlFetchApp.getRequest(CONFIG.INGEST_URL);
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
    const query = '(to:' + CONFIG.RECEIPT_ADDRESS + ' OR label:receipts) -label:' + CONFIG.DONE_LABEL + ' ' + CONFIG.SEARCH_WINDOW;
    const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);

    let ingested = 0, items = 0, failed = 0;
    threads.forEach(function (thread) {
      let threadOk = true;
      thread.getMessages().forEach(function (message) {
        try {
          const payload = buildPayload_(message, token);
          const res = UrlFetchApp.fetch(CONFIG.INGEST_URL, {
            method: 'post', contentType: 'application/json',
            payload: JSON.stringify(payload), muteHttpExceptions: true
          });
          const code = res.getResponseCode();
          let data = {};
          try { data = JSON.parse(res.getContentText()); } catch (e) {}
          if (code === 200 && data.ok) { ingested++; items += (data.added || 0); }
          else { threadOk = false; failed++; console.error('Ingest failed (' + code + '): ' + res.getContentText().slice(0, 300)); }
        } catch (err) {
          threadOk = false; failed++; console.error('Poller error: ' + String(err));
        }
      });
      if (threadOk) thread.addLabel(doneLabel);
    });

    console.log('Receipts poll: ' + ingested + ' email(s), ' + items + ' line item(s) queued, ' + failed + ' failure(s).');
  } finally {
    lock.releaseLock();
  }
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

    const bytes = att.getBytes();
    if (bytes.length > CONFIG.MAX_ATTACH_BYTES) {
      console.warn('Skipping large attachment "' + att.getName() + '" (' + bytes.length + ' bytes) on msg ' + message.getId());
      continue;
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

    attachments.push({
      filename: att.getName(),
      mimeType: mime,
      bytes: bytes.length,
      dataBase64: Utilities.base64Encode(bytes)
    });
  }

  return {
    token: token,
    gmailMessageId: message.getId(),
    gmailUrl: 'https://mail.google.com/mail/u/0/#all/' + message.getId(),
    subject: message.getSubject(),
    from: message.getFrom(),
    receivedDate: message.getDate() ? message.getDate().toISOString() : '',
    body: (message.getPlainBody() || '').slice(0, 20000),
    attachments: attachments
  };
}
