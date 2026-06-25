/* ============ Recast Listings Kit — property detail page ============ */
/* BUILD MARKER — bump this every time detail.jsx changes so we can confirm
   the live server is serving the current file (check the browser console). */
console.log("%cRecast detail.jsx — BUILD 23", "color:#EA9B60;font-weight:700");

/* Orange call pill — shared by the gallery viewer, sidebar callout, and mobile bar */
function AgentPill({ compact }) {
  const a = window.RECAST_AGENT || { name: "Recast Properties", phone: "214.906.4992", tel: "2149064992" };
  return (
    <a href={"tel:" + a.tel} className="agent-pill" style={{ display: "inline-flex", alignItems: "center", gap: 14,
      background: "var(--terracotta-500)", color: "#fff", borderRadius: 14, padding: compact ? "10px 18px" : "13px 22px",
      boxShadow: "var(--shadow-brand)", textDecoration: "none",
      transition: "background var(--dur) var(--ease-out), transform var(--dur-fast) var(--ease-out)" }}>
      <span style={{ width: 38, height: 38, borderRadius: "50%", background: "rgba(255,255,255,0.18)",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <LIcon name="phone" className="ic" style={{ width: 18, height: 18 }} />
      </span>
      <span style={{ lineHeight: 1.25 }}>
        <span style={{ display: "block", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: compact ? 15 : 16 }}>{a.name}</span>
        <span style={{ display: "block", fontWeight: 700, fontSize: compact ? 14 : 15, opacity: 0.95 }}>{a.phone}</span>
      </span>
    </a>
  );
}

/* Full-screen photo viewer — photos scroll vertically in numeric order. */
function GalleryViewer({ p, count, onClose }) {
  const photos = [];
  const url = i => window.RecastPhotos ? window.RecastPhotos.urlAt(p, i) : ((p.photos || [])[i] || "");
  for (let i = 0; i < count; i++) photos.push(url(i));

  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (window.lucide) window.lucide.createIcons();
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, []);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 120, background: "rgba(24,25,28,0.62)",
      display: "flex", justifyContent: "center" }}>
      <div className="gallery-modal-panel" onClick={e => e.stopPropagation()} style={{ background: "var(--white)",
        width: "min(1180px, 92vw)", height: "100%", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 80px rgba(0,0,0,0.45)" }}>
      {/* top bar */}
      <div className="gallery-modal-bar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 28px", borderBottom: "1px solid var(--color-divider)", flexShrink: 0 }}>
        <button onClick={onClose} aria-label="Close gallery" style={{ display: "inline-flex", alignItems: "center", gap: 9,
          background: "transparent", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)",
          fontWeight: 700, fontSize: 16, color: "var(--color-fg)", padding: 0 }}>
          <LIcon name="x" className="ic" style={{ width: 20, height: 20 }} />close
        </button>
        <span className="gallery-bar-status" style={{ display: "none" }}><StatusBadge status={p.status} /></span>
      </div>

      {/* body: scrolling photos + info rail */}
      <div className="gallery-modal-body" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 34,
        flex: 1, minHeight: 0, width: "100%", padding: "24px 32px 0" }}>
        <div className="gallery-scroll" style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, paddingBottom: 28 }}>
          {photos.map((src, i) => (
            <img key={i} src={src} alt={p.address + " photo " + (i + 1)} loading={i < 3 ? "eager" : "lazy"}
              style={{ width: "100%", display: "block", borderRadius: "var(--radius-md)" }} />
          ))}
        </div>
        <div className="gallery-info" style={{ paddingBottom: 28 }}>
          <div style={{ fontSize: 14, color: "var(--color-fg-subtle)", fontWeight: 600 }}>Asking price</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 36, letterSpacing: "-0.02em", margin: "2px 0 6px" }}>{fmtPrice(p.price)}</div>
          <div style={{ marginBottom: 22 }}><StatusBadge status={p.status} /></div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Call for a showing or more info</div>
          <AgentPill />
        </div>
      </div>

      {/* mobile bottom bar (shown ≤760px via CSS) */}
      <div className="gallery-mobile-bar" style={{ display: "none", alignItems: "center", justifyContent: "space-between", gap: 14,
        padding: "14px 18px calc(14px + env(safe-area-inset-bottom))", borderTop: "1px solid var(--color-divider)",
        background: "var(--white)", flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.35 }}>Call for a showing<br />or more info</span>
        <AgentPill compact />
      </div>
      </div>
    </div>
  );
}

function Gallery({ p }) {
  const [count, setCount] = React.useState(0);
  const [open, setOpen] = React.useState(false);

  const url = i => window.RecastPhotos ? window.RecastPhotos.urlAt(p, i) : ((p.photos || [])[i] || "");

  // Count photos in the background (lightweight HEAD requests).
  React.useEffect(() => {
    let cancelled = false;
    setCount(0);
    if (window.RecastPhotos) window.RecastPhotos.countFolder(p, n => { if (!cancelled) setCount(n); });
    return () => { cancelled = true; };
  }, [p.id]);

  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); }, [open, count]);

  const main = url(0), second = url(1), third = url(2); // shown immediately
  const openViewer = () => { if (count > 0 || main) setOpen(true); };

  return (
    <React.Fragment>
      <div className="gallery" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, height: 420, overflow: "hidden" }}>
        <div className="gallery-main" style={{ position: "relative", height: "100%", overflow: "hidden", borderRadius: "var(--radius-lg)", cursor: main ? "pointer" : "default" }} onClick={openViewer}>
          <ListingPhoto src={main} label={"Photos coming soon · " + p.address} alt={p.address} style={{ borderRadius: "var(--radius-lg)", height: "100%" }} />
          <div className="gallery-hint" style={{ display: "none", position: "absolute", bottom: 12, right: 12, alignItems: "center", gap: 7,
            background: "rgba(24,25,28,0.72)", color: "#fff", fontSize: 13, fontWeight: 700, padding: "7px 13px", borderRadius: "var(--radius-pill)" }}>
            <LIcon name="images" className="ic" style={{ width: 15, height: 15 }} />
            {count > 1 ? "View " + count + " photos" : "View photos"}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateRows: "1fr 1fr", gap: 12, minHeight: 0 }}>
          <ListingPhoto src={second} label="Photo 2" alt="" onClick={openViewer} style={{ borderRadius: "var(--radius-lg)", overflow: "hidden", minHeight: 0, cursor: second ? "pointer" : "default" }} />
          <div style={{ position: "relative", overflow: "hidden", borderRadius: "var(--radius-lg)", minHeight: 0, cursor: "pointer" }} onClick={openViewer}>
            <ListingPhoto src={third} label="Photo 3" alt="" style={{ borderRadius: "var(--radius-lg)", overflow: "hidden", height: "100%" }} />
            {count > 1 && (
              <div style={{ position: "absolute", inset: 0, borderRadius: "var(--radius-lg)", background: "rgba(24,25,28,0.55)",
                display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 15, gap: 8 }}>
                <LIcon name="images" className="ic" style={{ width: 18, height: 18 }} />
                {count > 3 ? ("+" + (count - 3) + " more") : "View all photos"}
              </div>
            )}
          </div>
        </div>
      </div>
      {open && <GalleryViewer p={p} count={Math.max(count, 1)} onClose={() => setOpen(false)} />}
    </React.Fragment>
  );
}

function FactGrid({ p }) {
  const facts = [
    ["bed-double", p.beds, "Bedrooms"],
    ["bath", p.baths, "Bathrooms"],
    ["ruler", p.sqft.toLocaleString(), "Sq ft"],
    ["land-plot", p.lot, "Lot size"],
    ["calendar", p.year, "Year built"],
    ["home", p.type, "Type"],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "var(--color-border)",
      borderRadius: "var(--radius-lg)", overflow: "hidden", border: "1px solid var(--color-border)" }}>
      {facts.map(([ic, v, l]) => (
        <div key={l} style={{ background: "var(--white)", padding: "20px 22px" }}>
          <LIcon name={ic} className="ic" style={{ width: 20, height: 20, color: "var(--color-brand)" }} />
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, marginTop: 8 }}>{v}</div>
          <div style={{ fontSize: 13, color: "var(--color-fg-subtle)", fontWeight: 600 }}>{l}</div>
        </div>
      ))}
    </div>
  );
}

function InquiryCard({ p }) {
  return (
    <div className="card inquiry-card" style={{ padding: 26, position: "sticky", top: 92 }}>
      <div style={{ fontSize: 13.5, color: "var(--color-fg-subtle)", fontWeight: 600 }}>Asking price</div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, letterSpacing: "-0.02em", margin: "2px 0 4px" }}>{fmtPrice(p.price)}</div>
      <div style={{ marginBottom: 20 }}><StatusBadge status={p.status} /></div>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Call for a showing or more info</div>
      <AgentPill />
    </div>
  );
}

function PropertyDetail({ p }) {
  if (!p) {
    return (
      <div className="wrap" style={{ padding: "90px 0", textAlign: "center" }}>
        <h1 className="rc-h2">Property not found</h1>
        <p style={{ color: "var(--color-fg-muted)" }}>This listing may have been removed.</p>
        <a href="index.html" className="btn btn-primary" style={{ marginTop: 8 }}><LIcon name="arrow-left" className="ic" />Back to all homes</a>
      </div>
    );
  }
  return (
    <main>
      <div className="wrap" style={{ paddingTop: 24, paddingBottom: 8 }}>
        <a href="index.html" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, color: "var(--color-fg-muted)" }}>
          <LIcon name="arrow-left" className="ic" style={{ width: 16, height: 16 }} />All properties
        </a>
      </div>
      <div className="wrap" style={{ paddingBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
          <div>
            <h1 className="rc-h2" style={{ margin: "0 0 4px" }}>{p.address}</h1>
            <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--color-fg-muted)", fontSize: 16 }}>
              <LIcon name="map-pin" className="ic" style={{ width: 16, height: 16, color: "var(--color-brand)" }} />
              {p.city}, {p.state} {p.zip}
            </div>
          </div>
          <div style={{ fontSize: 13, color: "var(--color-fg-subtle)", fontFamily: "var(--font-mono)" }}>MLS# {p.mlsId}</div>
        </div>
        <Gallery p={p} />
      </div>
      {/* Hard spacer — guarantees the photo-to-tagline gap from the JSX itself,
         so no stale detail.html / kit.css can collapse it. Responsive via class. */}
      <div className="gallery-gap" style={{ height: 44 }}></div>
      <div className="wrap detail-cols" style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 40, padding: "0 28px 72px", alignItems: "start" }}>
        <div>
          <p className="eyebrow" style={{ marginBottom: 18, color: "var(--color-fg)" }}>{p.tagline}</p>
          <FactGrid p={p} />
          <h2 className="rc-h4" style={{ margin: "32px 0 10px" }}>About this home</h2>
          <p className="rc-body" style={{ color: "var(--color-fg-muted)", maxWidth: 620 }}>{p.description}</p>

          <h2 className="rc-h4" style={{ margin: "30px 0 14px" }}>Highlights</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {p.highlights.map(h => (
              <div key={h} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 15 }}>
                <LIcon name="check-circle-2" className="ic" style={{ width: 18, height: 18, color: "var(--success-500)", flexShrink: 0 }} />{h}
              </div>
            ))}
          </div>

          <h2 className="rc-h4" style={{ margin: "32px 0 14px" }}>Location</h2>
          <iframe title={"Map of " + p.address}
            src={"https://www.google.com/maps?q=" + encodeURIComponent(p.address + ", " + p.city + ", " + p.state + " " + p.zip) + "&z=15&output=embed"}
            style={{ width: "100%", height: 320, border: 0, borderRadius: "var(--radius-lg)", display: "block" }}
            loading="lazy" allowFullScreen referrerPolicy="no-referrer-when-downgrade"></iframe>

          <p style={{ fontSize: 12, color: "var(--color-fg-subtle)", marginTop: 26, lineHeight: 1.6, maxWidth: 620 }}>
            Information is deemed reliable but not guaranteed. Square footage and details are approximate.
            Recast Properties LLC is the owner/seller of this property.
          </p>
        </div>
        <InquiryCard p={p} />
      </div>
    </main>
  );
}

Object.assign(window, { AgentPill, GalleryViewer, Gallery, FactGrid, InquiryCard, PropertyDetail });
