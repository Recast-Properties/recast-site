/* ============================================================
   Recast Properties — Listings data
   ------------------------------------------------------------
   Listings are managed in the admin tool (recast-properties.com/admin)
   and stored in Netlify Blobs. The site reads them from the /listings
   function, which returns the same CSV shape this loader expects.
   If that ever fails, the site falls back to the built-in sample data
   below automatically (so it never breaks).
   ============================================================ */
window.RECAST_SHEET_CSV_URL = "/.netlify/functions/listings"; // admin-managed listings feed

/* Where the listing photo folders live, relative to the /homes pages.
   Structure:  photos/<folder-name>/1.jpg (hero), 2.jpg, 3.jpg, ...
   The "photos" column in the sheet holds just the <folder-name>. */
window.RECAST_PHOTO_BASE = "../photos/";

/* Listing agent shown on the price callout + photo gallery.
   Change name / phone here and it updates everywhere. */
window.RECAST_AGENT = { name: "Dennis Little", phone: "214.906.4994", tel: "2149064994" };

/* ---- Built-in sample data (fallback + default) ----
   Field shape mirrors common RESO/MLS fields so the same UI can
   later be fed by an IDX feed with no changes.
   photos: empty on purpose — add real, licensed photo URLs. */
window.RECAST_SAMPLE_LISTINGS = [
  {
    id: "wax-elm-412",
    status: "available",
    price: 289000,
    address: "412 Elm Street",
    city: "Waxahachie", state: "TX", zip: "75165",
    beds: 3, baths: 2, sqft: 1640, lot: "0.21 ac", year: 1972,
    type: "Single-family",
    tagline: "Updated brick ranch on a quiet street",
    description:
      "Move-in ready brick ranch in an established Waxahachie neighborhood. New roof (2024), refreshed kitchen, and a large fenced backyard with mature shade trees. Minutes from historic downtown and I-35E.",
    highlights: ["New roof (2024)", "Updated kitchen", "Fenced backyard", "2-car garage", "No HOA"],
    mlsId: "20XXXXX1",
    photos: []
  },
  {
    id: "red-oak-hollow-118",
    status: "available",
    price: 342500,
    address: "118 Hollow Creek Dr",
    city: "Red Oak", state: "TX", zip: "75154",
    beds: 4, baths: 2.5, sqft: 2210, lot: "0.18 ac", year: 2006,
    type: "Single-family",
    tagline: "Spacious two-story with open floor plan",
    description:
      "Four-bedroom two-story with a bright open-concept living and kitchen. Primary suite down, three bedrooms up plus a game room. Covered patio overlooks a generous backyard. Easy commute to south Dallas.",
    highlights: ["Open concept", "Primary down", "Game room", "Covered patio", "Built 2006"],
    mlsId: "20XXXXX2",
    photos: []
  },
  {
    id: "ennis-magnolia-905",
    status: "pending",
    price: 215000,
    address: "905 Magnolia Ave",
    city: "Ennis", state: "TX", zip: "75119",
    beds: 3, baths: 1, sqft: 1280, lot: "0.25 ac", year: 1958,
    type: "Single-family",
    tagline: "Charming cottage near downtown Ennis",
    description:
      "Solid 1950s cottage with original hardwoods and great bones, freshly painted inside and out. Big corner lot with room to add on. Walkable to downtown Ennis shops and the Bluebonnet Trail.",
    highlights: ["Original hardwoods", "Corner lot", "Fresh paint", "Walk to downtown"],
    mlsId: "20XXXXX3",
    photos: []
  },
  {
    id: "midlothian-ridge-2207",
    status: "available",
    price: 415000,
    address: "2207 Ridgeview Ln",
    city: "Midlothian", state: "TX", zip: "76065",
    beds: 4, baths: 3, sqft: 2680, lot: "0.30 ac", year: 2015,
    type: "Single-family",
    tagline: "Like-new build in a sought-after district",
    description:
      "Better-than-new 2015 build in a top Midlothian school zone. Stone-and-brick exterior, oversized island kitchen, study, and a three-car garage. Quarter-acre-plus lot backing to a greenbelt.",
    highlights: ["Top school zone", "Island kitchen", "Study/office", "3-car garage", "Greenbelt lot"],
    mlsId: "20XXXXX4",
    photos: []
  },
  {
    id: "wax-farmto-77",
    status: "available",
    price: 268900,
    address: "77 Farm-to-Market 877",
    city: "Waxahachie", state: "TX", zip: "75167",
    beds: 3, baths: 2, sqft: 1490, lot: "0.9 ac", year: 1989,
    type: "Single-family",
    tagline: "Country feel on nearly an acre",
    description:
      "Get a little breathing room on almost a full acre just outside town. Updated 3/2 with a metal roof, new HVAC, and a detached workshop. Bring the chickens. No city restrictions out here.",
    highlights: ["~0.9 acre", "Metal roof", "New HVAC", "Detached workshop", "No city limits"],
    mlsId: "20XXXXX5",
    photos: []
  },
  {
    id: "ferris-oak-340",
    status: "sold",
    price: 199000,
    address: "340 Oak Grove Rd",
    city: "Ferris", state: "TX", zip: "75125",
    beds: 2, baths: 1, sqft: 1040, lot: "0.17 ac", year: 1965,
    type: "Single-family",
    tagline: "Starter home, fully renovated",
    description:
      "Top-to-bottom renovation: new kitchen, bath, flooring, paint, and systems. Perfect starter or rental. Sold. Call us about what's coming next.",
    highlights: ["Full renovation", "New systems", "Great rental", "Recently sold"],
    mlsId: "20XXXXX6",
    photos: []
  }
];

/* Back-compat: synchronous default before the async loader runs. */
window.RECAST_LISTINGS = window.RECAST_SAMPLE_LISTINGS;
