/* ============ Recast Properties — seller page sections (direct layout + FAQ) ============ */

/* ---------------------------------- HERO ---------------------------------- */
function Hero({ onOffer }) {
  return (
    <section id="top" className="hero-sec" style={{ padding: "72px 0 80px" }}>
      <div className="wrap hero-grid" style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 56, alignItems: "center" }}>
        <div>
          <span className="badge"><Icon name="map-pin" className="ic" />Waxahachie, TX · Ellis County &amp; Southern DFW</span>
          <h1 className="rc-h1 hero-h1" style={{ fontSize: 52, lineHeight: 1.05, margin: "20px 0 14px", letterSpacing: "-0.02em" }}>
            A faster, <span style={{ color: "var(--color-brand)" }}>easier</span> way to sell.
          </h1>
          <p className="rc-h4" style={{ fontWeight: 600, color: "var(--color-fg)", margin: "0 0 14px" }}>We buy houses and land for cash. Any condition, on your timeline.</p>
          <p className="rc-lead" style={{ maxWidth: 480, marginBottom: 28 }}>
            Foreclosure, bad tenants, an inherited house, a vacant property, or land you're done
            holding. If you need to sell, we can help.
          </p>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <Button kind="primary" size="lg" icon="hand-coins" onClick={onOffer}>Get My Offer</Button>
            <a href="tel:4695487253" className="btn btn-secondary btn-lg"><Icon name="phone" className="ic" />Call 469.548.7253</a>
          </div>
          <div className="hero-trust" style={{ display: "flex", gap: 26, marginTop: 30 }}>
            {[["clock", "Offer in 24–48 hrs"], ["calendar", "Close on your timeline"], ["shield-check", "No obligation"]].map(([ic, t]) => (
              <div key={t} style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 14, fontWeight: 600, color: "var(--color-fg-muted)" }}>
                <Icon name={ic} className="ic" style={{ width: 17, height: 17, color: "var(--color-brand)" }} />{t}
              </div>
            ))}
          </div>
        </div>
        <div style={{ position: "relative" }}>
          <img src="assets/hero-home.webp" alt="A home Recast purchased in the Dallas area" className="hero-photo-img"
            style={{ display: "block", width: "100%", aspectRatio: "4/5", objectFit: "cover", objectPosition: "center",
              borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)" }} />
        </div>
      </div>
    </section>
  );
}

/* ----------------------------- VALUE STRIP (dark) ----------------------------- */
function TrustStrip() {
  const vals = [["ban", "No agents"], ["circle-dollar-sign", "No fees"], ["wrench", "No repairs"], ["home", "As-is"]];
  return (
    <section style={{ background: "var(--ink-900)", color: "var(--paper)", padding: "22px 0" }}>
      <div className="wrap" style={{ display: "flex", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        {vals.map(([ic, l]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 11, fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 18 }}>
            <Icon name={ic} className="ic" style={{ width: 20, height: 20, color: "var(--terracotta-400)" }} />{l}
          </div>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------- PROCESS (3 steps) -------------------------------- */
function HowItWorks({ onOffer }) {
  const steps = [
    ["clipboard-list", "Tell us about the property", "Share the address, property type, and a few basic details."],
    ["search-check", "We review & make an offer", "We look at the property, location, condition, and your timeline, then make a straightforward cash offer."],
    ["calendar-check", "Close when it works for you", "No repairs, no drawn-out listing, no hassles. You pick the timeline."],
  ];
  return (
    <section id="how" style={{ background: "var(--paper-deep)", padding: "88px 0" }}>
      <div className="wrap">
        <div style={{ textAlign: "center", maxWidth: 620, margin: "0 auto 52px" }}>
          <p className="eyebrow">How it works</p>
          <h2 className="rc-h2" style={{ margin: 0 }}>A simple, three-step process</h2>
        </div>
        <div className="cards-3" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 22 }}>
          {steps.map(([ic, t, d], i) => (
            <div key={t} className="card" style={{ padding: 30 }}>
              <div style={{ width: 50, height: 50, borderRadius: 13, background: "var(--terracotta-100)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name={ic} className="ic" style={{ width: 24, height: 24, color: "var(--terracotta-700)" }} />
              </div>
              <p className="eyebrow" style={{ margin: "18px 0 6px" }}>Step 0{i + 1}</p>
              <h3 className="rc-h4" style={{ margin: "0 0 8px" }}>{t}</h3>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--color-fg-muted)" }}>{d}</p>
            </div>
          ))}
        </div>
        <div style={{ textAlign: "center", marginTop: 44 }}>
          <Button kind="primary" size="lg" onClick={onOffer} iconRight="arrow-right">Get My Offer</Button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- WHY RECAST ------------------------------- */
function Benefits() {
  const items = [
    ["zap", "Fast cash close", "Cash offer in 24–48 hours and a close in as little as a couple weeks."],
    ["shield-check", "No obligation", "Review the offer with no pressure. If it's not right for you, walk away."],
    ["map-pin", "We're local", "Based in Waxahachie and active across Ellis County. We know the area."],
    ["handshake", "Real solutions", "We offer down-to-earth solutions tailored to your situation."],
  ];
  return (
    <section id="why" style={{ padding: "88px 0" }}>
      <div className="wrap split" style={{ display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 56, alignItems: "center" }}>
        <div>
          <p className="eyebrow">Why Recast</p>
          <h2 className="rc-h2" style={{ margin: "0 0 16px" }}>Why work with Recast Properties?</h2>
          <p className="rc-body" style={{ color: "var(--color-fg-muted)", maxWidth: 380 }}>
            Selling the traditional way means repairs, showings, and months of waiting.
            We take all of that off your plate.
          </p>
          <img src="assets/why-recast-home.webp" alt="A brick home in the Dallas\u2013Fort Worth area"
            style={{ display: "block", width: "100%", marginTop: 26, aspectRatio: "16/10", objectFit: "cover", objectPosition: "center",
              borderRadius: "var(--radius-lg)" }} />
        </div>
        <div className="cards-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {items.map(([ic, t, d]) => (
            <div key={t} className="card" style={{ padding: 26 }}>
              <Icon name={ic} className="ic" style={{ width: 26, height: 26, color: "var(--color-brand)" }} />
              <h4 className="rc-h5" style={{ margin: "16px 0 7px", fontWeight: 600 }}>{t}</h4>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--color-fg-muted)" }}>{d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ SERVICE AREA ------------------------------ */
function ServiceArea() {
  const cities = ["Waxahachie", "Midlothian", "Maypearl", "Oak Leaf", "Red Oak", "Glenn Heights", "Ovilla", "Ennis", "Palmer", "Ferris", "Italy", "Venus"];
  return (
    <section id="service-area" style={{ padding: "88px 0 0" }}>
      <div className="wrap split" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "start" }}>
        <div>
          <p className="eyebrow">Serving Ellis County &amp; Southern DFW</p>
          <h2 className="rc-h2" style={{ margin: "0 0 16px" }}>Buying close to home.</h2>
          <p className="rc-lead" style={{ margin: 0, maxWidth: 470 }}>
            We focus on Ellis County and nearby Southern DFW communities, but we'll consider the right property anywhere.
          </p>
        </div>
        <div className="card" style={{ padding: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
            <Icon name="map-pin" className="ic" style={{ width: 18, height: 18, color: "var(--color-brand)" }} />
            <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-500)" }}>Communities we serve</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {cities.map(c => (
              <span key={c} style={{ fontSize: 14, fontWeight: 600, padding: "8px 14px", borderRadius: "var(--radius-pill)",
                background: "var(--terracotta-50)", color: "var(--terracotta-800)", border: "1px solid var(--terracotta-200)" }}>{c}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- FAQ --------------------------------- */
function FAQ() {
  const items = [
    ["Do you buy land?", "Yes. We review land, acreage, lots, and inherited land across Ellis County and Southern DFW."],
    ["Can you help if I'm facing foreclosure?", "Often, yes. Reach out as early as you can. The more time we have, the more options there usually are."],
    ["Do I need to make repairs first?", "No. We buy properties as-is, including homes that need repairs, cleanup, or updating."],
    ["Do you charge commissions?", "No. There are no agent commissions when you sell directly to Recast Properties."],
    ["Do I need to clean out the property?", "Not always. In many cases we can work with properties that still have items left behind."],
    ["Am I obligated to accept an offer?", "No. You can review the offer and decide if it works for you. No pressure."],
  ];
  const [open, setOpen] = React.useState(0);
  return (
    <section id="faq" style={{ background: "var(--paper-deep)", padding: "88px 0" }}>
      <div className="wrap" style={{ maxWidth: 820, marginLeft: "auto", marginRight: "auto" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <p className="eyebrow">FAQ</p>
          <h2 className="rc-h2" style={{ margin: 0 }}>Common questions</h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map(([q, a], i) => {
            const isOpen = open === i;
            return (
              <div key={q} className="card" style={{ padding: 0, overflow: "hidden" }}>
                <button onClick={() => setOpen(isOpen ? -1 : i)} style={{ width: "100%", cursor: "pointer", border: "none",
                  background: "transparent", padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 16, textAlign: "left", fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 17.5, color: "var(--color-fg)" }}>
                  {q}
                  <Icon name={isOpen ? "minus" : "plus"} className="ic" style={{ width: 20, height: 20, color: "var(--color-brand)", flexShrink: 0 }} />
                </button>
                {isOpen && (
                  <div style={{ padding: "0 24px 22px", fontSize: 15.5, lineHeight: 1.6, color: "var(--color-fg-muted)", maxWidth: 680 }}>{a}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ FINAL CTA ------------------------------ */
function FinalCTA({ onOffer }) {
  return (
    <section style={{ padding: "40px 0 88px" }}>
      <div className="wrap">
        <div className="cta-band" style={{ background: "var(--terracotta-500)", borderRadius: "var(--radius-xl)", padding: "56px",
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 30, boxShadow: "var(--shadow-brand)" }}>
          <div>
            <h2 className="rc-h2" style={{ color: "#fff", margin: "0 0 10px" }}>Get started today.</h2>
            <p style={{ color: "rgba(255,255,255,0.92)", fontSize: 17, margin: 0, maxWidth: 500 }}>
              Tell us about the house or land you're thinking about selling. We'll review it and follow
              up with a straightforward next step.
            </p>
          </div>
          <button className="btn btn-lg" style={{ background: "var(--ink-900)", color: "#fff", whiteSpace: "nowrap" }} onClick={onOffer}>
            Get My Offer<Icon name="arrow-right" className="ic" />
          </button>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Hero, TrustStrip, HowItWorks, Benefits, ServiceArea, FAQ, FinalCTA });
