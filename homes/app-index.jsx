/* Listings grid bootstrap — was inline <script type="text/babel"> in
   homes/index.html; extracted so it can be precompiled (npm run build). */
function App({ properties }) {
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
  return (
    <React.Fragment>
      <ListingHeader />
      <main>
        <ListingHero />
        <ListingGrid properties={properties} />
        <ListingCTA />
      </main>
      <ListingFooter />
    </React.Fragment>
  );
}
(async function () {
  // On /homes/ the server injects the listings (window.__LISTINGS__) so React
  // renders instantly with no fetch. Falls back to the CSV feed otherwise.
  const properties = (window.__LISTINGS__ && window.__LISTINGS__.length)
    ? window.__LISTINGS__ : await window.loadListings();
  ReactDOM.createRoot(document.getElementById("root")).render(<App properties={properties} />);
})();
