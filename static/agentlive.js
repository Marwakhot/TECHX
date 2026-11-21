// Live agent activity on a flight's live report. Saving a call starts the agents at once (monitor.call_logged); this strip
// follows the agent event log step by step (GET /api/agent/live/<flight>/<since>): the call is read for a new delay, the
// monitor detects the change, the Crew, Passenger, Maintenance and Gate agents re-check their areas, the orchestrator rebuilds the
// report and the 3 scenarios. Read-only: nothing here changes data. When the run ends, the page reloads the report.
const AgentLive = (() => {
  const L = { fid: null, events: [], closed: true };
  const STEPS = [["call", "Call read"], ["detect", "Monitor"], ["crew", "Crew agent"], ["pax", "Passenger agent"], ["mx", "Maintenance agent"],
    ["gate", "Gate agent"], ["orch", "Orchestrator"]];
  const KIND = { CREW_AGENT: "crew", PAX_AGENT: "pax", MX_AGENT: "mx", GATE_AGENT: "gate" }, AGENT = { crew: "crew", pax: "passengers", mx: "maintenance", gate: "gates" };
  const name = (k) => STEPS.find((s) => s[0] === k)[1];
  const unprefix = (txt, k) => String(txt || "").replace(new RegExp(`^${name(k)}:\\s*`), "");
  const clock = (ts) => String(ts || "").slice(11, 19);

  function start(fid, r, onDone, info) {
    clearTimeout(L.timer);
    Object.assign(L, { fid, since: r.since, run: r.run, events: [], status: "running", t0: Date.now(), elapsed: null, error: null,
      onDone, info: info || {}, closed: false });
    draw(); poll();
  }
  async function poll() {
    const fid = L.fid, run = L.run;
    try {
      const r = await api(`/api/agent/live/${fid}/${L.since}`);
      if (L.fid !== fid || L.run !== run) return; // a newer call took over
      L.events = r.events;
      if (r.run === run && r.status === "done") Object.assign(L, { status: "done", error: r.error, elapsed: r.elapsed_s });
    } catch { /* network blip: keep polling */ }
    if (L.status === "running" && Date.now() - L.t0 > 240000) Object.assign(L, { status: "done", error: "Timed out waiting for the agents" });
    draw();
    if (L.status === "running") L.timer = setTimeout(poll, 700);
    else { refreshBell(); L.onDone?.(L); }
  }

  // [state, text, note] per step. States: wait, run, ok, skip, warn, bad.
  function steps() {
    const ev = L.events, last = (k) => ev.filter((e) => e.kind === k).at(-1), done = L.status === "done";
    const delay = last("DELAY_FROM_CALL"), rej = last("DELAY_REJECTED"), llm = last("LLM_UNAVAILABLE");
    const replanning = last("REPLANNING"), replanned = last("REPLANNED"), change = last("CHANGE"), err = last("ERROR"), orch = last("ORCHESTRATOR");
    const s = {};
    s.call = delay ? ["ok", delay.summary, delay.detail?.read_by === "rules" ? "read by simple rules (LLM unreachable)" : "read by the LLM, number checked by code", delay.ts]
      : rej ? ["warn", rej.summary, "", rej.ts]
      : replanning || replanned || change || done ? ["skip", L.info.enroute ? "No new arrival delay stated on this call"
        : `${L.fid} is already on block: its arrival delay can no longer change`, llm ? "LLM unreachable" : ""]
      : ["run", "Reading the call for a new arrival estimate…"];
    s.detect = replanning ? ["ok", replanning.summary.replace(/\s*Crew, Passenger(,| and) Maintenance.*agents.*$/, "") || "New call on the system", "", replanning.ts]
      : change ? ["ok", change.summary, "", change.ts]
      : done ? ["skip", "Nothing changed that needs a re-plan"]
      : s.call[0] === "run" ? ["wait", "Compares the flight with its last snapshot"] : ["run", "Comparing the flight with its last snapshot…"];
    for (const k of ["crew", "pax", "mx", "gate"]) {
      const e = replanning && ev.filter((x) => KIND[x.kind] === k && x.id > replanning.id).at(-1);
      const src = String(e?.detail?.source || "");
      s[k] = e ? ["ok", unprefix(e.summary, k), `re-decided · ${src.startsWith("LLM") ? "LLM" : src.includes("nothing to decide") ? "nothing to choose" : "rules"}`, e.ts]
        : replanned ? ["ok", unprefix(replanned.detail?.agents?.[AGENT[k]]?.summary, k), "nothing changed in its area · plan kept", replanned.ts]
        : replanning ? ["run", "Re-checking its area…"]
        : done ? ["skip", "Not needed"] : ["wait", "Starts when the monitor re-plans"];
    }
    s.orch = replanned ? ["ok", (replanned.summary.split("Re-planned: ")[1] || replanned.summary), "report and 3 scenarios rebuilt", replanned.ts]
      : err ? ["bad", err.summary, "", err.ts]
      : orch && orch.id > (replanning?.id || 0) ? ["run", "Combining the four proposals into the report and 3 scenarios…"]
      : done ? ["skip", "Not needed"] : ["wait", "Waits for the four agents"];
    return s;
  }

  function draw() {
    const el = L.el;
    if (!el?.isConnected) return;
    if (L.closed || el.dataset.fid !== L.fid) { el.innerHTML = ""; return; }
    const s = steps(), running = L.status === "running", replanned = L.events.some((e) => e.kind === "REPLANNED");
    const secs = running ? ((Date.now() - L.t0) / 1000).toFixed(0) : L.elapsed ?? ((Date.now() - L.t0) / 1000).toFixed(0);
    el.innerHTML = `<section class="al ${running ? "on" : ""}" aria-live="polite" aria-label="Agents responding to the call">
      <div class="al-h"><span class="al-dot"></span><b>${running ? "Agents responding" : "Agents responded"}</b><span class="al-f">${h(L.fid)}</span>
        <span class="al-t">${h(secs)} s</span><button class="al-x" data-al-close="1" aria-label="Close">×</button></div>
      ${L.info.text ? `<p class="al-q">“${h(L.info.text.length > 160 ? L.info.text.slice(0, 157) + "…" : L.info.text)}” <span>· ${h(L.info.speaker || "OCC call")}</span></p>` : ""}
      <ol class="al-steps">${STEPS.map(([k, label]) => { const [st, txt, note, ts] = s[k];
        return `<li class="al-s al-${st}"><i aria-hidden="true"></i><div><b>${h(label)}</b><span>${h(shortIds(txt || ""))}</span>${note ? `<small>${h(note)}</small>` : ""}</div>
          <time>${h(clock(ts))}</time></li>`; }).join("")}</ol>
      ${running ? "" : `<div class="al-foot ${L.error ? "bad" : ""}">${L.error ? `Stopped: ${h(L.error)}`
        : replanned ? `Done in ${h(secs)} s · the report, stats and scenarios below are refreshed. <a href="#/lab/${h(L.fid)}">Open Decision hub →</a>`
        : `Done in ${h(secs)} s · no re-plan was needed.`}</div>`}</section>`;
    el.querySelector("[data-al-close]").onclick = () => { L.closed = true; draw(); };
    if (running) { clearTimeout(L.tick); L.tick = setTimeout(draw, 1000); } // keep the clock moving between polls
  }

  // The live report calls this on every render; the strip survives the page re-rendering itself.
  function mount(el, fid) { L.el = el; el.dataset.fid = fid; draw(); }
  return { start, mount };
})();

// "What the agent did" section on the Crew, Connecting passengers, Maintenance and Gates pages: the page's specialist agent
// (specialists.py), how it decided, what triggered its last run, every pick with its reason, and its recent runs.
// Read-only. Collapsible; the open/closed choice is remembered per page while the console is open.
const AgentPanel = (() => {
  const open = {};
  document.addEventListener("toggle", (e) => { const k = e.target.dataset?.alPanel; if (k) open[k] = e.target.open; }, true);
  const how = (src) => { src = String(src || "");
    return src.startsWith("LLM") ? ["LLM", "decided by the LLM from guard-approved options"] : src.includes("nothing to decide") ? ["nothing to choose", "nothing to choose between"]
      : src.startsWith("unavailable") ? ["unavailable", src] : ["rules", "decided by rules (LLM unavailable or its picks not usable)"]; };
  const t = (ts) => String(ts || "").slice(11, 16);
  const trig = (x) => x ? `triggered by ${x.flight_id ? `${h(x.flight_id)}: ` : ""}${h(x.changes.join(", "))}` : "run on request (a page or the live report needed it)";

  // a = the agent's data; decisions = [{who, what, why, by, tone}] built by the page; more = how many decisions are not listed
  function html(key, a, decisions, more = 0, emptyText = "No action needed.") {
    if (!a) return "";
    const [label, long] = a.delayed === false ? ["on time", "flight on time: the agents only recommend for delayed flights"] : how(a.source);
    const g = a.guard, last = (a.recent || [])[0];
    return `<details class="al-panel" data-al-panel="${key}" ${open[key] === false ? "" : "open"}>
      <summary><span class="al-dot"></span><b>${h(a.name)}</b><span class="al-tag" title="${h(long)}">${h(label)}</span>
        ${a.generated ? `<span class="al-when">decided ${h(t(a.generated))}</span>` : ""}
        ${g && decisions.length ? `<span class="al-tag ${g.ok ? "g" : "r"}" title="${h(g.reason || "dry run in a rolled-back transaction")}">${g.ok ? "✓ passes the guards" : "✕ refused by the guards"}</span>` : ""}
        <span class="al-chev" aria-hidden="true"></span></summary>
      <p class="al-lead">${h(shortIds(a.summary || ""))}</p>
      ${last ? `<p class="al-trig"><span>Last run ${h(t(last.ts))}</span> ${trig(last.trigger)}</p>` : ""}
      <div class="al-cols">
        <div><h4>What it decided</h4>${decisions.length ? `<ul class="al-dec">${decisions.map((x) => `<li class="${x.tone || ""}"><div><b>${h(x.who)}</b>${x.what ? ` <span>→ ${h(x.what)}</span>` : ""}</div>
            ${x.why ? `<p>${h(x.why)}</p>` : ""}${x.by ? `<em>${h(x.by)}</em>` : ""}</li>`).join("")}</ul>${more > 0 ? `<p class="al-more">+ ${more} more in the list below</p>` : ""}`
          : `<p class="al-none">${h(a.delayed === false ? "Nothing: the flight is on time." : emptyText)}</p>`}
          ${(a.findings || []).length ? `<ul class="al-find">${a.findings.map((f) => `<li>${h(shortIds(f))}</li>`).join("")}</ul>` : ""}</div>
        <div><h4>Recent runs</h4>${(a.recent || []).length ? `<ol class="al-rec">${a.recent.map((r) => `<li><time>${h(t(r.ts))}</time><div>${h(shortIds(r.summary))}
            <small>${h(how(r.source)[0])} · ${trig(r.trigger)}</small></div></li>`).join("")}</ol>` : '<p class="al-none">No runs logged yet.</p>'}</div>
      </div>
      <p class="al-note">The agent only proposes. Every action needs the Operations Controller's approval (PIN).</p></details>`;
  }
  return { html };
})();
