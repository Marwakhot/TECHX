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
  try { me = localStorage.getItem("aeroturn.me") || ""; } catch { /* private mode */ }
  const PICON = { Critical: "◆", High: "▲", Medium: "●", Low: "○", Unknown: "?" };
  const PRANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Unknown: 4 };
  const prio = (p) => `<span class="px-p ${h(p)}">${PICON[p] || ""} ${h(p)}</span>`;
  const SCLS = { "Confirmed missed": "miss", "Likely missed": "miss", "At risk": "risk", "Safe connection": "ok", Rebooked: "ok" };
  const MCT = '<abbr title="Minimum connection time: the shortest time a passenger needs between arriving and the onward departure">MCT</abbr>';

  async function mount(el) {
    P.root = el;
    el.innerHTML = '<div class="dl-skel"></div><div class="dl-skel"></div><div class="dl-skel"></div>';
    el.onclick = onClick; el.onchange = onChange;
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

  // ---------------- render ----------------
  function render() {
    const d = P.data, s = d.summary, dq = d.data;
    const flights = [...new Set(d.passengers.map((p) => p.connecting_flight))].sort(), dests = [...new Set(d.passengers.map((p) => p.final_destination))].sort();
    const low = d.passengers.filter((p) => p.priority === "Low").length;
    const opt = (k, label, vals) => `<label class="small muted">${label} <select data-f="${k}"><option value="">All</option>${vals.map(([v, l]) =>
      `<option value="${h(v)}" ${P.f[k] === v ? "selected" : ""}>${h(l)}</option>`).join("")}</select></label>`;
    const all = d.passengers, B = Object.fromEntries(BUCKETS.map((x) => [x[0], []]));
    all.forEach((p) => B[bucket(p)].push(p));
    const open = all.filter((p) => needsAction(bucket(p)));
    const vul = all.filter((p) => p.assistance), vulOpen = vul.filter((p) => needsAction(bucket(p)));
    const bagsBlocked = all.filter((p) => bagIssue(p) && bucket(p) !== "rebooked");
    const next = open.filter((p) => p.departs_in_min > 0).sort((a, b) => a.departs_in_min - b.departs_in_min)[0];
    const pct = (n) => { const v = all.length ? (100 * n) / all.length : 0; return n && v < 1 ? "<1" : Math.round(v); };
    const cnt = (list, k) => list.filter((p) => bucket(p) === k).length;
    const bar = (list, cls = "") => `<div class="px-stack ${cls}" role="img" aria-label="${BUCKETS.filter((x) => cnt(list, x[0]))
      .map((x) => `${cnt(list, x[0])} ${x[1]}`).join(", ")}">${BUCKETS.map(([k, l, , c]) => cnt(list, k)
        ? `<i style="flex:${cnt(list, k)};background:${c}" title="${cnt(list, k)} ${l}"></i>` : "").join("")}</div>`;
    const attn = all.filter((p) => needsAction(bucket(p)) || (bagIssue(p) && ["pending", "risk"].includes(bucket(p))))
      .sort((a, b) => PRANK[a.priority] - PRANK[b.priority] || (a.departs_in_min ?? 9999) - (b.departs_in_min ?? 9999));
    const reasons = (p) => [p.assistance && '<span class="px-chip vul">Vulnerable</span>', bucket(p) === "failed" && '<span class="px-chip bad">Rebooking failed</span>',
      bucket(p) === "missed" && '<span class="px-chip bad">Flight gone</span>', bagIssue(p) && '<span class="px-chip bag">Baggage</span>',
      !(p.alternatives || []).length && needsAction(bucket(p)) && '<span class="px-chip bad">No alternative seats</span>',
      p.hold_option && '<span class="px-chip">Hold possible</span>', bucket(p) === "pending" && '<span class="px-chip">Awaiting approval</span>'].filter(Boolean).join("");
    const pendIds = [...new Set(B.pending.map((p) => p.pending.change_id))];
    P.root.innerHTML = `
      <section class="px-kpis" aria-label="Disruption summary">
        <div class="k main"><span>Inbound</span><b>${h(s.flight)} <em class="${s.delay_min ? "late" : ""}">${s.delay_min ? `+${s.delay_min} min` : "on time"}</em></b>
          <small>${h(s.route)} · est. ${h(s.estimated_arrival)} <span class="px-lbl">PREDICTED</span></small></div>
        <div class="k"><span>Need rebooking now</span><b class="${open.length ? "bad" : ""}">${open.length}</b><small>${s.unresolved} unresolved of ${s.connecting_passengers} connecting</small></div>
        <div class="k"><span>Vulnerable needing action</span><b class="${vulOpen.length ? "bad" : ""}">${vulOpen.length}</b><small>of ${vul.length} with special assistance</small></div>
        <div class="k"><span>Next connection deadline</span>${next ? `<b><span class="px-cd" data-iso="${h(next.departure_iso)}"></span></b><small><span class="px-mono">${h(next.connecting_flight)}</span> · ${h(next.final_destination)}</small>`
          : '<b>—</b><small>no open connection departing</small>'}</div>
        <div class="k"><span>Disruption</span><b><span class="px-st ${h(s.status)}">${{ active: "● active", recovering: "◐ recovering", resolved: "✔ resolved" }[s.status]}</span></b>
          <small title="${h(dq.source)} · computed ${h(dq.computed_at)} · ${h(dq.clock)}"><span class="px-lbl sim">SIMULATED</span> as of ${h(String(dq.as_of || "").slice(11, 16) || dq.as_of || "unknown")}${dq.age_min != null ? ` · ${dq.age_min} min old` : ""}</small></div>
      </section>
      <p class="px-context small muted">Scheduled arrival ${h(s.scheduled_arrival)} · ${s.delay_reason ? `${h(s.delay_reason)} (source: ${h(s.reason_source)})` : "delay reason not reported"} ·
        ${s.affected_passengers} affected passengers on ${s.affected_connections} onward flights</p>
      ${dq.stale || dq.conflicts.length ? `<div class="px-alert" role="alert">${dq.stale ? `<div>⚠ No data update for ${dq.age_min} min while the disruption is active: verify before acting.</div>` : ""}
        ${dq.conflicts.length ? `<div>⚠ ${dq.conflicts.length} data conflict(s): ${dq.conflicts.slice(0, 2).map(h).join("; ")}${dq.conflicts.length > 2 ? "…" : ""}</div>` : ""}</div>` : ""}

      <section class="px-overview">
        <div class="px-break">
          <div class="px-h"><h3>All ${all.length} connecting passengers on ${h(s.flight)}</h3><span class="small muted">Click a status to filter the passenger list</span></div>
          ${bar(all, "big")}
          <div class="px-legend">${BUCKETS.map(([k, l, why, c]) => `<button class="px-leg ${P.f.bucket === k ? "on" : ""}" data-bucket="${k}" ${B[k].length ? "" : "disabled"} title="${h(why)}" aria-pressed="${P.f.bucket === k}">
            <i style="background:${c}"></i><span class="n">${B[k].length}</span><span class="l">${l}</span><span class="pc">${pct(B[k].length)}%</span></button>`).join("")}</div>
        </div>
        <div class="px-side">
          <div class="px-panel">
            <div class="px-h"><h4>Vulnerable passengers</h4><button class="ghost small" data-quick="vuln" ${vul.length ? "" : "disabled"}>Show all ${vul.length}</button></div>
            <p class="px-big">${vulOpen.length}<small> still need rebooking</small></p>
            ${vul.length ? bar(vul) : ""}
            <p class="small muted">${vul.length ? `${cnt(vul, "rebooked")} rebooked · ${cnt(vul, "pending")} awaiting approval · ${cnt(vul, "risk") + cnt(vul, "safe")} still connecting. ` : "No special assistance recorded on this flight. "}Protected passengers are rebooked first.</p>
          </div>
          <div class="px-panel">
            <div class="px-h"><h4>Baggage blockers</h4><button class="ghost small" data-quick="bags" ${bagsBlocked.length ? "" : "disabled"}>Show ${bagsBlocked.length}</button></div>
            <p class="px-big">${bagsBlocked.length}<small> passenger${bagsBlocked.length === 1 ? "" : "s"}</small></p>
            <p class="small muted">${bagsBlocked.length ? "Checked bags will not make the connection, or are on a different flight than the passenger. When choosing an option, prefer flights marked “bags make it”." : "No baggage blockers on this flight."}</p>
          </div>
        </div>
      </section>

      <section class="px-work">
        <div class="px-attn">
          <div class="px-h"><h3>Needs attention now <span class="small muted">· most urgent first</span></h3>${attn.length > 6 ? `<span class="small muted">${attn.length - 6} more in the list below</span>` : ""}</div>
          ${attn.length ? `<ol class="px-q">${attn.slice(0, 6).map((p) => `<li><button class="px-qrow" data-goto="${h(p.ref)}" aria-label="Open ${h(p.ref)} in the passenger list">
            ${prio(p.priority)}<span class="px-mono px-qref">${h(p.ref)}</span><span class="px-qf"><span class="px-mono">${h(p.connecting_flight)}</span> → ${h(p.final_destination)}</span>
            <span class="px-qcd">${p.departure_iso ? `<span class="px-cd" data-iso="${h(p.departure_iso)}"></span>` : ""}</span>
            <span class="px-qr">${reasons(p)}</span><span class="px-qgo" aria-hidden="true">Open →</span></button></li>`).join("")}</ol>`
          : '<p class="muted">Nothing needs action right now.</p>'}
        </div>
        <div class="px-outc">
          <div class="px-h"><h3>Rebooking outcomes</h3></div>
          <dl class="px-od">
            <dt><i style="background:${BMAP.rebooked[3]}"></i>Rebooked</dt><dd>${B.rebooked.length}</dd>
            <dt><i style="background:${BMAP.pending[3]}"></i>Awaiting approval</dt><dd>${B.pending.length}${pendIds.length ? ` <small class="muted">in ${pendIds.map((x) => `#${h(x)}`).join(", ")}</small>` : ""}</dd>
            <dt><i style="background:${BMAP.failed[3]}"></i>Failed, needs a new option</dt><dd>${B.failed.length}</dd>
          </dl>
          ${P.out.failedDecs.length ? `<p class="small muted px-oh">Recent failed rebooking decisions</p><ul class="px-fails">${P.out.failedDecs.slice(0, 4).map((c) =>
            `<li><b>#${h(c.id)}</b> ${h(FAILTXT[c.status])} · ${c.batch ? "batch" : `${c.pax} pax`}${c.reason ? `<div class="small muted">${h(c.reason)}</div>` : ""}</li>`).join("")}</ul>` : ""}
          <p class="small">${pendIds.length ? 'Pending items wait for a controller in the <a href="#/tab/log">approval queue</a>.' : 'Approvals happen in the <a href="#/tab/log">approval queue</a>.'}${P.out.loaded ? "" : ' <span class="px-warn">Decision log unavailable: failed outcomes not shown.</span>'}</p>
        </div>
      </section>
      <div class="card px-list" id="px-list">
        <div class="row between"><h3 style="margin:0">Passenger list <span class="small muted">· recommends only, nothing is booked here</span></h3>
          <span class="px-view" role="group" aria-label="View">${[["table", "Table"], ["final_destination", "Group by final destination"], ["connecting_flight", "Group by connecting flight"]]
            .map(([k, l]) => `<button data-view="${k}" class="${P.view === k ? "on" : ""}" aria-pressed="${P.view === k}">${l}</button>`).join(" ")}</span></div>
        <div class="px-bar">
          ${opt("priority", "Priority", ["Critical", "High", "Medium", "Low", "Unknown"].map((x) => [x, x]))}
          ${opt("status", "Status", ["Confirmed missed", "Likely missed", "At risk", "Safe connection", "Rebooked", "Unknown"].map((x) => [x, x]))}
          ${opt("flight", "Connecting flight", flights.map((x) => [x, x]))}${opt("dest", "Final destination", dests.map((x) => [x, x]))}
          ${opt("assist", "Special assistance", [["yes", "Recorded"], ["no", "None recorded"]])}
          ${opt("dep", "Departs within", [["30", "30 min"], ["60", "60 min"], ["120", "2 h"], ["gone", "Already departed"]])}
          <label class="small"><input type="checkbox" data-showlow="1" ${P.showLow ? "checked" : ""}> Show low-priority (safe) passengers (${low})</label>
        </div>
        ${P.f.bucket || P.f.bags || P.f.assist ? `<div class="px-active small">Showing: ${[P.f.bucket && BMAP[P.f.bucket][1], P.f.bags && "Baggage blockers", P.f.assist === "yes" && "Special assistance recorded", P.f.assist === "no" && "No special assistance"].filter(Boolean).map((x) => `<span class="px-chip on">${h(x)}</span>`).join(" ")}
          <button class="ghost small" data-quick="clear">Clear</button></div>` : ""}
        <div class="px-bar px-selbar ${P.sel.size ? "has" : ""}"><b>${P.sel.size} selected</b>
          <label class="small muted">Your name <input id="px-me" size="12" maxlength="40" value="${h(me)}" placeholder="required"></label>
          <button data-send="1" ${P.sel.size ? "" : "disabled"}>Send ${P.sel.size || ""} to Rebooking Recommendations</button>
          ${P.sel.size ? '<button class="ghost" data-clear="1">Clear selection</button>' : ""}
          <span class="small muted">Nothing is booked here: it goes to the <a href="#/tab/log">approval queue</a>.</span></div>
        <div id="px-handoff"></div>
        <div id="px-main">${P.view === "table" ? table() : groups(P.view)}</div>
        <details class="how" style="margin-top:14px"><summary>How the labels are set</summary><div>Deterministic, no statistical model.<br><b>Likely missed</b> = available connection &lt; ${MCT} (${d.rules.MCT_MIN} min);
          <b>At risk</b> = less than ${d.rules.VULNERABLE_SLACK_MIN} min spare beyond ${MCT}. <b>Critical</b> = likely missed and (protected-priority passenger, no alternative seats, or a hold
          that could still save it must be decided within ${d.rules.DECISION_WINDOW_MIN} min). <b>High</b> = likely missed with alternatives, or at risk with a protected-priority passenger.
          <b>Medium</b> = at risk. <b>Low</b> = feasible or rebooked. ${MCT} source: ${h(d.mct_source)} A passenger shows <b>Rebooked</b> only when the audit log holds a human-approved booking.</div></details>
      </div>`;
    tick();
  }

  const depBucket = (p) => P.f.dep === "gone" ? p.departs_in_min !== null && p.departs_in_min <= 0 : p.departs_in_min !== null && p.departs_in_min > 0 && p.departs_in_min <= +P.f.dep;
  function visible() {
    const f = P.f;
    const rows = P.data.passengers.filter((p) => (P.showLow || p.priority !== "Low" || f.priority === "Low" || f.status === "Safe connection" || f.status === "Rebooked" || f.bucket || f.assist)
      && (!f.bucket || bucket(p) === f.bucket) && (!f.bags || (bagIssue(p) && bucket(p) !== "rebooked"))
      && (!f.priority || p.priority === f.priority) && (!f.status || p.status === f.status) && (!f.flight || p.connecting_flight === f.flight)
      && (!f.dest || p.final_destination === f.dest) && (!f.assist || p.assistance === (f.assist === "yes")) && (!f.dep || depBucket(p)));
    const k = P.sort.key, dir = P.sort.dir;
    const val = (p) => k === "priority" ? PRANK[p.priority] * 10000 + (p.departs_in_min ?? 9999) : p[k] ?? "";
    return rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir);
  }
  function table() {
    const rows = visible();
    if (!rows.length) return `<p class="muted">No passengers match these filters.${!P.showLow ? " Low-priority (safe) passengers are hidden." : ""}</p>`;
    const th = (k, l, title) => `<th data-sort="${k}" title="${title}" aria-sort="${P.sort.key === k ? (P.sort.dir > 0 ? "ascending" : "descending") : "none"}">${l}${P.sort.key === k ? (P.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
    const all = rows.every((r) => P.sel.has(r.ref));
    return `<div style="overflow-x:auto"><table class="px-tbl"><thead><tr><th><input type="checkbox" data-all="1" ${all ? "checked" : ""} aria-label="Select all shown"></th>
      ${th("priority", "Priority", "Intervention priority")}${th("ref", "Pax ref", "Passenger reference")}${th("final_destination", "Final dest.", "Final destination")}
      ${th("connecting_flight", "Conn. flight", "Connecting flight")}${th("departs_in_min", "Departs", "Connecting flight departure (estimated)")}<th class="px-hide">${MCT}</th>
      ${th("available_min", "Available", "Available connection time (predicted)")}<th title="Connection risk">Risk</th><th class="px-hide" title="Passenger priority / service category">Category</th>
      <th title="Special assistance">Assistance</th>${th("status", "Status", "Current status")}<th></th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`;
  }
  function row(p) {
    const open = P.open === p.ref, rv = P.revealed[p.ref];
    const short = p.available_min !== null && p.available_min < p.mct_min;
    return `<tr class="px-row ${open ? "open" : ""}" data-row="${h(p.ref)}" aria-expanded="${open}">
      <td><input type="checkbox" data-sel="${h(p.ref)}" ${P.sel.has(p.ref) ? "checked" : ""} aria-label="Select ${h(p.ref)}"></td>
      <td>${prio(p.priority)}</td>
      <td><span class="px-mono">${h(p.ref)}</span><div class="small muted">${rv ? h(rv.name) : h(p.name_masked)}</div></td>
      <td>${h(p.final_destination)}</td><td class="px-mono">${h(p.connecting_flight)}</td>
      <td>${p.departure_est ? `<span class="px-mono">${h(p.departure_est)}</span>${p.departure_sched !== p.departure_est ? ` <small class="muted">(sched ${h(p.departure_sched)})</small>` : ""}
        <div><span class="px-cd" data-iso="${h(p.departure_iso)}"></span></div>` : '<span class="muted">unknown</span>'}</td>
      <td class="px-hide">${p.mct_min} min</td>
      <td class="${short ? "bad" : ""}">${p.available_min === null ? '<span class="muted">unknown</span>' : `${p.available_min} min`} <span class="px-lbl">PRED.</span></td>
      <td>${p.risk ? `<span class="px-s ${SCLS[p.status] || ""}">${h(p.risk.category)}</span>` : '<span class="muted small">insufficient data</span>'}</td>
      <td class="px-hide small">${h(p.priority_category)}</td>
      <td class="small">${p.assistance ? (rv ? h(rv.assistance) : "Yes · <span class=\"muted\">restricted</span>") : '<span class="muted">None recorded</span>'}</td>
      <td class="wrap"><span class="px-s ${SCLS[p.status] || ""}">${h(p.status)}</span>${bucket(p) === "failed" ? `<div class="small bad">✕ #${h(P.out.failed[p.ref].id)} ${h(FAILTXT[P.out.failed[p.ref].status])}</div>` : ""}${bagIssue(p) ? `<div class="small px-warn" title="${h(bagIssue(p))}">⚑ Baggage blocker</div>` : ""}${p.pending ? `<div class="small" style="color:var(--alert)">⏳ recommendation #${p.pending.change_id} awaiting approval</div>` : ""}</td>
      <td aria-hidden="true">${open ? "▾" : "▸"}</td></tr>${open ? detail(p) : ""}`;
  }
  function detail(p) {
    const rv = P.revealed[p.ref];
    const alts = p.alternatives || [];
    return `<tr class="px-detail"><td colspan="13"><div class="px-dgrid px-sticky">
      <div><h4>Why ${h(p.priority)}: ${h(p.priority_reason || "")}</h4><ul>${p.factors.map((x) => `<li>${h(x)}</li>`).join("")}</ul>
        ${p.missing.length ? `<h4 style="margin-top:12px">Missing or conflicting data</h4><ul>${p.missing.map((x) => `<li class="px-warn">${h(x)}</li>`).join("")}</ul>` : ""}
        <p class="small muted">Risk basis: ${h(p.risk?.basis || "insufficient data")}</p></div>
      <div><h4>Itinerary</h4><table><tbody>${(p.itinerary || []).map((s) => `<tr><td class="px-mono">${h(s.flight)}</td><td>${h(s.route)}</td>
          <td class="small">sched ${h(s.sched)} · est ${h(s.est)}</td><td class="small muted">${h(s.kind)}</td></tr>`).join("")}</tbody></table>
        <p class="small">Bags: ${p.bags ? `${p.bags} checked, currently on ${h(p.bag_location || "unknown")}` : "none checked"}</p>
        <h4 style="margin-top:12px">Available options</h4>
        ${["Safe connection", "Rebooked"].includes(p.status) ? '<p class="small muted">No intervention needed.</p>' : `
        ${alts.length ? alts.map((a, i) => `<label class="px-opt"><input type="radio" name="px-alt-${h(p.ref)}" data-alt="${h(p.ref)}" value="${h(a.flight)}"
            ${(P.override[p.ref] || alts.find((x) => x.bags_make_it || !p.bags)?.flight || alts[0].flight) === a.flight ? "checked" : ""}>
            <span class="px-mono">${h(a.flight)}</span> departs ${h(a.departs)} · ${a.connection_min} min connection · ${a.free_seats} free seats (shared) ·
            ${a.bags_make_it ? "bags make it" : '<span class="px-warn">bags may not make it</span>'}</label>`).join("")
          : '<p class="px-warn small">No alternative seats in the schedule: needs manual handling (hotel / other carrier).</p>'}
        ${p.hold_option ? `<p class="small">Network option: hold ${h(p.hold_option.flight)} by ${p.hold_option.minutes} min. That is a network schedule change for the controller (Scenario Lab / approval queue), not this tab.</p>` : ""}
        ${p.pending ? `<p class="small" style="color:var(--alert)">⏳ Already in the approval queue (#${p.pending.change_id}).</p>` : alts.length ? `<button class="ghost" data-sendone="${h(p.ref)}">Send ${h(p.ref)} with the selected option</button>` : ""}`}
        <h4 style="margin-top:12px">Personal data</h4>${rv ? `<p class="small">${h(rv.name)} · ${h(rv.assistance)} <button class="ghost small" data-hide="${h(p.ref)}">Mask again</button></p>`
          : `<p class="small muted">Masked by default. <button class="ghost small" data-reveal="${h(p.ref)}">Reveal (controller PIN, audited)</button></p>`}
      </div></div></td></tr>`;
  }
  function groups(key) {
    const gs = P.data.groups[key];
    if (!gs.length) return '<p class="muted">No affected passengers to group.</p>';
    return `<p class="small muted">Select a group to send it as one batch.</p><div class="px-groups">${gs.map((g) => {
      const refs = P.data.passengers.filter((p) => p[key] === g.key && p.status !== "Safe connection").map((p) => p.ref);
      return `<div class="px-group"><h4><span class="px-mono">${h(g.key)}</span><small class="muted">${g.passengers} pax</small></h4>
        <div class="row">${Object.entries(g.by_priority).sort((a, b) => PRANK[a[0]] - PRANK[b[0]]).map(([k, n]) => `${prio(k)} <small>${n}</small>`).join(" ")}</div>
        <div class="small">${g.assistance} with special assistance · alternatives: ${g.alternatives.map(h).join(", ") || '<span class="px-warn">none</span>'}</div>
        <div class="row"><button class="ghost small" data-gsel="${h(refs.join(","))}">Select group</button>
          <button class="ghost small" data-gopen="${h(key)}|${h(g.key)}">Show in table</button></div></div>`;
    }).join("")}</div>`;
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
  async function send(refs) {
    if (!me) { toast("Enter your name before sending a recommendation", "warn"); return q("#px-me")?.focus(); }
    const r = await api("/api/pax/recommend", { flight_id: S.flight, pax_ids: refs, by: me, overrides: P.override });
    const box = r.staged.map((s) => s.status === "PENDING"
      ? `<div>⏳ Recommendation <b>#${s.id}</b> for ${s.passengers.length} passenger(s) is <b>awaiting controller approval</b> in the <a href="#/tab/log">approval queue</a>.</div>`
      : `<div class="bad">⛔ Recommendation #${s.id} for ${s.passengers.length} passenger(s) refused by the guards: ${h(s.reason)}</div>`).join("") +
      (r.skipped.length ? `<div class="small muted">Not sent: ${r.skipped.map((x) => `${h(x.ref)} (${h(x.reason)})`).join("; ")}</div>` : "");
    P.sel.clear();
    await load();
    q("#px-handoff").innerHTML = `<div class="px-handoff" role="status">${box || "Nothing to send."}<div class="small muted">Nothing was booked. A controller must approve or reject each recommendation (PIN).</div></div>`;
  }
  const toList = () => q("#px-list", P.root)?.scrollIntoView({ behavior: "smooth", block: "start" });
  async function onClick(e) {
    const t = e.target;
    const d = t.closest("[data-retry],[data-view],[data-sort],[data-send],[data-clear],[data-sendone],[data-reveal],[data-hide],[data-gsel],[data-gopen],[data-bucket],[data-quick],[data-goto]")?.dataset;
    if (d) {
      if (d.retry) return load();
      if (d.bucket) { P.f = { ...P.f, bucket: P.f.bucket === d.bucket ? "" : d.bucket }; P.view = "table"; render(); return toList(); }
      if (d.quick) {
        P.f = d.quick === "clear" ? { ...NOF } : { ...NOF, ...(d.quick === "vuln" ? { assist: "yes" } : { bags: "yes" }) };
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
    if (r) { P.open = P.open === r.dataset.row ? null : r.dataset.row; render(); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === "px-me") { me = t.value.trim(); try { localStorage.setItem("aeroturn.me", me); } catch { /* ignore */ } return; }
    if (t.dataset.f !== undefined) { P.f[t.dataset.f] = t.value; return render(); }
    if (t.dataset.showlow) { P.showLow = t.checked; return render(); }
    if (t.dataset.sel) { t.checked ? P.sel.add(t.dataset.sel) : P.sel.delete(t.dataset.sel); return render(); }
    if (t.dataset.all) { visible().forEach((r) => (t.checked ? P.sel.add(r.ref) : P.sel.delete(r.ref))); return render(); }
    if (t.dataset.alt) { P.override[t.dataset.alt] = t.value; }
  }
  return { mount };
})();
