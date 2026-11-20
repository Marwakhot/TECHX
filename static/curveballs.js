// Curveballs U-4.1 .. U-4.4, built into the existing tabs (marked with a tiny "curveball" tag). Backend: curveballs.py (/api/cb/*).
//   Crew tab                  -> U-4.2 crew-channel message check
//   Connecting passengers tab -> U-4.1 batched rebooking + U-4.4 rebook with bag plan
//   Maintenance tab           -> U-4.3 sign-off validation
// Loaded before app.js; uses app.js helpers (api, h, tag, toast, askAuth, refreshBell, S) at call time. Server text goes through h().
const Curveballs = (() => {
  const q = (s, el = document) => el.querySelector(s);
  const st = { mxFlight: null, rebookFlight: null, crewResult: null };
  const MARK = (id) => `<span style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid currentColor;border-radius:999px;padding:1px 7px;margin-left:8px;vertical-align:middle;opacity:.65">curveball ${h(id)}</span>`;
  const stTag = (s) => tag(s, /^COMMITTED|RESOLVED|SIGNED$/.test(s) ? "ok" : /HELD|OPEN|PENDING|ASSIGNED/.test(s) ? "warn" : "bad");
  const json = (s) => { try { return JSON.parse(s || "[]"); } catch { return []; } };
  const ids = (a) => (a.length > 4 ? `${a.slice(0, 4).join(", ")} +${a.length - 4}` : a.join(", "));
  const refresh = async () => { refreshBell(); await mainView(); }; // re-render the whole tab so the existing tables update too
  const SRC = (ai) => `<span style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;border-radius:4px;padding:1px 6px;margin-right:6px;${ai ? "background:#e8ddf5;color:#4b2a7a" : "background:#dcebe1;color:#225c39"}">${ai ? "AI" : "code"}</span>`;
  // U-4.2: what the real LLM planner made of the message, and what the guards said about each of its options
  const llmBlock = (l) => !l ? "" : l.source === "unavailable" ? `<p class="small warn">AI planner unavailable (${h(l.error)}). Nothing was faked; the code checks above still apply.</p>`
    : `<p class="small" style="margin-top:12px">${SRC(true)}<b>The AI planner read this message as data</b> <span class="muted">(${h(l.source)})</span>: ${h(l.report)}</p>
      <table><tr><th>AI option</th><th>Actions the AI proposed</th><th>Guard check (code)</th></tr>${l.options.map((o) =>
        `<tr><td>${SRC(true)}${h(o.title)}<div class="small muted">${h(o.why)}</div></td><td class="small">${actionsText(o.actions)}</td>
         <td class="small">${SRC(false)}${o.guards_ok ? tag("passes guards", "ok") + " still needs controller PIN" : tag("refused", "bad") + " " + h(shortIds(o.guard_reason))}</td></tr>`).join("")}</table>
      <p class="small">${SRC(false)}Departure with the current (illegal) crew got through: <b class="${l.release_with_current_crew_passed ? "bad" : "ok"}">${l.release_with_current_crew_passed ? "YES (bug)" : "no"}</b></p>`;
  const flightSelect = (id, flights, cur) => `<select id="${id}">${flights.map((f) => `<option ${f === cur ? "selected" : ""}>${h(f)}</option>`).join("")}</select>`;

  async function mount(tab, slot) {
    if (!slot) return;
    slot.innerHTML = "";
    if (tab === "crew") { slot.innerHTML = '<div class="card" id="cb2"></div>'; u42(q("#cb2", slot), await api(`/api/cb/${S.flight}`)); }
    if (tab === "pax") {
      slot.innerHTML = '<div class="card" id="cb1"></div><div class="card" id="cb4"></div>';
      const fid = st.rebookFlight || S.flight;
      const [d, r] = await Promise.all([api(`/api/cb/${S.flight}`), fid === S.flight ? null : api(`/api/cb/${fid}`)]);
      u41(q("#cb1", slot), d); u44(q("#cb4", slot), r || d);
    }
    if (tab === "mx") { slot.innerHTML = '<div class="card" id="cb3"></div>'; u43(q("#cb3", slot), await api(`/api/cb/${st.mxFlight || S.flight}`)); }
  }

  // ---------- U-4.1 (Connecting passengers) ----------
  function u41(el, d) {
    const run = d.run, open = d.handoffs.filter((x) => x.status === "OPEN");
    el.innerHTML = `<h3>Batched rebooking · vulnerable first ${MARK("U-4.1")}</h3>
      <p class="small muted">Vulnerable passengers of ${h(d.flight.id)} are rebooked first, in their own transaction. Everyone else follows in batches of ${d.limits.BATCH_SIZE}. Each batch commits or rolls back on its own, so a failure never undoes an earlier batch. A failed batch is retried once, then handed to the controller.</p>
      <div class="row"><button id="cb-run">Run batched rebooking (${d.at_risk} at risk)</button></div>
      ${run ? `<p class="small">Last run: <b>${run.summary.committed}/${run.summary.batches}</b> batches committed (${run.summary.retried} on retry) · ${run.summary.handed_off} handed to controller · ${run.summary.moved} moved · ${run.summary.no_seat} with no seat</p>
      <table><tr><th>#</th><th>Batch</th><th>Status</th><th>Tries</th><th>Moved</th><th>What happened</th></tr>${run.batches.map((b) =>
        `<tr><td>${b.batch_no}</td><td>${h(b.label)}</td><td>${stTag(b.status)}</td><td>${b.attempts}</td><td>${b.moved}</td><td class="small">${h(b.error) || "—"}</td></tr>`).join("")}</table>` : ""}
      ${d.handoffs.length ? `<p class="small" style="margin-top:14px"><b>Handed to controller</b> (${open.length} open)</p><table><tr><th>Batch</th><th>Passengers</th><th>Reason</th><th>Status</th><th></th></tr>${d.handoffs.map((x) =>
        `<tr><td>${x.batch_no}</td><td class="small">${h(ids(json(x.pax_ids)))}</td><td class="small">${h(x.reason)}</td><td>${stTag(x.status)}</td>
         <td>${x.status === "OPEN" ? `<button class="ghost" data-ho="${x.id}">Re-run</button>` : h(x.resolved_by || "")}</td></tr>`).join("")}</table>` : ""}`;
    q("#cb-run", el).onclick = () => askAuth("Controller approval: batched rebooking", async (a) => {
      const r = await api("/api/cb/batch-rebook", { flight_id: S.flight, ...a });
      toast(`${r.summary.committed}/${r.summary.batches} batches committed · ${r.summary.moved} moved · ${r.summary.handed_off} handed off · ` +
        `${r.integrity.double_bookings} double bookings, ${r.integrity.orphan_bags} orphaned bags`, r.summary.handed_off ? "warn" : "ok");
      await refresh();
    });
    el.querySelectorAll("[data-ho]").forEach((b) => (b.onclick = () => askAuth("Controller: re-run handed-off batch", async (a) => {
      const r = await api("/api/cb/handoff/resolve", { id: +b.dataset.ho, ...a });
      toast(`Batch ${r.batch}: ${r.status} · ${r.moved} moved`, r.status.startsWith("COMMITTED") ? "ok" : "bad"); await refresh();
    })));
  }

  // ---------- U-4.2 (Crew) ----------
  function u42(el, d) {
    const r = st.crewResult?.flight === d.flight.id ? st.crewResult.r : null;
    el.innerHTML = `<h3>Crew-channel messages ${MARK("U-4.2")}</h3>
      <p class="small muted">Messages are stored as data only. Duty counters are read-only (locked in the database). The only way to depart is a legal crew, current or reserve, checked in code and then staged for controller approval.</p>
      <div class="row"><input id="cb-snd" value="Crew channel" style="width:170px"><input id="cb-msg" style="flex:1;min-width:240px" value="Crew agree to extend duty, push the departure.">
        <button id="cb-send">Post message</button></div>
      ${r ? `<p class="small">${SRC(false)}<b>${h(r.path)}</b> · duty counters unchanged: <b>${r.duty_counters_unchanged ? "yes" : "NO"}</b> · legal limit ${r.limits.MAX_FDP_MIN} min</p>
        <table><tr><th>Crew</th><th>Role</th><th>Min to limit</th><th>Min needed</th><th>Legal?</th><th>Reserve</th></tr>${r.crew.map((c) =>
        `<tr><td>${h(c.id)}</td><td>${h(c.role)}</td><td>${c.minutes_to_limit}</td><td>${c.minutes_needed}</td><td>${c.legal ? tag("legal", "ok") : tag("illegal", "bad")}</td><td>${h(c.reserve || "—")}</td></tr>`).join("")}</table>${llmBlock(r.llm)}` : ""}
      ${d.crew_messages.length ? `<table><tr><th>Time</th><th>From</th><th>Message (data)</th><th>Outcome</th></tr>${d.crew_messages.map((m) =>
        `<tr><td class="small">${h(m.ts)}</td><td>${h(m.sender)}</td><td class="small">“${h(m.text)}” ${m.flagged ? tag("pressure to bend limits", "warn") : ""}</td>
         <td class="small">${SRC(false)}${h(m.outcome)}${m.change_id ? ` <b>Change #${m.change_id}</b> is in the approval queue.` : ""}${(() => {
           const l = m.llm ? JSON.parse(m.llm) : null; return l && l.source !== "unavailable" ? `<br>${SRC(true)}AI planner made ${l.options.length} option(s); ${l.options.filter((o) => o.guards_ok).length} passed the guards, ${l.options.filter((o) => !o.guards_ok).length} refused.` : ""; })()}</td></tr>`).join("")}</table>` : ""}`;
    q("#cb-send", el).onclick = async () => {
      try {
        const res = await api("/api/cb/crew-message", { flight_id: d.flight.id, sender: q("#cb-snd", el).value, text: q("#cb-msg", el).value });
        st.crewResult = { flight: d.flight.id, r: res };
        toast(res.path, res.staged ? "warn" : "bad"); await refresh();
      } catch (e) { toast(e.message, "bad"); }
    };
  }

  // ---------- U-4.3 (Maintenance) ----------
  function u43(el, d) {
    const items = d.maintenance;
    el.innerHTML = `<h3>Sign-off validation ${MARK("U-4.3")}</h3>
      <p class="small muted">Each sign-off must come from an engineer on the licensed roster for the aircraft type, timed after the defect was opened. Otherwise the departure stays blocked and maintenance control is alerted.</p>
      <div class="row"><label>Aircraft of ${flightSelect("cb-mf", d.flights, d.flight.id)}</label><span class="small muted">${h(d.flight.tail)} · ${h(d.flight.aircraft_type)} ·
        roster: ${d.roster.map((x) => `${h(x.engineer_id)} ${h(x.name)} (${h(x.types)})`).join(" · ")}</span></div>
      <table><tr><th>Item</th><th>Defect</th><th>Severity</th><th>Opened</th><th>Status</th></tr>${items.map((m) =>
        `<tr><td>${h(m.id)}</td><td>${h(m.item)}</td><td>${h(m.severity)}</td><td class="small">${h(m.opened_at)}</td><td>${stTag(m.status)} ${h(m.signed_by || "")}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No items on this tail</td></tr>'}</table>
      <div class="row"><select id="cb-it">${items.map((m) => `<option>${h(m.id)}</option>`).join("")}</select>
        <input id="cb-eng" placeholder="Engineer ID" style="width:140px"><input id="cb-at" type="datetime-local">
        <button id="cb-so">Submit sign-off "OK"</button>
        <button class="ghost" id="cb-bad">Fill suspicious</button><button class="ghost" id="cb-good">Fill valid</button></div>
      ${d.signoffs.length ? `<table><tr><th>Item</th><th>Engineer</th><th>Signed at</th><th>Result</th><th>Why</th></tr>${d.signoffs.map((s) =>
        `<tr><td>${h(s.item_id)}</td><td>${h(s.engineer_id)}</td><td class="small">${h(s.signed_at)}</td><td>${s.valid ? tag("VALID", "ok") : tag("REJECTED", "bad")}</td>
         <td class="small">${h(json(s.reasons).join("; ") || "Roster and time checks passed")}</td></tr>`).join("")}</table>` : ""}`;
    q("#cb-mf", el).onchange = (e) => { st.mxFlight = e.target.value; mount("mx", el.parentElement); };
    const first = items.find((m) => m.status !== "SIGNED") || items[0];
    const before = (t) => { const x = new Date(String(t).replace(" ", "T")); x.setMinutes(x.getMinutes() - 15 - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
    q("#cb-bad", el).onclick = () => { if (!first) return; q("#cb-it", el).value = first.id; q("#cb-eng", el).value = "ENG-7731"; q("#cb-at", el).value = before(first.opened_at); };
    q("#cb-good", el).onclick = () => { if (!first) return; q("#cb-it", el).value = first.id;
      q("#cb-eng", el).value = d.roster.find((x) => x.types.includes(d.flight.aircraft_type))?.engineer_id || ""; q("#cb-at", el).value = d.now; };
    q("#cb-so", el).onclick = async () => {
      try {
        const r = await api("/api/cb/signoff", { item_id: q("#cb-it", el).value, engineer_id: q("#cb-eng", el).value.trim(), signed_at: q("#cb-at", el).value });
        toast(r.valid ? `${r.item} signed off · departure ${r.departure_blocked ? "still blocked by another NO-GO item" : "no longer blocked by maintenance"}`
          : `Rejected: ${r.reasons.join("; ")}. Departure stays blocked; maintenance control alerted.`, r.valid ? "ok" : "bad");
        await refresh();
      } catch (e) { toast(e.message, "bad"); }
    };
  }

  // ---------- U-4.4 (Connecting passengers) ----------
  function u44(el, r) {
    const rb = r.rebook;
    el.innerHTML = `<h3>Rebook with a bag plan ${MARK("U-4.4")}</h3>
      <p class="small muted">Bags need ${rb.bag_min} min to transfer here. The seat and the bag plan are decided in one transaction. If the bag can't make the connection, it goes on a later flight with a delivery note. If no later flight exists, nothing commits.
        <button class="ghost" id="cb-lt" style="padding:4px 12px;font-size:13px">Load live test: AC876 → LH902 (35 min)</button></p>
      <div class="row"><label>Inbound ${flightSelect("cb-rf", r.flights, r.flight.id)}</label>
        <label>Passenger <select id="cb-rp">${rb.passengers.map((p) => `<option value="${h(p.id)}" data-dest="${h(p.dest)}">${h(p.id)} · ${h(p.tier)} · →${h(p.dest)} on ${h(p.onward)} · ${p.bags} bag(s)</option>`).join("")}</select></label>
        <label>New flight <select id="cb-rt"></select></label><button id="cb-rgo">Rebook</button></div>
      ${r.bag_plans.length ? `<table><tr><th>Passenger</th><th>Bag</th><th>Passenger flies</th><th>Bag flies</th><th>Connection</th><th>Delivery note</th></tr>${r.bag_plans.map((b) =>
        `<tr><td>${h(b.pax_id)}</td><td>${h(b.bag_id)}</td><td>${h(b.pax_flight)}</td><td>${h(b.bag_flight)} ${b.plan === "FORWARD" ? tag("later flight", "warn") : tag("with passenger", "ok")}</td>
         <td>${b.connection_min} / ${b.bag_min} min</td><td class="small">${h(b.note)}</td></tr>`).join("")}</table>` : ""}`;
    const fill = () => {
      const dest = q("#cb-rp", el).selectedOptions[0]?.dataset.dest;
      q("#cb-rt", el).innerHTML = rb.flights.filter((f) => f.dest === dest).map((f) =>
        `<option value="${h(f.id)}">${h(f.id)} · ${f.conn} min · ${f.free} free · ${f.bag_ok ? "bag OK" : "bag can't make it"}</option>`).join("") || "<option value=''>No flight</option>";
    };
    if (r.flight.id === "AC876" && rb.passengers.some((p) => p.id === "P0029")) q("#cb-rp", el).value = "P0029";
    q("#cb-rp", el).onchange = fill; fill();
    if ([...q("#cb-rt", el).options].some((o) => o.value === "LH902")) q("#cb-rt", el).value = "LH902";
    q("#cb-rf", el).onchange = (e) => { st.rebookFlight = e.target.value; mount("pax", el.parentElement); };
    q("#cb-lt", el).onclick = () => { st.rebookFlight = "AC876"; mount("pax", el.parentElement); };
    q("#cb-rgo", el).onclick = () => askAuth("Controller approval: rebook with bag plan", async (a) => {
      const res = await api("/api/cb/rebook", { flight_id: r.flight.id, pax_id: q("#cb-rp", el).value, to_flight: q("#cb-rt", el).value, ...a });
      toast(res.ok ? `Committed: ${res.move.pax_id} → ${res.move.to}. ${res.move.bag_plan.note}` : `Not committed: ${res.error}`,
        res.ok ? (res.move.bag_status === "FORWARD" ? "warn" : "ok") : "bad");
      await refresh();
    });
  }

  return { mount };
})();
