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
type, tagline, description, highlights, mlsId, agentName, agentPhone, photos`
- `highlights` is stored pipe-delimited (`a|b|c`); the admin shows one per line.
- `agentName` / `agentPhone` are the **per-property "who to call"** shown on the
  listing's orange call button. Leave both blank to use the site-wide default
  (`window.RECAST_AGENT` in `homes/data.js`). The `tel:` link is derived by
  stripping non-digits from `agentPhone`.
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
| `photo.mjs` | **public** | Serves `/photos/<folder>/<n>.jpg` from the `listing-photos` Blob store (long CDN cache w/ `stale-while-revalidate`; `HEAD` is a cheap metadata-only existence check). |
| `photos-list.mjs` | **public** | `?folder=<id>` → `{ count }` for a listing's photos, in one Blob `list`. The gallery uses it instead of probing `1.jpg, 2.jpg, …` one at a time. |
| `listing-page.mjs` | **public** | Server-renders a listing at **`/homes/<id>`** — real content + `<title>`/meta/OG + `RealEstateListing` JSON-LD baked into the HTML, and injects `window.__LISTING__` so React renders instantly. Reads `homes/detail.html` as its template (`included_files`). |
| `homes-index.mjs` | **public** | Server-renders **`/homes/`** — meta + `ItemList` JSON-LD + a linked list of every listing; injects `window.__LISTINGS__`. Template: `homes/index.html`. |
| `sitemap.mjs` | **public** | **`/sitemap.xml`** generated from Blobs, so every current listing URL is included automatically. |
| `admin-migrate-photos.mjs` | auth | One-time import of the original static `photos/` folders into Blobs (already run). |

Shared server code lives in **`netlify/lib/listings.mjs`** (not a function — imported by
the three above): reads the Blob, normalizes to the same shape `sheet-loader.js`
produces, and builds the HTML/meta/JSON-LD.

### Crawler / AI-search visibility
The listing pages are **server-rendered from Blobs** so crawlers and AI search that
don't run JavaScript see the full content (before this, the raw HTML was an empty
`<div id="root">`). `netlify.toml` routes `/homes/<id>` and `/homes/` to the render
functions (the `/homes/<id>` rule is **not** forced, so real static files —
`index.html`, `detail.html`, `*.jsx`, `*.js` — still win; only a bare id falls
through). Old `/homes/detail.html?id=X` links **301** to the clean `/homes/<id>`.
React still boots on top for the interactive UI (it consumes the injected
`window.__LISTING__` / `window.__LISTINGS__`, so there's no re-fetch).

### How the public site reads listings
`homes/data.js` sets `RECAST_SHEET_CSV_URL = "/.netlify/functions/listings"`.
`homes/sheet-loader.js` fetches that CSV and renders the cards/detail pages
exactly as before — so switching off Google Sheets was a one-line change. If the
feed ever fails, the site falls back to the built-in `RECAST_SAMPLE_LISTINGS`.

### Who to call (per-property agent)
Each listing carries its own `agentName` / `agentPhone` (set in the admin editor).
On a **listing detail page** they drive two things, both in `homes/`:
- The orange **call button** (`AgentPill` in `detail.jsx`) shows the agent name +
  phone.
- The **header "Call for a showing"** number (`ListingHeader` in
  `listing-components.jsx`) switches to the listing's `agentPhone`.

If a listing leaves them blank, the call button falls back to the site-wide
default in `homes/data.js` (`window.RECAST_AGENT`), and the header falls back to
its own default line (`214.906.4992`). The **landing page** (`homes/index.html`)
has no single listing, so its header always shows that default. The `tel:` link
is derived by stripping non-digits from the phone. Bump the `?v=` query string on
the changed `.jsx` in `homes/*.html` when editing these, so browsers don't serve
a cached copy.

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

- **Dependencies:** `package.json` has the functions' runtime deps
  (`@netlify/blobs`, `heic-convert`) plus **devDependencies** for the build
  (`@babel/core`, `@babel/preset-react`). Netlify runs `npm install` at deploy.
- **Build step:** `npm run build` (→ `build.mjs`) precompiles the site's **`.jsx`
  → `.js`** (JSX only, via `@babel/preset-react`), so the browser no longer runs
  `@babel/standalone`. Output `.js` sit next to their sources and are **gitignored**
  (build artifacts). `netlify.toml` sets `command = "npm run build"`, `publish = "."`.
  Sources: `components.jsx`, `OfferModal.jsx`, `app-home.jsx`, and under `homes/`
  `listing-components.jsx`, `landing.jsx`, `app-index.jsx`, `detail.jsx`,
  `app-detail.jsx`. (`sections.jsx` is unused/dead.) **Editing a `.jsx` requires a
  rebuild** — bump its `?v=` in the HTML too.
- **Deploy:** from `/Users/paulbjork/Desktop/recast-site Claude`, either
  `npm run build && netlify deploy --prod --no-build`, or `netlify deploy --prod`
  (which runs the build). Git/CI deploys run the build command automatically.
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
- **2026-07-28** — **Build step (JSX precompile).** The site had loaded
  `@babel/standalone` and compiled JSX in the browser on every page load. Added a
  Netlify build (`npm run build` → `build.mjs`) that precompiles `.jsx`→`.js`;
  removed the in-browser Babel from all three pages. Inline `type="text/babel"`
  bootstraps were extracted to `app-home.jsx` / `homes/app-index.jsx` /
  `homes/app-detail.jsx`. No behavior change — just faster first paint.
- **2026-07-28** — **Crawler / AI-search visibility.** Listing pages are now
  server-rendered from Blobs (`listing-page.mjs`, `homes-index.mjs`, shared
  `netlify/lib/listings.mjs`) with full content + meta + OG + JSON-LD in the raw
  HTML — previously the listing content was invisible to non-JS crawlers. Moved to
  clean **`/homes/<id>`** URLs (old `detail.html?id=X` 301s over); dynamic
  `sitemap.xml` lists every listing. React still hydrates the interactive UI.
- **2026-07-28** — **Listings image performance.** Grid heroes + detail-gallery
  photos now serve through **Netlify Image CDN** (resized, WebP) instead of full
  1600px JPEGs; `photo.mjs` cache went from `max-age=60` to
  `max-age=300, stale-while-revalidate=604800`. Root-caused the slow lightbox: the
  gallery counted photos by probing `1.jpg, 2.jpg, …` **sequentially** (~6s for a
  27-photo listing, which blocked the viewer from rendering its image slots).
  Replaced with the new **`photos-list.mjs`** manifest (one request) + a parallel
  fallback; the viewer now preloads its top 3 photos on the detail page. `HEAD` on
  `photo.mjs` is now metadata-only.
- **2026-07-15** — Added **per-property "who to call"**: new `agentName` /
  `agentPhone` fields (admin editor → CSV feed → `AgentPill`), with a site-default
  fallback. On a listing page the **header** call number also switches to the
  listing's agent. Fixed the detail-page **description** dropping paragraph breaks
  (now split into real paragraphs with `white-space: pre-line`).

## Retired (do not resurrect)
- The **Google Sheet** listings source (sheet id `1lpCONle2BfovuOu7_9k17hYwCuDKxnvE0ddeQLdGI5k`).
- The **`listings-admin.gs`** Apps Script and its `LISTINGS_WEBHOOK_URL` /
  `LISTINGS_WEBHOOK_TOKEN` env vars. Removed.
