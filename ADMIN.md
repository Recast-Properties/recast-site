# Listings & Admin — recast-properties.com

How the public **listings** (the "Available Properties" pages) work, the **admin
hub** at `recast-properties.com/admin`, and the tools under it.

This is separate from the phone/website **scheduler** backend — see `CLAUDE.md`
for that. They share the same Netlify site and `netlify/functions/` folder but
nothing else.

---

## The public site (layout and rules)

| URL | Page | Source |
|---|---|---|
| `/` | **Homepage = the listings grid** (forced rewrite to `homes-index`) | `homes/index.html` + `homes/landing.jsx` |
| `/homes/` | The same grid; its canonical URL | same |
| `/homes/<id>` | One listing (server-rendered) | `homes/detail.html` + `homes/detail.jsx` |
| `/sell/` | Seller page ("we buy houses", cash-offer form) | `sell/index.html` + `components.jsx`, `OfferModal.jsx`, `app-home.jsx` |
| `/index.html` | 301 to `/` (the seller page lived here before) | `netlify.toml` |

- **Never move or redirect `/homes/` or `/homes/<id>`.** QR codes on yard signs
  point there.
- **Shared listings chrome** lives in `homes/listing-components.jsx`: the orange
  "New homes added regularly" bar and the nav, pinned together inside the sticky
  header; the menu (Get Notified, Sell Your House) and call pill, which fold
  into a hamburger below 900px (`.listing-header` rule in `kit.css`); the
  footer; and the Get Notified sign-up.
- **Get Notified sign-up** (`NotifyForm`): name, Email / Text / Both, email
  and/or mobile, and a required, unticked text-consent box whose exact wording
  (`SMS_CONSENT`) is sent as its value, so every sign-up records what was agreed
  to. It posts to the **Netlify form `get-notified`** (hidden detection copy in
  `homes/index.html`; field names must match), and a Netlify email notification
  sends each one to paul@ as "NEW BUYER SIGN-UP (Get Notified)". It posts to
  `/privacy.html`, not `/`: Netlify only captures form posts sent to a static
  file, and `/` is rewritten to a function. On the homepage the form sits inline
  in the bottom box (`#get-notified`) and every Get Notified link scrolls there;
  on listing pages the same links open it as a pop-up (`openNotify()`).
- **Open:** the site's Terms and Privacy pages describe texts only for seller
  inquiries and appointments. Before texting listing alerts from the business
  number, they need a line covering new-listing alerts.
- **Paths are absolute** (`/assets/...`, `/homes/...`) in `homes/index.html` and
  the seller page, because the grid template renders at both `/` and `/homes/`.
- **Bump the `?v=`** on any changed `.js`/`.css` in the page that loads it, or
  browsers keep the cached copy.

---

## The admin hub (since 2026-08-11)

**`/admin` is the landing page for all internal tools.** One password
(`ADMIN_PASSWORD`), one remembered login (`localStorage` key
`recast_admin_token`, shared by every page and by `/receipts` — sign in once
on a device and it stays signed in until **Sign out**):

| URL | Tool |
|---|---|
| `/admin/` | The hub — cards + nav to everything below. |
| `/admin/listings/` | Listings admin (was at `/admin` before 2026-08-11). |
| `/admin/email/` | **Email setup** — create a property email (alias + label + filter) on paul@ or properties@. Replaces the two Apps Script "Email Setup" dialogs. |
| receipts alias URL | Receipts queue (still on its own Netlify alias deploy — see `RECEIPTS.md`; the hub links out). |
| — | Auction Sheets: placeholder card, not built. |

Every admin page is `noindex, nofollow` and served `cache-control: no-store`
(`netlify.toml`).

### Email setup (`/admin/email/` + `email-setup.mjs`)

One form: pick the **mailbox** (paul@ / properties@ — hardcoded allowlist),
type an alias name, confirm, and the function runs the steps, reporting each
one separately (a failed step shows red — never a green "done").

**The two mailboxes use DIFFERENT models** (matching how each was historically
set up — discovered 2026-08-12 when properties@ "didn't work"):

- **paul@ — ALIAS model:** ① Workspace alias on the user (if the address
  already belongs to someone else, the error names the owner) → ② Gmail label
  named after the alias → ③ filter `to:<alias>` → label, skip inbox.
- **properties@ — GROUP model** (each property email is a **Google Group**,
  properties@ is just a member; the form adds a required **Property name**
  field, e.g. "320 Elm"): ① Google Group `<alias>@` with the property name as
  its group name → ② group settings: anyone can post, no moderation/spam
  quarantine, invited-only join → ③ properties@ added as MEMBER → ④ Gmail
  label named the **property name** (not the alias), in properties@ →
  ⑤ filter `query:<groupEmail>` → label, skip inbox **and spam**.
  Which mailbox is group-model is the `GROUP_MAILBOXES` list in the function
  (mirrored by `isGroup()` in the page).

Re-running is safe: already-existing pieces count as success. The page lists
the chosen mailbox's current property emails (aliases for paul@; groups the
mailbox is a member of, with their names, for properties@).

**Removal:** each entry in the list has a **Remove** button (confirm step, then
per-step report like create). It undoes the pieces in reverse order — paul@:
filter → label → Workspace alias (if the alias actually lives on the *other*
mailbox the error names the owner); properties@: filter → label (looked up via
the group's name) → the Google Group itself. Mail to the address bounces
afterward; old messages stay in the mailbox but lose the label grouping.
Already-gone pieces count as success (safe to re-run).
`info@recast-properties.com` is **protected** (hardcoded `PROTECTED` list in
`email-setup.mjs`) — it's the FROM address for the call-summary/confirmation
emails; the UI shows a "protected" tag instead of a button and the function
refuses it server-side.

**The old Apps Script dialogs:** the paul@ one ("Create Property Email",
bound to its sheet) was retired 2026-08-11 — its code was replaced with a
retirement comment, so the "Recast Tools → Email Setup" menu no longer
appears. The properties@ one ("Add Property Email", under the properties@
account's script.google.com) is **not** a twin — it's the group-model script
this tool now mirrors. Retire it the same way once the group model is
verified working end to end here.

**How it authenticates to Google:** a **service account with domain-wide
delegation** (`email-setup@recast-admin.iam.gserviceaccount.com`). The function
hand-rolls the RS256 JWT → token exchange (native `crypto`, no googleapis
dependency) and impersonates `GOOGLE_ADMIN_USER` for the Directory/Groups
calls and the target mailbox for the Gmail calls. The DWD grant
(admin.google.com → Security → API controls → Domain-wide delegation) must
authorize the service account's client ID for exactly these five scopes:
`admin.directory.user.alias`, `gmail.labels`, `gmail.settings.basic`, plus for
the group model `admin.directory.group` and `apps.groups.settings`. The group
model also needs the **Groups Settings API** enabled on the `recast-admin` GCP
project (Admin SDK is already on).

**Env vars (Netlify):** `GOOGLE_SA_EMAIL` (service-account client_email),
`GOOGLE_SA_KEY` (its PEM private key; `\n`-escaped is fine),
`GOOGLE_ADMIN_USER` (`paul@recast-properties.com`).

---

## In plain terms (how to use the listings admin)

1. Go to **recast-properties.com/admin** (laptop or phone), enter the admin
   password, and open **Listings Admin** (or go straight to
   `recast-properties.com/admin/listings`). The login is remembered on that
   device until you hit **Sign out** (since 2026-09-03).
2. **+ New listing** — fill in the fields, drag in photos, hit **Save**. It's
   live on the site immediately. No deploy, no spreadsheet.
3. **Click any listing** to edit it — change text, add/remove/reorder photos
   (the first photo is the cover), then **Save**. The pill beside the title
   opens that listing's own page: **View live page ↗** when it's live,
   **Preview ↗** (the `?preview=1` link) while it isn't.
4. **Live checkbox** (right end of every row) — untick it and the property
   disappears from the public site everywhere (cards, its own page, sitemap)
   but stays here, dimmed. Tick it to put it back. Saves on click.
5. **Preview ↗** (right end of every row, after Live) opens the listing's own
   page at `/homes/<id>?preview=1`. It works **whether or not the listing is
   live** — so untick Live, build the listing, and send that link to Dennis to
   check it before it goes public. Copy the address from the tab it opens.
   Not password-protected: anyone with the link can open it. While the listing
   isn't live a yellow "Preview" banner sits across the top, and search
   engines are told not to index the page.
6. **View live site ↗** (pill beside the "Listings" heading) opens the public
   `/homes/` page in a new tab to check what visitors see.
7. **Delete** removes the listing and all its photos.
8. **3D walkthrough** — paste the Matterport share link into the "3D walkthrough
   URL" field and Save. The listing page gets a 3D walkthrough button; clear the
   field to remove it.

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
type, tagline, description, highlights, mlsId, agentName, agentPhone, tourUrl,
photos, hidden`
- `highlights` is stored pipe-delimited (`a|b|c`); the admin shows one per line.
- `agentName` / `agentPhone` are the **per-property "who to call"** shown on the
  listing's orange call button. Leave both blank to use the site-wide default
  (`window.RECAST_AGENT` in `homes/data.js`). The `tel:` link is derived by
  stripping non-digits from `agentPhone`.
- `tourUrl` is the optional **3D walkthrough** link (a Matterport share URL like
  `https://my.matterport.com/show/?m=XXXX`). When set, the listing page shows a
  "3D walkthrough" chip on the gallery hero and a "View 3D walkthrough" button
  under the call button; both open the tour in an in-page viewer (iframe, with
  an "Open in new tab" link). Only an `http(s)://` value is stored — anything
  else is dropped server-side. Blank = no button.
- `photos` holds the **folder name** (= the `id`).
- `status` is `available | pending | sold`.
- `hidden` is `"1"` or `""` — the **Live** checkbox on each row of the listings
  admin (and in the editor). `"1"` keeps the listing off every public surface —
  the `/homes/` cards, its `/homes/<id>` page (404 + noindex), the sitemap, the
  JSON-LD and the CSV feed — while the admin still shows it, dimmed. Absent on
  rows saved before 2026-09-03, which reads as visible. `status` is a different
  axis: a `sold` listing still shows (with its SOLD badge) unless it is hidden.
  The one way to see a hidden listing is the **preview link**,
  `/homes/<id>?preview=1` (the admin's Preview ↗) — see `listing-page.mjs`.

### Functions (`netlify/functions/`)
All admin functions require the header **`x-admin-token: <ADMIN_PASSWORD>`** and
are written as **Netlify v2 (ESM `.mjs`, `export default`)** — required so Blobs
auto-configures (the older `exports.handler` style does NOT get Blobs).

| Function | Public? | Purpose |
|---|---|---|
| `admin-ping.mjs` | auth | Password check (the login screen calls this). |
| `admin-listings.mjs` | auth | `list` / `save` (upsert by id) / `delete` / `reorder` / `visibility` (flip one row's `hidden` without touching its other fields) / `seed`. |
| `admin-photos.mjs` | auth | `list` / `add` (stage one photo) / `arrange` (set final order) / `clear`. |
| `listings.mjs` | **public** | Read-only feed the website loads — returns the listings as **CSV**. |
| `photo.mjs` | **public** | Serves `/photos/<folder>/<n>.jpg` from the `listing-photos` Blob store (long CDN cache w/ `stale-while-revalidate`; `HEAD` is a cheap metadata-only existence check). |
| `photos-list.mjs` | **public** | `?folder=<id>` → `{ count }` for a listing's photos, in one Blob `list`. The gallery uses it instead of probing `1.jpg, 2.jpg, …` one at a time. |
| `listing-page.mjs` | **public** | Server-renders a listing at **`/homes/<id>`** — real content + `<title>`/meta/OG + `RealEstateListing` JSON-LD baked into the HTML, and injects `window.__LISTING__` so React renders instantly. Reads `homes/detail.html` as its template (`included_files`). With **`?preview=1`** it also renders a *hidden* listing (`readListings({ includeHidden: true })`): `noindex` + `x-robots-tag`, `cache-control: no-store`, and a "Preview" banner above the page while the listing is hidden. No password — anyone with the link can open it. |
| `homes-index.mjs` | **public** | Server-renders the grid at **`/`** (the homepage) and **`/homes/`** — meta + `ItemList` JSON-LD + a linked list of every listing; injects `window.__LISTINGS__`. Template: `homes/index.html`. |
| `sitemap.mjs` | **public** | **`/sitemap.xml`** generated from Blobs, so every current listing URL is included automatically. |
| `admin-migrate-photos.mjs` | auth | One-time import of the original static `photos/` folders into Blobs (already run). |
| `email-setup.mjs` | auth | Property-email creator/remover (see "Email setup" above): `list` / `create` / `remove`, alias model for paul@ and Google-Group model for properties@, via a Google service account with domain-wide delegation. `info@` protected. |

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
The `/` rewrite serves the same grid render. The crawler copy sits in a
`.ssr-copy` wrapper that `homes/index.html` and `homes/detail.html` hide
(`html.js`, set by a tiny head script) from browsers that run scripts, so it
doesn't flash as a plain list before React draws; it is shown again after 4s if
the page scripts never load. Crawlers still get it in the raw HTML.

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
its own default line (`214.906.4992`). The **landing page** (`homes/index.html`, served at both `/` and `/homes/`)
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
- **Deploy:** from `/Users/paulbjork/Desktop/Claude/Recast-site`, either
  `npm run build && netlify deploy --prod --no-build`, or `netlify deploy --prod`
  (which runs the build). Git/CI deploys run the build command automatically.
  **The `netlify` CLI is not on PATH on this Mac** (found 2026-09-08): no global
  install, no Homebrew copy. The working binary is the npx cache at
  `~/.npm/_npx/b3ca12a867cd0704/node_modules/.bin/netlify` (netlify-cli 27.4.1,
  logged in as paul@, linked to site `1452cbfc-…`). `npx netlify-cli` without a
  version tries to download the newest release and stops for confirmation, so
  either call that binary directly or `npm i -g netlify-cli` once.
- **Repo:** `main`, pushed to GitHub (`Recast-Properties/recast-site`). Commit and push with every change.
- **Local dev:** `netlify dev` (Blobs is emulated locally). Note: Blobs-dependent
  behavior is most reliably verified against a deploy preview / prod.

---

## Change log

- **2026-10-28** — **Listings grid became the homepage** (layout above, "The
  public site").
  - `/` serves the grid; the seller page moved from `index.html` to `/sell/`;
    `/index.html` 301s to `/`. `/homes/` URLs unchanged for the sign QR codes.
  - Listings header: Get Notified + Sell Your House menu; seller page menu gained
    Homes for Sale. Seller page logo now links to `/` (it scrolled to its own top).
  - Orange "New homes added regularly. Be the first to know." bar, pinned with
    the nav. The listing page's sticky price card moved down to clear the taller
    header (`top: 141`).
  - Get Notified went from a mailto to the `get-notified` Netlify form: first a
    pop-up, then inline in the homepage's bottom box with a home photo beside it
    on desktop (hidden on phones).
  - Phones: hamburger menu (later raised to below 900px, because the header
    wrapped at tablet width), two-line orange bar, tighter hero spacing.
  - Crawler copy no longer flashes before the page draws (`.ssr-copy`, hidden
    when scripts run; shown again after 4s if they fail).
  - Styling: no glow on any orange button; All properties became a small orange
    pill; bolder "Homes for sale" / "Get Notified" labels (`.eyebrow-strong`);
    phone number removed from every footer's "Get in touch"; "become available"
    wording; the hero intro widened so its last word never sits alone.

- **2026-10-22** — **Editor header pill.** Beside the "Edit listing" title, a
  right-aligned pill opens that listing's page in a new tab — `/homes/<id>`
  when live, `/homes/<id>?preview=1` (labelled Preview ↗) while hidden. Set in
  `openEditor()` from the saved row; hidden on a new, unsaved listing.

- **2026-10-21** — **Preview link for not-yet-live listings.** Every row of the
  listings admin has a **Preview ↗** link (after the Live checkbox) to
  `/homes/<id>?preview=1`. `listing-page.mjs` reads that flag and calls
  `readListings({ includeHidden: true })` (new option in
  `netlify/lib/listings.mjs`, whose normalized shape gained a `hidden`
  boolean), so a hidden listing renders instead of 404ing. The preview
  response is `noindex` (meta + `x-robots-tag`), `cache-control: no-store`,
  and carries a yellow "Preview — this listing is not on the public site yet"
  banner while the listing is hidden; a live listing's preview link is just
  its page. Deliberately not password-protected (Paul's call — it's for
  sending to Dennis): anyone who knows the id and adds `?preview=1` can open a
  hidden listing, as they already could its photos. Every other public surface
  (grid, CSV feed, sitemap, JSON-LD) still filters hidden rows.

- **2026-09-08** — **3D walkthrough (Matterport) per listing** (deployed, commit
  `117a70e`). New optional
  `tourUrl` field in the admin editor, stored with the listing and carried
  through the CSV feed, `netlify/lib/listings.mjs` and `sheet-loader.js`
  (http(s) only). On the detail page a `TourButton` (in `detail.jsx`) renders a
  chip on the gallery hero and a full-width button in the inquiry card; either
  opens `TourViewer`, a modal iframe styled like the photo viewer, with the
  Matterport URL given `play=1` so it starts without the splash screen, plus an
  "Open in new tab" link. The server-rendered crawler content gains a plain
  "3D walkthrough" link. Bumped `detail.js` to v30 / BUILD 30 and
  `sheet-loader.js` to v9 on both homes pages. No card badge on the grid (not
  built).

- **2026-09-03** — **Per-listing "Live" checkbox.** Each row of the listings
  admin (and the editor, next to Status) has a **Live** checkbox that controls
  whether the property appears on the public site. Stored as `hidden` = `"1"`;
  filtered out in the two public readers — `netlify/lib/listings.mjs`
  `readListings()` (so `/homes/`, `/homes/<id>` → 404, sitemap and JSON-LD all
  agree) and the `listings.mjs` CSV feed — so a hidden row never leaves the
  server. The row checkbox calls a new `visibility` action that touches only
  that flag (`save` normalizes every field, so a partial save would have
  blanked the rest); the editor's Save carries the flag through. Unchecked rows
  dim in the admin. Older rows have no `hidden` field and read as visible, so
  nothing on the site changed when this shipped. Same day: a **View live site
  ↗** pill beside the "Listings" heading, right-aligned with the cards, opens
  the public `/homes/` page in a new tab.

- **2026-09-03** — **Admin login is remembered.** `/admin`, `/admin/listings/`
  and `/admin/email/` kept the password in `sessionStorage`, so every new tab
  or browser restart asked for it again. Switched to `localStorage` (reading
  the old `sessionStorage` key as a fallback so an open session isn't logged
  out by the deploy), matching what `/receipts` has done since 2026-08-21.
  **Sign out** clears both. The stored value is still the password itself,
  validated against `admin-ping` on every page load — a wrong or rotated
  password just lands on the login screen.

- **2026-08-12** — **Group model verified live** end to end (create `testremove@`
  + remove, all steps green). One hiccup found and fixed: Google's members call
  can 503 ("Service unavailable") while a fresh group provisions — the member
  step now retries like the settings step (the old Apps Script's 4s sleep
  covered the same race). With this proven, the properties@ Apps Script
  ("Add Property Email") is clear to retire — still pending, needs the
  properties@ account's script.google.com.
- **2026-08-12** — **properties@ = GROUP model.** Removal "worked for paul@ but
  not properties@": turned out properties@'s property emails are **Google
  Groups** (per its old Apps Script "Add Property Email": group + external
  posting + properties@ as member + label named the property name + filter
  `query:<group>` skipping inbox+spam) — the 2026-08-11 tool had wrongly
  assumed aliases for both, and its SA had no group scopes (verified by API
  probe: properties@ is a real user with zero aliases). `email-setup.mjs` now
  branches on `GROUP_MAILBOXES`: list/create/remove use the group model for
  properties@ (create takes a required property-name label; group-create
  failure blocks the rest, other steps run independently; settings step retries
  while a fresh group provisions), alias model unchanged for paul@. `list`
  returns `{mode, entries:[{address,name}]}`. UI: property-name field +
  group-aware copy/preview/list. **Needs two manual grants** (see "How it
  authenticates"): DWD scopes `admin.directory.group` + `apps.groups.settings`,
  and the Groups Settings API enabled on `recast-admin`.
- **2026-08-12** — **Email removal.** `/admin/email/` alias list gained a
  per-alias **Remove** button; `email-setup.mjs` gained the `remove` action
  (filter → label → alias, idempotent, per-step report) and a hardcoded
  `PROTECTED` list (`info@`) it refuses to delete. `list` now also returns
  `protectedAliases` so the UI can hide the button. No new DWD scopes needed.
- **2026-08-11** — **Admin hub + email setup.** `/admin` became the hub landing
  page; the listings tool moved to `/admin/listings/` (same code, absolute
  paths, new nav bar). New `/admin/email/` + `email-setup.mjs`: one tool creates
  a property email (Workspace alias + Gmail label + skip-inbox filter) on either
  paul@ or properties@ via a service account with domain-wide delegation —
  replaces the two per-mailbox Apps Script "Email Setup" dialogs (whose
  identical-looking dialogs caused a wrong-mailbox mixup on 2026-08-11). Added
  `no-store` headers for `/admin/*`.
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
