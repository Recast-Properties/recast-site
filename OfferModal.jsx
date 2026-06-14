/* ============ Recast Website Kit — multi-step seller intake modal ============ */

function OfferModal({ open, onClose }) {
  const [step, setStep] = React.useState(0);
  const [data, setData] = React.useState({
    address: "", ownerRel: "", reason: "", timeline: "", mortgage: "", liens: "",
    name: "", phone: "", email: "", callDay: "", callTime: "", company: "",
  });
  const set = (k, v) => setData(d => ({ ...d, [k]: v }));

  // Real availability from the backend (Nylas free/busy, weekday 30-min slots).
  const [avail, setAvail] = React.useState({ loading: true, days: [], error: false });
  const [selectedStart, setSelectedStart] = React.useState(""); // ISO start_time of chosen slot
  const [submitting, setSubmitting] = React.useState(false);
  const [submitMsg, setSubmitMsg] = React.useState("");
  const [bookedLabel, setBookedLabel] = React.useState("");

  const loadAvailability = React.useCallback(() => {
    setAvail({ loading: true, days: [], error: false });
    fetch("/.netlify/functions/web-booking", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "availability" }),
    })
      .then(r => r.json())
      .then(j => setAvail(j && j.ok ? { loading: false, days: j.days || [], error: false } : { loading: false, days: [], error: true }))
      .catch(() => setAvail({ loading: false, days: [], error: true }));
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setStep(0);
    setSelectedStart(""); setSubmitMsg(""); setBookedLabel("");
    setData(d => ({ ...d, callDay: "", callTime: "" }));
    loadAvailability();
  }, [open, loadAvailability]);

  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); }, [step, open, avail]);
  if (!open) return null;

  const steps = ["Contact", "Property", "Situation", "Schedule"];
  const canNext =
    (step === 0 && data.name && data.phone) ||
    (step === 1 && data.address.trim().length > 4 && data.ownerRel) ||
    (step === 2 && data.reason && data.timeline) ||
    (step === 3 && selectedStart) ||
    step === 4;

  const next = () => setStep(s => Math.min(s + 1, 4));
  const back = () => setStep(s => Math.max(s - 1, 0));

  const submitOffer = () => {
    if (submitting || !selectedStart) return;
    setSubmitting(true);
    setSubmitMsg("");
    const lead = {
      action: "book",
      start_time: selectedStart,
      name: data.name,
      phone: data.phone,
      email: data.email,
      propertyAddress: data.address,
      ownerRel: data.ownerRel,
      reason: data.reason,
      timeline: data.timeline,
      mortgage: data.mortgage,
      liens: data.liens,
      company: data.company, // honeypot — real users leave blank
    };
    fetch("/.netlify/functions/web-booking", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lead),
    })
      .then(r => r.json())
      .then(j => {
        setSubmitting(false);
        if (j && j.ok && j.status === "booked") {
          setBookedLabel(j.scheduledLabel || (data.callDay + " at " + data.callTime + " CT"));
          setStep(4);
        } else if (j && j.status === "slot_taken") {
          setSubmitMsg("Sorry — that time was just taken. Please pick another.");
          setSelectedStart(""); setData(d => ({ ...d, callTime: "" }));
          loadAvailability();
        } else {
          setSubmitMsg("Something went wrong booking that time. Please try again, or call us at 469-548-7253.");
        }
      })
      .catch(() => {
        setSubmitting(false);
        setSubmitMsg("Couldn't reach our scheduler. Please try again, or call us at 469-548-7253.");
      });
  };

  const ownerOptions = ["I'm the owner", "Family member of the owner", "Authorized representative", "Other"];
  const reasonOptions = ["Foreclosure / behind on payments", "Inherited the property", "Tired of being a landlord",
    "Relocating", "Divorce", "Need cash quickly", "Too many repairs needed", "Just exploring options", "Other"];
  const timelineOptions = ["As soon as possible", "Within 30 days", "1 to 2 months", "3+ months", "Just exploring"];

  // Schedule data comes from the backend now (real open slots).
  const days = avail.days;
  const activeDay = days.find(d => d.date_label === data.callDay) || days[0];
  const timeSlots = activeDay ? activeDay.slots : []; // [{ start_time, label }]

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(24,25,28,0.55)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 560, maxWidth: "100%", padding: 0, boxShadow: "var(--shadow-lg)", overflow: "hidden" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid var(--color-divider)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="assets/recast-mark-orange-transparent.png" alt="" style={{ height: 26 }} />
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Get your cash offer</span>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-500)" }}>
            <Icon name="x" className="ic" style={{ width: 20, height: 20 }} />
          </button>
        </div>

        {/* progress */}
        {step < 4 && (
          <div style={{ display: "flex", gap: 6, padding: "16px 24px 0" }}>
            {steps.map((s, i) => (
              <div key={s} style={{ flex: 1 }}>
                <div style={{ height: 5, borderRadius: 3, background: i <= step ? "var(--terracotta-500)" : "var(--ink-200)" }}></div>
                <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 7, color: i <= step ? "var(--color-brand-press)" : "var(--ink-400)" }}>{s}</div>
              </div>
            ))}
          </div>
        )}

        {/* body */}
        <div style={{ padding: "22px 24px 8px", minHeight: 268 }}>
          {step === 1 && (
            <div>
              <h3 className="rc-h4" style={{ margin: "0 0 6px" }}>Where's the property?</h3>
              <p style={{ marginTop: 0, marginBottom: 18, color: "var(--color-fg-muted)", fontSize: 14.5 }}>Street address, or at minimum the city and nearest cross-street.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Field label="Property address (or city + cross-street)">
                  <input autoFocus value={data.address} onChange={e => set("address", e.target.value)} placeholder="123 Main St, Waxahachie, TX 75165" />
                </Field>
                <Field label="Are you the owner?">
                  <select value={data.ownerRel} onChange={e => set("ownerRel", e.target.value)}>
                    <option value="" disabled>Select one</option>
                    {ownerOptions.map(o => <option key={o}>{o}</option>)}
                  </select>
                </Field>
              </div>
            </div>
          )}
          {step === 2 && (
            <div>
              <h3 className="rc-h4" style={{ margin: "0 0 16px" }}>Tell us about the sale</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
                <div style={{ display: "flex", gap: 14 }}>
                  <Field label="Reason for selling">
                    <select value={data.reason} onChange={e => set("reason", e.target.value)}>
                      <option value="" disabled>Select one</option>
                      {reasonOptions.map(o => <option key={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Timeline">
                    <select value={data.timeline} onChange={e => set("timeline", e.target.value)}>
                      <option value="" disabled>Select one</option>
                      {timelineOptions.map(o => <option key={o}>{o}</option>)}
                    </select>
                  </Field>
                </div>
                <div style={{ display: "flex", gap: 14 }}>
                  <Field label="Mortgage balance / owed (optional)">
                    <input value={data.mortgage} onChange={e => set("mortgage", e.target.value)} placeholder="Rough estimate is fine" />
                  </Field>
                  <Field label="Other liens (optional)">
                    <input value={data.liens} onChange={e => set("liens", e.target.value)} placeholder="Taxes, HOA, etc. or None" />
                  </Field>
                </div>
              </div>
            </div>
          )}
          {step === 0 && (
            <div>
              <h3 className="rc-h4" style={{ margin: "0 0 18px" }}>How can we reach you?</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Field label="Full name"><input autoFocus value={data.name} onChange={e => set("name", e.target.value)} placeholder="Jordan Smith" /></Field>
                <div style={{ display: "flex", gap: 14 }}>
                  <Field label="Best phone to call"><input value={data.phone} onChange={e => set("phone", e.target.value)} placeholder="214.000.0000" /></Field>
                  <Field label="Email (optional)"><input value={data.email} onChange={e => set("email", e.target.value)} placeholder="you@email.com" /></Field>
                </div>
                {/* honeypot — hidden from humans, bots tend to fill it */}
                <input tabIndex="-1" autoComplete="off" value={data.company} onChange={e => set("company", e.target.value)}
                  aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }} />
              </div>
            </div>
          )}
          {step === 3 && (
            <div>
              <h3 className="rc-h4" style={{ margin: "0 0 4px" }}>When's a good time to talk?</h3>
              <p style={{ marginTop: 0, marginBottom: 16, color: "var(--color-fg-muted)", fontSize: 14.5 }}>Pick from our open times. Shown in Central Time. No obligation.</p>

              {avail.loading && (
                <p style={{ color: "var(--color-fg-muted)", fontSize: 14.5, padding: "20px 0" }}>Loading available times…</p>
              )}
              {!avail.loading && avail.error && (
                <p style={{ color: "var(--color-fg-muted)", fontSize: 14.5, padding: "16px 0" }}>
                  We couldn't load times right now. Please call us at 469-548-7253 and we'll get you scheduled.
                </p>
              )}
              {!avail.loading && !avail.error && days.length === 0 && (
                <p style={{ color: "var(--color-fg-muted)", fontSize: 14.5, padding: "16px 0" }}>
                  No open times in the next couple weeks. Please call us at 469-548-7253.
                </p>
              )}

              {!avail.loading && !avail.error && days.length > 0 && (
                <div>
                  <span style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 8 }}>Day</span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 18 }}>
                    {days.map(d => {
                      const active = activeDay && activeDay.date_label === d.date_label;
                      const parts = d.date_label.split(", ");
                      return (
                        <button key={d.date_label} onClick={() => { setData(prev => ({ ...prev, callDay: d.date_label, callTime: "" })); setSelectedStart(""); }} style={{ cursor: "pointer", padding: "11px 4px", borderRadius: "var(--radius-md)",
                          border: active ? "1.5px solid var(--terracotta-500)" : "1.5px solid var(--ink-200)",
                          background: active ? "var(--terracotta-50)" : "var(--white)", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: active ? "var(--terracotta-800)" : "var(--ink-500)" }}>{parts[0]}</span>
                          <span style={{ fontSize: 12.5, fontWeight: 700, color: active ? "var(--terracotta-800)" : "var(--color-fg)" }}>{parts[1] || ""}</span>
                        </button>
                      );
                    })}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 8 }}>Time <span style={{ color: "var(--ink-400)", fontWeight: 600 }}>(Central)</span></span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, maxHeight: 156, overflowY: "auto" }}>
                    {timeSlots.map(slot => {
                      const active = selectedStart === slot.start_time;
                      return (
                        <button key={slot.start_time} onClick={() => { setSelectedStart(slot.start_time); setData(prev => ({ ...prev, callDay: prev.callDay || (days[0] && days[0].date_label), callTime: slot.label })); }} style={{ cursor: "pointer", padding: "10px 4px", borderRadius: "var(--radius-md)",
                          border: active ? "1.5px solid var(--terracotta-500)" : "1.5px solid var(--ink-200)",
                          background: active ? "var(--terracotta-50)" : "var(--white)", fontSize: 13, fontWeight: 700,
                          color: active ? "var(--terracotta-800)" : "var(--color-fg)" }}>{slot.label}</button>
                      );
                    })}
                  </div>
                </div>
              )}

              {submitMsg && <p style={{ color: "var(--terracotta-800)", fontSize: 13.5, marginTop: 14, marginBottom: 0 }}>{submitMsg}</p>}
            </div>
          )}
          {step === 4 && (
            <div style={{ textAlign: "center", padding: "14px 0" }}>
              <div style={{ width: 60, height: 60, borderRadius: "50%", background: "var(--success-50)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
                <Icon name="phone-call" className="ic" style={{ width: 28, height: 28, color: "var(--success-700)" }} />
              </div>
              <h3 className="rc-h3" style={{ margin: "0 0 8px" }}>You're booked, {data.name.split(" ")[0] || "there"}!</h3>
              <p style={{ color: "var(--color-fg-muted)", fontSize: 15, maxWidth: 400, margin: "0 auto 20px" }}>
                We will call you about {data.address || "your property"} at the time you picked. Talk soon.
              </p>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 12, background: "var(--paper-deep)", borderRadius: "var(--radius-md)", padding: "16px 24px" }}>
                <Icon name="calendar-check" className="ic" style={{ width: 24, height: 24, color: "var(--color-brand-press)" }} />
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-500)" }}>Your call</div>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18 }}>{bookedLabel || (data.callDay + " · " + data.callTime + " CT")}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ display: "flex", gap: 12, padding: "12px 24px 24px", alignItems: "center" }}>
          {step > 0 && step < 4 && <Button kind="secondary" onClick={back} icon="arrow-left">Back</Button>}
          {step < 3 && <Button kind="primary" block disabled={!canNext} onClick={next} iconRight="arrow-right">Continue</Button>}
          {step === 3 && <Button kind="primary" block disabled={!canNext || submitting} onClick={submitOffer} icon="phone-call">{submitting ? "Booking…" : "Schedule my call"}</Button>}
          {step === 4 && <Button kind="primary" block onClick={onClose}>Done</Button>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { OfferModal });
