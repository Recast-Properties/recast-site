/* ============================================================
   Recast Properties — lead delivery config
   ------------------------------------------------------------
   Paste your Google Apps Script Web App URL between the quotes
   to turn on Google Sheet logging + seller confirmation emails.
   (See apps-script/Code.gs for how to get this URL.)
   Leave it blank to disable — the site still works and Netlify
   still emails Paul; this just adds the Sheet + auto-reply.
   ============================================================ */
window.RECAST_LEAD_ENDPOINT = "https://script.google.com/macros/s/AKfycbwrfE4QP0VjFtNhctVLp30Ibl1YjQk14hOeFLSbIThc5_sZ-zRq6WufMZ-jF8GKafEjiQ/exec";

// Fire-and-forget POST to the Apps Script endpoint (no-cors so the
// browser doesn't block it; we don't need to read the response).
window.recastSubmitLead = function (payload) {
  try {
    var url = (window.RECAST_LEAD_ENDPOINT || "").trim();
    if (!url) return;
    fetch(url, { method: "POST", mode: "no-cors", body: new URLSearchParams(payload) }).catch(function () {});
  } catch (e) { /* never block the UI on lead delivery */ }
};
