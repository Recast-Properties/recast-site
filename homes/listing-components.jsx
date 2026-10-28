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
    <React.Fragment>
    <header style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(251,248,244,0.86)",
      backdropFilter: "blur(10px)", borderBottom: "1px solid var(--color-border)" }}>
      <div className="wrap" style={{ height: 74, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <img src="../assets/recast-mark-orange-transparent.png" alt="Recast Properties" style={{ height: 30 }} />
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, color: "var(--ink-900)", letterSpacing: "-0.01em" }}>Recast Properties</span>
        </a>
        <nav className="main-nav" style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {[["Get Notified", "#get-notified"], ["Sell Your House", "/sell/"]].map(([l, href]) => (
            <a key={l} href={href} onClick={href === "#get-notified" ? openNotify : undefined} className="nav-link" style={{ fontSize: 15, fontWeight: 600, color: "var(--color-fg-muted)" }}>{l}</a>
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
    <NotifyModal />
    </React.Fragment>
  );
}

/* ------------------------------- Get Notified ------------------------------- */
/* Buyer sign-up. Posts to the Netlify form "get-notified" (its hidden copy is in
   homes/index.html, which is how Netlify detects it); Netlify emails every
   submission to paul@. Opened by openNotify() from the header link and the
   grid's CTA button. */
function openNotify(e) {
  if (e) e.preventDefault();
  if (window.recastOpenNotify) window.recastOpenNotify();
}

// The exact words a visitor agrees to by ticking the text box. Sent as the
// checkbox's value, so every sign-up records what was agreed to.
const SMS_CONSENT = "Yes, text me about new properties at this number. Recast Properties will only use it " +
  "for new-listing alerts, nothing else. Message frequency varies. Msg & data rates may apply. " +
  "Reply STOP to opt out at any time.";

function NotifyModal() {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState("idle"); // idle | sending | done | error
  const [via, setVia] = React.useState("email");    // email | text | both
  const [err, setErr] = React.useState("");
  React.useEffect(() => {
    window.recastOpenNotify = () => { setOpen(true); setState("idle"); setVia("email"); setErr(""); };
  }, []);
  React.useEffect(() => { if (open && window.lucide) window.lucide.createIcons(); });
  if (!open) return null;
  const close = () => setOpen(false);

  async function submit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.has("phone") && String(fd.get("phone")).replace(/\D/g, "").length < 10) {
      setErr("Please enter a 10-digit mobile number.");
      return;
    }
    setErr(""); setState("sending");
    try {
      // Post to a plain static page: "/" is rewritten to a function, and Netlify
      // only captures form posts sent to a static file.
      const r = await fetch("/privacy.html", { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fd).toString() });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setState("done");
    } catch (_) { setState("error"); }
  }

  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(24,25,28,0.55)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="notify-title" onClick={e => e.stopPropagation()} className="card"
        style={{ width: 480, maxWidth: "100%", maxHeight: "100%", overflowY: "auto", padding: 0, boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid var(--color-divider)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/assets/recast-mark-orange-transparent.png" alt="" style={{ height: 26 }} />
            <span id="notify-title" style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Get notified about new homes</span>
          </div>
          <button onClick={close} aria-label="Close" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-500)" }}>
            <LIcon name="x" className="ic" style={{ width: 20, height: 20 }} />
          </button>
        </div>
        {state === "done" ? (
          <div style={{ padding: "28px 24px 26px" }}>
            <h3 className="rc-h4" style={{ margin: "0 0 8px" }}>You're on the list.</h3>
            <p style={{ margin: "0 0 22px", color: "var(--color-fg-muted)", fontSize: 15 }}>We'll reach out when a home comes up that fits what you're looking for.</p>
            <button className="btn btn-primary" onClick={close}>Done</button>
          </div>
        ) : (
          <form onSubmit={submit} style={{ padding: "22px 24px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ margin: 0, color: "var(--color-fg-muted)", fontSize: 14.5 }}>New homes are added regularly. Leave your info and we'll let you know when one matches.</p>
            <input type="hidden" name="form-name" value="get-notified" />
            <input type="hidden" name="page" value={location.pathname} />
            <p hidden><label>Leave this empty <input name="bot-field" tabIndex={-1} autoComplete="off" /></label></p>
            <label className="field"><span>Name</span>
              <input name="name" required maxLength={100} autoComplete="name" autoFocus placeholder="Jane Smith" /></label>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend style={{ fontSize: 13, fontWeight: 700, color: "var(--color-fg)", marginBottom: 7, padding: 0 }}>How should we reach you?</legend>
              <div style={{ display: "flex", gap: 8 }}>
                {[["email", "Email"], ["text", "Text"], ["both", "Both"]].map(([v, l]) => (
                  <label key={v} style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
                    padding: "10px 0", borderRadius: "var(--radius-md)", cursor: "pointer", fontWeight: 700, fontSize: 14.5,
                    background: via === v ? "var(--terracotta-50)" : "var(--white)",
                    boxShadow: "inset 0 0 0 1.5px " + (via === v ? "var(--terracotta-500)" : "var(--ink-200)") }}>
                    <input type="radio" name="contact-pref" value={v} checked={via === v} onChange={() => setVia(v)}
                      style={{ accentColor: "var(--terracotta-500)", margin: 0 }} />{l}
                  </label>
                ))}
              </div>
            </fieldset>
            {via !== "text" && (
              <label className="field"><span>Email</span>
                <input name="email" type="email" required maxLength={150} autoComplete="email" placeholder="you@email.com" /></label>
            )}
            {via !== "email" && (
              <React.Fragment>
                <label className="field"><span>Mobile phone</span>
                  <input name="phone" type="tel" required maxLength={30} autoComplete="tel" placeholder="214.555.0123" /></label>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5, color: "var(--color-fg-muted)", cursor: "pointer" }}>
                  <input type="checkbox" name="sms-consent" value={SMS_CONSENT} required
                    style={{ accentColor: "var(--terracotta-500)", width: 18, height: 18, marginTop: 1, flexShrink: 0 }} />
                  <span>{SMS_CONSENT} See our <a href="/privacy.html" target="_blank" style={{ color: "var(--color-brand-press)", fontWeight: 600 }}>Privacy Policy</a> and <a href="/terms.html" target="_blank" style={{ color: "var(--color-brand-press)", fontWeight: 600 }}>Terms</a>.</span>
                </label>
              </React.Fragment>
            )}
            <label className="field"><span>What are you looking for? (optional)</span>
              <textarea name="looking-for" rows={3} maxLength={1000} placeholder="Area, bedrooms, price range, move-in timing..." /></label>
            {err && <p role="alert" style={{ margin: 0, color: "var(--error-700)", fontSize: 14 }}>{err}</p>}
            {state === "error" && <p role="alert" style={{ margin: 0, color: "var(--error-700)", fontSize: 14 }}>
              That didn't go through. Please try again, or call 214.906.4992.</p>}
            <button type="submit" className="btn btn-primary btn-block" disabled={state === "sending"}>
              {state === "sending" ? "Sending..." : "Notify me"}</button>
          </form>
        )}
      </div>
    </div>
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

Object.assign(window, { LIcon, fmtPrice, STATUS, StatusBadge, ListingPhoto, ListingHeader, ListingFooter, openNotify });
