// Build step: precompile the site's JSX to plain JS so the browser doesn't have
// to run @babel/standalone at page load. Run by `npm run build` (Netlify's build
// command). Transforms JSX only (React.createElement) — the files use global
// React and window.* like before, so the compiled .js load as ordinary scripts
// in the same order. Output .js sits next to each source and is gitignored.
import { transformFileSync } from "@babel/core";
import { writeFileSync } from "node:fs";

const FILES = [
  // root marketing page
  "components.jsx", "OfferModal.jsx", "app-home.jsx",
  // listings grid + detail
  "homes/listing-components.jsx", "homes/landing.jsx", "homes/app-index.jsx",
  "homes/detail.jsx", "homes/app-detail.jsx",
];

let n = 0;
for (const f of FILES) {
  const { code } = transformFileSync(f, {
    presets: [["@babel/preset-react", { runtime: "classic" }]],
    comments: false, compact: false,
  });
  writeFileSync(f.replace(/\.jsx$/, ".js"), code);
  n++;
  console.log("compiled", f);
}
console.log(`\n✓ compiled ${n} JSX files`);
