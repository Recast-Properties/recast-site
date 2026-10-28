/* ============ Recast Listings Kit — card, filter, landing sections ============ */

function Stat({ icon, value, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <LIcon name={icon} className="ic" style={{ width: 16, height: 16, color: "var(--ink-400)" }} />
      <span style={{ fontWeight: 700, fontSize: 14.5 }}>{value}</span>
      <span style={{ fontSize: 13, color: "var(--color-fg-subtle)" }}>{label}</span>
    </div>
  );
}

function PropertyCard({ p }) {
  const sold = p.status === "sold";
  return (
    <a href={"/homes/" + p.id} className="prop-card" style={{ display: "block", background: "var(--white)",
      borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-sm)", overflow: "hidden",
      transition: "transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out)" }}>
      <div style={{ position: "relative" }}>
        <ListingPhoto label={"Photo · " + p.city} src={window.RecastPhotos ? window.RecastPhotos.heroUrl(p) : (p.photos && p.photos[0])} alt={p.address} style={{ aspectRatio: "3/2" }} />
        <div style={{ position: "absolute", top: 12, left: 12 }}><StatusBadge status={p.status} /></div>
        <div style={{ position: "absolute", bottom: 12, right: 12, background: "rgba(24,25,28,0.82)", color: "#fff",
          fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, padding: "6px 13px", borderRadius: "var(--radius-md)" }}>
          {fmtPrice(p.price)}
        </div>
      </div>
      <div style={{ padding: "18px 20px 20px" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, letterSpacing: "-0.01em" }}>{p.address}</div>
        <div style={{ fontSize: 14, color: "var(--color-fg-muted)", marginTop: 2 }}>{p.city}, {p.state} {p.zip}</div>
        <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
          <Stat icon="bed-double" value={p.beds} label="bd" />
          <Stat icon="bath" value={p.baths} label="ba" />
          <Stat icon="ruler" value={p.sqft.toLocaleString()} label="sqft" />
        </div>
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13.5, color: "var(--color-fg-subtle)" }}>{p.type} · Built {p.year}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: sold ? "var(--ink-400)" : "var(--color-brand-press)", display: "flex", alignItems: "center", gap: 5 }}>
            {sold ? "View" : "Details"}<LIcon name="arrow-right" className="ic" style={{ width: 15, height: 15 }} />
          </span>
        </div>
      </div>
    </a>
  );
}

function FilterBar({ count, sort, setSort }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 26 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ fontSize: 14, color: "var(--color-fg-subtle)", fontWeight: 600 }}>{count} {count === 1 ? "home" : "homes"} available</span>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, color: "var(--color-fg-muted)", fontWeight: 600 }}>Sort</span>
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ padding: "9px 12px", fontSize: 14, width: "auto" }}>
            <option value="featured">Featured</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="sqft-desc">Largest</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function ListingHero() {
  return (
    <section className="listing-hero" style={{ padding: "54px 0 36px" }}>
      <div className="wrap">
        <p className="eyebrow" style={{ marginBottom: 12 }}>Homes for sale</p>
        <h1 className="rc-h1" style={{ fontSize: 46, margin: "0 0 14px", letterSpacing: "-0.02em" }}>Available properties</h1>
        <p className="rc-lead" style={{ maxWidth: 640, margin: 0, textWrap: "pretty" /* no lone last word */ }}>
          Move-in ready and renovated homes across Ellis County and the southern DFW metro.
          New properties are added as they become available.
        </p>
      </div>
    </section>
  );
}

function ListingGrid({ properties }) {
  const list = properties;
  return (
    <section style={{ padding: "0 0 64px" }}>
      <div className="wrap">
        {list.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--color-fg-subtle)" }}>
            <LIcon name="home" className="ic" style={{ width: 30, height: 30 }} />
            <p style={{ fontWeight: 600 }}>No homes in this category right now. Check back soon.</p>
          </div>
        ) : (
          <div className="prop-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
            {list.map(p => <PropertyCard key={p.id} p={p} />)}
          </div>
        )}
      </div>
    </section>
  );
}

/* CTA: new homes added regularly, with the Get Notified sign-up form right in it
   (#get-notified is what the orange bar / header links scroll to). */
function ListingCTA() {
  return (
    <section style={{ padding: "0 0 72px" }}>
      <div className="wrap">
        {/* Wraps instead of using .cta-band's phone stacking: the form drops below the
            text whenever both can't fit side by side. */}
        <div className="notify-band" style={{ background: "var(--paper-deep)", borderRadius: "var(--radius-xl)", padding: "44px 48px",
          display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "28px 48px" }}>
          <div style={{ flex: "1 1 300px", paddingTop: 8 }}>
            <p className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <LIcon name="bell" className="ic" style={{ width: 15, height: 15 }} />Get Notified
            </p>
            <h2 className="rc-h3" style={{ margin: "0 0 8px" }}>New homes added regularly</h2>
            <p style={{ margin: 0, fontSize: 16, color: "var(--color-fg-muted)", maxWidth: 480 }}>
              Be the first to know. Sign up to receive emails and we'll reach out as soon as homes become available.
            </p>
          </div>
          <div id="get-notified" className="card" style={{ flex: "1 1 360px", maxWidth: 480, padding: 0 }}>
            <NotifyForm />
          </div>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { PropertyCard, ListingHero, ListingGrid, ListingCTA });
