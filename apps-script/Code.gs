/****************************************************************
 * Recast Properties — Website Lead Handler (Google Apps Script)
 * ------------------------------------------------------------
 * Receives form submissions from the website, appends each one
 * to a Google Sheet, and (if the seller left an email) sends
 * them a confirmation email automatically.
 *
 * SETUP (one time, ~5 minutes):
 *  1. Open the Google Sheet you want leads to land in
 *     (the same spreadsheet Vapi uses is fine — this writes to
 *      its OWN tab so it won't collide with Vapi's columns).
 *  2. Extensions ▸ Apps Script. Delete whatever's in Code.gs and
 *     paste THIS whole file in.
 *  3. Fill in SHEET_ID below (it's the long id in the sheet URL:
 *     docs.google.com/spreadsheets/d/THIS_PART/edit).
 *  4. Click Deploy ▸ New deployment ▸ gear icon ▸ Web app.
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     Click Deploy, authorize when asked, and COPY the Web app URL.
 *  5. Paste that URL into lead-config.js on the website
 *     (RECAST_LEAD_ENDPOINT) and redeploy the site.
 *
 * Note: emails are sent from the Google account that owns this
 * script. Run it under your recast-properties.com Google account
 * so the confirmation comes from your brand.
 ****************************************************************/

const SHEET_ID = "PASTE_YOUR_SPREADSHEET_ID_HERE";
const TAB_NAME = "Website Leads";          // created automatically if missing
const CONTACT_PHONE = "945-245-8458";       // shown in the confirmation email
const INTERNAL_REPLYTO = "paul@recast-properties.com";

const HEADERS = ["Timestamp", "Type", "Name", "Phone", "Email", "Property Address",
  "Owner Relationship", "Reason for Selling", "Timeline", "Mortgage Balance", "Other Liens",
  "Preferred Call", "Listing", "MLS #", "Message"];

function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(TAB_NAME);
    if (!sh) sh = ss.insertSheet(TAB_NAME);
    if (sh.getLastRow() === 0) sh.appendRow(HEADERS);

    const tz = ss.getSpreadsheetTimeZone() || "America/Chicago";
    const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");

    sh.appendRow([
      stamp,
      p.type || "",
      p.name || "",
      p.phone || "",
      p.email || "",
      p["property-address"] || "",
      p["owner-relationship"] || "",
      p.reason || "",
      p.timeline || "",
      p["mortgage-balance"] || "",
      p["other-liens"] || "",
      p["preferred-call"] || "",
      p.property || "",
      p["mls-id"] || "",
      p.message || ""
    ]);

    if (p.email && /\S+@\S+\.\S+/.test(p.email)) sendConfirmation(p);

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function sendConfirmation(p) {
  const first = (p.name || "there").split(" ")[0];
  const where = p["property-address"] ? (" about " + p["property-address"]) : "";
  const subject = p["property-address"]
    ? ("We received your info on " + p["property-address"])
    : "Thanks for reaching out to Recast Properties";
  const callLineHtml = p["preferred-call"]
    ? ("<p style=\"margin:0 0 14px\">We have you down for a call on <strong>" + p["preferred-call"] + "</strong>.</p>")
    : "";
  const html =
    "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#18191C\">" +
      "<p style=\"margin:0 0 14px\">Hi " + first + ",</p>" +
      "<p style=\"margin:0 0 14px\">Thanks for reaching out to Recast Properties. We received your information" + where + " and we'll be in touch soon.</p>" +
      callLineHtml +
      "<p style=\"margin:0 0 14px\">If you need to reschedule, call " + CONTACT_PHONE + ".</p>" +
      "<p style=\"margin:0\">Talk soon,<br>Recast Properties<br>" +
        "<span style=\"color:#71757E\">We buy houses and land for cash. No agents. No fees. No repairs.</span></p>" +
    "</div>";
  const callLineText = p["preferred-call"] ? ("We have you down for a call on " + p["preferred-call"] + ".\n\n") : "";
  const plain =
    "Hi " + first + ",\n\n" +
    "Thanks for reaching out to Recast Properties. We received your information" + where + " and we'll be in touch soon.\n\n" +
    callLineText +
    "If you need to reschedule, call " + CONTACT_PHONE + ".\n\n" +
    "Talk soon,\nRecast Properties\nWe buy houses and land for cash. No agents. No fees. No repairs.";
  MailApp.sendEmail({ to: p.email, subject: subject, body: plain, htmlBody: html, name: "Recast Properties", replyTo: INTERNAL_REPLYTO });
}

function doGet() {
  return ContentService.createTextOutput("Recast lead handler is running.");
}
