/* ============ Recast Website Kit — primitives, header, footer ============ */

function Icon({ name, className, style }) {
  return <span className={"ico " + (className || "")} style={style} data-lucide={name} aria-hidden="true"></span>;
}

function Logo({ variant = "horizontal", height = 34 }) {
  const src = variant === "white"
    ? "/assets/recast-logo-horizontal-white.png"
    : "/assets/recast-logo-horizontal-black.png";
  return <img src={src} alt="Recast Properties" style={{ height }} />;
}

function Button({ kind = "primary", size, block, children, icon, iconRight, ...rest }) {
  const cls = ["btn", "btn-" + kind, size === "lg" ? "btn-lg" : "", block ? "btn-block" : ""].join(" ").trim();
  return (
    <button className={cls} {...rest}>
      {icon && <Icon name={icon} className="ic" />}
      {children}
      {iconRight && <Icon name={iconRight} className="ic" />}
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label && <span>{label}</span>}
      {children}
      {hint && <span style={{ fontSize: 12, color: "var(--color-fg-subtle)" }}>{hint}</span>}
    </label>
  );
}

function PhotoPlaceholder({ id, note = "Drop a photo", style, markStyle }) {
  return (
    <image-slot
      id={id}
      shape="rounded"
      radius="18"
      placeholder={note}
      style={{ display: "block", width: "100%", height: "100%", ...style }}
    ></image-slot>
  );
}

/* ---------------------------------- Header ---------------------------------- */
function Header({ onOffer }) {
  const [open, setOpen] = React.useState(false);
  const links = [["How it works", "#how"], ["Why Recast", "#why"], ["FAQ", "#faq"], ["Homes for Sale", "/homes/"]];
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(251,248,244,0.86)",
      backdropFilter: "blur(10px)", borderBottom: "1px solid var(--color-border)" }}>
      <div className="wrap" style={{ height: 74, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <a href="#top" style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <img src="/assets/recast-mark-orange-transparent.png" alt="Recast Properties" style={{ height: 30 }} />
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, color: "var(--ink-900)", letterSpacing: "-0.01em" }}>Recast Properties</span>
        </a>
        <nav className="main-nav" style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {links.map(([l, href]) => (
            <a key={l} href={href} className="nav-link" style={{ fontSize: 15, fontWeight: 600, color: "var(--color-fg-muted)" }}>{l}</a>
          ))}
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <a href="tel:4695487253" className="header-phone" style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 15 }}>
            <Icon name="phone" className="ic" style={{ width: 16, height: 16, color: "var(--color-brand)" }} />
            469.548.7253
          </a>
          <Button kind="primary" onClick={onOffer}>Get My Offer</Button>
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------- Footer ---------------------------------- */
function Footer({ onOffer }) {
  return (
    <footer style={{ background: "var(--ink-900)", color: "var(--paper)", paddingTop: 64 }}>
      <div className="wrap">
        <div className="footer-grid" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 40, paddingBottom: 48 }}>
          <div>
            <Logo variant="white" height={30} />
            <p style={{ color: "var(--ink-300)", fontSize: 15, lineHeight: 1.7, maxWidth: 320, marginTop: 18 }}>
              We buy houses and land across Ellis County and Southern DFW, without repairs, commissions, or months of uncertainty.
            </p>
          </div>
          <div>
            <h5 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, margin: "0 0 16px" }}>Company</h5>
            {[["How it works", "#how"], ["Why Recast", "#why"], ["FAQ", "#faq"]].map(([l, href]) => (
              <a key={l} href={href} style={{ display: "block", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>{l}</a>
            ))}
            <a href="/homes/" style={{ display: "block", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>Homes for sale</a>
          </div>
          <div>
            <h5 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, margin: "0 0 16px" }}>Get in touch</h5>
            <a href="tel:4695487253" style={{ display: "flex", gap: 9, alignItems: "center", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>
              <Icon name="phone" className="ic" style={{ width: 15, height: 15 }} />469.548.7253</a>
            <a href="mailto:info@recast-properties.com" style={{ display: "flex", gap: 9, alignItems: "center", color: "var(--ink-300)", fontSize: 14, padding: "6px 0" }}>
              <Icon name="mail" className="ic" style={{ width: 15, height: 15 }} />info@recast-properties.com</a>
            <div style={{ marginTop: 14 }}><Button kind="primary" onClick={onOffer}>Get My Offer</Button></div>
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

Object.assign(window, { Icon, Logo, Button, Field, PhotoPlaceholder, Header, Footer });
