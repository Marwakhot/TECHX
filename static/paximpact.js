// Connecting Passengers tab, powered by the Passenger Impact Agent (pax_impact.py).
// Read-only analysis + a recommendation hand-off. Nothing on this tab books, buys, modifies or issues a ticket:
// "Send to Rebooking Recommendations" stages a PENDING recommendation that a controller approves or rejects (with PIN).
// Uses app.js helpers at call time (h, api, toast, askAuth, S). Every server string is escaped with h().
const PaxImpact = (() => {
  const q = (s, el = document) => el.querySelector(s);
  const P = { root: null, data: null, sel: new Set(), open: null, view: "table", showLow: false, sort: { key: "priority", dir: 1 },
    f: { priority: "", status: "", flight: "", dest: "", assist: "", dep: "", bucket: "", bags: "" }, revealed: {}, override: {}, timer: null,
    out: { failed: {}, failedDecs: [], loaded: false } };
  const NOF = { priority: "", status: "", flight: "", dest: "", assist: "", dep: "", bucket: "", bags: "" };

  // ---- passenger outcome buckets (display only: every bucket is derived from fields the API already returns) ----
  // One bucket per passenger, in workflow order. "Failed" = the latest rebooking decision for that passenger in the decision log was
  // rejected, rolled back or blocked by the guards, and the passenger still has no booking and nothing pending.
  const BUCKETS = [
    ["rebooked", "Rebooked", "Human-approved booking recorded in the audit log", "#2f8a52"],
    ["pending", "Awaiting approval", "Recommendation is in the controller approval queue", "#d9a84e"],
    ["failed", "Rebooking failed", "Last attempt was rejected, rolled back or blocked by the guards: needs a new option", "#b3362a"],
    ["missed", "Missed · flight gone", "Onward flight has already departed and no booking is recorded", "#6e2a1e"],
    ["needs", "Needs rebooking", "Likely to miss the connection; no recommendation sent yet", "#c2703d"],
    ["risk", "At risk", "Connection still possible but has little spare time beyond MCT", "#e6c8a0"],
    ["safe", "Safe connection", "Connection remains feasible", "#cfc5b8"],
    ["unknown", "Unknown data", "Connecting flight missing from the flight data", "#8f8580"]];
  const BMAP = Object.fromEntries(BUCKETS.map((b) => [b[0], b]));
  const FAILTXT = { REJECTED: "rejected by controller", ROLLED_BACK: "rolled back", BLOCKED: "blocked by guards" };
  function bucket(p) {
    if (p.status === "Rebooked") return "rebooked";
    if (p.status === "Unknown") return "unknown";
    if (p.pending) return "pending";
    if (p.status === "Likely missed" || p.status === "Confirmed missed") return P.out.failed[p.ref] ? "failed" : p.status === "Confirmed missed" ? "missed" : "needs";
    if (p.status === "At risk") return P.out.failed[p.ref] ? "failed" : "risk";
    return "safe";
  }
  // baggage blockers: the backend's own "bags may not make it" finding, or bags checked onto a different flight than the passenger
  function bagIssue(p) {
    if (!p.bags) return null;
    if (p.bag_location && p.bag_location !== p.connecting_flight) return `bags are on ${p.bag_location}, passenger is on ${p.connecting_flight}`;
    if (p.status !== "Safe connection" && (p.factors || []).some((f) => f.includes("bags may not make it"))) return "bags may not make the connection";
    return null;
  }
  const needsAction = (b) => b === "failed" || b === "missed" || b === "needs";
  let me = "";
  try { me = localStorage.getItem("aviant.me") || ""; } catch { /* private mode */ }
  const PICON = { Critical: "◆", High: "▲", Medium: "●", Low: "○", Unknown: "?" };
  const PRANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Unknown: 4 };
  const prio = (p) => `<span class="px-p ${h(p)}">${PICON[p] || ""} ${h(p)}</span>`;
  const SCLS = { "Confirmed missed": "miss", "Likely missed": "miss", "At risk": "risk", "Safe connection": "ok", Rebooked: "ok" };
  const MCT = '<abbr title="Minimum connection time: the shortest time a passenger needs between arriving and the onward departure">MCT</abbr>';

  async function mount(el) {
    P.root = el;
    el.innerHTML = '<div class="dl-skel"></div><div class="dl-skel"></div><div class="dl-skel"></div>';
    el.onclick = onClick; el.onchange = onChange;
    el.oninput = (e) => { if (e.target.id === "px2-q") { P.q = e.target.value; q("#px-list", P.root).innerHTML = list(curRows()); } };
    clearInterval(P.timer);
    P.timer = setInterval(tick, 1000);
    await load();
  }
  async function load() {
    try {
      const [pax, decs] = await Promise.all([api(`/api/pax/${S.flight}`), api("/api/decisions").catch(() => null)]);
      P.data = pax; P.out = outcomes(decs);
    }
    catch (e) {
      P.root.innerHTML = `<div class="card"><p class="bad">The Passenger Impact Agent could not load passenger data for ${h(S.flight)}: ${h(e.message)}</p>
        <p class="small muted">No values are shown rather than guessing.</p><button class="ghost" data-retry="1">Retry</button></div>`;
      return;
    }
    const known = new Set(P.data.passengers.map((p) => p.ref));
    P.sel = new Set([...P.sel].filter((x) => known.has(x)));
    render();
  }

  // rebooking outcomes from the decision log: the latest decision per passenger wins (the list is newest first)
  function outcomes(decs) {
    const o = { failed: {}, failedDecs: [], loaded: !!decs };
    if (!decs) return o;
    const seen = new Set();
    for (const c of decs.decisions || []) {
      if (c.flight_id !== S.flight) continue;
      let acts = []; try { acts = JSON.parse(c.actions || "[]"); } catch { /* malformed: skip */ }
      const pax = acts.filter((a) => a.kind === "REBOOK").map((a) => a.pax_id);
      const batch = acts.some((a) => a.kind === "REBOOK_AT_RISK" || a.kind === "REBOOK_TIERS");
      const bad = !!FAILTXT[c.status];
      if (bad && (pax.length || batch)) o.failedDecs.push({ id: c.id, status: c.status, reason: c.reason, pax: pax.length, batch });
      for (const r of pax) { if (seen.has(r)) continue; seen.add(r); if (bad) o.failed[r] = { id: c.id, status: c.status, reason: c.reason }; }
    }
    return o;
  }

  // ---------------- render (layout only; same data + same send/reveal endpoints) ----------------
  const DECIDE = ["failed", "missed", "needs", "risk"], DONE = ["rebooked", "pending"];
  const tabOf = (p) => DONE.includes(bucket(p)) ? "approved" : DECIDE.includes(bucket(p)) || bagIssue(p) || !feas(p).ok ? "decide" : "none";
  // the controller's own edit wins; otherwise the Passenger agent's pick (specialists.py); otherwise the earliest flight
  // that passenger and bags can make. On time: the agents recommend nothing, only the controller's own choice counts.
  const approvable = (p) => !p.pending && !!chosen(p) && feas(p).ok;  // both checks pass: passenger AND bags make it
  const chosen = (p) => { const a = p.alternatives || []; return a.find((x) => x.flight === P.override[p.ref]) || (P.data.agent?.delayed === false ? undefined
    : a.find((x) => x.flight === p.agent_pick?.flight) || a.find((x) => x.bags_make_it || !p.bags) || a[0]); };
  function conf(p) {
    const a = chosen(p);
    if (!a || (p.missing || []).length > 1) return ["low", "Low confidence", 1];
    if ((p.missing || []).length || !a.bags_make_it && p.bags || p.status === "At risk") return ["med", "Medium confidence", 2];
    return ["high", "High confidence", 3];
  }
  // Connection feasibility: two separate checks on the connection that would be approved (the chosen rebooking, or the
  // current onward flight). A row is approvable only when BOTH pass; otherwise it is "Review required" with a recommended action.
  function feas(p) {
    const b = bucket(p), bm = P.data.bag_mct, mct = p.mct_min ?? P.data.rules.MCT_MIN, alts = p.alternatives || [];  // per passenger: 30 once rebooked
    const a = b === "rebooked" || b === "safe" ? null : chosen(p);
    const flight = a ? a.flight : p.connecting_flight, conn = a ? a.connection_min : p.available_min;
    if (conn == null) return { flight, pax: [false, "Connection time unknown"], bag: [false, "Unknown"], ok: false, action: "Hold for manual review: the connection time is unknown." };
    const paxOk = a ? conn >= mct && a.free_seats > 0 : conn >= mct && b !== "missed";
    const wrongPlace = !a && p.bags && p.bag_location && p.bag_location !== p.connecting_flight;
    const fwd = !a && p.bags && p.bag_forwarded;  // bags already routed on a later flight and delivered (approved bag plan)
    const bagOk = !p.bags || (a ? a.bags_make_it : fwd || conn >= bm && !wrongPlace);
    const pax = [paxOk, paxOk ? `${conn} min, needs ${mct}` : !a && !alts.length && b !== "safe" ? "No flight they can make" : `${conn} min, needs ${mct}`];
    const bag = [bagOk, !p.bags ? "No checked bags" : fwd ? `Forwarded on ${p.bag_forwarded}, delivered to the passenger`
      : wrongPlace ? `Bags are on ${p.bag_location}` : `${conn} min, needs ${bm}`];
    let action = "";
    if (!paxOk) action = alts.length ? `Rebook the passenger: pick a flight with a free seat and at least ${mct} min to connect.`
      : "Hold for manual review: no seat on a flight they can make (hotel or other carrier).";
    else if (!bagOk) {
      const both = alts.find((x) => x.bags_make_it && x.flight !== flight);
      action = wrongPlace ? `Arrange baggage transfer: move the bags from ${p.bag_location} to ${flight}.`
        : both ? `Rebook on ${both.flight} (${both.connection_min} min) so the passenger and bags travel together.`
        : `Arrange a priority baggage transfer (bags need ${bm} min, this connection gives ${conn}) or hold for manual review.`;
    }
    return { flight, pax, bag, ok: paxOk && bagOk, action };
  }
  const recTxt = (a) => `Rebook ${a.flight} · ${a.departs} · ${a.connection_min} min connection`;
  const left = (p) => p.status === "Confirmed missed" || p.status === "Likely missed" || (p.departs_in_min ?? 1) <= 0
    ? '<b class="px2-miss">Missed</b>' : p.departs_in_min != null ? `<b class="px2-left">${p.departs_in_min} min left</b>` : '<span class="muted">unknown</span>';
  const situation = (p) => bucket(p) === "failed" ? `Booking attempt ${FAILTXT[P.out.failed[p.ref].status]}.` : p.priority_reason || (p.factors || [])[0] || p.status;
  const needs = (p) => p.assistance ? `<span class="px2-need">${P.revealed[p.ref] ? h(P.revealed[p.ref].assistance) : "Assistance"}</span>` : "";
  const dots = (n) => `<span class="px2-dots">${[1, 2, 3].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;

  // what the Passenger agent did (AgentPanel, agentlive.js): its hold decisions, then its rebooking picks (protected care first)
  function agentSec() {
    const ag = P.data.agent; if (!ag) return "";
    const holds = (ag.holds || []).map((x) => ({ who: `${x.flight_id} by ${x.minutes} min`, what: x.recommended ? `saves ${x.pax.length} connection(s)` : "not recommended",
      why: x.reason, by: x.by, tone: x.recommended ? "hold" : "hold off" }));
    const picks = P.data.passengers.filter((p) => p.agent_pick).sort((a, b) => b.assistance - a.assistance);
    const shown = picks.slice(0, 8).map((p) => ({ who: `PNR ${p.ref}${p.assistance ? " · protected care" : ""}`, what: `rebook ${p.agent_pick.flight}`,
      why: p.agent_hold ? `${p.agent_pick.reason} (saved by the ${p.agent_hold.flight} hold if approved)` : p.agent_pick.reason, by: p.agent_pick.by }));
    return AgentPanel.html("pax", ag, [...holds, ...shown], picks.length - shown.length, "No passenger is missing a connection: nothing to rebook.");
  }

  function render() {
    const d = P.data, s = d.summary, all = d.passengers;
    const B = Object.fromEntries(BUCKETS.map((x) => [x[0], []]));
    all.forEach((p) => B[bucket(p)].push(p));
    const open = all.filter((p) => needsAction(bucket(p)));
    const next = open.filter((p) => p.departs_in_min > 0).sort((a, b) => a.departs_in_min - b.departs_in_min)[0];
    const pct = (n) => { const v = all.length ? (100 * n) / all.length : 0; return n && v < 1 ? "<1" : Math.round(v); };
    const T = { decide: [], approved: [], none: [] };
    all.forEach((p) => T[tabOf(p)].push(p));
    const reviewed = T.approved.length, totalDec = T.decide.length + reviewed;
    const easy = T.decide.filter(approvable);
    P.tab = P.tab || "decide";
    const tabs = [["decide", "Needs your decision"], ["approved", "Approved"], ["none", "No action needed"]];
    P.root.innerHTML = `
      <section class="px-kpis px2-kpis" aria-label="Disruption summary">
        <div class="k main"><span>Inbound</span><b>${h(s.flight)} <em class="${s.delay_min ? "late" : ""}">${s.delay_min ? `+${s.delay_min} min` : "on time"}</em></b>
          <small>${h(s.route)} · est. ${h(s.estimated_arrival)} <span class="px-lbl">PREDICTED</span></small></div>
        <div class="k"><span>Need rebooking now</span><b class="${open.length ? "bad" : ""}">${open.length}</b><small>${s.unresolved} unresolved of ${s.connecting_passengers} connecting</small></div>
        <div class="k"><span>Next connection deadline</span>${next ? `<b><span class="px-cd" data-iso="${h(next.departure_iso)}"></span></b><small><span class="px-mono">${h(next.connecting_flight)}</span> · ${h(next.final_destination)}</small>`
          : '<b>—</b><small>no open connection departing</small>'}</div>
      </section>
      ${agentSec()}
      <div class="px2">
      <header class="px2-head">
        <div><h2>All ${all.length} connecting passengers on ${h(s.flight)}</h2>
          <p class="px2-sub">Click a status to filter the list. Sorted by urgency, vulnerable passengers pinned to the top.</p></div>
        <div class="px2-prog"><span>${reviewed} of ${totalDec} reviewed</span><i><b style="width:${totalDec ? (100 * reviewed) / totalDec : 0}%"></b></i></div>
        <div class="px2-all"><button class="px2-btn dark" data-approveall="1" ${easy.length ? "" : "disabled"}>Review &amp; approve all (${easy.length})</button>
          <small>Every row where passenger and bags both make it · listed together before you confirm</small></div>
      </header>
      <p class="px2-cap">Passenger status overview</p>
      <div class="px2-ov">
        <div class="px2-stack">${BUCKETS.map(([k, l, , c]) => B[k].length ? `<button data-bucket="${k}" class="${P.f.bucket === k ? "on" : ""}" style="flex:${B[k].length};background:${c}${k === "missed" || k === "failed" ? ";opacity:.55" : ""}">
          ${B[k].length / all.length > 0.025 ? B[k].length : ""}<span class="px2-tip"><b>${l}</b>${B[k].length} passengers · ${pct(B[k].length)}%</span></button>` : "").join("")}</div>
        <div class="px2-keyw"><button class="px2-btn px2-keyb ${P.key ? "on" : ""}" data-key="1">Status key <span>${P.key ? "⌃" : "⌄"}</span></button>
          ${P.key ? `<div class="px2-key"><div class="px2-kh"><span>Status</span><span>Count · share</span></div>${BUCKETS.map(([k, l, why, c]) =>
            `<button data-bucket="${k}" class="${P.f.bucket === k ? "on" : ""}" title="${h(why)}" ${B[k].length ? "" : "disabled"}><i style="background:${c}"></i><span class="l">${l}</span>
            <span class="n">${B[k].length}</span><span class="pc">${pct(B[k].length)}%</span><span class="ck">${P.f.bucket === k ? "✓" : ""}</span></button>`).join("")}
            <div class="px2-kf"><span>${P.f.bucket ? `Filtering by ${BMAP[P.f.bucket][1]}` : "No filter"}</span>${P.f.bucket ? '<a href="#" data-quick="clear">Clear filter</a>' : ""}</div></div>` : ""}</div>
      </div>
      <div class="px2-filters">
        <label class="px2-search">⌕ <input id="px2-q" placeholder="Search name or PNR" value="${h(P.q || "")}"></label>
        <select data-f="priority" class="px2-sel"><option value="">Priority: All</option>${["Critical", "High", "Medium", "Low", "Unknown"].map((x) =>
          `<option ${P.f.priority === x ? "selected" : ""}>${x}</option>`).join("")}</select>
        <a href="#" data-quick="clear" class="px2-link">Clear filters</a>
      </div>
      <nav class="px2-tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${P.tab === k ? "on" : ""}">${l} <span class="${k === "decide" ? "dark" : ""}">${T[k].length}</span></button>`).join("")}</nav>
      <div id="px-list">${list(T[P.tab])}</div>
      <div id="px-handoff"></div>
      <div class="px2-foot">
        ${P.sel.size ? `<div class="px2-selbar"><b>${P.sel.size} selected</b><input id="px-me" size="10" maxlength="40" value="${h(me)}" placeholder="Your name">
          <button class="px2-btn" data-send="1">Approve selected</button><a href="#" data-clear="1">Clear</a></div>` : "<span></span>"}
      </div>
      ${tabs.filter(([k]) => k !== P.tab).map(([k, l]) => `<button class="px2-coll" data-tab="${k}"><span><b>${l}</b> · ${T[k].length} passenger${T[k].length === 1 ? "" : "s"}${k === "none" ? ", connection still safe" : k === "approved" ? ", booked or awaiting approval" : ", most urgent first"}</span><span>›</span></button>`).join("")}
      </div>
      ${P.drawer ? drawer(T[P.tab]) : ""}`;
    tick();
  }

  function visible(rows) {
    const f = P.f, qq = (P.q || "").toLowerCase();
    return rows.filter((p) => (!f.bucket || bucket(p) === f.bucket) && (!f.priority || p.priority === f.priority) && (!f.assist || p.assistance === (f.assist === "yes"))
      && (!f.bags || bagIssue(p)) && (!qq || `${p.ref} ${p.name_masked} ${P.revealed[p.ref]?.name || ""}`.toLowerCase().includes(qq)))
      .sort((a, b) => PRANK[a.priority] - PRANK[b.priority] || (a.departs_in_min ?? 9999) - (b.departs_in_min ?? 9999));
  }
  function list(rows) {
    rows = visible(rows);
    P.shown = rows.map((p) => p.ref);
    if (!rows.length) return '<p class="muted px2-empty">No passengers match these filters.</p>';
    const vul = rows.filter((p) => p.assistance), oth = rows.filter((p) => !p.assistance);
    const allSel = rows.every((r) => P.sel.has(r.ref));
    const grp = (t, rs) => rs.length ? `<tr class="px2-grp"><td colspan="8">${t}</td></tr>${rs.map(row).join("")}` : "";
    return `<div class="px2-tw"><table class="px2-tbl"><thead><tr><th><input type="checkbox" data-all="1" ${allSel ? "checked" : ""} aria-label="Select all shown"></th>
      <th>Passenger</th><th>Connection</th><th>Special needs</th><th>Situation</th><th>Connection feasibility</th><th>AI recommendation</th><th>Action</th></tr></thead>
      <tbody>${grp("Vulnerable · pinned to top", vul)}${grp("Other passengers · by time to connection", oth)}</tbody></table></div>`;
  }
  function row(p) {
    const rv = P.revealed[p.ref], alts = p.alternatives || [], a = chosen(p), [ck, cl, cn] = conf(p), b = bucket(p);
    const fail = b === "failed";
    const rec = p.pending ? `<div class="px2-rec static">Recommendation #${h(p.pending.change_id)} awaiting approval</div>`
      : b === "rebooked" || b === "safe" ? `<div class="px2-rec static">${b === "rebooked" ? "Rebooked · approved booking recorded" : "Keep booking, no change needed"}</div>`
      : alts.length ? `<select class="px2-rec" data-alt="${h(p.ref)}">${alts.map((x) => `<option value="${h(x.flight)}" ${x === a ? "selected" : ""}>${h(recTxt(x))}${x.bags_make_it ? "" : " (bags may not make it)"}</option>`).join("")}</select>`
      : '<div class="px2-rec static">No alternative seats: manual handling</div>';
    const fz = feas(p), blocked = !fz.ok && !p.pending && b !== "rebooked";
    const act = p.pending || b === "rebooked" ? '<span class="px2-note">Approved</span>'
      : blocked ? `<button class="px2-btn" data-drawer="${h(p.ref)}">Review</button><span class="px2-note warn">Review required · approval blocked</span>`
      : b === "safe" ? '<span class="px2-note">No action</span>'
      : !alts.length ? `<button class="px2-btn" data-drawer="${h(p.ref)}">Review</button><span class="px2-note warn">Needs your review</span>`
      : fail ? `<button class="px2-btn retry" data-sendone="${h(p.ref)}">Retry</button>`
      : ck === "low" ? `<button class="px2-btn" data-drawer="${h(p.ref)}">Review</button><span class="px2-note warn">Needs your review</span>`
      : `<button class="px2-btn dark" data-sendone="${h(p.ref)}">Approve</button>`;
    return `<tr class="px2-row" data-row="${h(p.ref)}">
      <td><input type="checkbox" data-sel="${h(p.ref)}" ${P.sel.has(p.ref) ? "checked" : ""} ${p.pending || !alts.length || blocked ? "disabled" : ""} aria-label="Select ${h(p.ref)}"></td>
      <td><b class="px2-name">${rv ? h(rv.name) : h(p.name_masked)}</b><div class="px2-pnr">PNR ${h(p.ref)}</div></td>
      <td><span class="px2-mono">${h(P.data.summary.flight)} → ${h(p.connecting_flight)}</span><div>${left(p)}</div></td>
      <td>${needs(p)}</td>
      <td class="px2-sit">${h(situation(p))}</td>
      <td class="px2-fz"><div class="px2-ck ${fz.pax[0] ? "ok" : "no"}"><b>${fz.pax[0] ? "✓" : "✕"} Passenger</b><span>${h(fz.pax[1])}</span></div>
        <div class="px2-ck ${fz.bag[0] ? "ok" : "no"}"><b>${fz.bag[0] ? "✓" : "✕"} Baggage</b><span>${h(fz.bag[1])}</span></div>
        <div class="px2-fl">on ${h(fz.flight)}</div>${blocked ? `<div class="px2-ra"><b>Recommended action</b>${h(fz.action)}</div>` : ""}</td>
      <td>${rec}${fail ? `<div class="px2-err">${h(P.out.failed[p.ref].reason || "Last attempt " + FAILTXT[P.out.failed[p.ref].status])}</div>` : ""}
        <div class="px2-meta">${dots(cn)}<span>${cl}</span>${P.override[p.ref] ? '<span class="px2-tag">Edited</span>' : ""}<a href="#" data-drawer="${h(p.ref)}">View reasoning</a></div></td>
      <td class="px2-act">${act}</td></tr>`;
  }
  function drawer(rows) {
    const p = P.data.passengers.find((x) => x.ref === P.drawer);
    if (!p) return "";
    const ids = visible(rows).map((x) => x.ref), i = ids.indexOf(p.ref), rv = P.revealed[p.ref], a = chosen(p), [, cl, cn] = conf(p), alts = p.alternatives || [], fz = feas(p);
    return `<div class="px2-scrim" data-close="1"></div><aside class="px2-drawer" role="dialog" aria-label="Why this recommendation">
      <div class="px2-dh"><span class="px2-cap">Why this recommendation</span><span><button data-nav="-1" ${i <= 0 ? "disabled" : ""}>‹</button> ${i + 1} of ${ids.length}
        <button data-nav="1" ${i >= ids.length - 1 ? "disabled" : ""}>›</button><button data-close="1">✕</button></span></div>
      <div class="px2-db">
        <div class="px2-dt"><h3>${rv ? h(rv.name) : h(p.name_masked)}</h3><span class="px2-pnr">PNR ${h(p.ref)}</span></div>
        <div>${needs(p)} <span class="px2-mono">${h(P.data.summary.flight)} → ${h(p.connecting_flight)}</span> ${left(p)}</div>
        <div class="px2-box"><span class="px2-cap">AI recommendation</span><b>${a ? h(recTxt(a)) : "No alternative seats: manual handling (hotel / other carrier)"}</b><div class="px2-meta">${dots(cn)}<span>${cl}</span></div></div>
        <h4 class="px2-cap">Connection feasibility · on ${h(fz.flight)}</h4><div class="px2-fz">
          <div class="px2-ck ${fz.pax[0] ? "ok" : "no"}"><b>${fz.pax[0] ? "✓" : "✕"} Passenger connection</b><span>${h(fz.pax[1])}</span></div>
          <div class="px2-ck ${fz.bag[0] ? "ok" : "no"}"><b>${fz.bag[0] ? "✓" : "✕"} Baggage connection</b><span>${h(fz.bag[1])}</span></div>
          ${fz.ok ? "" : `<div class="px2-ra"><b>Review required · recommended action</b>${h(fz.action)}</div>`}</div>
        <h4 class="px2-cap">Data used</h4><dl class="px2-dl"><dt>Inbound flight status</dt><dd>${h(P.data.summary.flight)} ${P.data.summary.delay_min ? `+${P.data.summary.delay_min} min` : "on time"}</dd>
          <dt>Seat availability</dt><dd>${alts.map((x) => h(x.flight)).join(" · ") || "none"}</dd><dt>Passenger profile</dt><dd>${p.assistance ? "Assistance recorded" : "No assistance"} · ${h(p.priority_category || "")}</dd>
          <dt>Bags</dt><dd>${p.bags ? `${p.bags} on ${h(p.bag_forwarded || p.bag_location || "unknown")}` : "none checked"}</dd></dl>
        <h4 class="px2-cap">Assumptions</h4><ol class="px2-ol">${[...(a && p.agent_pick?.flight === a.flight && p.agent_pick.reason ? [`${P.data.agent?.name || "Passenger agent"}: ${p.agent_pick.reason}`] : []),
          ...(p.agent_hold ? [`${P.data.agent?.name || "Passenger agent"} recommends holding ${p.agent_hold.flight} by ${p.agent_hold.minutes} min instead: ${p.agent_hold.reason}`] : []),
          ...(p.factors || [])].map((x) => `<li>${h(x)}</li>`).join("")}${(p.missing || []).map((x) => `<li class="px-warn">${h(x)}</li>`).join("")}</ol>
        <h4 class="px2-cap">Calculations</h4><dl class="px2-dl box"><dt>Available connection time</dt><dd>${p.available_min == null ? "unknown" : `${p.available_min} min`}</dd>
          <dt>Minimum connection time</dt><dd>${p.mct_min} min</dd><dt><b>Buffer remaining</b></dt><dd><b>${p.available_min == null ? "—" : `${p.available_min - p.mct_min} min`}</b></dd></dl>
        <h4 class="px2-cap">Alternatives considered</h4>${alts.map((x) => `<div class="px2-alt"><b class="px2-mono">${h(x.flight)} · ${h(x.departs)}</b> ${x === a ? '<em class="ok">Chosen</em>' : '<em>Not chosen</em>'}
          <div class="small muted">${x.connection_min} min connection · ${x.free_seats} free seats · ${x.bags_make_it ? "bags make it" : "bags may not make it"}</div></div>`).join("") || '<p class="small muted">None in the schedule.</p>'}
        ${p.hold_option ? `<p class="small">Network option: hold ${h(p.hold_option.flight)} by ${p.hold_option.minutes} min (Scenario Lab / approval queue).</p>` : ""}
        <details class="px2-audit"><summary><b>Personal data</b> · masked by default</summary>${rv ? `<p class="small">${h(rv.name)} · ${h(rv.assistance)} <a href="#" data-hide="${h(p.ref)}">Mask again</a></p>`
          : `<p class="small">Restricted. <a href="#" data-reveal="${h(p.ref)}">Reveal (controller PIN, audited)</a></p>`}</details>
      </div>
      ${a && fz.ok && !p.pending && bucket(p) !== "rebooked" ? `<div class="px2-df"><button class="px2-btn dark" data-sendone="${h(p.ref)}">Approve</button><button class="px2-btn" data-edit="1">Edit</button>
        <button class="px2-btn" data-sendone="${h(p.ref)}" data-next="1">Approve &amp; next</button></div>` : ""}
    </aside>`;
  }

  function tick() {
    if (!P.root?.isConnected) { clearInterval(P.timer); return; }
    document.querySelectorAll(".px-cd[data-iso]").forEach((el) => {
      const s = Math.round((new Date(el.dataset.iso) - Date.now()) / 1000);
      el.classList.toggle("soon", s > 0 && s <= 1800);
      el.textContent = s <= 0 ? "departed" : s <= 5400 ? `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `in ${Math.round(s / 60)} min`;
    });
  }

  // ---------------- events ----------------
  // Approve = the controller's name + PIN in the approval window, then the rebooking is staged and approved in one go
  async function send(refs) {
    const rows = Object.fromEntries(P.data.passengers.map((p) => [p.ref, p])), blocked = refs.filter((x) => rows[x] && !feas(rows[x]).ok);
    refs = refs.filter((x) => !blocked.includes(x));
    if (blocked.length) toast(`${blocked.length} passenger(s) need review: passenger or baggage cannot make the connection, so approval is blocked`, "warn");
    if (!refs.length) return;
    const list = refs.length > 1 ? `<ul class="small" style="max-height:260px;overflow:auto;margin:8px 0 0;padding-left:18px;font-weight:400">${refs.map((x) => {
      const p = rows[x], c = p && chosen(p);
      return `<li>${h(x)} · ${h(p?.connecting_flight || "")} → <b>${h(c?.flight || "agent's pick")}</b>${c ? ` · ${c.connection_min} min` : ""}${p?.bags
        ? ` · ${p.bags} bag(s) make it` : ""}${p && conf(p)[0] !== "high" ? ` · <span class="warn">${h(conf(p)[1].toLowerCase())}</span>` : ""}</li>`; }).join("")}</ul>` : "";
    askAuth(`Approve rebooking for ${refs.length} passenger(s)${list}<div class="small muted" style="margin-top:6px">Enter your name and controller PIN. The rebooking is checked by the guards and applied at once.</div>`, async (a) => {
      me = a.controller; try { localStorage.setItem("aviant.me", me); } catch { /* ignore */ }
      const r = await api("/api/pax/recommend", { flight_id: S.flight, pax_ids: refs, by: me, overrides: P.override });
      const lines = [];
      for (const s of r.staged) {
        if (s.status !== "PENDING") { lines.push(`<div class="bad">⛔ ${s.passengers.length} passenger(s) refused by the guards: ${h(s.reason)}</div>`); continue; }
        const x = await api("/api/approve", { id: s.id, controller: a.controller, pin: a.pin });
        lines.push(x.status === "APPROVED" ? `<div>✓ Decision <b>#${s.id}</b> approved: ${s.passengers.length} passenger(s) rebooked.</div>`
          : `<div class="bad">⛔ Decision #${s.id}: ${h(x.status)} ${h(x.reason || "")}</div>`);
      }
      if (r.skipped.length) lines.push(`<div class="small muted">Not sent: ${r.skipped.map((x) => `${h(x.ref)} (${h(x.reason)})`).join("; ")}</div>`);
      P.sel.clear();
      await load(); refreshBell();
      q("#px-handoff").innerHTML = `<div class="px2-toast" role="status"><div>${lines.join("") || "Nothing to approve."}</div><a href="#/tab/log" class="px2-btn">Decision log</a></div>`;
    });
  }
  const curRows = () => P.data.passengers.filter((p) => tabOf(p) === (P.tab || "decide"));
  const toList = () => q("#px-list", P.root)?.scrollIntoView({ behavior: "smooth", block: "start" });
  async function onClick(e) {
    const t = e.target;
    const d = t.closest("[data-retry],[data-view],[data-sort],[data-send],[data-clear],[data-sendone],[data-reveal],[data-hide],[data-gsel],[data-gopen],[data-bucket],[data-quick],[data-goto],[data-tab],[data-key],[data-drawer],[data-close],[data-nav],[data-approveall],[data-edit]")?.dataset;
    if (d) {
      if (t.closest("a")) e.preventDefault();
      if (d.tab) { P.tab = d.tab; P.drawer = null; return render(); }
      if (d.key) { P.key = !P.key; return render(); }
      if (d.drawer) { P.drawer = d.drawer; return render(); }
      if (d.close) { P.drawer = null; return render(); }
      if (d.nav) { const ids = visible(curRows()).map((x) => x.ref); P.drawer = ids[ids.indexOf(P.drawer) + +d.nav] || P.drawer; return render(); }
      if (d.edit) { const r = q(`tr[data-row="${CSS.escape(P.drawer)}"] select`, P.root); P.drawer = null; render(); return q(`tr[data-row="${CSS.escape(r?.dataset.alt || "")}"] select`, P.root)?.focus(); }
      if (d.approveall) { const refs = curRows().filter(approvable).map((p) => p.ref);
        return send(refs).catch((err) => toast(err.message, "bad")); }
      if (d.sendone && d.next) { const ids = visible(curRows()).map((x) => x.ref); P.drawer = ids[ids.indexOf(d.sendone) + 1] || null; }
      else if (d.sendone) P.drawer = null;
      if (d.retry) return load();
      if (d.bucket) { P.f = { ...P.f, bucket: P.f.bucket === d.bucket ? "" : d.bucket }; P.view = "table"; render(); return toList(); }
      if (d.quick) {
        P.q = d.quick === "clear" ? "" : P.q; P.f = d.quick === "clear" ? { ...NOF } : { ...NOF, ...(d.quick === "vuln" ? { assist: "yes" } : { bags: "yes" }) };
        P.view = "table"; render(); return d.quick === "clear" ? null : toList();
      }
      if (d.goto) { P.f = { ...NOF }; P.view = "table"; P.open = d.goto; render();
        return q(`tr[data-row="${CSS.escape(d.goto)}"]`, P.root)?.scrollIntoView({ behavior: "smooth", block: "center" }); }
      if (d.view) { P.view = d.view; return render(); }
      if (d.sort) { P.sort = { key: d.sort, dir: P.sort.key === d.sort ? -P.sort.dir : 1 }; return render(); }
      if (d.clear) { P.sel.clear(); return render(); }
      if (d.send) return send([...P.sel]).catch((err) => toast(err.message, "bad"));
      if (d.sendone) return send([d.sendone]).catch((err) => toast(err.message, "bad"));
      if (d.hide) { delete P.revealed[d.hide]; return render(); }
      if (d.reveal) return askAuth(`Reveal personal data for ${h(d.reveal)}<div class="small muted" style="margin-top:6px">Restricted to Operations Controllers. The access is written to the audit log.</div>`,
        async (a) => { P.revealed[d.reveal] = await api("/api/pax/reveal", { pax_id: d.reveal, ...a }); render(); });
      if (d.gsel) { d.gsel.split(",").filter(Boolean).forEach((x) => P.sel.add(x)); return render(); }
      if (d.gopen) { const [k, v] = d.gopen.split("|"); P.view = "table"; P.f = { ...P.f, [k === "final_destination" ? "dest" : "flight"]: v }; return render(); }
    }
    if (t.matches("input, button, a, label, select") || t.closest("label, a")) return;
    const r = t.closest("tr[data-row]");
    if (r) { P.drawer = r.dataset.row; render(); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === "px-me") { me = t.value.trim(); try { localStorage.setItem("aviant.me", me); } catch { /* ignore */ } return; }
    if (t.dataset.f !== undefined) { P.f[t.dataset.f] = t.value; return render(); }
    if (t.dataset.showlow) { P.showLow = t.checked; return render(); }
    if (t.dataset.sel) { t.checked ? P.sel.add(t.dataset.sel) : P.sel.delete(t.dataset.sel); return render(); }
    if (t.dataset.all) { visible(curRows()).filter((r) => !r.pending && (r.alternatives || []).length).forEach((r) => (t.checked ? P.sel.add(r.ref) : P.sel.delete(r.ref))); return render(); }
    if (t.dataset.alt) { P.override[t.dataset.alt] = t.value; return render(); }
  }
  return { mount };
})();
