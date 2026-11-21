// Gates tab: the Gate agent (specialists.py) and a live 3D view of Frankfurt. The 3D airport is logostream's embeddable
// <logostream-airport-3d> element, used as published (https://airline.logostream.dev/airport-3d-map): we only hand it the
// aircraft list. Every aircraft comes from our own schedule (GET /api/gates): arrivals fly the approach, roll out and taxi to
// their real gate, turn around, push back, taxi out and take off. Ground paths follow the real taxiways (fra-ground.json,
// built from the same OpenStreetMap scene, ODbL). A simulated clock runs from now (T+0) at the chosen speed.
const GatesTab = (() => {
  // logostream embed keys are browser keys bound to one site address each (safe in page source). Add one per deployment.
  const EMBED_KEYS = { "localhost:8000": "emb_edc8eece7f5f7f32879fb27280afaa66",
    "techx-marwakhots-projects.vercel.app": "emb_cfeab4b2f7bba2c284f30c6f7fe22da9", "techx-git-main-marwakhots-projects.vercel.app": "emb_cfeab4b2f7bba2c284f30c6f7fe22da9" };
  const EMBED_KEY = EMBED_KEYS[location.host];
  const SCRIPT = "https://airline.logostream.dev/embed/v1/airport-3d.js";
  const AIRLINE = { EK: "UAE", QR: "QTR", AC: "ACA", UA: "UAL", ET: "ETH", AI: "AIC", TK: "THY", SA: "SAA", MS: "MSR", AA: "AAL", LH: "DLH", AZ: "ITY" };
  const TYPE = { B777: "B77W", B788: "B788", A359: "A359", A320: "A320", A380: "A388" };
  const SPEEDS = [1, 5, 20, 60];
  const R = 6371008.8, RAD = Math.PI / 180;
  // motion model (metres, metres per second)
  const APP_M = 5000, GLIDE = Math.tan(3 * RAD), TOUCH_M = 350, EXIT_M = 2100, V_APP = 72, V_EXIT = 15, V_TAXI = 9;
  const ROLL_M = 2200, V_ROT = 80, CLIMB_M = 3000, CLIMB_H = 400, LINEUP_S = 30, PUSH_S = 90;
  const X = { speed: 20, t: 0, paused: false, night: false, list: "arr", sel: null, data: null, ground: null, tracks: new Map(), start: Date.now(), towIn: {} };
  const TOW_FROM = "V106"; // remote parking a borrowing flight is towed from
  const q = (s) => document.querySelector(s);
  const clock = (t) => new Date(X.start + t * 60000).toTimeString().slice(0, 5);
  const T = (m) => `T${m >= 0 ? "+" : ""}${Math.round(m)}`;
  const carrier = (id) => AIRLINE[String(id).replace(/\d.*$/, "")] || "";

  // ---------- page ----------
  async function mount(el) {
    el.innerHTML = `<section class="gt-stage">
        <div class="gt-map" id="gt-map"><div class="gt-load"><span class="x-spin"></span> Loading the 3D map of Frankfurt…</div></div>
        <aside class="gt-side" aria-label="Gates and the Gate agent">
          <div class="gt-ctl"><b class="gt-clock" id="gt-clock">--:--</b><span class="gt-t" id="gt-t">T+0</span>
            <button class="ghost" data-gt="pause">Pause</button>${SPEEDS.map((s) => `<button class="ghost" data-gt-speed="${s}">${s}×</button>`).join("")}
            <button class="ghost" data-gt="night">Night</button><button class="ghost" data-gt="now">Now</button></div>
          <div class="gt-demo"><h4>Live: a delay frees a gate</h4>
            <p class="small muted">Report a real delay on an arrival. Its gate goes idle and the Gate agent re-decides on the spot.</p>
            <div class="gt-demo-row"><select id="gt-demo-f" aria-label="Arrival"></select><select id="gt-demo-m" aria-label="Minutes late">
              <option>45</option><option selected>60</option><option>90</option></select><button data-gt="demo">Report delay</button></div>
            <ol class="gt-feed" id="gt-feed"></ol></div>
          <div class="gt-stats" id="gt-stats"></div>
          <div class="mx-sum gt-sum" id="gt-sum"></div>
          <div id="gt-agent"></div>
          <h4 class="gt-h">Gate agent plan</h4><div id="gt-plan"></div>
          <div class="gt-tabs" role="tablist"><button data-gt-list="arr" role="tab">Arrivals</button><button data-gt-list="dep" role="tab">Departures</button></div>
          <ol class="gt-flights" id="gt-flights"></ol>
          <div class="gt-card" id="gt-card" hidden></div>
        </aside>
        <p class="gt-hint small">Drag to move, right-drag to turn, Ctrl/⌘ + wheel to zoom. Simulated clock from now (T+0) on the console's live data.
          3D map by <a href="https://airline.logostream.dev/airport-3d-map" target="_blank" rel="noopener">logostream</a> · © OpenStreetMap contributors, Overture Maps Foundation (ODbL).</p>
      </section>
      <div class="card gt-boardcard"><h3>Gate board <span class="small muted">· what stands at each gate now and who is due</span></h3><div id="gt-board"></div></div>`;
    X.night = true;
    el.onclick = onClick;
    await Promise.all([load(), ground()]);
    X.tracks.clear();
    mapInit();
    loop();
  }

  async function load() {
    X.data = await api("/api/gates");
    drawAgent(); drawPlan(); drawBoard(); drawSum();
    const sel = q("#gt-demo-f"), cur = sel?.value, kinds = Object.fromEntries(X.data.board.map((g) => [g.gate, g.kind]));
    if (sel && !X.demoBusy) sel.innerHTML = X.data.schedule.filter((f) => f.kind === "TURN" && f.status === "ENROUTE" && kinds[f.gate] === "CONTACT")
      .sort((a, b) => a.delay - b.delay || a.arr - b.arr).map((f) => `<option value="${h(f.id)}" ${f.id === cur ? "selected" : ""}>${h(f.id)} · gate ${h(f.gate)} · lands ${T(f.arr)}${f.delay ? ` (+${f.delay})` : ""}</option>`).join("");
    if (sel && !cur && [...sel.options].some((o) => o.value === "AA70")) { sel.value = "AA70"; q("#gt-demo-m").value = "60"; } // the demo flight (seed.py)
  }
  // ---------- after approval: the camera and clock follow the borrowing flight in, out, and the late aircraft back in ----------
  const phaseOf = (id) => phases(X.t).find((x) => x.f.id === id);
  const until = async (ok, ms = 90000) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < ms && q("#gt-map")) await sleep(250); };
  async function director(p, li) {
    const note = (txt, st = "ok") => { const el = q("#gt-feed"); if (el) el.insertAdjacentHTML("beforeend", `<li class="gt-f-${st}"><i></i><div>${txt}</div></li>`); };
    li?.querySelector("button")?.remove();
    await load(); X.tracks.clear(); X.paused = false;
    const b = X.data.schedule.find((f) => f.id === p.flight_id), late = X.data.schedule.find((f) => f.kind === "TURN" && f.out && f.gate === p.gate && f.id !== p.flight_id);
    if (!b) return;
    const follow = (id) => { const x = phaseOf(id); if (x?.ac?.registration) X.map?.focusOn({ registration: x.ac.registration }); };
    note(`Approved. <b>${h(b.id)}</b> is towed from remote parking ${towFrom(b)} to gate <b>${h(p.gate)}</b>…`, "run");
    X.towIn[b.id] = { start: X.t + 0.05 };
    const tow = track("tow", b, towTrack); X.speed = Math.max(2, (tow?.dur || 200) / 10); // ~10 s on screen
    await sleep(150); follow(b.id);
    await until(() => phaseOf(b.id)?.phase === "parked");
    note(`<b>${h(b.id)}</b> is parked at <b>${h(p.gate)}</b> and boarding.`); X.speed = 1; await sleep(2500);
    note(`Departure: <b>${h(b.id)}</b> pushes back and takes off at ${T(b.dep)}…`, "run");
    X.t = Math.max(X.t, b.dep - 0.2); const dep = track("dep", b, departureTrack); X.speed = (dep?.dur || 400) / 14;
    await sleep(150); follow(b.id);
    await until(() => phaseOf(b.id)?.phase === "gone");
    note(`<b>${h(b.id)}</b> is airborne. Gate <b>${h(p.gate)}</b> is clear again.`);
    if (late) {
      const arr = track("arr", late, arrivalTrack); note(`<b>${h(late.id)}</b> lands ${T(late.arr)} and taxis into its own gate <b>${h(p.gate)}</b>…`, "run");
      X.t = Math.max(X.t, late.arr - (arr?.dur || 560) / 60 + 1.5); X.speed = (arr?.dur || 560) / 15;
      await sleep(150); follow(late.id);
      await until(() => phaseOf(late.id)?.phase === "parked");
      note(`<b>${h(late.id)}</b> is at <b>${h(p.gate)}</b>. The gate did a full turn while ${h(late.id)} was late.`);
    }
    X.speed = 20;
  }
  // ---------- live demo: a real delay goes in, the agent re-decides, each step is shown as it happens ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function feed(steps) {
    q("#gt-feed").innerHTML = steps.map(([st, txt, extra]) => `<li class="gt-f-${st}"><i></i><div>${txt}${extra || ""}</div></li>`).join("");
  }
  async function demo() {
    if (X.demoBusy) return;
    const fid = q("#gt-demo-f").value, min = +q("#gt-demo-m").value, f = X.data.schedule.find((x) => x.id === fid); if (!f) return;
    X.demoBusy = true; const steps = [];
    const push = (st, txt, extra) => { steps.push([st, txt, extra]); feed(steps); };
    const done = (st, txt, extra) => { steps[steps.length - 1] = [st, txt, extra]; feed(steps); };
    try {
      push("run", `Ops feed: <b>${h(fid)}</b> now ${f.delay + min} min late…`);
      await api("/api/ops/eta", { flight_id: fid, delay_min: f.delay + min, source: "Ops feed (Gates demo)", reason: "Late departure from origin" });
      done("ok", `<b>${h(fid)}</b> from ${h(f.origin)} is <b>${f.delay + min} min late</b>: lands ${T(f.arr + min)} instead of ${T(f.arr)}`);
      X.map?.focusOn({ gate: f.gate }); await sleep(1400);
      push("ok", `<b>Gate agent</b> notices the delay: gate <b>${h(f.gate)}</b> will stand <b>empty until ${T(f.arr + min - X.data.buffer_min)}</b>`); await sleep(1600);
      push("run", `<b>Gate agent</b> is looking for a flight that needs a gate and is gone before ${h(fid)} lands…`);
      await load(); X.tracks.clear();
      const p = (X.data.agent?.picks || []).find((x) => x.gate === f.gate && x.late_inbound === fid), k = (X.data.agent?.picks || []).indexOf(p);
      const src = String(X.data.agent?.source || "").startsWith("LLM") ? "decided by the LLM, checked by the guards" : "decided by rules, checked by the guards";
      if (p) {
        done("ok", `<b>Gate agent</b>: lend <b>${h(p.gate)}</b> to <b>${h(p.flight_id)}</b> (leaves ${T(p.leaves)}). ${h(p.reason)} <small>${src}</small>`,
          `<button data-gt-approve="${k}">Approve with PIN…</button>`);
        X.sel = p.flight_id;
      } else {
        const lent = (X.data.board.find((g) => g.gate === f.gate) || {}).state === "lent";
        done("warn", lent ? `<b>Gate agent</b>: ${h(f.gate)} is already lent out from an earlier run. Click <b>Reset demo</b> (top right) to start the day again.`
          : `<b>Gate agent</b>: ${h(f.gate)} is idle until ${T(f.arr + min - X.data.buffer_min)}, but no flight that needs a gate is gone by then (each needs its departure plus 30 min of room for a hold). <small>${src}</small>`);
      }
    } catch (e) { done("bad", h(e.message)); } finally { X.demoBusy = false; }
  }
  async function ground() {
    if (X.ground) return;
    const g = await (await fetch("/fra-ground.json")).json();
    const adj = g.nodes.map(() => []);
    for (const [a, b] of g.edges) { const d = Math.hypot(g.nodes[a][0] - g.nodes[b][0], g.nodes[a][1] - g.nodes[b][1]); adj[a].push([b, d]); adj[b].push([a, d]); }
    const comp = new Int32Array(g.nodes.length).fill(-1); let best = -1, bestN = 0;
    for (let i = 0, c = 0; i < g.nodes.length; i++) { // keep the largest connected taxiway network
      if (comp[i] >= 0) continue; let n = 0; const st = [i]; comp[i] = c;
      while (st.length) { const u = st.pop(); n++; for (const [v] of adj[u]) if (comp[v] < 0) { comp[v] = c; st.push(v); } }
      if (n > bestN) { bestN = n; best = c; } c++;
    }
    X.ground = { ...g, adj, main: g.nodes.map((_, i) => i).filter((i) => comp[i] === best) };
  }

  // ---------- ground paths ----------
  const near = (p) => { const G = X.ground; let bi = G.main[0], bd = Infinity;
    for (const i of G.main) { const d = (G.nodes[i][0] - p[0]) ** 2 + (G.nodes[i][1] - p[1]) ** 2; if (d < bd) { bd = d; bi = i; } } return bi; };
  function route(a, b) { // Dijkstra over the taxiway graph, node a -> node b
    const G = X.ground, dist = new Map([[a, 0]]), prev = new Map(), heap = [[0, a]], done = new Set();
    const push = (x) => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [d, u] = pop(); if (done.has(u)) continue; done.add(u); if (u === b) break;
      for (const [v, w] of G.adj[u]) if (d + w < (dist.get(v) ?? Infinity)) { dist.set(v, d + w); prev.set(v, u); push([d + w, v]); }
    }
    const out = [b]; let u = b; while (u !== a && prev.has(u)) out.push(u = prev.get(u));
    return out.reverse().map((i) => G.nodes[i]);
  }
  const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const along = (p, d, m) => [p[0] + d[0] * m, p[1] + d[1] * m];
  function runway(name, fromEnd) { // threshold + unit direction of travel; fromEnd picks which end the movement starts at
    const [a, b] = X.ground.runways[name], [s, e] = fromEnd === "east" ? (a[0] > b[0] ? [a, b] : [b, a]) : fromEnd === "north" ? (a[1] < b[1] ? [a, b] : [b, a]) : [a, b];
    const L = Math.hypot(e[0] - s[0], e[1] - s[1]); return { thr: s, dir: [(e[0] - s[0]) / L, (e[1] - s[1]) / L] };
  }
  // a segment = polyline + duration; speeds v0 -> v1 (linear), heights h0 -> h1, back = pushback (nose opposite to motion)
  const seg = (pts, v0, v1, h0 = 0, h1 = 0, back = false) => { const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = cum.at(-1) || 0.001; return { pts, cum, len, v0, v1, h0, h1, back, dur: len / ((v0 + v1) / 2) }; };

  function arrivalTrack(f) {
    const stand = X.ground.gates[gateKey(f.gate)]; if (!stand) return null;
    const d2 = (r) => (along(r.thr, r.dir, EXIT_M)[0] - stand[0]) ** 2 + (along(r.thr, r.dir, EXIT_M)[1] - stand[1]) ** 2;
    const rw = [runway("07R/25L", "east"), runway("07C/25C", "east")].sort((a, b) => d2(a) - d2(b))[0]; // westerly flow, runway nearest the gate
    const td = along(rw.thr, rw.dir, TOUCH_M), ex = along(rw.thr, rw.dir, EXIT_M), far = along(rw.thr, rw.dir, -APP_M);
    const taxi = route(near(ex), near(stand));
    return [seg([far, td], V_APP, V_APP, (APP_M + TOUCH_M) * GLIDE, 0), seg([td, ex], V_APP - 8, V_EXIT), seg([ex, ...taxi, [stand[0], stand[1]]], V_TAXI, V_TAXI)];
  }
  function towTrack(f) { // nearest remote stand -> the lent gate, at taxi speed
    const a = X.ground.gates[towFrom(f)], b = X.ground.gates[gateKey(f.gate)]; if (!a || !b) return null;
    return [seg([[a[0], a[1]], ...route(near(a), near(b)), [b[0], b[1]]], V_TAXI, V_TAXI)];
  }
  const towFrom = (f) => { const b = X.ground.gates[gateKey(f.gate)]; if (!b) return TOW_FROM;
    return Object.keys(X.ground.gates).filter((k) => /^V\d/.test(k)).sort((x, y) => { const p = X.ground.gates[x], q2 = X.ground.gates[y];
      return Math.hypot(p[0] - b[0], p[1] - b[1]) - Math.hypot(q2[0] - b[0], q2[1] - b[1]); })[0] || TOW_FROM; };
  function departureTrack(f) {
    const stand = X.ground.gates[gateKey(f.gate)]; if (!stand) return null;
    const rw = [runway("18", "north"), runway("07C/25C", "east"), runway("07R/25L", "east")]
      .sort((a, b) => Math.hypot(a.thr[0] - stand[0], a.thr[1] - stand[1]) - Math.hypot(b.thr[0] - stand[0], b.thr[1] - stand[1]))[0]; // runway start nearest the gate
    const n0 = near(stand), lift = along(rw.thr, rw.dir, ROLL_M), gone = along(rw.thr, rw.dir, ROLL_M + CLIMB_M);
    const push = X.ground.nodes[n0], taxi = route(n0, near(rw.thr));
    const pushSeg = seg([[stand[0], stand[1]], push], 1, 1, 0, 0, true); pushSeg.dur = PUSH_S;
    const hold = seg([rw.thr, along(rw.thr, rw.dir, 0.5)], 0.02, 0.02); hold.dur = LINEUP_S;
    return [pushSeg, seg([...taxi, rw.thr], V_TAXI, V_TAXI), hold, seg([rw.thr, lift], 0.1, V_ROT), seg([lift, gone], V_ROT, V_ROT + 10, 0, CLIMB_H)];
  }
  const dur = (tr) => tr.reduce((a, s) => a + s.dur, 0);
  function at(tr, sec) { // position on a track `sec` seconds after it starts (seg = which segment it is on)
    for (const [seg, s] of tr.entries()) {
      if (sec > s.dur) { sec -= s.dur; continue; }
      const u = s.dur ? sec / s.dur : 1, frac = s.v0 === s.v1 ? u : (s.v0 * u + 0.5 * (s.v1 - s.v0) * u * u) / ((s.v0 + s.v1) / 2);
      const d = Math.min(frac, 1) * s.len; let i = 1; while (i < s.cum.length - 1 && s.cum[i] < d) i++;
      const a = s.pts[i - 1], b = s.pts[i], k = (d - s.cum[i - 1]) / ((s.cum[i] - s.cum[i - 1]) || 1), p = lerp(a, b, Math.max(0, Math.min(1, k)));
      let hd = Math.atan2(b[0] - a[0], -(b[1] - a[1])) / RAD; if (s.back) hd += 180;
      return { p, seg, hd: (hd + 360) % 360, h: s.h0 + (s.h1 - s.h0) * u };
    }
    return null;
  }
  const gateKey = (g) => String(g || "").replace(/\s+/g, "").toUpperCase();
  const ll = (p) => { const o = X.ground.origin; return { lat: o.lat - p[1] / (R * RAD), lon: o.lon + p[0] / (R * RAD * Math.cos(o.lat * RAD)) }; };
  function track(key, f, make) { const k = `${key}:${f.id}:${f.gate}`; if (!X.tracks.has(k)) { const tr = make(f); X.tracks.set(k, tr && { tr, dur: dur(tr) }); } return X.tracks.get(k); }

  // ---------- what every aircraft is doing at sim time t (minutes) ----------
  function phases(t) {
    const out = [], s = t * 60;
    for (const f of X.data?.schedule || []) {
      const reg = f.tail || `D-A${f.id.slice(2)}`, base = { flight: f.id, type: TYPE[f.type] || f.type, airline: carrier(f.kind === "TURN" ? f.out || f.id : f.id), registration: reg };
      if (!f.gate || !X.ground.gates[gateKey(f.gate)]) { out.push({ f, phase: "nogate" }); continue; }
      if (f.kind === "TURN" && f.arr > 0) {
        const a = track("arr", f, arrivalTrack), st = f.arr * 60 - (a?.dur || 0);
        if (s < st) { out.push({ f, phase: "enroute" }); continue; }
        if (a && s < f.arr * 60) { const p = at(a.tr, s - st); out.push({ f, phase: p.seg < 2 ? "landing" : "taxi-in", ac: move(base, p, f.delay > 0 ? "delayed" : "arrived") }); continue; }
      }
      const tow = X.towIn[f.id];
      if (tow) { const k = track("tow", f, towTrack);
        if (s < tow.start * 60) { out.push({ f, phase: "remote", ac: { ...base, gate: towFrom(f) } }); continue; }
        if (k && s < tow.start * 60 + k.dur) { out.push({ f, phase: "taxi-in", ac: move(base, at(k.tr, s - tow.start * 60), "boarding") }); continue; } }
      const dep = f.dep ?? 1e9;
      if (s < dep * 60) {
        const st = dep - t <= 40 ? "boarding" : f.kind === "TURN" && f.arr > 0 && t - f.arr < 8 ? "arrived" : "";
        out.push({ f, phase: "parked", ac: { ...base, gate: f.gate, ...(st ? { status: st } : {}) } }); continue;
      }
      const d = track("dep", f, departureTrack);
      if (d && s < dep * 60 + d.dur) { const p = at(d.tr, s - dep * 60); out.push({ f, phase: ["pushback", "taxi-out", "taxi-out", "take-off", "take-off"][p.seg], ac: move(base, p, "departing") }); continue; }
      out.push({ f, phase: "gone" });
    }
    return out;
  }
  const move = (base, p, status) => ({ ...base, ...ll(p.p), headingDeg: Math.round(p.hd * 10) / 10, heightM: Math.round(p.h), onGround: p.h < 1, status });

  // ---------- 3D map (logostream element, as published) ----------
  async function mapInit() {
    const box = q("#gt-map"); if (!box) return;
    if (!EMBED_KEY) { box.innerHTML = `<p class="gt-err">The 3D map has no embed key for ${h(location.host)} yet (logostream keys are bound to one site address).<br>
      Everything else on this page works. Create a key for this address and add it to EMBED_KEYS in static/gates.js.</p>`; return; }
    try {
      if (!customElements.get("logostream-airport-3d")) {
        if (!document.querySelector(`script[src="${SCRIPT}"]`)) {
          const sc = document.createElement("script"); sc.src = SCRIPT; document.head.append(sc);
          await new Promise((ok, no) => { sc.onload = ok; sc.onerror = () => no(new Error("Could not load the 3D map script")); });
        }
        await customElements.whenDefined("logostream-airport-3d");
      }
    } catch (e) { box.innerHTML = `<p class="bad small gt-err">${h(e.message)}</p>`; return; }
    const m = document.createElement("logostream-airport-3d");
    m.setAttribute("icao", "EDDF"); m.setAttribute("embed-key", EMBED_KEY); m.setAttribute("theme", X.night ? "night" : "clay");
    m.id = "gt-3d";
    m.addEventListener("ready", () => box.querySelector(".gt-load")?.remove());
    m.addEventListener("error", (e) => { const c = e.detail?.code; box.querySelector(".gt-load")?.remove();
      if (c === "unauthorized") toast("3D map: the embed key only works on http://localhost:8000. Open the console there.", "bad"); });
    m.addEventListener("warnings", (e) => console.warn("3D map warnings", e.detail));
    m.addEventListener("aircraft-click", (e) => e.detail && select(e.detail.aircraft.flight));
    box.append(m);
    X.map = m;
  }

  function loop() {
    clearInterval(X.timer); let last = performance.now(), n = 0;
    X.timer = setInterval(() => {
      if (!q("#gt-map")) { clearInterval(X.timer); return; } // left the tab
      const now = performance.now(), dt = (now - last) / 1000; last = now;
      if (!X.paused) X.t += (dt * X.speed) / 60;
      const ph = phases(X.t);
      if (X.map) X.map.aircraft = ph.filter((x) => x.ac).map((x) => x.ac);
      if (++n % 5 === 1) drawLive(ph);
      if (n % 100 === 0) load().catch(() => {}); // pick up approved moves and new delays (~every 10 s)
    }, 100);
  }

  // ---------- side panel ----------
  const phaseTxt = { enroute: "En route", remote: "Remote parking", landing: "On approach", "taxi-in": "Taxiing in", parked: "At gate", pushback: "Pushing back", "taxi-out": "Taxiing out", "take-off": "Taking off", gone: "Departed", nogate: "No gate yet" };
  function drawLive(ph) {
    if (!q("#gt-clock")) return;
    q("#gt-clock").textContent = clock(X.t); q("#gt-t").textContent = T(X.t);
    document.querySelectorAll("[data-gt-speed]").forEach((b) => b.classList.toggle("on", +b.dataset.gtSpeed === X.speed));
    q('[data-gt="pause"]').textContent = X.paused ? "Play" : "Pause";
    q('[data-gt="night"]').classList.toggle("on", X.night);
    document.querySelectorAll("[data-gt-list]").forEach((b) => b.setAttribute("aria-selected", b.dataset.gtList === X.list));
    const onSite = ph.filter((x) => x.ac && x.ac.onGround !== false).length;
    const placed = ph.filter((x) => x.phase !== "nogate").map((x) => x.f); // only flights the map can show (they have a gate)
    const arrived = placed.filter((f) => f.kind === "TURN" && f.arr > X.t - 60 && f.arr <= X.t).length;
    const left = placed.filter((f) => f.dep != null && f.dep > X.t - 60 && f.dep <= X.t).length;
    q("#gt-stats").innerHTML = `<div><b>${onSite}</b><span>Aircraft on site</span></div><div><b>${arrived}</b><span>Arrivals, last hour · reached their gate</span></div>
      <div><b>${left}</b><span>Departures, last hour · left their gate</span></div>`;
    const rows = X.list === "arr"
      ? ph.filter((x) => x.f.kind === "TURN").sort((a, b) => a.f.arr - b.f.arr).map((x) => [x, x.f.id, `${x.f.origin} → FRA`, x.f.arr, x.f.delay])
      : ph.filter((x) => x.f.dep != null).sort((a, b) => a.f.dep - b.f.dep).map((x) => [x, x.f.kind === "TURN" ? x.f.out : x.f.id, `FRA → ${x.f.dest}`, x.f.dep, x.f.kind === "TURN" ? Math.max(0, x.f.dep - x.f.sched_dep) : x.f.delay]);
    q("#gt-flights").innerHTML = rows.map(([x, id, rt, when, late]) => `<li><button data-gt-fly="${h(x.f.id)}" class="${X.sel === x.f.id ? "on" : ""} gt-${x.phase}">
      <b>${h(id)}</b><span class="gt-rt">${h(rt)}</span><span class="gt-when">${clock(when)}${late > 0 ? ` <em>+${late}</em>` : ""}</span>
      <span class="gt-ph">${h(phaseTxt[x.phase])}${x.f.gate ? ` · ${h(x.f.gate)}` : ""}</span></button></li>`).join("");
    if (X.sel) drawCard(ph.find((x) => x.f.id === X.sel));
  }
  function drawCard(x) {
    const c = q("#gt-card"); if (!c) return;
    if (!x) { c.hidden = true; return; }
    const f = x.f, pick = (X.data.agent?.picks || []).find((p) => p.flight_id === (f.kind === "TURN" ? f.out : f.id) || p.late_inbound === f.id);
    c.hidden = false;
    c.innerHTML = `<button class="gt-x" data-gt="close" aria-label="Close">×</button><b>${h(f.kind === "TURN" ? `${f.id} / ${f.out}` : f.id)}</b>
      <span class="small muted">${h(f.kind === "TURN" ? `${f.origin} → FRA → ${f.dest}` : `FRA → ${f.dest}`)} · ${h(f.type)}${f.tail ? ` · ${h(f.tail)}` : ""}</span>
      <dl>${f.kind === "TURN" ? `<dt>On block</dt><dd>${clock(f.arr)} (${T(f.arr)})${f.delay ? ` · <span class="bad">${f.delay} min late</span>` : ""}</dd>` : ""}
        <dt>Off block</dt><dd>${f.dep != null ? `${clock(f.dep)} (${T(f.dep)})` : "—"}</dd><dt>Gate</dt><dd>${h(f.gate || "none yet")}</dd><dt>Now</dt><dd>${h(phaseTxt[x.phase])}</dd></dl>
      ${pick ? `<p class="small"><b>Gate agent:</b> ${h(pick.gate)} → ${h(pick.flight_id)}. ${h(pick.reason)}</p>` : ""}
      <a href="#/flight/${h(f.kind === "TURN" ? f.id : "")}" ${f.kind === "TURN" ? "" : "hidden"}>Open live report →</a>`;
  }
  function select(id) {
    X.sel = id; const x = phases(X.t).find((y) => y.f.id === id); drawCard(x);
    if (X.map && x) X.map.focusOn(x.ac ? { registration: x.ac.registration } : { gate: x.f.gate || "" });
  }

  // ---------- agent, plan, board ----------
  function drawSum() {
    const b = X.data.board, n = (s) => b.filter((g) => g.state === s).length;
    q("#gt-sum").innerHTML = `<div><b class="${n("idle") ? "warn" : ""}">${n("idle")}</b><span>idle behind a delay</span></div>
      <div><b>${n("lent")}</b><span>lent out</span></div>
      <div><b class="${b.some((g) => g.kind === "REMOTE" && g.now) ? "bad" : "ok"}">${b.filter((g) => g.kind === "REMOTE" && g.now).length}</b><span>on a remote stand</span></div>
      <div><b>${b.filter((g) => g.kind === "CONTACT" && g.state === "free").length}</b><span>contact gates free</span></div>`;
  }
  function drawAgent() {
    const a = X.data.agent;
    q("#gt-agent").innerHTML = AgentPanel.html("gates", a && { ...a, picks: undefined }, (a?.picks || []).map((p) => ({
      who: `${p.flight_id} (${p.need === "remote stand" ? `on remote stand ${p.from}` : "no gate"}, leaves ${T(p.leaves)})`,
      what: p.type === "lend" ? `${p.gate}, lent by ${p.holder}` : `${p.gate} (free contact gate)`, why: p.reason, by: p.by })), 0,
      "No delayed arrival leaves a gate that another flight can use.");
  }
  function drawPlan() {
    const picks = X.data.agent?.picks || [];
    q("#gt-plan").innerHTML = picks.length ? `<ul class="gt-plan">${picks.map((p, i) => `<li><div><b>${h(p.gate)} → ${h(p.flight_id)}</b>
        ${tag(p.type === "lend" ? `lent while ${p.late_inbound} is late` : "free contact gate", p.type === "lend" ? "warn" : "ok")}
        <p class="small">${h(p.reason)}</p><span class="small muted">Decision goes on ${h(p.owner)}'s record · ${h(p.by === "LLM" ? "picked by the LLM" : "picked by rules")}</span></div>
        <button data-gt-approve="${i}">Approve…</button></li>`).join("")}</ul>`
      : `<p class="muted small">Nothing to move right now.</p>`;
  }
  function drawBoard() {
    const S = { free: ["free", "ok"], idle: ["idle · its aircraft is late", "warn"], lent: ["lent", "warn"], due: ["aircraft inbound", ""], occupied: ["occupied", ""], closed: ["closed", "bad"] };
    q("#gt-board").innerHTML = `<table><thead><tr><th>Gate</th><th>Type</th><th>State</th><th>At the gate now</th><th>Then</th></tr></thead><tbody>${X.data.board.map((g) => {
      const [label, cls] = S[g.state] || [g.state, ""];
      const now = g.now ? `<b>${h(g.now)}</b>${g.leaves != null ? ` <span class="muted small">leaves ${T(g.leaves)}</span>` : ""}${g.aircraft_in && g.state !== "lent"
        ? ` <span class="small ${g.aircraft_in.delay ? "warn" : "muted"}">· aircraft ${h(g.aircraft_in.id)} ${g.aircraft_in.status === "ENROUTE" ? `lands ${T(g.aircraft_in.arr)}${g.aircraft_in.delay ? ` (+${g.aircraft_in.delay})` : ""}` : "on block"}</span>` : ""}` : '<span class="muted">—</span>';
      return `<tr class="click" data-gt-gate="${h(g.gate)}"><td><b>${h(g.gate)}</b></td><td>${h(g.kind.toLowerCase())}</td><td>${tag(label, cls)}</td><td>${now}</td>
        <td>${g.then.map((x) => `${h(x.id)} <span class="small muted">${x.arr != null ? `lands ${T(x.arr)}` : ""}</span>`).join("<br>") || '<span class="muted">—</span>'}</td></tr>`; }).join("")}</tbody></table>`;
  }

  function onClick(e) {
    const t = e.target.closest("button, tr[data-gt-gate]"); if (!t) return;
    const d = t.dataset;
    if (d.gtSpeed) X.speed = +d.gtSpeed;
    else if (d.gt === "pause") X.paused = !X.paused;
    else if (d.gt === "now") X.t = 0;
    else if (d.gt === "demo") { demo(); return; }
    else if (d.gt === "night") { X.night = !X.night; X.map?.setAttribute("theme", X.night ? "night" : "clay"); }
    else if (d.gt === "close") { X.sel = null; drawCard(null); }
    else if (d.gtList) X.list = d.gtList;
    else if (d.gtFly) select(d.gtFly);
    else if (d.gtGate) { X.map?.focusOn({ gate: d.gtGate }); q("#gt-map").scrollIntoView({ behavior: "smooth", block: "center" }); }
    else if (d.gtApprove) {
      const p = X.data.agent.picks[+d.gtApprove];
      decide(p.owner, `Gate agent: ${p.gate} → ${p.flight_id}`, [{ kind: p.type === "lend" ? "GATE_LOAN" : "GATE_CHANGE", flight_id: p.flight_id, gate: p.gate }],
        (r) => { if (r?.status === "APPROVED") { X.tracks.clear(); if (p.type === "lend") director(p, t.closest(".gt-feed li")); else load();
        } });
    }
    drawLive(phases(X.t));
  }
  return { mount };
})();
