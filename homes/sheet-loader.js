/* ============================================================
   Recast Properties — listings feed loader
   Fetches the CSV feed at RECAST_SHEET_CSV_URL (set in data.js —
   today the /listings Netlify function, fed by the admin tool),
   parses it, and maps rows → listing objects.
   Falls back to RECAST_SAMPLE_LISTINGS on any error or if blank.
   ============================================================ */
(function () {
  // --- RFC-4180-ish CSV parser (handles quotes, commas, newlines) ---
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, inQ = false;
    text = text.replace(/^\uFEFF/, ""); // strip BOM
    while (i < text.length) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const num = v => {
    const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  };
  const list = v => String(v == null ? "" : v).split("|").map(s => s.trim()).filter(Boolean);
  const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // accept a few header spellings → canonical key
  const ALIAS = {
    id: "id", status: "status", price: "price",
    address: "address", street: "address",
    city: "city", state: "state", zip: "zip", zipcode: "zip",
    beds: "beds", bedrooms: "beds", baths: "baths", bathrooms: "baths",
    sqft: "sqft", squarefeet: "sqft", lot: "lot", lotsize: "lot",
    year: "year", yearbuilt: "year", type: "type", propertytype: "type",
    tagline: "tagline", description: "description", desc: "description",
    highlights: "highlights", features: "highlights",
    mlsid: "mlsId", mls: "mlsId", photos: "photos", photourls: "photos",
    agentname: "agentName", agent: "agentName",
    agentphone: "agentPhone", agentnumber: "agentPhone",
    toururl: "tourUrl", tour: "tourUrl", matterport: "tourUrl", walkthrough: "tourUrl"
  };

  function rowsToListings(rows) {
    if (!rows.length) return [];
    const headers = rows[0].map(h => ALIAS[h.trim().toLowerCase().replace(/[\s_]+/g, "")] || h.trim().toLowerCase());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || cells.every(c => !String(c).trim())) continue; // skip blank rows
      const o = {};
      headers.forEach((h, idx) => { o[h] = cells[idx] != null ? cells[idx].trim() : ""; });
      if (!o.address && !o.id) continue;
      out.push({
        id: o.id || slug((o.city || "") + "-" + (o.address || ("listing-" + r))),
        status: (o.status || "available").toLowerCase(),
        price: num(o.price),
        address: o.address || "",
        city: o.city || "", state: o.state || "TX", zip: o.zip || "",
        beds: num(o.beds), baths: num(o.baths), sqft: num(o.sqft),
        lot: o.lot || "—", year: o.year ? num(o.year) : "—",
        type: o.type || "Single-family",
        tagline: o.tagline || "",
        description: o.description || "",
        highlights: list(o.highlights),
        mlsId: o.mlsId || "",
        agentName: o.agentName || "",
        agentPhone: o.agentPhone || "",
        tourUrl: /^https?:\/\//i.test(o.tourUrl || "") ? o.tourUrl : "",
        photos: /https?:\/\/|\|/.test(o.photos) ? list(o.photos) : [],
        photoFolder: (/https?:\/\/|\|/.test(o.photos) ? "" : (o.photos || "")).trim()
      });
    }
    return out;
  }

  async function loadListings() {
    const url = (window.RECAST_SHEET_CSV_URL || "").trim();
    const fallback = window.RECAST_SAMPLE_LISTINGS || [];
    if (!url) return fallback;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const parsed = rowsToListings(parseCSV(await res.text()));
      if (!parsed.length) throw new Error("no rows parsed");
      window.RECAST_LISTINGS = parsed;
      return parsed;
    } catch (e) {
      console.warn("[Recast] Google Sheet load failed — using built-in sample data.", e.message);
      return fallback;
    }
  }

  // --- Photo helpers (folder-based: photos/<folder>/1.jpg, 2.jpg, ...) ---
  function photoBase() { return (window.RECAST_PHOTO_BASE || "../photos/"); }

  // Route a same-origin photo through Netlify's Image CDN so it's resized to the
  // size actually displayed and re-encoded as WebP (a 700 KB / 1600px hero becomes
  // a ~60 KB card-sized WebP), and the transformed result is cached hard at the
  // edge. External photo URLs are left untouched (they'd need remote_images config)
  // and an empty src passes through so the placeholder still shows.
  function cdnImg(src, width) {
    if (!src || /^https?:\/\//i.test(src)) return src;
    var abs = String(src).replace(/^(?:\.\.\/)+/, "/"); // ../photos/x/1.jpg -> /photos/x/1.jpg
    if (abs.charAt(0) !== "/") abs = "/" + abs;
    return "/.netlify/images?url=" + encodeURIComponent(abs) + "&w=" + width + "&fm=webp&q=72";
  }

  function heroUrl(p) {
    if (p.photos && p.photos.length) return p.photos[0];
    if (p.photoFolder) return cdnImg(photoBase() + p.photoFolder + "/1.jpg", 800);
    return "";
  }
  // Direct URL for the i-th photo (0-indexed) without probing.
  function urlAt(p, i) {
    if (p.photos && p.photos.length) return p.photos[i] || "";
    if (p.photoFolder) return photoBase() + p.photoFolder + "/" + (i + 1) + ".jpg";
    return "";
  }
  // Probe contiguously-numbered images (1.jpg, 2.jpg, …) until one is missing.
  function probeFolder(p, done) {
    if (p.photos && p.photos.length) { done(p.photos.slice()); return; }
    if (!p.photoFolder) { done([]); return; }
    const base = photoBase() + p.photoFolder + "/";
    const found = [];
    (function tryNext(n) {
      if (n > 60) { done(found); return; }
      const img = new Image();
      img.onload = function () { found.push(base + n + ".jpg"); tryNext(n + 1); };
      img.onerror = function () { done(found); };
      img.src = base + n + ".jpg";
    })(1);
  }

  // How many photos a listing has, in ONE request. The manifest endpoint reads the
  // photo Blob store and returns the count; if it's unavailable we fall back to a
  // fast PARALLEL probe (all HEADs at once, not the old one-at-a-time walk that
  // cost ~6s and blocked the lightbox). Returns a Promise<number>.
  async function manifest(p) {
    if (p.photos && p.photos.length) return p.photos.length;
    if (!p.photoFolder) return 0;
    try {
      const r = await fetch("/.netlify/functions/photos-list?folder=" + encodeURIComponent(p.photoFolder));
      if (r.ok) { const j = await r.json(); if (j && typeof j.count === "number") return j.count; }
    } catch (e) { /* fall through to probe */ }
    return parallelCount(p);
  }
  function parallelCount(p) {
    if (!p.photoFolder) return Promise.resolve(0);
    const base = photoBase() + p.photoFolder + "/";
    const MAX = 60;
    return Promise.all(
      Array.from({ length: MAX }, function (_, i) {
        return fetch(base + (i + 1) + ".jpg", { method: "HEAD" }).then(function (r) { return r.ok; }).catch(function () { return false; });
      })
    ).then(function (oks) { let n = 0; while (oks[n]) n++; return n; });
  }
  // Back-compat callback wrapper (older callers passed a done() callback).
  function countFolder(p, done) { manifest(p).then(done); }

  window.RecastListings = { parseCSV, rowsToListings, loadListings };
  window.RecastPhotos = { heroUrl, urlAt, probeFolder, countFolder, manifest, cdnImg };
  window.loadListings = loadListings;
})();
