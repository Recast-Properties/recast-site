# Listings & Admin — recast-properties.com

How the public **listings** (the "Available Properties" pages) work, and the
**admin tool** at `recast-properties.com/admin` used to manage them.

This is separate from the phone/website **scheduler** backend — see `CLAUDE.md`
for that. They share the same Netlify site and `netlify/functions/` folder but
nothing else.

---

## In plain terms (how to use it)

1. Go to **recast-properties.com/admin** (laptop or phone) and enter the admin
   password. You stay logged in for that browser session.
2. **+ New listing** — fill in the fields, drag in photos, hit **Save**. It's
   live on the site immediately. No deploy, no spreadsheet.
3. **Click any listing** to edit it — change text, add/remove/reorder photos
   (the first photo is the cover), then **Save**.
4. **Delete** removes the listing and all its photos.

**The Listing ID** doubles as the photo folder name (e.g. `104ashburne`). Pick a
short, lowercase, no-spaces id when you create a listing; it can't be changed
afterward (it's how the photos are tied to the listing).

**Photos:** drop in **JPG / PNG / WebP**. The browser auto-shrinks and renumbers
them. Raw iPhone **HEIC** files may not convert in a desktop browser — if a photo
won't upload, it's almost always HEIC; re-save/share it as JPG first. (Photos
shared from an iPhone usually arrive as JPG already.)

**Password:** stored as the Netlify environment variable `ADMIN_PASSWORD`. To see
or change it, use the Netlify dashboard (Site settings → Environment variables)
or `netlify env:set ADMIN_PASSWORD <new>` then redeploy. It is intentionally NOT
written down in this repo.

---

## How it works (architecture)

Everything lives in **Netlify Blobs** (Netlify's built-in key/value storage).
There is **no database, no Google Sheet, and no Apps Script** — the admin tool is
the single source of truth.

### Data stores (Netlify Blobs)
- **`listings-data`** store, key **`listings.json`** — an array of listing
  objects (one per property), keyed by the field names below. Read with **strong
  consistency** so a save shows up immediately on reload.
- **`listing-photos`** store — keys **`<folder>/<n>.jpg`** (e.g.
  `104ashburne/1.jpg`), always numbered contiguously `1..n`. Photos being
  uploaded are briefly staged under `<folder>/.stg/<uuid>.jpg` and cleared once
  the order is committed.

### Listing fields
`id, status, price, address, city, state, zip, beds, baths, sqft, lot, year,
type, tagline, description, highlights, mlsId, photos`
- `highlights` is stored pipe-delimited (`a|b|c`); the admin shows one per line.
- `photos` holds the **folder name** (= the `id`).
- `status` is `available | pending | sold`.

### Functions (`netlify/functions/`)
All admin functions require the header **`x-admin-token: <ADMIN_PASSWORD>`** and
are written as **Netlify v2 (ESM `.mjs`, `export default`)** — required so Blobs
auto-configures (the older `exports.handler` style does NOT get Blobs).

| Function | Public? | Purpose |
|---|---|---|
| `admin-ping.mjs` | auth | Password check (the login screen calls this). |
| `admin-listings.mjs` | auth | `list` / `save` (upsert by id) / `delete` / `seed`. |
| `admin-photos.mjs` | auth | `list` / `add` (stage one photo) / `arrange` (set final order) / `clear`. |
| `listings.mjs` | **public** | Read-only feed the website loads — returns the listings as **CSV**. |
| `photo.mjs` | **public** | Serves `/photos/<folder>/<n>.jpg` from the `listing-photos` Blob store. |
| `admin-migrate-photos.mjs` | auth | One-time import of the original static `photos/` folders into Blobs (already run). |

### How the public site reads listings
`homes/data.js` sets `RECAST_SHEET_CSV_URL = "/.netlify/functions/listings"`.
`homes/sheet-loader.js` fetches that CSV and renders the cards/detail pages
exactly as before — so switching off Google Sheets was a one-line change. If the
feed ever fails, the site falls back to the built-in `RECAST_SAMPLE_LISTINGS`.

### How photos are served
`netlify.toml` force-redirects `/photos/*` → the `photo.mjs` function, which reads
from the `listing-photos` Blob store. The original static `photos/` folders are
kept in the repo as a backup but are shadowed by this redirect.

### Photo upload flow (why it's one-at-a-time)
A Netlify function request body is capped at ~6 MB. Sending a whole photo set in
one request fails past ~12 photos. So the admin uploads **each photo
individually** (`add` → staged in Blobs, returns an id), then sends one tiny
**`arrange`** call with just the ordered list of references (no image bytes) to
number them `1..n`. The save button shows `Uploading 7/30…` while it runs, and
each photo tracks a staged id so a retry never re-uploads.

### Auth model
The `/admin` page is public HTML, but every data action is enforced
**server-side** against `ADMIN_PASSWORD`. The listing/photo data is already
public on the live site, so nothing secret is exposed; the password only gates
**writing**.

---

## Build / deploy

- **Dependencies:** `package.json` exists only so functions can use
  `@netlify/blobs`. Netlify runs `npm install` at deploy and bundles it into each
  function; `node_modules` is auto-excluded from the published site.
- **No build step.** The site is plain files published from the repo root
  (`netlify.toml` → `publish = "."`).
- **Deploy:** `netlify deploy --prod` from `/Users/paulbjork/Desktop/recast-site`.
  (`--no-build` is fine since there's nothing to build.)
- **Local dev:** `netlify dev` (Blobs is emulated locally). Note: Blobs-dependent
  behavior is most reliably verified against a deploy preview / prod.

---

## Change log

- **2026-06-24** — Built the admin tool (listings + photo uploads) on Netlify
  Blobs. Initially wired to the Google Sheet via an Apps Script, then
  **scrapped that** per Paul's call: listings now live entirely in Blobs, edited
  only in the admin tool. Seeded the 3 existing listings from the old sheet.
- **2026-06-24** — Fixed a 500 when saving listings with many photos (the ~6 MB
  body limit): switched to per-photo upload + `arrange`. Added strong consistency
  to both Blob stores.
- **2026-06-24** — Admin polish: clear the password field after login (stops
  Chrome's repeated "save password?" prompt); Recast logo in the top-left and the
  page title/back button moved above the content, on both the list and editor
  screens.

## Retired (do not resurrect)
- The **Google Sheet** listings source (sheet id `1lpCONle2BfovuOu7_9k17hYwCuDKxnvE0ddeQLdGI5k`).
- The **`listings-admin.gs`** Apps Script and its `LISTINGS_WEBHOOK_URL` /
  `LISTINGS_WEBHOOK_TOKEN` env vars. Removed.
