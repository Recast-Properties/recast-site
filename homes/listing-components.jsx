/* ============ Recast Listings Kit — shared helpers, header, footer ============ */

function LIcon({ name, className, style }) {
  return <span className={"ico " + (className || "")} style={style} data-lucide={name} aria-hidden="true"></span>;
}

const fmtPrice = n => "$" + n.toLocaleString("en-US");
const STATUS = {
  available: { label: "Available", bg: "var(--success-50)", fg: "var(--success-700)", dot: "var(--success-500)" },
  pending:   { label: "Pending",   bg: "var(--warning-50)", fg: "var(--warning-700)", dot: "var(--warning-500)" },
  sold:      { label: "Sold",      bg: "var(--ink-100)",    fg: "var(--ink-600)",     dot: "var(--ink-400)" },
};

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.available;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 700,
      padding: "5px 11px", borderRadius: "var(--radius-pill)", background: s.bg, color: s.fg }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.dot }}></span>{s.label}
    </span>
  );
}

/* Listing photo: shows a real image when `src` is provided, else a branded placeholder */
function ListingPhoto({ label = "Property photo", src, alt, style, className, onClick }) {
  const [errored, setErrored] = React.useState(false);
  React.useEffect(() => { setErrored(false); }, [src]);
  if (src && !errored) {
    return (
      <div className={className} onClick={onClick} style={{ position: "relative", background: "var(--paper-deep)", overflow: "hidden", ...style }}>
        <img src={src} alt={alt || label} loading="lazy" onError={() => setErrored(true)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
    );
  }
  return (
    <div className={className} onClick={onClick} style={{ position: "relative", background: "linear-gradient(135deg, var(--paper-warm), var(--paper-deep))",
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", ...style }}>
      <img src="../assets/recast-mark-orange-transparent.png" alt="" style={{ width: 64, opacity: 0.18 }} />
      <span style={{ position: "absolute", bottom: 10, left: 12, fontSize: 11, fontWeight: 700, letterSpacing: ".04em",
        textTransform: "uppercase", color: "var(--ink-500)", background: "rgba(255,255,255,.72)",
        padding: "4px 9px", borderRadius: "var(--radius-pill)" }}>{label}</span>
    </div>
  );
}

/* ---------------------------------- Header ---------------------------------- */
/* On a listing page, `p` carries that property's agent — the header call number
   switches to the listing's agent phone. Off a listing (landing page), `p` is
   omitted and it falls back to the site-wide showing line. */
function ListingHeader({ p }) {
  const listingPhone = String((p && p.agentPhone) || "").trim();
  const phone = listingPhone || "214.906.4992";
  const tel = phone.replace(/[^0-9]/g, "");
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(251,248,244,0.86)",
      backdropFilter: "blur(10px)", borderBottom: "1px solid var(--color-border)" }}>
      <div className="wrap" style={{ height: 74, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <img src="../assets/recast-mark-orange-transparent.png" alt="Recast Properties" style={{ height: 30 }} />
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, color: "var(--ink-900)", letterSpacing: "-0.01em" }}>Recast Properties</span>
        </a>
        <nav className="main-nav" style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {[["Get Notified", "mailto:info@recast-properties.com"], ["Sell Your House", "/sell/"]].map(([l, href]) => (
            <a key={l} href={href} className="nav-link" style={{ fontSize: 15, fontWeight: 600, color: "var(--color-fg-muted)" }}>{l}</a>
          ))}
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <a href={"tel:" + tel} className="header-phone" style={{ display: "inline-flex", alignItems: "center", gap: 13, textDecoration: "none" }}>
            <span className="header-phone-label" style={{ fontWeight: 700, fontSize: 14.5, color: "var(--ink-900)" }}>Call for a showing</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "var(--color-brand)", color: "#fff",
              fontWeight: 700, fontSize: 15, padding: "9px 16px", borderRadius: 999, boxShadow: "0 3px 10px rgba(234,155,96,0.32)" }}>
              <LIcon name="phone" className="ic" style={{ width: 16, height: 16, color: "#fff" }} />{phone}
            </span>
          </a>
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------- Footer ---------------------------------- */
function ListingFooter() {
  return (
    <footer style={{ background: "var(--ink-900)", color: "var(--paper)", paddingTop: 56, marginTop: 20 }}>
      <div className="wrap">
        <div className="footer-grid" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 40, paddingBottom: 44 }}>
          <div>
            <img src="../assets/recast-logo-horizontal-white.png" alt="Recast Properties LLC" style={{ height: 28 }} />
            <p style={{ color: "var(--ink-300)", fontSize: 15, lineHeight: 1.7, maxWidth: 320, marginTop: 18 }}>
              Quality homes for sale across Ellis County and the southern DFW metro.
            </p>
          </div>
          <div>
            <h5 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, margin: "0 0 16px" }}>Explore</h5>
            <a href="/homes/" style={{ display: "block", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>Available homes</a>
            <a href="/sell/" style={{ display: "block", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>Sell your house</a>
          </div>
          <div>
            <h5 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, margin: "0 0 16px" }}>Get in touch</h5>
            <a href="tel:2149064992" style={{ display: "flex", gap: 9, alignItems: "center", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>
              <LIcon name="phone" className="ic" style={{ width: 15, height: 15 }} />214.906.4992</a>
            <a href="mailto:info@recast-properties.com" style={{ display: "flex", gap: 9, alignItems: "center", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>
              <LIcon name="mail" className="ic" style={{ width: 15, height: 15 }} />info@recast-properties.com</a>
          </div>
        </div>
        <div className="footer-bottom" style={{ borderTop: "1px solid var(--ink-700)", padding: "22px 0 32px", display: "flex",
          justifyContent: "space-between", alignItems: "center", color: "var(--ink-400)", fontSize: 13 }}>
          <span>© 2026 Recast Properties LLC. All rights reserved.</span>
          <span style={{ display: "flex", gap: 22 }}>
            <a href="/privacy.html" style={{ color: "var(--ink-400)" }}>Privacy Policy</a>
            <a href="/terms.html" style={{ color: "var(--ink-400)" }}>Terms &amp; Conditions</a>
          </span>
        </div>
      </div>
    </footer>
  );
}

Object.assign(window, { LIcon, fmtPrice, STATUS, StatusBadge, ListingPhoto, ListingHeader, ListingFooter });
