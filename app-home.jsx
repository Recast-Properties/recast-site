/* Root marketing page bootstrap — the interactive offer modal island.
   Was inline <script type="text/babel"> in index.html; extracted so it can be
   precompiled (npm run build) instead of transformed by babel-standalone. */
function OfferApp() {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => { window.recastOpenOffer = () => setOpen(true); }, []);
  return <OfferModal open={open} onClose={() => setOpen(false)} />;
}
ReactDOM.createRoot(document.getElementById("offer-root")).render(<OfferApp />);
