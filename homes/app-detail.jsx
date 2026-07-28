/* Listing detail bootstrap — was inline <script type="text/babel"> in
   homes/detail.html; extracted so it can be precompiled (npm run build). */
function App({ properties, initialId }) {
  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
  const id = initialId || new URLSearchParams(location.search).get("id");
  const p = properties.find(x => x.id === id) || properties[0];
  return (
    <React.Fragment>
      <ListingHeader p={p} />
      <PropertyDetail p={p} />
      <ListingFooter />
    </React.Fragment>
  );
}
(async function () {
  // On /homes/<id> the server injects the listing (window.__LISTING__) so React
  // renders instantly with no fetch. Falls back to the feed + ?id= or the path.
  let properties, id;
  if (window.__LISTING__) { properties = [window.__LISTING__]; id = window.__LISTING__.id; }
  else {
    properties = await window.loadListings();
    id = new URLSearchParams(location.search).get("id") || (location.pathname.match(/\/homes\/([^\/?#]+)/) || [])[1];
  }
  ReactDOM.createRoot(document.getElementById("root")).render(<App properties={properties} initialId={id} />);
})();
