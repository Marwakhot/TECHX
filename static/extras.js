// Extra OCC features, mounted inside the main console by app.js:
//   What-if + Recovery comparison (Scenario Lab),
//   Passengers & bags (opens when you click an AI option), Guard Attack Mode and Audit replay (menu tabs).
// Loaded BEFORE app.js; it only touches app.js helpers (h, api, toast, tag, actionsText, askAuth, resultToast, refreshBell, S)
// at call time. Every server string is escaped with h(). Numbers/decisions come from code; text marked "LLM" from the model.
// Readability helpers shared by every tab (used at call time, after app.js has defined h()).
// how(): long explanations go behind a small "How it works" toggle so the page shows data first.
const how = (html, label = "How it works") => `<details class="how"><summary>${label}</summary><div>${html}</div></details>`;
// bullets(): split model prose into short sentences shown as a list (text is escaped with h()).
const bullets = (text) => { const parts = String(text ?? "").split(/(?<=[.!?])\s+(?=[A-Z0-9'"‘“(])/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? `<ul class="bul">${parts.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : `<p>${h(text)}</p>`; };
// shortIds(): "['P0248', 'P0255', ...]" in guard messages -> "P0248, P0255, P0254 +9 more" (call before h()).
const shortIds = (s) => String(s ?? "").replace(/\[\s*'[^'\]]+'(?:\s*,\s*'[^'\]]+')*\s*\]/g, (m) => {
  const ids = m.match(/'([^']+)'/g).map((x) => x.slice(1, -1));
  return ids.length <= 3 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} +${ids.length - 3} more`; });

const Extras = (() => {
  const q = (s, el = document) => el.querySelector(s);
  const src = (s) => `<span class="x-src ${String(s || "").startsWith("LLM") ? "llm" : "code"}">${h(s || "code")}</span>`;
  const CODE = '<span class="x-src code">code</span>', LLM = '<span class="x-src llm">LLM</span>';
  const X = {};

  async function busy(btn, fn) {
    const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="x-spin"></span> ${old}`;
    try { return await fn(); } catch (e) { toast(e.message, "bad"); } finally { btn.disabled = false; btn.innerHTML = old; }
  }

  // ======================= Scenario Lab: comparison + what-if =======================
  const CMP = [["at_risk", "Still at risk"], ["vulnerable_at_risk", "Vulnerable at risk"], ["protected", "Connections kept"], ["network_delay_added", "Network delay +min"],
    ["total_cost_eur", "Total cost €"], ["crew_min_margin", "Crew margin"], ["turn_gap", "Turn gap"], ["bags_rush", "Rush bags"]];
  function comparison(el, id, r) {
    el.innerHTML = `<div class="row between"><h3>Side-by-side comparison ${CODE}</h3><button class="ghost" id="x-explain">Explain the trade-offs (AI)</button></div>
      <table><thead><tr><th>#</th><th>Scenario</th>${CMP.map(([, l]) => `<th class="num">${l}</th>`).join("")}<th class="num">Score</th></tr></thead><tbody>${r.rows.map((s, i) => `<tr>
        <td>${i + 1}</td><td><b>${h(s.title)}</b>${s.ok ? "" : `<div class="bad small">🛡 ${h(shortIds(s.reason))}</div>`}</td>
        ${CMP.map(([k]) => `<td class="num ${s.best.includes(k) ? "x-best" : ""}">${s.ok ? h(s.kpis[k]) : "—"}</td>`).join("")}<td class="num">${s.ok ? s.score : tag("blocked", "bad")}</td></tr>`).join("")}</tbody></table>
      ${how("Green = best value in that column among scenarios that pass the guards. Ranking uses your priority toggles; vulnerable protection is always weighted.", "How to read this")}<div id="x-narr"></div>`;
    q("#x-explain").onclick = (e) => busy(e.target, async () => {
      const n = (await api("/api/compare", { flight_id: id, priorities: S.prio, narrate: true })).narrative;
      q("#x-narr").innerHTML = `<h3>Trade-offs ${src(n.source)}</h3>${bullets(n.summary || n.error)}<ul class="small">${(n.risks || []).map((x) => `<li>${h(x)}</li>`).join("")}</ul>`;
    });
  }

  async function whatif(el, id, scenarios) {
    const d = await api(`/api/flight/${id}`);
    const standby = [...new Map(d.crew.flatMap((c) => c.options.map((o) => [o.id, { ...o, role: c.role }]))).values()];
    el.innerHTML = `<h3>What-if simulator</h3><p class="small muted">Try a change. Nothing is saved.</p>${how(`${CODE} applies the change and the plan inside a transaction that is always rolled back and computes every number; ${LLM} only explains.`)}
    <div class="grid2"><div>
      <div class="row"><label>Extra inbound delay <input type="range" class="x-range" id="w_delay" min="0" max="180" step="5" value="0"> <b id="w_delay_v">0</b> min</label></div>
      <div class="row"><label>Onward seats sold elsewhere <input type="range" class="x-range" id="w_cut" min="0" max="100" step="10" value="0"> <b id="w_cut_v">0</b>%</label></div>
      <div class="row"><label>Close gate <select id="w_gate"><option value="">none</option>${d.gates.filter((g) => !g.occupied_by).map((g) => `<option>${h(g.id)}</option>`).join("")}</select></label>
        <label class="small"><input type="checkbox" id="w_mx"> Assume NO-GO maintenance signed off</label></div>
      <div class="small muted">Standby crew who call in sick:</div>
      <div class="row">${standby.map((s) => `<label class="small"><input type="checkbox" class="w_sb" value="${h(s.id)}"> ${h(s.id)} ${h(s.role)}</label>`).join("") || '<span class="muted small">no legal standby options</span>'}</div>
      <div class="row"><label>Plan to test <select id="w_plan"><option value="-1">none (impact only)</option>${scenarios.map((s, i) => `<option value="${i}">${h(s.title)}</option>`).join("")}</select></label>
        <button id="w_run">Run what-if</button></div>
    </div><div id="w_out"><p class="muted small">Results appear here.</p></div></div>`;
    ["delay", "cut"].forEach((k) => (q(`#w_${k}`).oninput = (e) => (q(`#w_${k}_v`).textContent = e.target.value)));
    q("#w_run").onclick = (e) => busy(e.target, async () => {
      const pv = +q("#w_plan").value, actions = pv >= 0 ? scenarios[pv].actions : null;
      const r = await api("/api/whatif", { flight_id: id, actions, params: { extra_delay: +q("#w_delay").value, seat_cut_pct: +q("#w_cut").value,
        gate_closed: q("#w_gate").value || null, mx_signed: q("#w_mx").checked, standby_unavailable: [...document.querySelectorAll(".w_sb:checked")].map((x) => x.value) } });
      const rows = [["at_risk", "Connections at risk"], ["vulnerable_at_risk", "Vulnerable at risk"], ["crew_illegal", "Crew over legal limit"], ["open_nogo", "Open NO-GO items"],
        ["turn_gap", "Turnaround gap (min)"], ["bags_short_connection", "Bags below bag MCT"], ["bags_rush", "Rush-tagged bags"], ["pax_cost_eur", "Passenger cost (€)"]];
      const pk = r.plan.kpis;
      q("#w_out").innerHTML = `<div class="small muted">${r.applied.map(h).join(" · ") || "no change applied"}</div>
        <table><thead><tr><th>KPI ${CODE}</th><th class="num">Now</th><th class="num">What-if</th>${actions ? '<th class="num">With plan</th>' : ""}</tr></thead><tbody>${rows.map(([k, l]) =>
          `<tr><td>${l}</td><td class="num">${h(r.baseline[k])}</td><td class="num ${r.delta[k] > 0 ? "bad" : ""}">${h(r.after[k])}</td>${actions ? `<td class="num">${pk ? h(pk[k]) : "—"}</td>` : ""}</tr>`).join("")}</tbody></table>
        ${actions ? `<p>${r.plan.ok ? tag("plan passes the guards", "ok") : `${tag("plan BLOCKED", "bad")} <span class="small bad">${h(r.plan.reason)}</span>`}</p>` : ""}
        ${r.findings.length ? `<b>Findings ${CODE}</b><ul class="small">${r.findings.map((f) => `<li>${h(f)}</li>`).join("")}</ul>` : ""}
        <b>Explanation ${src(r.narrative.source)}</b><p class="small">${h(r.narrative.summary || r.narrative.error)}</p>`;
    });
  }

  // ======================= Passengers & bags for one AI option =======================
  async function paxPanel(el, id, option) {
    el.hidden = false;
    el.innerHTML = `<h3>Passengers & bags · ${h(option.title)}</h3><p class="muted small"><span class="x-spin"></span> Dry-running this option (rolled back)…</p>`;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    let p;
    try { p = await api("/api/preview", { flight_id: id, actions: option.actions }); } catch (e) { el.innerHTML = `<p class="bad">${h(e.message)}</p>`; return; }
    const s = p.summary, out = (o) => tag(o, o === "STRANDED" ? "bad" : o === "REBOOKED" ? "warn" : "ok");
    el.innerHTML = `<div class="row between"><h3>Passengers & bags · ${h(option.title)}</h3><button class="ghost small" id="x-pclose">Close</button></div>
      <p class="small muted">Dry run of this option. Nothing is saved.</p>
      ${how(`${CODE} dry-run of this option: seats are planned vulnerable-first and baggage-aware (bag minimum connection ${p.bag_mct} min). It prefers a flight both
      the passenger and their bags can make, otherwise the bag is rush-tagged. Seats and bags move in one atomic transaction behind a passenger–bag match guard.`)}
      ${p.ok ? "" : `<p class="bad">🛡 Blocked by the guards: ${h(shortIds(p.reason))}</p>`}
      <div class="x-kpi"><div>At risk now<b>${s.at_risk_before}</b></div><div>Rebooked<b>${s.rebooked}</b></div><div>Kept by a hold<b class="ok">${s.kept_by_hold}</b></div>
        <div>Stranded<b class="${s.stranded ? "bad" : "ok"}">${s.stranded}</b><span class="small muted">${s.vulnerable_stranded} vulnerable</span></div>
        <div>Bags moving<b>${s.bags_moving}</b></div><div>Bags at risk<b class="${s.bags_short ? "warn" : "ok"}">${s.bags_short}</b><span class="small muted">rush-tagged ${s.bags_rush}</span></div></div>
      <div class="row">${p.ok ? `<button id="x-papply">Apply this option (controller PIN)</button>
        <label class="small"><input type="radio" name="x-chaos" value="" checked> normal</label>
        <label class="small"><input type="radio" name="x-chaos" value="seat"> 💥 inject seat conflict mid-batch</label>
        <label class="small"><input type="radio" name="x-chaos" value="bag"> 💥 inject baggage-system failure mid-batch</label>` : ""}</div>
      <div id="x-pnotes"></div>
      <table><thead><tr><th>Pax</th><th>Tier</th><th>Dest</th><th>Was on</th><th>Outcome</th><th>New flight</th><th class="num">Connection</th><th class="num">Bags</th><th>Bags make it</th></tr></thead>
      <tbody>${p.passengers.map((x) => `<tr><td>${h(x.id)} <span class="muted small">${h(x.name)}</span></td><td>${tierTag(x.tier)}</td><td>${h(x.dest)}</td><td>${h(x.was)}</td>
        <td>${out(x.outcome)}</td><td>${x.outcome === "STRANDED" ? '<span class="muted">—</span>' : h(x.onward)}</td><td class="num">${x.conn_min} min</td><td class="num">${x.bags}</td>
        <td>${!x.bags ? "—" : x.outcome === "STRANDED" ? '<span class="muted">with pax</span>' : x.bag_ok ? tag("yes", "ok") : tag(String(x.bag_status || "").includes("RUSH") ? "rush-tagged" : "at risk", "warn")}</td></tr>`).join("")}</tbody></table>`;
    q("#x-pclose").onclick = () => { el.hidden = true; document.querySelectorAll(".x-sel").forEach((c) => c.classList.remove("x-sel")); };
    if (!p.ok) return;
    q("#x-papply").onclick = () => {
      const chaos = q("input[name=x-chaos]:checked").value || false;
      askAuth(`Controller approval: ${h(option.title)}<div class="small muted" style="margin-top:6px">${actionsText(option.actions)}</div>` +
        (chaos ? `<p class="bad small">Chaos on: ${chaos === "bag" ? "the baggage system rejects a re-tag" : "a competing booking grabs a seat"} mid-batch</p>` : ""), async (a) => {
        const r = await api("/api/decide", { flight_id: id, title: option.title, actions: option.actions, chaos, origin: "Live report", ...a });
        resultToast(r); refreshBell();
        if (r.status === "ROLLED_BACK") {
          q("#x-pnotes").innerHTML = `<p class="bad">ROLLED BACK: ${h(r.reason)}</p><p class="small muted">Nothing changed: every hold, crew swap, gate change, seat and bag in this decision was undone ·
            ${r.integrity.double_bookings} double bookings, ${r.integrity.orphan_bags} orphaned bags.</p>`;
        } else if (r.status === "APPROVED") notifications(q("#x-pnotes"), id);
      });
    };
  }
  function notifications(el, id) {
    el.innerHTML = `<div class="card"><h3>Passenger notifications</h3><p class="small muted">AI drafts · controller PIN to send</p>${how(`${LLM} writes one message per group (care tier, new flight, bag status) and never sees a name;
      ${CODE} fills the names in locally. Sending needs the controller PIN.`)}<button id="x-ndraft">Draft notifications (AI)</button><div id="x-nout"></div></div>`;
    q("#x-ndraft").onclick = (e) => busy(e.target, async () => {
      const n = await api("/api/notify/draft", { flight_id: id });
      const msgs = n.groups.flatMap((g) => g.pax.filter((p) => p.message).map((p) => ({ pax_id: p.id, message: p.message })));
      q("#x-nout").innerHTML = `<p class="small">${src(n.source)} · ${n.groups.length} groups · ${msgs.length} messages</p>${n.groups.map((g) =>
        `<div class="x-item"><div class="meta">${tierTag(g.tier)} ${h(g.original_flight)} → ${h(g.new_flight || "pending")} · bags ${h(g.bag_status)} · ${g.pax.length} pax
        ${g.salutation_added_by_code ? '<span class="warn">salutation added by code</span>' : ""}</div><q>${h(g.pax[0]?.message)}</q></div>`).join("")}
        <button id="x-nsend" ${msgs.length ? "" : "disabled"}>Approve & send ${msgs.length} messages</button>`;
      q("#x-nsend").onclick = () => askAuth(`Send ${msgs.length} passenger messages`, async (a) => {
        const r = await api("/api/notify/send", { flight_id: id, messages: msgs, ...a }); toast(`${r.sent} passenger messages sent`);
      });
    });
  }

  // ======================= shared helpers for the inbox-style pages =======================
  const tt = (m) => (m == null ? "—" : `T${m < 0 ? "−" : "+"}${Math.abs(m)}`);
  function download(name, text, type = "text/markdown") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  // keep a selected row visible inside its own scroll box, never scrolling the page
  function keepVisible(row, box) {
    if (!row || !box) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop - 8;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight + 8;
  }
  // list of [group label, items]; each row gets data-k; ↑/↓ or j/k moves; onSelect(k) draws the detail pane
  function inboxList(box, onSelect) {
    box.onclick = (e) => { const it = e.target.closest("[data-k]"); if (it) onSelect(it.dataset.k); };
    box.onkeydown = (e) => {
      const d = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key]; if (!d) return;
      e.preventDefault();
      const rows = [...box.querySelectorAll("[data-k]")], j = rows.findIndex((r) => r.classList.contains("on"));
      const next = rows[Math.min(rows.length - 1, Math.max(0, j + d))]; if (next) onSelect(next.dataset.k);
    };
  }
  const markOn = (box, k) => { box.querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("on", x.dataset.k === String(k))); keepVisible(box.querySelector(".on"), box); };

  // ======================= Maintenance: fleet-wide queue, most urgent departure first =======================
  // Left: every item across the fleet, grouped (blocking a departure / deferrable / signed). Right: the selected item:
  // where it is in Open → Assigned → Signed off, which departure it blocks and how long is left, and the engineers ranked by
  // when they could finish. All timing is code: start = max(aircraft on block, engineer walk); finish = start + inspection.
  const slackTag = (s) => s == null ? "" : s < 0 ? tag(`release slips ${-s} min`, "bad") : s < 10 ? tag(`${s} min spare`, "warn") : tag(`${s} min spare`, "ok");
  async function maintenanceTab(el) {
    el.innerHTML = `<div class="card ga-head mx-head"><div class="ga-head-row"><div><h3>Maintenance</h3>
      <p class="muted small">Every open item across the fleet, most urgent departure first. A NO-GO item blocks its aircraft's release until the assigned licensed engineer signs it off.</p></div>
      <div class="mx-sum" id="mx-sum"></div></div>
      ${how(`${CODE} computes every time on this page: an engineer can start once they have walked to the aircraft <i>and</i> it is on block;
        the fix ends after the inspection time; the spare time is the scheduled departure minus that finish. Times are relative to now (T+0).`, "How times are worked out")}</div>
      <div id="mx-agent"></div>
      <div id="mx-out"><p class="muted small"><span class="x-spin"></span> Loading the maintenance queue…</p></div>`;
    await loadMx();
  }
  // the engineer the Maintenance agent picked for an open item (specialists.py), else the one who finishes first
  const mxPick = (i) => i.options.find((o) => o.id === i.agent_pick?.engineer_id) || i.options[0];
  async function loadMx() {
    X.mx = await api("/api/maintenance");
    const items = X.mx.items, n = (f) => items.filter(f).length;
    // what the Maintenance agent did (AgentPanel, agentlive.js): one engineer per open item on a delayed flight
    const ag = X.mx.agent;
    q("#mx-agent").innerHTML = AgentPanel.html("mx", ag && { ...ag, picks: undefined }, (ag?.picks || []).map((p) => {
      const i = items.find((x) => x.id === p.item_id), e = i?.options.find((o) => o.id === p.engineer_id);
      return { who: `${p.item_id}${i ? ` · ${i.item}` : ""} (${p.blocks_departure ? "NO-GO" : "deferrable"}, ${p.outbound || "—"})`, what: e ? e.name : p.engineer_id,
        why: p.reason, by: p.by, tone: p.blocks_departure && (p.slack ?? 0) < 0 ? "late" : "" }; }), 0, "No open item on a delayed flight needs an engineer.");
    const blocking = items.filter((i) => i.blocks_departure), late = blocking.filter((i) => ((i.assigned || mxPick(i))?.slack ?? 0) < 0);
    q("#mx-sum").innerHTML = `<div><b class="${blocking.length ? "bad" : "ok"}">${blocking.length}</b><span>NO-GO open</span></div>
      <div><b class="${late.length ? "bad" : "ok"}">${late.length}</b><span>will delay a release</span></div>
      <div><b>${n((i) => i.severity !== "NO-GO" && i.status !== "SIGNED")}</b><span>deferrable (MEL)</span></div>
      <div><b>${n((i) => i.status === "SIGNED")}</b><span>signed off</span></div>`;
    if (!items.some((i) => i.id === X.mxSel)) X.mxSel = items[0]?.id;
    const group = (i) => (i.status === "SIGNED" ? "Signed off" : i.blocks_departure ? "Blocking a departure" : "Deferrable (MEL) · does not block release");
    q("#mx-out").innerHTML = `<div class="ga-inbox"><div class="card ga-list" tabindex="0" role="listbox" aria-label="Maintenance items">${items.map((i, j) => {
      const best = i.assigned || mxPick(i);
      return `${j === 0 || group(items[j - 1]) !== group(i) ? `<div class="ga-sep small muted">${group(i)}</div>` : ""}
        <div class="ga-item mx-item" role="option" data-k="${h(i.id)}"><b>${h(i.id)} · ${h(i.item)}</b>${tag(i.severity, i.severity === "NO-GO" && i.status !== "SIGNED" ? "bad" : "")}
          <span class="small muted">${h(i.tail)} · ${h(i.inbound || "—")} → ${h(i.outbound || "—")} · ${h(i.status.toLowerCase())}</span>
          ${i.status === "SIGNED" ? "" : `<span class="small mx-urg">Departs ${tt(i.dep)} ${i.blocks_departure && best ? slackTag(best.slack) : ""}</span>`}</div>`;
    }).join("")}</div><div class="card ga-detail" id="mx-detail"></div></div>`;
    const box = q("#mx-out .ga-list");
    inboxList(box, selectMx);
    selectMx(X.mxSel);
  }
  function selectMx(id) {
    X.mxSel = id; markOn(q("#mx-out .ga-list"), id);
    const i = X.mx.items.find((x) => x.id === id), el = q("#mx-detail"); if (!i || !el) return;
    const stage = { OPEN: 0, ASSIGNED: 1, SIGNED: 2 }[i.status] ?? 0;
    const steps = ["Open", "Engineer assigned", "Signed off"].map((s, n) => `<li class="${n < stage ? "done" : n === stage ? "cur" : ""}">${s}</li>`).join("");
    const a = i.assigned;
    el.innerHTML = `<div class="ga-d-top"><span class="small muted">${h(i.tail)} · ${h(i.inbound || "")}</span>${tag(i.severity, i.severity === "NO-GO" && i.status !== "SIGNED" ? "bad" : "")}</div>
      <div class="ga-d-name">${h(i.id)} · ${h(i.item)}</div>
      <ol class="mx-steps">${steps}</ol>
      ${i.blocks_departure ? `<div class="ga-stop GUARD"><span class="small muted">Blocks release of</span> <b>${h(i.outbound)}</b> · departs ${tt(i.dep)}
        <p class="small">No departure until a licensed engineer signs this off. The guard is in code, so nothing (and no AI) can skip it.</p></div>`
        : i.status === "SIGNED" ? "" : `<div class="ga-stop HITL"><span class="small muted">Deferrable</span><p class="small">Can be carried under the MEL; it does not block ${h(i.outbound || "the")} release.</p></div>`}
      <dl class="ga-dl"><dt>Aircraft on block</dt><dd>${tt(i.on_block)}</dd><dt>Inspection time</dt><dd>${i.work_min} min</dd>
        <dt>Outbound</dt><dd>${h(i.outbound || "—")} · ${tt(i.dep)} · ${h(i.dep_status || "")}</dd>
        ${i.status === "SIGNED" ? `<dt>Signed off by</dt><dd>${h(i.signed_by)}</dd>` : ""}
        ${a && i.status === "ASSIGNED" ? `<dt>Assigned engineer</dt><dd><b>${h(a.name)}</b> · ${h(a.location)} · ${a.walk_min} min walk<br>
          <span class="small">Can finish by ${tt(a.finish)}</span> ${i.blocks_departure ? slackTag(a.slack) : ""}</dd>` : ""}</dl>
      ${i.status === "ASSIGNED" ? `<div class="row mx-act"><button data-sign="${h(i.id)}">Record engineer sign-off</button>
        <span class="small muted">Needs the assigned engineer's licence number</span></div>` : ""}
      ${i.status === "OPEN" ? `<h3 class="mx-h">Assign an engineer</h3><p class="small muted">Ranked by when they could finish. ${CODE}</p>
        <table class="mx-eng"><thead><tr><th>Engineer</th><th>Base</th><th class="num">Walk</th><th class="num">Done by</th><th>vs departure</th><th></th></tr></thead><tbody>
        ${i.options.map((o, n) => `<tr class="${o.busy_with ? "muted" : ""}"><td><b>${h(o.name)}</b>${o.busy_with ? ""
          : o.id === i.agent_pick?.engineer_id ? ` <span class="tag ok" title="${h(`${X.mx.agent?.name || "Maintenance agent"}: ${i.agent_pick.reason}`)}">agent pick</span>`
          : n === 0 && !X.mx.agent ? ' <span class="tag ok">fastest</span>' : ""}
          ${o.busy_with ? `<div class="small muted">busy on ${h(o.busy_with)}</div>` : ""}</td><td>${h(o.location)}</td><td class="num">${o.walk_min} min</td>
          <td class="num">${tt(o.finish)}</td><td>${i.blocks_departure ? slackTag(o.slack) : '<span class="muted small">not blocking</span>'}</td>
          <td><button class="ghost" data-assign="${h(o.id)}" ${o.busy_with ? "disabled" : ""}>Assign</button></td></tr>`).join("")}</tbody></table>
        <p class="small muted">Assigning goes to the Operations Controller for approval (PIN).</p>` : ""}
      <h3 class="mx-h">History</h3>${i.history.length ? `<ul class="mx-hist">${i.history.map((x) =>
        `<li><span class="x-mono small muted">${h(x.ts)}</span> ${h(x.what)} <span class="small muted">· ${h(x.who)}</span></li>`).join("")}</ul>`
        : '<p class="small muted">No actions yet.</p>'}`;
    el.onclick = (e) => {
      const eid = e.target.dataset.assign, sid = e.target.dataset.sign;
      if (eid) { const o = i.options.find((x) => x.id === eid);
        decide(i.inbound, `Assign ${o.name} to ${i.id}`, [{ kind: "ASSIGN_ENGINEER", item_id: i.id, engineer_id: eid }], (r) => r?.status === "APPROVED" && loadMx()); }
      if (sid) modal(`Engineer sign-off ${h(sid)}`, [["licence", `${a?.name || "Assigned engineer"}'s licence no. (B1-xxxxx)`, "password", ""]],
        async (v) => { await api("/api/signoff", { item_id: sid, ...v }); toast(`${sid} signed off`); refreshBell(); await loadMx(); });
    };
  }

  // ======================= Guard Attack Mode: verdict strip + review inbox =======================
  // A fixed regression suite (same attacks every run, no AI, instant) plus optional AI-invented attacks on top.
  // Verdict on top, attempts on the left, the selected attempt on the right; ↑/↓ moves; layer chips filter; recent runs + export.
  const LAYERS = { SCHEMA: ["Schema", "Rejected before it reached the system: the action is not on the whitelist, or is malformed."],
    GUARD: ["Guards", "Dry-run inside a rolled-back transaction; a safety rule refused it."],
    HITL: ["Controller", "Legal per the rules, so it stays a proposal: nothing runs without the Operations Controller PIN."] };
  const layerTag = (k) => `<span class="ga-layer ${h(k)}">${h(LAYERS[k]?.[0] || k)}</span>`;

  async function attackTab(el) {
    const flights = await api("/api/flights");
    el.innerHTML = `<div class="card ga-head"><div class="ga-head-row"><div><h3>Guard Attack Mode</h3>
        <p class="muted small">Attacks try to break the safety rules; every attempt runs through the real defences. Nothing is saved.</p></div>
        <div class="row"><label class="small">Flight <select id="x-af">${flights.map((f) => `<option ${f.id === S.flight ? "selected" : ""}>${h(f.id)}</option>`).join("")}</select></label>
        <button id="x-afix" class="ghost" title="The same attacks every run. Instant, no AI.">Run fixed suite</button>
        <button id="x-arun" title="Fixed suite plus new attacks invented by the AI (about 10 s)">Run fixed + AI</button></div></div>
      <div class="ga-flow small">${["SCHEMA", "GUARD", "HITL"].map((k) => `<span title="${h(LAYERS[k][1])}">${layerTag(k)}</span>`).join('<span class="muted">→</span>')}
        <span class="muted">· each attempt stops at the first layer that refuses it</span></div>
      <div id="ga-hist"></div></div>
      <div id="x-aout">${X.atk ? "" : '<div class="ga-empty muted small">Run the fixed suite (instant) or add AI-invented attacks to review each attempt here.</div>'}</div>`;
    const go = (mode) => (e) => busy(e.target, async () => {
      q("#x-aout").innerHTML = `<div class="gm-status run"><h3><span class="gm-live"></span>Attacking ${h(q("#x-af").value)}…</h3><span class="small muted">every attempt runs through the real defences · nothing will be saved</span></div><div class="gm-prog"><i class="ind"></i></div>`;
      X.atk = await api("/api/redteam", { flight_id: q("#x-af").value, mode }); X.atkSel = "0"; X.atkFilter = ""; X.atkTab = "g"; X.atkPlay = true; drawAttack(); drawHistory();
    });
    q("#x-afix").onclick = go("fixed"); q("#x-arun").onclick = go("full");
    drawHistory();
    if (X.atk) drawAttack();
  }
  async function drawHistory() {
    const el = q("#ga-hist"); if (!el) return;
    const runs = await api("/api/redteam/history").catch(() => []);
    el.innerHTML = runs.length ? `<details class="how ga-hist"><summary>Recent runs (${runs.length})</summary><div><table><thead><tr><th>Time</th><th>Flight</th><th>Suite</th>
      <th class="num">Attacks</th><th>Schema · Guards · Controller</th><th>Result</th></tr></thead><tbody>${runs.map((r) => `<tr><td class="x-mono small">${h(r.ts)}</td><td>${h(r.flight)}</td>
      <td>${r.mode === "fixed" ? "Fixed" : "Fixed + AI"}</td><td class="num">${h(r.attacks)}</td><td class="small">${h(r.stopped.SCHEMA ?? 0)} · ${h(r.stopped.GUARD ?? 0)} · ${h(r.stopped.HITL ?? 0)}</td>
      <td>${r.unchanged && !r.committed ? tag("state unchanged", "ok") : tag("STATE CHANGED", "bad")}</td></tr>`).join("")}</tbody></table></div></details>` : "";
  }

  function attackItems() {
    const r = X.atk;
    return [...r.attacks.map((a, i) => ({ t: "atk", i, a })), ...(r.injection ? [{ t: "inj" }] : []), { t: "imm" }];
  }
  const atkGroup = (it) => (it.t !== "atk" ? "Other probes" : it.a.suite === "ai" ? "AI-invented attacks" : "Fixed suite");

  const GL = ["SCHEMA", "GUARD", "HITL"], GQ = { SCHEMA: "Is the request well-formed and on the whitelist?", GUARD: "Do the safety rules allow it?", HITL: "Does it still need the controller PIN?" };
  const GC = { SCHEMA: "schema", GUARD: "guards", HITL: "controller" };
  const gcell = (st) => (st === "scan" ? '<i class="gm-spin"></i>' : st === "pass" ? '<span class="gm-ok">✓ pass</span>' : st === "block" ? '<span class="gm-blk">BLOCKED</span>' : st === "skip" ? "—" : '<i class="gm-dot"></i>');
  function drawAttack() {
    const r = X.atk, n = r.attacks.length, ok = r.state_unchanged && !r.committed, play = X.atkPlay; X.atkPlay = false;
    (X.atkTs || []).forEach(clearTimeout); X.atkTs = [];
    const done = r.attacks.map(() => !play), cnt = (k) => r.attacks.filter((a, i) => done[i] && a.stopped_by === k).length;
    const other = attackItems().map((it, k) => ({ ...it, k })).filter((it) => it.t !== "atk");
    const drawLayers = () => { const v = q("#gm-layer"); if (!v) return;
      v.innerHTML = GL.map((k) => { const list = r.attacks.map((a, i) => ({ a, i })).filter((o) => done[o.i] && o.a.stopped_by === k);
        return `<div class="gm-lc ${GC[k]}"><h4><span>${h(LAYERS[k][0])}</span><span>${list.length}</span></h4><p>${GQ[k]}</p>${list.length ? list.map((o) =>
          `<button class="gm-lk" data-k="${o.i}"><b>${h(o.a.name || "Attack " + (o.i + 1))}</b><span>${h(shortIds(o.a.reason))}</span></button>`).join("") : '<div class="muted small">Nothing stopped here yet.</div>'}</div>`; }).join(""); };
    const status = () => { const d = done.filter(Boolean).length, el = q("#gm-status"); if (!el) return;
      const fin = d === n;
      el.className = `gm-status ${fin ? (ok ? "" : "bad") : "run"}`;
      el.innerHTML = fin ? `<h3>${ok ? "✓ State unchanged" : "✘ State changed"}</h3><span class="small muted">${n} attacks · ${r.committed} committed · ${src(r.source)} · <span class="x-mono">${h(r.state_hash_before)} → ${h(r.state_hash_after)}</span></span>${r.ai_error ? `<span class="small warn">${h(r.ai_error)}</span>` : ""}`
        : `<h3><span class="gm-live"></span>Attack ${Math.min(d + 1, n)} of ${n}</h3><span class="small muted">${d} stopped so far · 0 committed · <span class="x-mono">${h(r.state_hash_before)} → …</span></span>`;
      q("#gm-prog").style.width = `${(d / Math.max(1, n)) * 100}%`;
      GL.forEach((k) => { const e = q(`#gm-n-${k}`); if (e) e.textContent = cnt(k); }); drawLayers(); };
    q("#x-aout").innerHTML = `<div id="gm-status"></div><div class="gm-prog"><i id="gm-prog"></i></div>
      <div class="gm-split"><div><div class="gm-tabs"><button class="gm-tab ${X.atkTab !== "l" ? "on" : ""}" data-t="g">Live gauntlet</button>
        <button class="gm-tab ${X.atkTab === "l" ? "on" : ""}" data-t="l">By layer</button><button class="gm-tab gm-exp" id="ga-export">Export report</button></div>
      <div class="gm-scroll" ${X.atkTab === "l" ? "hidden" : ""}><div class="gm-gaunt ga-list" tabindex="0">
        <div class="gm-gr gm-gh"><div class="gm-nm">ATTACK</div>${GL.map((k) => `<div class="gm-ch ${GC[k]}"><b>${h(LAYERS[k][0]).toUpperCase()}</b><span>${GQ[k]}</span><em id="gm-n-${k}">0</em></div>`).join("")}</div>
        ${r.attacks.map((a, i) => { const hit = GL.indexOf(a.stopped_by);
          return `<div class="gm-gr ga-item" data-k="${i}"><div class="gm-nm"><b>${h(a.name || "Attack " + (i + 1))}${a.suite === "ai" ? '<span class="gm-ai">AI</span>' : ""}</b><div>${h(a.targets)}</div></div>
            ${GL.map((k, j) => `<div class="gm-cell ${GC[k]}" id="gm-c-${i}-${j}">${gcell(play ? "" : j < hit ? "pass" : j === hit ? "block" : "skip")}</div>`).join("")}</div>`; }).join("")}
        ${other.map((it) => `<div class="gm-gr gm-oth ga-item" data-k="${it.k}"><div class="gm-nm">${it.t === "inj" ? "<b>Prompt-injection probe</b><div>A fake call planted in the transcripts</div>" : "<b>Immutability probes</b><div>Code tries to rewrite the rule constants</div>"}</div>
          <div class="gm-cell gm-wide">${it.t === "inj" ? (r.injection.error ? tag("skipped", "warn") : tag(r.injection.release_passed_guards ? "check" : "held", r.injection.release_passed_guards ? "warn" : "ok"))
            : tag(`${r.immutability.filter((p) => p.blocked).length}/${r.immutability.length} blocked`, r.immutability.every((p) => p.blocked) ? "ok" : "bad")}</div></div>`).join("")}
      </div></div><div class="gm-layers" id="gm-layer" ${X.atkTab === "l" ? "" : "hidden"}></div></div>
      <div class="card ga-detail gm-detail" id="ga-detail"></div></div>`;
    q("#ga-export").onclick = exportAttack;
    q("#x-aout .gm-tabs").onclick = (e) => { const b = e.target.closest("[data-t]"); if (!b) return; X.atkTab = b.dataset.t;
      q("#x-aout .gm-scroll").hidden = X.atkTab === "l"; q("#gm-layer").hidden = X.atkTab !== "l";
      q("#x-aout").querySelectorAll(".gm-tab[data-t]").forEach((t) => t.classList.toggle("on", t === b)); };
    q("#gm-layer").onclick = (e) => { const b = e.target.closest("[data-k]"); if (b) selectAttack(b.dataset.k); };
    inboxList(q("#x-aout .ga-list"), selectAttack);
    status(); selectAttack(X.atkSel);
    if (!play || matchMedia("(prefers-reduced-motion: reduce)").matches) { done.fill(true); status(); return; }
    const T = (fn, ms) => X.atkTs.push(setTimeout(fn, ms));
    const set = (i, j, st) => { const c = q(`#gm-c-${i}-${j}`); if (c) { c.innerHTML = gcell(st); c.classList.toggle("scan", st === "scan"); } };
    const cur = (i) => { q("#x-aout")?.querySelectorAll(".gm-gr.cur").forEach((e) => e.classList.remove("cur")); if (i != null) q(`#x-aout .gm-gr[data-k="${i}"]`)?.classList.add("cur"); };
    r.attacks.forEach((a, i) => { const hit = Math.max(0, GL.indexOf(a.stopped_by)), t0 = 300 + i * 460;
      for (let j = 0; j <= hit; j++) { const ts = t0 + j * 320;
        T(() => { set(i, j, "scan"); cur(i); }, ts);
        T(() => { if (j < hit) return set(i, j, "pass"); set(i, j, "block"); for (let k = j + 1; k < 3; k++) set(i, k, "skip");
          done[i] = true; status(); if (String(i) === X.atkSel) selectAttack(X.atkSel); if (i === n - 1) cur(null); }, ts + 260); } });
  }

  function exportAttack() {
    const r = X.atk, line = (a) => `| ${a.suite === "ai" ? "AI" : "Fixed"} | ${a.name} | ${a.targets} | ${LAYERS[a.stopped_by]?.[0] || a.stopped_by} | ${String(shortIds(a.reason)).replace(/\|/g, "/")} |`;
    download(`guard-attack-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`, [
      "# Aviant · Guard Attack report", "", `- Result: **${r.state_unchanged && !r.committed ? "state unchanged" : "STATE CHANGED"}**`,
      `- Attacks: ${r.attacks.length} · committed: ${r.committed}`, `- State hash: ${r.state_hash_before} → ${r.state_hash_after}`, `- Source: ${r.source}`, "",
      "| Suite | Attack | Rule targeted | Stopped by | Reason |", "|---|---|---|---|---|", ...r.attacks.map(line), "",
      "## Immutability probes", ...r.immutability.map((p) => `- ${p.blocked ? "blocked" : "NOT BLOCKED"}: \`${p.probe}\` (${p.error})`),
      ...(r.injection && !r.injection.error ? ["", "## Prompt-injection probe", `> ${r.injection.call.speaker}: ${r.injection.call.text}`, "",
        ...r.injection.suggestions.map((s) => `- ${s.title}: ${s.ok ? "passes the guards, still needs the controller PIN" : "blocked: " + shortIds(s.reason)}`)] : [])].join("\n"));
  }

  function selectAttack(k) {
    const box = q("#x-aout .ga-list"); X.atkSel = String(k); markOn(box, k);
    const r = X.atk, it = attackItems()[+k], el = q("#ga-detail"); if (!it || !el) return;
    const ks = [...box.querySelectorAll("[data-k]")].map((x) => x.dataset.k), pos = ks.indexOf(String(k));
    const nav = `<div class="ga-d-top"><span class="small muted">${pos + 1} of ${ks.length} · ↑ ↓ to move</span><span class="row">
      <button class="ghost" data-nav="-1" ${pos <= 0 ? "disabled" : ""}>Prev</button><button class="ghost" data-nav="1" ${pos >= ks.length - 1 ? "disabled" : ""}>Next</button></span></div>`;
    let body;
    if (it.t === "atk") {
      const a = it.a;
      body = `<div class="ga-d-name">${h(a.name || "Attack " + (it.i + 1))}</div>
        <div class="gm-path">${GL.map((k, j) => { const hit = GL.indexOf(a.stopped_by); return `<div class="gm-ps ${GC[k]} ${j < hit ? "pass" : j === hit ? "hit" : ""}">${j < hit ? "✓ " : ""}${h(LAYERS[k][0]).toUpperCase()}${j === hit ? " · STOPPED" : ""}</div>`; }).join("")}</div>
        <div class="ga-stop ${h(a.stopped_by)}"><span class="small muted">${a.suite === "ai" ? "Invented by the AI" : "Fixed suite"}</span>
          <p class="small">${h(LAYERS[a.stopped_by]?.[1] || "")}</p></div>
        <dl class="ga-dl"><dt>Rule targeted</dt><dd>${h(a.targets) || "—"}</dd><dt>What it tried</dt><dd>${h(a.tactic) || "—"}</dd>
          <dt>Why it was stopped</dt><dd>${h(shortIds(a.reason))}</dd>
          <dt>Actions that passed the whitelist</dt><dd>${a.kept_actions.length ? actionsText(a.kept_actions) : '<span class="muted">None</span>'}
            ${a.schema_notes.map((s) => `<div class="small ga-note">${h(s)}</div>`).join("")}</dd></dl>
        <details class="ga-raw"><summary class="small">Raw payload · ${a.raw_actions.length} action(s)</summary><div class="x-pre">${h(JSON.stringify(a.raw_actions, null, 1))}</div></details>`;
    } else if (it.t === "inj") {
      const inj = r.injection;
      body = inj.error ? `<div class="ga-d-name">Prompt-injection probe</div><p class="warn">Skipped: ${h(inj.error)}</p>`
        : `<div class="ga-d-name">Prompt-injection probe</div>
        <p class="small muted">The attacker planted this call. The planner AI then proposed options, and each was dry-run through the guards.</p>
        <blockquote class="ga-quote"><span class="small muted">${h(inj.call.speaker)}</span>“${h(inj.call.text)}”</blockquote>
        <dl class="ga-dl">${inj.suggestions.map((s) => `<dt>${h(s.title)}</dt><dd>${s.ok ? tag("passes · still needs PIN", "warn") : tag("blocked", "bad")}
          <div class="small">${actionsText(s.actions)}</div>${s.reason ? `<div class="small muted">${h(shortIds(s.reason))}</div>` : ""}</dd>`).join("")}</dl>`;
    } else {
      body = `<div class="ga-d-name">Immutability probes</div><p class="small muted">Code tries to rewrite the guard constants while the system is running.</p>
        <dl class="ga-dl">${r.immutability.map((p) => `<dt class="x-mono">${h(p.probe)}</dt><dd>${p.blocked ? tag("blocked", "ok") : tag("NOT blocked", "bad")}
          <div class="small muted x-mono">${h(p.error)}</div></dd>`).join("")}</dl>`;
    }
    el.innerHTML = nav + body;
    el.onclick = (e) => { const b = e.target.closest("[data-nav]"); if (!b) return;
      const next = ks[Math.min(ks.length - 1, Math.max(0, pos + +b.dataset.nav))]; if (next != null) selectAttack(next); };
  }

  // ======================= Audit replay: verdict + filtered timeline + exact changes =======================
  // Runs on open. Filter by actor / text / state changes; scrub the timeline (click, ← →, play). For the selected step:
  // the headline figures that moved and every record field that changed, the hashes, and a link to the flight. Export = evidence pack.
  const RKP = [["at_risk", "Connections at risk"], ["vulnerable_at_risk", "Vulnerable at risk"], ["crew_illegal", "Crew over limit"], ["open_nogo", "Open NO-GO"],
    ["outbound_gate", "Outbound gate"], ["outbound_status", "Outbound status"], ["outbound_delay", "Outbound delay"], ["double_bookings", "Double bookings"], ["orphan_bags", "Orphaned bags"]];
  const stepBad = (s) => s.match === false || !!s.error;

  async function replayTab(el) {
    el.innerHTML = `<div class="card"><div class="ga-head-row"><div><h3>Audit replay</h3>
        <p class="muted small">Rebuilds the data from the audit log, event by event, and proves it explains the live state.</p></div>
        <button id="x-rrun" class="ghost">Re-run replay</button></div>
      ${how(`${CODE} rebuilds the seed dataset in a scratch database and re-applies every committed event from the append-only audit log, comparing the state hash after
      each step with the hash recorded at commit time. A match proves the log fully explains the live state, and that rolled-back attempts left no trace.`)}</div>
      <div id="x-rout"><p class="muted small"><span class="x-spin"></span> Replaying the audit log…</p></div>`;
    // per flight: the replay always verifies the whole log; the flight picks whose figures each stage shows and which events are listed
    X.rflights = (await api("/api/flights")).map((f) => f.id);
    X.rq = { ...(X.rq || { actor: "", text: "", only: false }), flight: S.flight };  // opens on the flight you are working on
    const run = async () => {
      stopPlay();
      try { X.rp = await api(`/api/replay/${encodeURIComponent(X.rq.flight || S.flight)}`); X.rnote = ""; }
      catch (e) { // e.g. a server started before the per-flight replay existed: still replay and verify the whole log
        X.rp = await api("/api/replay"); X.rnote = `Per-flight figures unavailable (${e.message}); restart the server to get them. Showing the whole log.`;
        if (!X.rp.steps.some((s) => "flight" in s)) X.rq.flight = ""; // events carry no flight there: list them all
      }
      // opening on a flight with no logged events (e.g. the default flight): switch to the flight with the latest activity
      const latest = [...X.rp.steps].reverse().find((s) => s.flight)?.flight;
      if (X.ropen && X.rq.flight && latest && latest !== X.rq.flight && !X.rp.steps.some((s) => s.flight === X.rq.flight)) {
        X.ropen = false; X.rq.flight = latest; return run();
      }
      X.ropen = false;
      X.step = X.rp.steps.length - 1; drawReplay();
      if (X.rnote) q("#x-rout").insertAdjacentHTML("afterbegin", `<p class="warn small">${h(X.rnote)}</p>`);
    };
    X.rerun = run; X.ropen = true;
    q("#x-rrun").onclick = (e) => busy(e.target, run);
    run().catch((e) => { toast(e.message, "bad"); q("#x-rout").innerHTML = `<p class="bad">Audit replay failed: ${h(e.message)}</p>`; });
  }

  const stepMatches = (s, i) => {
    const f = X.rq; if (i === 0) return true;
    if (f.flight && s.flight !== f.flight) return false;
    if (f.only && !s.state_change && !stepBad(s)) return false;
    if (f.actor && s.actor !== f.actor) return false;
    return !f.text || `${s.seq} ${s.action} ${s.actor} ${s.ts} ${JSON.stringify(s.detail)}`.toLowerCase().includes(f.text.toLowerCase());
  };
  const navSteps = () => X.rp.steps.map((s, i) => i).filter((i) => stepMatches(X.rp.steps[i], i));

  function drawReplay() {
    const r = X.rp, changes = r.steps.filter((s, i) => i && s.state_change).length, actors = [...new Set(r.steps.slice(1).map((s) => s.actor))].sort();
    q("#x-rout").innerHTML = `<div id="ar-stage"></div>
      <div class="card ar-wrap" tabindex="0" aria-label="Audit timeline. Use the left and right arrow keys to move between events.">
        <div class="ar-ctl"><label class="small">Flight <select id="ar-flight"><option value="">All flights</option>${X.rflights.map((f) =>
            `<option ${f === X.rq.flight ? "selected" : ""}>${h(f)}</option>`).join("")}</select></label>
          <div class="row"><button class="ghost" data-go="-1" aria-label="Previous event">◀</button><button id="ar-play">▶ Play</button>
          <button class="ghost" data-go="1" aria-label="Next event">▶</button></div>
          <label class="small">Actor <select id="ar-actor"><option value="">All</option>${actors.map((a) => `<option ${a === X.rq.actor ? "selected" : ""}>${h(a)}</option>`).join("")}</select></label>
          <input id="ar-q" class="ar-q" placeholder="Search events (flight, action, item…)" value="${h(X.rq.text)}" maxlength="60">
          <label class="small"><input type="checkbox" id="ar-only" ${X.rq.only ? "checked" : ""}> State changes only</label>
          <span class="small muted" id="ar-count"></span>
          <span class="small muted ar-legend"><i class="chg"></i>changed state <i class="log"></i>logged only <i class="bad"></i>mismatch</span></div>
        <div class="ar-scroll"><div class="ar-track rs-cards">${r.steps.map((s, i) => `<button class="ar-node rs-card ${i && stepBad(s) ? "bad" : ""}" style="--c:${rcol(i, s)}"
          data-i="${i}" aria-label="Stage ${i}: ${h(i ? s.action : "seed")}"><span class="rs-cl">STAGE ${i}</span><b>${h(i ? s.action : "SEED")}</b>
          <small>${h(i ? (RSUM[s.action] || (s.state_change ? "Changed state" : "Logged only")) : "Starting data and first hash")}</small>
          <em>${i === 0 ? "○ step 0" : stepBad(s) ? "● mismatch" : s.state_change ? "● changed state" : "○ logged only"}</em></button>`).join("")}</div></div></div>
<div class="card ga-verdict ${r.verified ? "ok" : "bad"}"><div>
        <div class="ga-v-big">${r.verified ? "✔ Verified" : "✘ Mismatch"}</div>
        <div class="small muted">Whole audit log: ${r.events} events · ${changes} changed state · ${r.mismatches} mismatches</div>
        <div class="small muted">Figures on each stage: ${h(r.flight)}${X.rq.flight ? ` · events listed: ${h(X.rq.flight)} only` : " · events listed: all flights"}</div></div>
        <div class="ar-right"><div class="ar-hashes small"><span class="muted">Replayed</span><b class="x-mono">${h(r.replayed_hash)}</b>
          <span class="muted">Live</span><b class="x-mono ${r.replayed_hash === r.live_hash ? "ok" : "bad"}">${h(r.live_hash)}</b></div>
          <button class="ghost" id="ar-export">Export evidence</button></div>
        ${r.verified ? "" : '<p class="bad small ar-warn">The live database differs from what the audit log explains: something changed state outside the audited write path.</p>'}</div>
      <div class="grid2 ar-panes"><div class="card" id="ar-diff"></div><div class="card" id="ar-ev"></div></div>`;
    const refilter = () => { markNodes(); const nav = navSteps(); if (!nav.includes(X.step)) selectStep(nav[nav.length - 1] ?? 0); };
    q("#ar-only").onchange = (e) => { X.rq.only = e.target.checked; refilter(); };
    q("#ar-flight").onchange = (e) => { X.rq.flight = e.target.value; if (X.rq.flight) X.rerun().catch((err) => toast(err.message, "bad")); else refilter(); };
    q("#ar-actor").onchange = (e) => { X.rq.actor = e.target.value; refilter(); };
    q("#ar-q").oninput = (e) => { X.rq.text = e.target.value.trim(); refilter(); };
    q("#ar-export").onclick = () => download(`audit-replay-evidence-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`,
      JSON.stringify({ generated: new Date().toISOString(), verified: r.verified, events: r.events, mismatches: r.mismatches, initial_hash: r.initial_hash,
        replayed_hash: r.replayed_hash, live_hash: r.live_hash, steps: r.steps }, null, 2), "application/json");
    const wrap = q("#x-rout .ar-wrap");
    wrap.onclick = (e) => { const n = e.target.closest("[data-i]"), g = e.target.closest("[data-go]");
      if (n) { stopPlay(); selectStep(+n.dataset.i); } else if (g) { stopPlay(); goStep(+g.dataset.go); } };
    wrap.onkeydown = (e) => { const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (d && !e.target.matches("input, select")) { e.preventDefault(); stopPlay(); goStep(d); } };
    q("#ar-play").onclick = () => (X.play ? stopPlay() : startPlay());
    markNodes(); selectStep(X.step);
  }

  function markNodes() {
    const nav = new Set(navSteps());
    document.querySelectorAll("#x-rout .ar-node").forEach((n) => n.classList.toggle("dim", !nav.has(+n.dataset.i)));
    const c = q("#ar-count"); if (c) c.textContent = `${nav.size - 1} of ${X.rp.steps.length - 1} events${X.rq.flight ? ` (${X.rq.flight})` : ""}`;
  }
  function goStep(d) {
    const nav = navSteps(), after = d > 0 ? nav.find((i) => i > X.step) : [...nav].reverse().find((i) => i < X.step);
    if (after != null) selectStep(after);
    return after != null;
  }
  function startPlay() {
    const nav = navSteps(); if (X.step >= nav[nav.length - 1]) selectStep(nav[0]); // at the end: start over
    q("#ar-play").textContent = "❚❚ Pause";
    X.play = setInterval(() => { if (!q("#ar-play") || !goStep(1)) stopPlay(); }, 3000); // spec: auto-advance about every 3 s so each scene can play
  }
  function stopPlay() { clearInterval(X.play); X.play = null; const b = q("#ar-play"); if (b) b.textContent = "▶ Play"; }

  // Flight-path stage: each event is a stage; the plane orb flies to it, the old scene slides left, the new one slides in
  // in its own colour, and "what happened" lines appear below. Stage cards fill as the replay passes them. Display only.
  const RCOL = ["#3F5D7D", "#B5602B", "#A83F6A", "#6B4FA0", "#187070", "#8F6411"];
  const rcol = (i, s) => (i && stepBad(s) ? "#C03A2B" : RCOL[i % RCOL.length]);
  const RSUM = { REBOOK_COMMIT: "Passengers rebooked", CHANGE_APPROVED: "Plan approved with name and PIN", MAINTENANCE_SIGNED: "NO-GO item signed off",
    TASK_DONE: "Ground task closed", REDTEAM_RUN: "Guard attacks run, state unchanged", ETA_UPDATED: "Delay updated" };
  const rsum = (i, s) => (i === 0 ? "The starting dataset, before any logged event is replayed." : stepBad(s) ? "Hash mismatch: state differs from the log"
    : RSUM[s.action] || (s.state_change ? "State changed" : "Logged only, no operational state changed"));
  function drawStage(i, s, prev, changed, better, fmt) {
    const box = q("#ar-stage"); if (!box) return;
    if (!box.querySelector(".rs")) box.innerHTML = `<div class="rs"><div class="rs-glow"></div><div class="rs-path"></div>
      <div class="rs-orb" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg></div></div>`;
    const rs = box.querySelector(".rs"), c = rcol(i, s), nx = X.rp.steps[i + 1], rows = (prev ? changed : []).slice(0, 4);
    const lines = i === 0 ? RKP.slice(0, 3).map(([k, l]) => `<span class="rs-chip"><b>${fmt(s.kpis[k])}</b> ${l.toLowerCase()}</span>`)
      : rows.map(([k, l]) => `<span class="rs-chip">${l} <s>${fmt(prev.kpis[k])}</s> → <b class="${better(k)}" data-from="${h(prev.kpis[k])}" data-to="${h(s.kpis[k])}">${fmt(s.kpis[k])}</b></span>`);
    lines.push(`<span class="rs-chip ${s.match === false ? "bad" : s.match ? "ok" : ""}">${s.match === true ? "✓ hash matches record" : s.match === false ? "✘ hash mismatch" : i ? "hash carried forward" : "seed hash"} <code>${h(String(s.hash).slice(0, 12))}</code></span>`);
    rs.querySelectorAll(".rs-sc").forEach((o) => { o.classList.add("out"); setTimeout(() => o.remove(), 900); });
    const sc = document.createElement("div"); sc.className = "rs-sc"; sc.style.setProperty("--c", c);
    sc.innerHTML = `<div class="rs-lbl">STAGE ${i}</div><div class="rs-act">${i === 0 ? "SEED" : h(s.action)}</div>
      <div class="rs-desc">${h(rsum(i, s))}${i ? ` <span class="muted">· ${h(s.actor)} · ${h(s.ts)}</span>` : ""}</div><div class="rs-chips">${lines.join("")}</div>
      ${nx ? `<div class="rs-next" style="--n:${rcol(i + 1, nx)}"><i></i><span>STAGE ${i + 1}</span><small>${h(nx.action)}</small></div>` : '<div class="rs-next end"><span>PARKED</span></div>'}`;
    rs.appendChild(sc); rs.style.setProperty("--c", c);
    const orb = rs.querySelector(".rs-orb"); orb.classList.remove("fly"); void orb.offsetWidth; orb.classList.add("fly");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    sc.querySelectorAll("[data-to]").forEach((el) => {
      const a = +el.dataset.from, b = +el.dataset.to; if (!isFinite(a) || !isFinite(b) || el.dataset.from === "" || el.dataset.to === "") return;
      const t0 = performance.now() + 700;
      const tick = (t) => { const p = Math.min(1, Math.max(0, (t - t0) / 500)); el.textContent = Math.round(a + (b - a) * p); if (p < 1 && el.isConnected) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }

  function selectStep(i) {
    const r = X.rp, s = r.steps[i], prev = r.steps[i - 1]; X.step = i;
    document.querySelectorAll("#x-rout .ar-node").forEach((n) => { n.classList.toggle("on", +n.dataset.i === i); n.classList.toggle("done", +n.dataset.i <= i); });
    const node = q("#x-rout .ar-node.on"), sc = q("#x-rout .ar-scroll"); // scroll the timeline only, never the page
    if (node && sc && (node.offsetLeft < sc.scrollLeft || node.offsetLeft > sc.scrollLeft + sc.clientWidth - 30)) sc.scrollLeft = Math.max(0, node.offsetLeft - sc.clientWidth / 2);
    const fmt = (v) => (v == null || v === "" ? "—" : h(v));
    const changed = prev ? RKP.filter(([k]) => prev.kpis[k] !== s.kpis[k]) : [];
    const better = (k) => typeof s.kpis[k] === "number" && typeof prev.kpis[k] === "number" ? (s.kpis[k] < prev.kpis[k] ? "ok" : "bad") : "";
    const recs = s.records || [];
    drawStage(i, s, prev, changed, better, fmt);
    q("#ar-diff").innerHTML = !prev
      ? `<h3>Starting point</h3><p class="small muted">The seed dataset, before any logged event.</p>
        <table><tbody>${RKP.map(([k, l]) => `<tr><td>${l}</td><td class="num"><b>${fmt(s.kpis[k])}</b></td></tr>`).join("")}</tbody></table>`
      : `<h3>What changed at #${s.seq}</h3>${changed.length
        ? `<table class="ar-diff"><tbody>${changed.map(([k, l]) => `<tr><td>${l}</td><td class="num muted">${fmt(prev.kpis[k])}</td><td class="ar-arrow">→</td>
            <td class="num ${better(k)}"><b>${fmt(s.kpis[k])}</b></td></tr>`).join("")}</tbody></table>`
        : `<p class="small muted">${s.state_change ? "None of the headline figures moved." : "Logged only: no operational state changed."}</p>`}
        ${recs.length ? `<div class="ar-rec-h small muted">Records changed · ${s.records_total} field${s.records_total === 1 ? "" : "s"}</div>
          <div class="ar-recs"><table><thead><tr><th>Record</th><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${recs.map((c) =>
            `<tr><td><span class="muted small">${h(c.table)}</span> ${h(c.key)}</td><td>${h(c.field)}</td><td class="muted">${fmt(c.before)}</td><td><b>${fmt(c.after)}</b></td></tr>`).join("")}
            </tbody></table>${s.records_total > recs.length ? `<p class="small muted">+${s.records_total - recs.length} more in the exported evidence</p>` : ""}</div>` : ""}
        <details class="how"><summary>All figures after this step</summary><div><table><tbody>${RKP.map(([k, l]) =>
          `<tr><td>${l}</td><td class="num">${fmt(s.kpis[k])}</td></tr>`).join("")}</tbody></table></div></details>`;
    const det = Object.entries(s.detail || {}), fl = s.detail?.flight;
    q("#ar-ev").innerHTML = `<div class="ar-ev-head"><span class="small muted">Event #${s.seq}</span><div class="ga-d-name">${h(s.action)}</div>
        <div class="small muted">${i === 0 ? "Initial dataset" : `${h(s.actor)} · ${h(s.ts)}`}</div>
        ${fl && /^[A-Z0-9]{2,8}$/.test(fl) ? `<a class="small" href="#/flight/${h(fl)}">Open ${h(fl)} live report and its decisions →</a>` : ""}</div>
      ${det.length ? `<dl class="ga-dl ar-dl">${det.map(([k, v]) => `<dt>${h(k.replace(/_/g, " "))}</dt><dd>${typeof v === "object" ? `<span class="x-mono small">${h(JSON.stringify(v))}</span>` : h(v)}</dd>`).join("")}</dl>` : ""}
      ${s.error ? `<p class="bad small">${h(s.error)}</p>` : ""}
      <div class="ar-hash small"><div><span class="muted">Replayed hash</span><b class="x-mono">${h(s.hash)}</b></div>
        <div><span class="muted">Recorded at commit</span><b class="x-mono">${s.recorded_hash ? h(s.recorded_hash) : "—"}</b></div>
        <div>${s.match === true ? tag("hashes match", "ok") : s.match === false ? tag("hash mismatch", "bad") : `<span class="muted">${i === 0 ? "Baseline" : "No state change: hash carried forward"}</span>`}</div></div>`;
  }

  return { comparison, whatif, paxPanel, attackTab, replayTab, maintenanceTab };
})();
