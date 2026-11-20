// Aviant OCC front end: hash router, no build step. All server text is escaped with h().
const $ = (s) => document.querySelector(s);
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sign = (n) => (n >= 0 ? "+" : "") + n;
const HUB = [50.03, 8.57];
// warm palette: soft sand for on time, then muted orange deepening to rust with delay
const BANDS = [["On time", 0, 0, "#e9dfd1"], ["1–15 min", 1, 15, "#edd2ad"], ["16–30 min", 16, 30, "#e3a877"],
  ["31–60 min", 31, 60, "#d27e4a"], ["60+ min", 61, 1e9, "#9e3a24"]];
const ON_TIME = "#312726"; // on-time routes / planes on the cream flight map: deep brown
const PRIO = [["connections", "Maximise connections"], ["on_time", "Minimise network delay"], ["cost", "Minimise EU261 cost"], ["crew_rest", "Crew rest margin"]];
const S = { tab: "map", filters: new Set(BANDS.map((b) => b[0])), flight: "EK812", auth: { controller: "", pin: "" },
  prio: { connections: true, on_time: false, cost: false, crew_rest: false }, chaos: false };
let globe, rec;

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const band = (d) => BANDS.find((b) => d >= b[1] && d <= b[2]);
const delayChip = (d) => `<span class="tag" style="background:${band(d)[3]};color:${d > 60 ? "#fff8ed" : "#312726"};border-color:transparent">${d ? "+" + d + " min" : "on time"}</span>`;
const tag = (t, cls = "") => `<span class="tag ${cls}">${h(t)}</span>`;
const statusTag = (s) => tag(s, { APPROVED: "ok", PENDING: "warn", REJECTED: "warn" }[s] || "bad");
const tierTag = (t) => tag(t, t === "STANDARD" ? "" : "warn");
const ACT = { DELAY: (a) => `Delay ${a.flight_id} +${a.minutes} min`, GATE_CHANGE: (a) => `${a.flight_id} → gate ${a.gate}`,
  CREW_SWAP: (a) => `${a.crew_id} → ${a.standby_id}`, CREW_AUTOSWAP: (a) => `Swap every illegal crew member (${a.flight_id})`,
  REBOOK: (a) => `${a.pax_id} → ${a.to_flight}`, REBOOK_AT_RISK: (a) => `Rebook all at-risk pax of ${a.flight_id}, vulnerable first`,
  REBOOK_TIERS: (a) => `Rebook only ${(a.tiers || []).join(", ")} of ${a.flight_id}`,
  ASSIGN_ENGINEER: (a) => `${a.engineer_id} → ${a.item_id}`, DEPARTURE_RELEASE: (a) => `Release ${a.flight_id} for departure` };
const actionsText = (acts) => acts.length ? acts.map((a) => h((ACT[a.kind] || (() => a.kind))(a))).join("<br>") : '<span class="muted">No actions</span>';
const notifList = (ns) => `<ul class="feed small">${ns.map((n) => `<li><b>${h(n.recipient)}</b>: ${h(n.message)} <span class="muted">${h(n.ts)}</span></li>`).join("") || '<li class="muted">No notifications yet</li>'}</ul>`;

function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = shortIds(msg); t.className = kind; t.hidden = false;
  clearTimeout(t.timer); t.timer = setTimeout(() => (t.hidden = true), 8000);
}
function resultToast(r) {
  const i = r.integrity ? ` · integrity: ${r.integrity.double_bookings} double bookings, ${r.integrity.orphan_bags} orphaned bags` : "";
  if (r.status === "APPROVED") toast(`Decision #${r.id} applied · ${r.notified} personnel notified${i}`);
  else if (r.status === "ROLLED_BACK") toast(`Decision #${r.id} rolled back atomically: ${r.reason}${i}`, "bad");
  else if (r.status === "BLOCKED") toast(`Blocked by guards: ${r.reason}`, "bad");
  else toast(`Decision #${r.id}: ${r.status}`, "warn");
}

function modal(title, fields, onOk, onCancel) {
  const m = $("#modal");
  m.innerHTML = `<div class="box"><h3>${title}</h3>${fields.map(([id, label, type, val]) =>
    `<label>${h(label)}<input id="m_${id}" type="${type}" value="${h(val)}" maxlength="40" autocomplete="off"></label>`).join("")}
    <div class="row"><button id="mok">Confirm</button><button id="mno" class="ghost">Cancel</button></div></div>`;
  m.hidden = false;
  $("#mno").onclick = () => { m.hidden = true; onCancel?.(); };
  $("#mok").onclick = async () => {
    const v = Object.fromEntries(fields.map(([id]) => [id, $("#m_" + id).value]));
    $("#mok").disabled = true;
    try { await onOk(v); m.hidden = true; } catch (e) { toast(e.message, "bad"); $("#mok").disabled = false; }
  };
}
const askAuth = (title, onOk, onCancel) => modal(title, [["controller", "Operations Controller name", "text", S.auth.controller],
  ["pin", "Controller PIN", "password", S.auth.pin]], async (v) => { S.auth = v; await onOk(v); }, onCancel);

// the page a decision is taken on, kept with the controller's name so the Decision log shows where each decision came from
const ORIGIN = { hub: "Decision hub", crew: "Crew page", pax: "Passengers page", mx: "Maintenance page", log: "Decision log" };
const originNow = () => (location.hash.startsWith("#/flight/") ? "Live report" : ORIGIN[S.tab] || "Console");
function decide(fid, title, actions, after, chaos = false) {
  const origin = originNow();
  askAuth(`Controller approval: ${h(title)}<div class="small muted" style="margin-top:6px">${actionsText(actions)}</div>` +
    (chaos ? '<p class="bad small">Chaos on: a competing booking grabs a seat mid-batch</p>' : ""),
  async (a) => { const r = await api("/api/decide", { flight_id: fid, title, actions, chaos, origin, ...a }); resultToast(r); after(r); refreshBell(); },
  () => after(null));
}

// ---------- main page (sections are chosen from the sidebar menu) ----------
// Operations = the controller's daily workflow; Assurance = safety / compliance tools that prove the system can be trusted
const SECTIONS = [["map", "Live overview", "Operations"], ["crew", "Crew", "Operations"], ["pax", "Connecting passengers", "Operations"],
  ["mx", "Maintenance", "Operations"], ["hub", "Decision hub", "Operations"], ["log", "Decision log", "Operations"], ["attack", "Guard Attack Mode", "Assurance"], ["replay", "Audit replay", "Assurance"]];
async function mainView() {
  $("#view").innerHTML = `<section id="tab"></section><section id="cb-slot"></section>`; // cb-slot: U-4 curveball panels (curveballs.js)
  await { map: mapTab, crew: crewTab, pax: paxTab, mx: mxTab, hub: () => labView(S.flight), log: logTab, attack: () => Extras.attackTab($("#tab")), replay: () => Extras.replayTab($("#tab")) }[S.tab]();
  const t = $("#tab")?.querySelector("h1, h2, h3"); if (t) { t.classList.add("tab-title"); t.parentElement.classList.add("tab-head"); }
  await Curveballs.mount(S.tab, $("#cb-slot")).catch((e) => toast(e.message, "bad"));
}

// live overview cards either side of the globe
const sideList = (fs, empty) => fs.map((f) => `<a class="live-row" href="#/flight/${h(f.id)}"><span><b>${h(f.id)}</b> ${h(f.origin)}→FRA</span>${delayChip(f.delay_min)}
  <span class="small muted">${[f.at_risk && `${f.at_risk} connections at risk`, f.crew_illegal && `${f.crew_illegal} crew over limit`, f.open_nogo && "NO-GO maintenance open",
    f.turn_gap > 0 && `turnaround +${f.turn_gap} min`].filter(Boolean).map(h).join(" · ") || "No issues"}</span></a>`).join("") || `<p class="small muted">${empty}</p>`;

async function mapTab() {
  const flights = await api("/api/flights");
  const late = flights.filter((f) => f.delay_min).sort((a, b) => b.delay_min - a.delay_min), onTime = flights.filter((f) => !f.delay_min);
  const action = late.filter((f) => f.at_risk || f.crew_illegal || f.open_nogo);
  $("#tab").innerHTML = `<div class="globe-zone"><div class="globe-stage">
      <div class="brand"><h2 class="brand-name" aria-label="Aviant">${[..."Aviant"].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}</h2>
        <p class="brand-sub">Turnaround and disruption recovery · FRA hub</p></div>
      <aside class="live-side" style="grid-column:1"><div class="live-head"><span class="live-dot"></span>Delayed · take action</div>
        <div class="live-big">${late.length}<span> of ${flights.length} inbound delayed</span></div>
        <p class="small live-note">${action.length} need a decision now</p>${sideList(late, "No delays right now")}</aside>
      <div class="globe-disc"><div id="globe"></div></div>
      <aside class="live-side" style="grid-column:3"><div class="live-head"><span class="live-dot ok"></span>On schedule</div>
        <div class="live-big">${onTime.length}<span> on time</span></div>
        <p class="small live-note">${flights.reduce((n, f) => n + f.at_risk, 0)} connections at risk network-wide</p>${sideList(onTime, "No flights on time")}
        <p class="small live-note">Drag the globe to spin it. Click any flight for its live report.</p></aside>
    </div></div>
    <div class="card fmap"><div class="fmap-head"><h3>Inbound traffic · live</h3>
      <div class="fmap-legend"><span><i style="background:${ON_TIME}"></i>On time</span><span><i style="background:${BANDS[2][3]}"></i>Delayed</span>
      <span><i style="background:${BANDS[4][3]}"></i>60+ min</span></div></div><div id="fmap"></div>
      <p class="fmap-note">Hover a plane for its flight number · click it for the live report</p></div>
    <div class="card filters"><h3>All inbound flights</h3><div class="row">${BANDS.map((b) =>
    `<label><input type="checkbox" value="${b[0]}" ${S.filters.has(b[0]) ? "checked" : ""}><i style="background:${b[3]}"></i>${b[0]}
     <span class="muted">(${flights.filter((f) => band(f.delay_min) === b).length})</span></label>`).join("")}</div><table id="ftable"></table></div>`;
  const el = $("#globe"), ROUTE = "#fff8ed"; // on-time routes in cream so they read clearly over the dark-brown globe
  globe?._destructor();
  // earth globe: deep-brown ocean and warm beige land from a painted texture (see earthTexture below)
  globe = new Globe(el).showAtmosphere(true).atmosphereColor("#c9a27e").atmosphereAltitude(0.12).backgroundColor("rgba(0,0,0,0)")
    .width(el.offsetWidth).height(el.offsetHeight)
    .arcColor("color").arcStroke(1.1).arcDashLength(0.6).arcDashGap(0.2).arcDashAnimateTime(8000).arcsTransitionDuration(0)
    .pointColor(() => "#fff8ed").pointAltitude(0.006).pointRadius(0.45).pointResolution(8).pointsTransitionDuration(0)
    .particleLat("lat").particleLng("lng").particleAltitude(0.004).particlesColor(() => "#ffffff")
    .particlesSize(2).particlesSizeAttenuation(false); // CSS px; three.js scales it by the pixel ratio below
  const mat = globe.globeMaterial();
  mat.color.set("#ffffff");  /* white: show the earth texture in its true colours */ mat.shininess = 6; mat.needsUpdate = true; // soft, mostly matte
  // the globe is enlarged 1.58x by CSS (and more while zoomed), so render at a matching resolution to keep the dots crisp
  globe.renderer().setPixelRatio(Math.min(3, (devicePixelRatio || 1) * 1.6)); globe.width(el.offsetWidth).height(el.offsetHeight);
  earthTexture().then((url) => { if (globe && $("#globe") === el) globe.globeImageUrl(url); }).catch(() => {});
  globe.pointOfView({ lat: 35, lng: 10 }); // look from the hub's latitude so the routes into FRA face the viewer
  const ctl = globe.controls();
  ctl.enableZoom = false; ctl.enablePan = false;
  ctl.minPolarAngle = ctl.maxPolarAngle = ((90 - 35) * Math.PI) / 180; // lock that tilt: drag spins sideways only
  ctl.autoRotate = true; ctl.autoRotateSpeed = 2;
  const draw = () => {
    const shown = flights.filter((f) => S.filters.has(band(f.delay_min)[0]));
    globe.arcsData(shown.map((f) => ({ startLat: f.lat, startLng: f.lon, endLat: HUB[0], endLng: HUB[1], color: Array(2).fill(f.delay_min ? band(f.delay_min)[3] : ROUTE) })))
      .pointsData(shown.map((f) => ({ lat: f.lat, lng: f.lon })).concat([{ lat: HUB[0], lng: HUB[1] }]));
    $("#ftable").innerHTML = `<thead><tr><th>Flight</th><th>From</th><th>Status</th><th>On-block</th><th>Delay</th><th>Connections at risk</th>
      <th>Crew margin</th><th>NO-GO mx</th><th>Turn gap</th></tr></thead><tbody>${shown.map((f) => `<tr class="click" data-id="${h(f.id)}">
      <td><b>${h(f.id)}</b></td><td>${h(f.origin)}</td><td>${h(f.status)}</td><td>T${sign(f.eff)}</td><td>${delayChip(f.delay_min)}</td>
      <td>${f.at_risk}/${f.connecting} ${f.vulnerable_at_risk ? tag(f.vulnerable_at_risk + " vulnerable", "warn") : ""}</td>
      <td class="${f.crew_min_margin < 0 ? "bad" : f.crew_min_margin < 60 ? "warn" : ""}">${f.crew_min_margin} min</td>
      <td class="${f.open_nogo ? "bad" : ""}">${f.open_nogo}</td><td class="${f.turn_gap > 0 ? "warn" : ""}">${sign(f.turn_gap)} min</td></tr>`).join("")}</tbody>`;
    FlightMap.update(shown);
  };
  FlightMap.mount($("#fmap"), { hub: HUB, color: (f) => (f.delay_min ? band(f.delay_min)[3] : ON_TIME),
    label: (f) => `<b>${h(f.id)}</b>${h(f.origin)} → FRA · ${f.delay_min ? "+" + f.delay_min + " min" : "on time"}<br>
      <span class="muted">${h(f.status)}${f.at_risk ? ` · ${f.at_risk} connections at risk` : ""}</span><br><span class="go">Click to open live report →</span>` });
  $(".filters .row").onchange = (e) => { e.target.checked ? S.filters.add(e.target.value) : S.filters.delete(e.target.value); draw(); };
  $("#ftable").onclick = (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = `#/flight/${tr.dataset.id}`; };
  draw();
  globeScroll();
}
// Earth texture: deep-brown ocean and warm beige land, painted once from the land mask (globe-map.svg) and cached.
// Land shades by latitude (a little deeper toward the poles), so the continents read softly against the dark sea.
let earthP;
function earthTexture() {
  return (earthP ??= new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const W = 2048, H = 1024, c = document.createElement("canvas"); c.width = W; c.height = H;
      const g = c.getContext("2d");
      // land: the mask, recoloured green with a latitude gradient
      g.drawImage(img, 0, 0, W, H);
      g.globalCompositeOperation = "source-in";
      const land = g.createLinearGradient(0, 0, 0, H);
      land.addColorStop(0, "#9c8770"); land.addColorStop(0.3, "#c8b293"); land.addColorStop(0.5, "#dcc8a8");
      land.addColorStop(0.7, "#c8b293"); land.addColorStop(1, "#9c8770");
      g.fillStyle = land; g.fillRect(0, 0, W, H);
      // ocean: deep brown, a touch warmer near the equator
      g.globalCompositeOperation = "destination-over";
      const sea = g.createLinearGradient(0, 0, 0, H);
      sea.addColorStop(0, "#15110e"); sea.addColorStop(0.5, "#2a201a"); sea.addColorStop(1, "#15110e");
      g.fillStyle = sea; g.fillRect(0, 0, W, H);
      res(c.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = rej; img.src = "/globe/globe-map.svg";
  }));
}
// Scroll-driven zoom, as on the reference: across the tall dark zone the globe goes from 2x and pushed 135% down to 1x, centred.
function globeScroll() {
  const clamp = (x) => Math.min(1, Math.max(0, x)), inApp = scrollY >= $("#app").offsetTop - 2;
  const z = $(".globe-zone"), disc = $(".globe-disc"), brand = $(".brand");
  if (!z || !disc) return document.body.classList.toggle("hdr", inApp); // other pages: header whenever you're past the intro
  const top = z.getBoundingClientRect().top, p = clamp(-top / (z.offsetHeight - innerHeight));
  const v = clamp((p - 0.6) / 0.3); // side panels arrive once the globe has settled
  document.body.classList.toggle("hdr", inApp && p > 0.8); // header only after the opening name + globe
  if (top < innerHeight * 0.75) brand.classList.add("in"); // the name blurs in above the half-risen globe
  // as you scroll on, the name glides up and fades out before the rising globe can reach it (never behind the globe)
  const out = clamp(p / 0.32), ease = out * out * (3 - 2 * out);
  brand.style.opacity = 1 - ease;
  brand.style.transform = `translateY(${-22 * ease}vh) scale(${1 - 0.06 * ease})`;
  brand.style.visibility = ease >= 1 ? "hidden" : "visible";
  // opening: the top half of a big globe under the name; scrolling shrinks it into the centre
  disc.style.transform = `translateY(${83 * (1 - p)}%) scale(${1.8 - 0.8 * p})`;
  document.querySelectorAll(".live-side").forEach((s, i) => {
    s.style.opacity = v; s.style.transform = `translateX(${(i ? 1 : -1) * 40 * (1 - v)}px)`; s.style.pointerEvents = v > 0.5 ? "auto" : "none";
  });
}
// The intro (sky, jet window, cloud fade) plays once. As soon as you are fully inside the console it is removed for the rest of
// the visit, keeping your place, so scrolling up on any page stops at the top of that page instead of flying back into the sky.
function retireIntro() {
  if (document.body.classList.contains("intro-done")) return;
  const top = $("#app").offsetTop;
  if (scrollY < top - 1) return;
  const y = scrollY - top;
  document.body.classList.add("intro-done");
  window.scrollTo({ top: y, behavior: "instant" });
}
window.addEventListener("scroll", () => { retireIntro(); requestAnimationFrame(globeScroll); }, { passive: true });
// the globe's edge mask drifts with the cursor (eased by a CSS transition on --mask-x), and the globe follows resizes
window.addEventListener("mousemove", (e) => $("#globe")?.style.setProperty("--mask-x", `${50 + 75 * (0.5 - e.clientX / innerWidth)}%`));
window.addEventListener("resize", () => { const el = $("#globe"); if (globe && el) globe.width(el.offsetWidth).height(el.offsetHeight); });

async function pickerTab(render) {
  const [flights, d] = await Promise.all([api("/api/flights"), api(`/api/flight/${S.flight}`)]);
  $("#tab").innerHTML = `<div class="row" style="margin-top:12px"><label>Flight <select id="pick">${flights.map((f) =>
    `<option value="${h(f.id)}" ${f.id === S.flight ? "selected" : ""}>${h(f.id)} ${h(f.origin)}→FRA ${f.delay_min ? "+" + f.delay_min + " min" : ""}</option>`).join("")}
    </select></label><a href="#/flight/${h(S.flight)}">Open live report →</a></div><div class="card" id="sub"></div>`;
  $("#pick").onchange = (e) => { S.flight = e.target.value; mainView(); };
  await render(d, $("#sub"));
}

// Crew: duty-time bars against the legal ceiling, grouped by role, with the Crew agent's standby pick per member
// (specialists.py: chosen from guard-approved standby only; the reason is the suggestion's tooltip).
// Display only: swaps still go through decide() (controller name + PIN), and the dropdowns list only guard-approved standby.
const CREW_F = { f: "all" };
const crewTab = () => { const agentP = api(`/api/agents/${S.flight}/crew`).catch(() => null); return pickerTab(async (d, el) => {
  const ag = await agentP;
  const MAX = d.limits.MAX_FDP_MIN, o = d.outbound, crew = d.crew;
  const st = (c) => (c.margin < 0 ? "over" : c.margin < 60 ? "tight" : "ok");
  // standby already used in a pending swap (so the same person is not proposed twice)
  const busy = new Set();
  for (const c of d.decisions || []) if (c.status === "PENDING") {
    try { JSON.parse(c.actions || "[]").forEach((a) => a.kind === "CREW_SWAP" && busy.add(a.standby_id)); } catch { /* skip */ }
  }
  const over = crew.filter((c) => c.margin < 0), tight = crew.filter((c) => st(c) === "tight");
  const worst = crew.length ? Math.min(...crew.map((c) => c.margin)) : 0;
  const pool = new Map();
  crew.forEach((c) => c.options.forEach((s) => pool.set(s.id, { ...s, role: c.role })));
  const top = Math.max(MAX, ...crew.map((c) => c.projected_fdp)) * 1.04; // bar scale: a little past the ceiling
  const pc = (m) => `${Math.max(0, Math.min(100, (100 * m) / top))}%`;
  const bar = (c) => `<div class="cw-bar" role="img" aria-label="${h(c.name)}: ${c.duty_used} min used, ${c.projected_fdp} min projected, limit ${MAX} min">
      <i class="used" style="width:${pc(Math.min(c.duty_used, MAX))}"></i><i class="proj" style="left:${pc(Math.min(c.duty_used, MAX))};width:${pc(Math.max(0, Math.min(c.projected_fdp, MAX) - Math.min(c.duty_used, MAX)))}"></i>
      ${c.projected_fdp > MAX ? `<i class="over" style="left:${pc(MAX)};width:${pc(c.projected_fdp - MAX)}"></i>` : ""}<b class="lim" style="left:${pc(MAX)}"></b></div>`;
  // the Crew agent's pick per member (each standby at most once); if the agent is unreachable, the same rule it falls back
  // to: most over-limit first, closest legal standby (the dropdown still lists every legal option)
  const sug = new Map(), given = new Set(busy);
  if (ag && ag.flight_id === d.flight.id) ag.picks.forEach((p) => { const c = crew.find((x) => x.id === p.crew_id), s = c?.options.find((o) => o.id === p.standby_id);
    if (s && !given.has(s.id)) { sug.set(c.id, { ...s, reason: p.reason }); given.add(s.id); } });
  else [...crew].sort((x, y) => x.margin - y.margin).forEach((c) => { const s = c.options.find((o) => !given.has(o.id)); if (s) { sug.set(c.id, s); given.add(s.id); } });
  const best = (c) => sug.get(c.id);
  const row = (c) => {
    const b = best(c), k = st(c);
    return `<div class="cw-row ${k}">
      <div class="cw-who"><span class="cw-av">${h(c.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2))}</span>
        <div><b>${h(c.name)}</b><small>${h(c.id)} · ${h(c.role)} · ${h(c.type_rating)}</small></div></div>
      <div class="cw-time">${bar(c)}<small>${c.duty_used} min used · ${c.projected_fdp} min projected at departure</small></div>
      <div class="cw-m ${k}"><b>${c.margin > 0 ? "+" : ""}${c.margin} min</b><small>${{ over: "over limit", tight: "tight", ok: "legal" }[k]}</small></div>
      <div class="cw-act">${k === "over" ? (b ? `<div class="cw-sug"${b.reason ? ` title="${h(`${ag.name}: ${b.reason}`)}"` : ""}><small>Suggested standby</small><b>${h(b.id)} · ${h(b.name)}</b><small>${h(b.location)} · ${b.walk_min} min walk</small>
          <button data-swap="${h(c.id)}|${h(b.id)}">Propose swap</button></div>` : `<p class="small ${ag?.delayed === false ? "muted" : "bad"}">${ag?.delayed === false ? "On time: no agent recommendation (choose manually below)"
          : c.options.length ? "Matching standby already suggested for a more urgent crew member" : "No legal standby available"}</p>`) : ""}
        <select data-crew="${h(c.id)}" aria-label="Choose standby for ${h(c.name)}"><option value="">${c.options.length ? (k === "over" ? "or choose another…" : "Swap with standby…") : "no legal standby"}</option>${c.options.map((s) =>
          `<option value="${h(s.id)}" ${busy.has(s.id) ? "disabled" : ""}>${h(s.id)} · ${h(s.name)} · ${h(s.location)} (${s.walk_min} min)${busy.has(s.id) ? " · already proposed" : ""}</option>`).join("")}</select></div></div>`;
  };
  const vis = crew.filter((c) => CREW_F.f === "all" || st(c) === CREW_F.f);
  const deck = vis.filter((c) => /^(CPT|FO|SO|CAP|CAPT)/i.test(c.role)), cabin = vis.filter((c) => !deck.includes(c));
  const group = (t, list) => list.length ? `<section class="cw-group"><div class="cw-gh"><h3>${t}</h3><span class="small muted">${list.filter((c) => c.margin < 0).length} of ${list.length} over limit</span></div>${list.map(row).join("")}</section>` : "";
  // what the Crew agent did (AgentPanel, agentlive.js)
  const agentSec = AgentPanel.html("crew", ag && ag.flight_id === d.flight.id ? ag : null, (ag?.picks || []).map((p) => {
    const c = crew.find((x) => x.id === p.crew_id), s = c?.options.find((o) => o.id === p.standby_id);
    return { who: `${c ? c.name : p.crew_id} (${p.role}, ${p.margin_min > 0 ? "+" : ""}${p.margin_min} min)`, what: `standby ${p.standby_id}${s ? ` · ${s.name}` : ""}`,
      why: p.reason, by: p.by }; }), 0, "All crew are within duty limits: no swap needed.");
  el.className = "cw";
  el.innerHTML = `
    <section class="px-kpis" aria-label="Crew summary">
      <div class="k main"><span>Outbound</span><b>${h(o.id)} <em>→ ${h(o.dest)}</em></b><small>${h(o.aircraft_type)} · departs T${sign(o.eff)}</small></div>
      <div class="k"><span>Over the legal limit</span><b class="${over.length ? "bad" : ""}">${over.length}</b><small>of ${crew.length} crew</small></div>
      <div class="k"><span>Tightest margin</span><b class="${worst < 0 ? "bad" : ""}">${worst > 0 ? "+" : ""}${worst} min</b><small>legal ceiling ${MAX} min</small></div>
      <div class="k"><span>Standby available</span><b>${[...pool.keys()].filter((x) => !busy.has(x)).length}</b><small>${busy.size ? `${busy.size} already proposed` : "guard-approved only"}</small></div>
    </section>
    ${agentSec}
    ${over.length && over.length === crew.length ? '<div class="px-alert" role="alert">⚠ Every crew member is over the legal limit: a full standby crew is needed for this departure.</div>' : ""}
    <div class="cw-top"><div class="cw-filter" role="group" aria-label="Filter crew">${[["all", "All", crew.length], ["over", "Over limit", over.length], ["tight", "Tight (< 60 min)", tight.length],
      ["ok", "Legal", crew.length - over.length - tight.length]].map(([k, l, n]) => `<button class="${CREW_F.f === k ? "on" : ""}" data-cf="${k}" aria-pressed="${CREW_F.f === k}">${l} <span>${n}</span></button>`).join("")}</div>
      <div class="cw-key small muted"><i class="used"></i>duty used <i class="proj"></i>to departure <i class="over"></i>over limit <b class="lim"></b>legal ceiling</div></div>
    <div class="cw-layout"><div>${group("Flight deck", deck)}${group("Cabin crew", cabin)}${vis.length ? "" : '<p class="muted">No crew in this filter.</p>'}</div>
      <aside class="cw-pool"><h3>Standby pool</h3>${pool.size ? `<ul>${[...pool.values()].sort((a, b) => a.walk_min - b.walk_min).map((s) =>
        `<li class="${busy.has(s.id) ? "used" : ""}"><b>${h(s.id)}</b> ${h(s.name)}<small>${h(s.role)} · ${h(s.location)} · ${s.walk_min} min walk${busy.has(s.id) ? " · already proposed" : ""}</small></li>`).join("")}</ul>`
        : '<p class="small muted">No legal standby for this crew.</p>'}<p class="small muted">Only standby that pass the guards are listed. Every swap needs controller approval (PIN).</p></aside></div>`;
  const swap = (cid, sid, reset) => decide(d.flight.id, `Crew swap ${cid} → ${sid}`, [{ kind: "CREW_SWAP", crew_id: cid, standby_id: sid }],
    (r) => (r?.status === "APPROVED" || r?.status === "PENDING" ? mainView() : reset?.()));
  el.onclick = (e) => {
    const f = e.target.closest("[data-cf]"); if (f) { CREW_F.f = f.dataset.cf; return mainView(); }
    const b = e.target.closest("[data-swap]"); if (b) { const [cid, sid] = b.dataset.swap.split("|"); swap(cid, sid); }
  };
  el.onchange = (e) => { const s = e.target; if (s.dataset.crew && s.value) swap(s.dataset.crew, s.value, () => (s.value = "")); };
}); };

// Connecting Passengers: Passenger Impact Agent (analysis + recommendation hand-off only; it never books anything)
const paxTab = () => pickerTab((d, el) => { el.className = ""; return PaxImpact.mount(el).catch((e) => toast(e.message, "bad")); });

// Maintenance: fleet-wide queue of open items, most urgent departure first (see Extras.maintenanceTab)
const mxTab = () => Extras.maintenanceTab($("#tab"));

// Decision log = every executed/pending decision + the Decision Ledger (calls -> AI-extracted, human-confirmed, guard-checked items)
const logTab = () => pickerTab((d, el) => { el.className = ""; return DecisionLog.mount(el).catch((e) => toast(e.message, "bad")); });

// ---------- live report page ----------
async function reportView(id) {
  S.flight = id;
  const d = await api(`/api/flight/${id}`), k = d.kpis, f = d.flight, o = d.outbound;
  const stats = [["Delay", `+${f.delay_min} min`, `on-block T${sign(k.eta)}`, f.delay_min > 30],
    ["Connecting passengers", k.connecting, `${k.at_risk} at risk · ${k.vulnerable_at_risk} vulnerable`, k.at_risk > 0],
    ["Crew duty margin", `${k.crew_min_margin} min`, `${k.crew_illegal} over the legal limit for ${o.id}`, k.crew_illegal > 0],
    ["Maintenance", `${k.open_nogo} NO-GO open`, `${d.maintenance.length} item(s) on ${f.tail}`, k.open_nogo > 0],
    ["Turnaround", `T${sign(k.off_block)}`, `off-block vs scheduled T${sign(k.outbound_dep)} (${sign(k.turn_gap)} min)`, k.turn_gap > 0],
    ["EU261 exposure", `€${k.pax_cost_eur.toLocaleString()}`, `do-nothing €${k.baseline_eur.toLocaleString()} · ${k.protected} protected`, k.pax_cost_eur > 0]];
  $("#view").innerHTML = `<div class="row"><a href="#/">← Network</a></div>
    <h2>${h(f.id)} <span class="muted">${h(f.origin)} → FRA</span> ${delayChip(f.delay_min)} ${tag(f.status)}</h2>
    <div class="row muted">${h(f.aircraft_type)} ${h(f.tail)} · outbound ${h(o.id)} → ${h(o.dest)} dep T${sign(o.eff)} · gate ${h(o.gate)} · ${h(o.status)}
      <button id="release" class="ghost">Propose departure release</button></div>
    <div id="agent-live"></div>
    <div class="card"><div class="row between"><h3>Live situation report</h3>
      <span><span id="rsrc" class="muted small"></span> <button id="regen" class="ghost">↻ Regenerate</button></span></div><div id="report" class="report muted">Generating report…</div></div>
    <div class="stats">${stats.map(([t, v, s, bad]) => `<div class="stat ${bad ? "alert" : ""}"><div class="muted small">${h(t)}</div><div class="big">${h(v)}</div><div class="small">${h(s)}</div></div>`).join("")}</div>
    <div class="card"><div class="row between"><h3>Top 3 agent suggestions <span class="muted small">· click one to see its passengers & bags</span></h3><a href="#/lab/${h(id)}"><button>Open Decision hub →</button></a></div><div id="sugg" class="grid3"></div></div>
    <div class="card" id="x-pax" hidden></div>
    <div class="grid2"><div class="card"><h3>Calls on the system</h3><div class="row"><input id="spk" placeholder="Caller, e.g. Ramp control" maxlength="40">
      <button id="mic" class="ghost">Record call</button></div><textarea id="txt" rows="3" maxlength="2000" placeholder="Record (live transcription) or type the call…"></textarea>
      <button id="save">Save transcript → update report</button><ul class="feed">${d.comms.map((c) => `<li><b>${h(c.at)} · ${h(c.speaker)}</b><br>${h(c.text)}</li>`).join("")}</ul></div>
    <div class="card"><h3>Turnaround critical path</h3><p class="small">${d.turnaround.path.map(h).join(" → ")}</p><table>${d.turnaround.tasks.map((t) =>
      `<tr class="${t.critical ? "crit" : ""}"><td>${h(t.name)}</td><td>${t.minutes} min</td><td>ends T${sign(t.finish)}</td><td>${t.status === "DONE" ? tag("DONE", "ok")
      : `<button class="ghost small" data-task="${h(t.id)}">Mark done</button>`}</td></tr>`).join("")}</table>
      <h3 style="margin-top:14px">Decisions & notifications</h3>${d.decisions.slice(0, 5).map((c) => `<div class="small">#${c.id} ${statusTag(c.status)} ${h(c.title)}</div>`).join("") ||
      '<p class="muted small">No decisions yet</p>'}${notifList(d.notifications.slice(0, 8))}</div></div>`;
  $("#regen").onclick = () => loadReport(id, true);
  $("#release").onclick = () => decide(id, `Release ${o.id} for departure`, [{ kind: "DEPARTURE_RELEASE", flight_id: o.id }], (r) => r && reportView(id));
  AgentLive.mount($("#agent-live"), id); // live agent activity after a call is saved (agentlive.js)
  // Saving a call starts the agents at once; the strip follows them, then the report, stats and scenarios reload.
  $("#save").onclick = async () => {
    const speaker = $("#spk").value.trim(), text = $("#txt").value.trim();
    $("#save").disabled = true;
    try {
      const r = await api("/api/comms", { flight_id: id, speaker, text });
      toast("Call saved · agents responding");
      $("#txt").value = "";
      const now = new Date().toTimeString().slice(0, 5);
      $("#save").nextElementSibling.insertAdjacentHTML("afterbegin", `<li><b>${h(now)} · ${h(speaker || "OCC call")}</b><br>${h(text)}</li>`);
      AgentLive.start(id, r, () => { if (location.hash === `#/flight/${id}`) reportView(id); }, { enroute: f.status === "ENROUTE", text, speaker });
    } catch (e) { toast(e.message, "bad"); }
    if ($("#save")) $("#save").disabled = false;
  };
  $("#mic").onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast("Live transcription isn't supported in this browser (use Chrome/Edge) — type the call instead", "warn");
    if (rec) return rec.stop();
    rec = new SR(); rec.continuous = true; rec.lang = "en-GB";
    rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal && $("#txt")) $("#txt").value += e.results[i][0].transcript + " "; };
    rec.onend = () => { rec = null; if ($("#mic")) $("#mic").textContent = "Record call"; };
    rec.start(); $("#mic").textContent = "Stop recording";
  };
  $("#view").onclick = async (e) => { const t = e.target.dataset.task;
    if (t) try { await api("/api/task", { flight_id: id, task_id: t }); reportView(id); } catch (err) { toast(err.message, "bad"); } };
  loadReport(id);
}

async function loadReport(id, force) {
  $("#report").textContent = "Generating report…";
  try {
    const r = force ? await api("/api/report", { flight_id: id }) : await api(`/api/report/${id}`);
    if (!$("#report") || S.flight !== id) return;
    $("#report").innerHTML = bullets(r.report); $("#report").classList.remove("muted");
    const ai = String(r.source || "").startsWith("LLM"), sAi = String(r.suggestions_source || r.source || "").startsWith("LLM");
    $("#rsrc").textContent = `${r.on_time ? "On time · no recommendations" : ai ? "AI" : "Rule-based fallback (AI unavailable)"}${ai && !sAi ? " · options rule-based" : ""} · ${String(r.generated || "").slice(11, 16)}`;
    $("#rsrc").title = `Report: ${r.source} · Options: ${r.suggestions_source || r.source} · ${r.generated} · from call transcripts + live data` +
      Object.values(r.agents || {}).map((a) => `\n${a.name}: ${a.source}`).join("");
    $("#sugg").innerHTML = r.suggestions.map((s, i) => `<div class="sugg x-pick" data-opt="${i}"><div class="muted small">Option ${i + 1}</div><b>${h(s.title)}</b>
      <p class="small clamp2" title="${h(s.why)}">${h(s.why)}</p><div class="small">${actionsText(s.actions)}</div>${s.revised_from ? `<div class="small warn" title="${h(shortIds(s.revised_from))}">↻ Revised after a guard refusal</div>` : ""}</div>`).join("")
      || `<p class="muted">${h(id)} is on time: the agents only recommend when a flight is delayed.</p>`;
    $("#sugg").onclick = (e) => { const c = e.target.closest("[data-opt]"); if (!c || !r.suggestions[c.dataset.opt].actions.length) return;
      document.querySelectorAll("#sugg .x-sel").forEach((x) => x.classList.remove("x-sel")); c.classList.add("x-sel");
      Extras.paxPanel($("#x-pax"), id, r.suggestions[c.dataset.opt]); };
  } catch (e) { toast(e.message, "bad"); }
}

// ---------- decision hub (was Scenario Lab) ----------
// Three priorities map onto the backend's ranking toggles: customer satisfaction -> connections + on_time,
// cost effectiveness -> cost, legality -> crew_rest. Checks are read from each scenario's dry-run KPIs.
const HUB_P = [["sat", "Customer satisfaction", ["connections", "on_time"]], ["cost", "Cost effectiveness", ["cost"]], ["legal", "Legality (crew duty)", ["crew_rest"]]];
const hubOn = (p) => HUB_P.filter(([, , ks]) => ks.some((k) => p[k])).map(([k]) => k);
const eur = (v) => `€${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
const ICO = { pax: '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.8M16 4.2a3 3 0 0 1 0 5.6"/>',
  bag: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M4 12h16"/>', crew: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  mx: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>', net: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.5M8.2 13.2l7.6 4.5"/>' };
function hubChecks(s, id) {
  if (!s.ok) return [["pax", "Passengers", false, "Refused by the guards.", s.reason, null]];
  const k = s.kpis, c = [];
  c.push(["pax", "Passengers", !k.at_risk && !k.vulnerable_at_risk, k.at_risk || k.vulnerable_at_risk ? `${k.at_risk} passengers still miss their connection${k.vulnerable_at_risk ? `, ${k.vulnerable_at_risk} of them vulnerable` : ""}.` : `All ${k.baseline_at_risk} at-risk passengers are protected.`,
    `Affected: ${k.at_risk} passengers. Rebook them on the next free seats.`, ["#/tab/pax", "Passengers tab"]]);
  const bags = (k.bags_rush || 0) + (k.bags_short_connection || 0);
  c.push(["bag", "Baggage", !bags, bags ? `${bags} bags may not make their passenger's flight.` : "All bags travel with their passengers.", `Affected: ${bags} bags. Move those passengers to a later flight or rush-tag the bags.`, [`#/flight/${id}`, "Live report"]]);
  const crewBad = k.crew_illegal > 0 || k.crew_min_margin < 0;
  c.push(["crew", "Crew", !crewBad, crewBad ? `${k.crew_illegal || 1} crew member${k.crew_illegal > 1 ? "s" : ""} would exceed the duty limit.` : `Duty time is within limits (${k.crew_min_margin} min margin).`, "Affected: crew duty time. Assign standby crew.", ["#/tab/crew", "Crew tab"]]);
  c.push(["mx", "Maintenance", !k.open_nogo, k.open_nogo ? `${k.open_nogo} NO-GO item${k.open_nogo > 1 ? "s" : ""} still unsigned.` : "Aircraft is cleared.", "Affected: open NO-GO items. A licensed engineer must sign them off.", ["#/tab/mx", "Maintenance tab"]]);
  // holds on other passengers' onward flights (the outbound's own retime is the turnaround, not a knock-on delay)
  const od = k.onward_delay_added ?? k.network_delay_added, net = od > 30;
  c.push(["net", "Downstream network", !net, od ? `Adds ${od} min of delay to onward flights.` : "No onward flights are affected.", `Affected: ${od} min of onward delay. Pick a plan with a shorter hold.`, null]);
  return c;
}
// The hub is its own menu tab (#/tab/hub). #/lab/<flight> still works: it opens the hub tab for that flight.
async function labView(id) {
  if (S.hubFlight !== id) { S.hubFlight = id; S.hubPick = 0; }
  const flights = await api("/api/flights");
  $("#tab").innerHTML = `<div class="row" style="margin-top:12px"><label>Flight <select id="pick">${flights.map((f) =>
    `<option value="${h(f.id)}" ${f.id === id ? "selected" : ""}>${h(f.id)} ${h(f.origin)}→FRA ${f.delay_min ? "+" + f.delay_min + " min" : ""}</option>`).join("")}
    </select></label><a href="#/flight/${h(id)}">Open live report →</a></div>
    <div class="hub"><h2 class="hub-title">Decision hub · ${h(id)}</h2><p class="hub-sub">Everything a scenario depends on, checked in one place.</p>
    <div class="hub-sec"><i>1</i>PRIORITIES</div>
    <div class="hub-row"><div class="hub-pills" id="hub-p">${HUB_P.map(([k, l]) => `<button class="hub-pill" data-p="${k}">${l}</button>`).join("")}</div>
      <button class="hub-regen" id="regen">Regenerate scenarios</button><span id="lsrc" class="muted small"></span></div>
    <p class="hub-note" id="hub-note"></p><div id="scen" class="hub-scen"></div><div id="hub-rest"></div></div>`;
  $("#pick").onchange = (e) => { S.flight = e.target.value; mainView(); };
  const mark = () => { const on = hubOn(S.prio); document.querySelectorAll("#hub-p .hub-pill").forEach((b) => b.classList.toggle("on", on.includes(b.dataset.p))); };
  $("#hub-p").onclick = (e) => { const b = e.target.closest("[data-p]"); if (!b) return; const ks = HUB_P.find(([k]) => k === b.dataset.p)[2], on = !ks.some((k) => S.prio[k]);
    ks.forEach((k) => (S.prio[k] = on)); mark(); $("#hub-note").innerHTML = '<b>Priorities changed.</b> Regenerate to build new scenarios for them.'; };
  $("#regen").onclick = () => { S.hubPick = 0; loadLab(id, true); };
  mark(); loadLab(id);
}
async function loadLab(id, regenerate = false) {
  $("#scen").innerHTML = `<p class="muted">${regenerate ? "Asking the agent for new scenarios, then dry-running them…" : "Dry-running the recommended scenarios…"}</p>`; $("#hub-rest").innerHTML = "";
  try {
    const [c, d] = await Promise.all([api("/api/compare", { flight_id: id, priorities: S.prio, regenerate, narrate: false }), api(`/api/flight/${id}`)]);
    const rows = c.rows.slice(0, 3), used = hubOn(c.priorities);
    $("#lsrc").textContent = `Source: ${c.scenario_source}`;
    if (c.on_time) { $("#hub-note").innerHTML = ""; $("#scen").innerHTML = `<p class="muted">${h(id)} is on time: the agents only recommend recovery scenarios when a flight is delayed.</p>`; return; }
    $("#hub-note").innerHTML = `Scenarios built to protect: ${used.length ? used.map((k) => HUB_P.find(([p]) => p === k)[1].toLowerCase()).join(", ") : "the agent's default balance"}`;
    const draw = () => {
      const pick = S.hubPick, s = rows[pick], L = "ABC";
      $("#scen").innerHTML = rows.map((r, i) => { const ch = hubChecks(r, id), bad = ch.filter((x) => !x[2]).length;
        return `<button class="hub-card ${i === pick ? "on" : ""}" data-i="${i}"><div class="hub-prio">${used.map((k) => `<span>${h(HUB_P.find(([p]) => p === k)[1])}</span>`).join("")}</div>
          <div class="hub-cl">SCENARIO ${L[i]} ${i === 0 && r.ok ? '<em>AI recommended</em>' : ""}</div><b>${h(r.title)}</b><p>${h(r.why)}</p>
          <div class="hub-bars">${(r.ok ? ch : [0, 0, 0, 0, 0].map(() => [0, 0, false])).map((x) => `<i class="${x[2] ? "g" : "r"}"></i>`).join("")}<span class="${bad ? "r" : "g"}">${!r.ok ? "Blocked" : bad ? `${bad} issue${bad > 1 ? "s" : ""}` : "All 5 checks ready"}</span></div></button>`; }).join("");
      if (!s) return;
      const ch = hubChecks(s, id), bad = ch.filter((x) => !x[2]), k = s.kpis || {}, max = Math.max(...rows.map((r) => r.kpis?.total_cost_eur || 0), 1);
      const low = Math.min(...rows.filter((r) => r.ok).map((r) => r.kpis.total_cost_eur));
      const parts = s.ok ? [["Rebooking & care", k.pax_cost_eur || 0, "#e8c79a"], ["Delays", 100 * (k.network_delay_added || 0), "#e8b2a4"]].filter((p) => p[1] > 0) : [];
      $("#hub-rest").innerHTML = `<div class="hub-sec"><i>2</i>CHECKS FOR: ${h(s.title).toUpperCase()}</div>
        <div class="hub-checks">${ch.map(([ic, l, ok, txt, fix, link]) => `<div class="hub-ck ${ok ? "g" : "r"}"><div class="hub-ckh"><span class="hub-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICO[ic]}</svg></span>${h(l).toUpperCase()}</div>
          <div class="hub-st">${ok ? "✓ Ready" : "⚑ Issue"}</div><p>${h(txt)}</p>${ok ? "" : `<div class="hub-fix"><b>Fix this:</b> ${h(fix)}</div><button class="hub-go" data-stage="${ic}">Review ${h(l)} stage ↓</button>${link ? `<a class="hub-go2" href="${link[0]}">Open ${h(link[1])} →</a>` : ""}`}</div>`).join("")}</div>
        <div class="hub-sec"><i>3</i>COST IMPACT · ESTIMATES</div>
        <div class="hub-cost"><div class="hub-box"><div class="hub-bh">TOTAL COST BY SCENARIO</div>${rows.map((r, i) => `<div class="hub-cr ${i === pick ? "on" : ""}"><span>Scenario ${L[i]}${r.ok && r.kpis.total_cost_eur === low ? "<em>Lowest</em>" : ""}</span>
            <div class="hub-tr"><i style="width:${r.ok ? (r.kpis.total_cost_eur / max) * 100 : 0}%"></i></div><b>${r.ok ? eur(r.kpis.total_cost_eur) : "—"}</b></div>`).join("")}</div>
          <div class="hub-box"><div class="hub-bh">WHERE THE COST COMES FROM: SCENARIO ${L[pick]}</div>
            <div class="hub-split">${parts.map(([l, v, c]) => `<div style="flex:${v};background:${c}"><small>${l}</small><b>${eur(v)}</b></div>`).join("") || '<p class="muted small">No cost estimate.</p>'}</div>
            <div class="hub-tot"><span>Estimated total</span><b>${s.ok ? eur(k.total_cost_eur) : "—"}</b></div></div></div>
        <div class="hub-sec"><i>4</i>REVIEW AND APPROVE</div><div id="hub-ap"></div>`;
      const open = hubApprove(id, s, bad, d);
      $("#hub-rest").onclick = (e) => { const b = e.target.closest(".hub-go[data-stage]"); if (b) open(b.dataset.stage); };
    };
    $("#scen").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) { S.hubPick = +b.dataset.i; draw(); } };
    if (!(S.hubPick < rows.length)) S.hubPick = 0;
    draw();
  } catch (e) { toast(e.message, "bad"); $("#scen").innerHTML = `<p class="bad">${h(e.message)}</p>`; }
}

// ---------- Review and approve ----------
// Five operational areas, each a stage the Operations Manager reviews inside the hub. Only areas with actions need review.
// [key, label, action kinds that belong to it, page with the full detail, page name]
const REBOOK_KINDS = ["REBOOK", "REBOOK_AT_RISK", "REBOOK_TIERS"];
const HUB_AREAS = [["net", "Downstream network", ["DELAY", "GATE_CHANGE", "DEPARTURE_RELEASE"], (id) => `#/flight/${id}`, "Live report"],
  ["mx", "Maintenance", ["ASSIGN_ENGINEER", "SIGN_OFF"], () => "#/tab/mx", "Maintenance page"],
  ["crew", "Crew", ["CREW_SWAP", "CREW_AUTOSWAP"], () => "#/tab/crew", "Crew page"],
  ["bag", "Baggage", REBOOK_KINDS, () => "#/tab/pax", "Connecting passengers page"],
  ["pax", "Passengers", REBOOK_KINDS, () => "#/tab/pax", "Connecting passengers page"]];
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hhmm = (ts) => String(ts || "").slice(11, 16);

// Which stages the manager has opened, per flight + area + exact actions (a different plan needs a fresh review).
// Session storage only keeps this across page changes; losing it just means reviewing again.
const hubSeen = (() => { try { return JSON.parse(sessionStorage.getItem("aviant.hubSeen")) || {}; } catch { return {}; } })();
const saveSeen = () => { try { sessionStorage.setItem("aviant.hubSeen", JSON.stringify(hubSeen)); } catch { /* private mode */ } };

// What each approval does and what it fixes, per area. Plain text; escaped where it is drawn.
function hubItems(area, s, d) {
  const k = s.kpis || {}, b = d.kpis, o = d.outbound, acts = s.actions || [], of = (ks) => acts.filter((a) => ks.includes(a.kind));
  const vul = (ps) => ps.filter((p) => p.tier !== "STANDARD").length;
  if (area === "net") return of(HUB_AREAS[0][2]).map((a) => {
    if (a.kind === "DELAY" && a.flight_id !== o.id) {
      const p = d.passengers.filter((x) => x.at_risk && x.onward === a.flight_id), v = vul(p);
      return { what: `Hold ${a.flight_id} by ${a.minutes} min`, resolves: p.length
        ? `${plural(p.length, "connecting passenger")}${v ? ` (${v} vulnerable)` : ""} from ${d.flight.id} can still make ${a.flight_id} to ${p[0].dest}.`
        : `Keeps ${a.flight_id} in step with the late arrival of ${d.flight.id}.` }; }
    if (a.kind === "DELAY") return { what: `Retime ${o.id} by ${a.minutes} min`, resolves: b.turn_gap > 0
      ? `The turnaround runs ${b.turn_gap} min past the scheduled departure; ${o.id} leaves when the aircraft is ready.` : `Gives the turnaround room to finish before ${o.id} leaves.` };
    if (a.kind === "GATE_CHANGE") { const remote = d.gates.find((g) => g.id === o.gate)?.kind === "REMOTE";
      return { what: `Move ${a.flight_id} from ${o.gate} to gate ${a.gate}`, resolves: remote
        ? `Replaces a remote stand with a contact gate: no bus transfer, faster boarding and a shorter bag connection.` : `Frees up boarding and bag loading for ${a.flight_id}.` }; }
    return { what: `Release ${a.flight_id} for departure`, resolves: `${a.flight_id} is cleared to leave, with legal crew and no open NO-GO item.` };
  });
  if (area === "mx") return of(["ASSIGN_ENGINEER"]).map((a) => {
    const m = d.maintenance.find((x) => x.id === a.item_id), e = d.engineers.find((x) => x.id === a.engineer_id);
    return { what: `Assign ${e?.name || a.engineer_id} to ${a.item_id}${m ? ` (${m.item})` : ""}`, resolves: m?.severity === "NO-GO"
      ? `Starts the fix on the NO-GO item that blocks ${o.id}. The engineer then signs it off with their licence.` : `Gets ${a.item_id} worked on before ${o.id} departs.` };
  });
  if (area === "crew") return of(HUB_AREAS[2][2]).map((a) => {
    if (a.kind === "CREW_AUTOSWAP") { const over = d.crew.filter((c) => c.margin < 0);
      return { what: `Replace ${plural(over.length || 1, "crew member")} over the duty limit with legal standby crew`, resolves: over.length
        ? `${over.map((c) => `${c.role} ${c.id} (${-c.margin} min over)`).join(", ")} would break the duty limit on ${o.id}. After the swap the tightest margin is ${k.crew_min_margin} min.`
        : `Keeps the ${o.id} crew inside duty limits.` }; }
    const c = d.crew.find((x) => x.id === a.crew_id);
    return { what: `Replace ${c ? c.role + " " : ""}${a.crew_id} with standby ${a.standby_id}`, resolves: c && c.margin < 0
      ? `${a.crew_id} would be ${-c.margin} min over the duty limit on ${o.id}.` : `Adds duty-time margin for ${o.id}.` };
  });
  if (area === "bag") {
    if (!of(REBOOK_KINDS).length) return [];
    const fixed = Math.max((b.bags_short_connection || 0) - (k.bags_short_connection || 0), 0);
    return [{ what: "Move checked bags with every rebooked passenger", resolves: [fixed ? `${plural(fixed, "bag")} no longer miss the connection.` : "Bags travel on the same flight as their passengers.",
      k.bags_rush ? `${plural(k.bags_rush, "bag")} rush-tagged where only the passenger makes the flight.` : ""].filter(Boolean).join(" ") }];
  }
  return of(REBOOK_KINDS).map((a) => {
    if (a.kind === "REBOOK") { const p = d.passengers.find((x) => x.id === a.pax_id);
      return { what: `Rebook ${a.pax_id} onto ${a.to_flight}`, resolves: `${a.pax_id}${p ? ` (${p.tier})` : ""} misses ${p?.onward || "their connection"}; ${a.to_flight} gets them to ${p?.dest || "their destination"}.` }; }
    const saved = Math.max((b.at_risk || 0) - (k.at_risk || 0), 0), v = b.vulnerable_at_risk || 0;
    return { what: a.kind === "REBOOK_TIERS" ? `Rebook ${(a.tiers || []).join(", ")} passengers off ${a.flight_id}` : `Rebook every at-risk passenger off ${a.flight_id}, vulnerable first`,
      resolves: `${saved} of ${b.at_risk} at-risk passengers reach their destination${v ? `, vulnerable passengers first` : ""}.` +
        (k.at_risk ? ` ${k.at_risk} still have no seat${k.vulnerable_at_risk ? ` (${k.vulnerable_at_risk} vulnerable)` : ""}.` : "") };
  });
}

// The stage page shown inside the hub: just the facts behind that area's approvals, plus a link to the full page.
function hubStage(area, s, d) {
  const k = s.kpis || {}, b = d.kpis, o = d.outbound, tbl = (head, body) => body.length
    ? `<table class="hub-dt"><thead><tr>${head.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((x) => `<td>${h(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const risk = {};
  d.passengers.filter((p) => p.at_risk).forEach((p) => { const r = risk[p.onward] ||= { dest: p.dest, conn: p.conn_min, n: 0, v: 0, alts: p.options.length }; r.n++; r.v += p.tier !== "STANDARD"; r.conn = Math.min(r.conn, p.conn_min); });
  if (area === "net") return tbl(["Onward flight", "To", "At-risk pax", "Connection now", "Hold in plan"], Object.entries(risk).map(([f, r]) =>
    [f, r.dest, r.n, `${r.conn} min (MCT ${d.limits.MCT_MIN})`, ((s.actions || []).find((a) => a.kind === "DELAY" && a.flight_id === f)?.minutes ?? 0) + " min"])) +
    `<p class="small muted">Outbound ${o.id} at ${o.gate} · turnaround ${sign(b.turn_gap)} min vs schedule · onward hold cap ${d.limits.MAX_ONWARD_HOLD_MIN} min · plan adds ${k.network_delay_added || 0} min network delay</p>`;
  if (area === "mx") return tbl(["Item", "Fault", "Severity", "Status", "Engineer"], d.maintenance.map((m) => [m.id, m.item, m.severity, m.status, m.engineer || "—"]));
  if (area === "crew") return tbl(["Crew", "Role", "Duty margin now", "Legal standby"], d.crew.filter((c) => c.margin < 60).map((c) => [c.id, c.role, `${c.margin} min`, c.options.length])) ||
    '<p class="small muted">No crew member is within 60 min of the duty limit.</p>';
  if (area === "bag") return tbl(["", "Now", "After the plan"], [["Bags on connecting passengers", b.bags, k.bags ?? b.bags], ["Below the bag connection time", b.bags_short_connection, k.bags_short_connection ?? "—"],
    ["Rush-tagged", b.bags_rush, k.bags_rush ?? "—"]]) + `<p class="small muted">Bag minimum connection time ${b.bag_mct} min.</p>`;
  return tbl(["Onward flight", "To", "At-risk pax", "Vulnerable", "Alternatives"], Object.entries(risk).map(([f, r]) => [f, r.dest, r.n, r.v, r.alts])) +
    `<p class="small muted">After the plan: ${k.at_risk ?? "—"} still miss their connection, ${k.vulnerable_at_risk ?? "—"} of them vulnerable.</p>`;
}

const DEC_WORD = { APPROVED: "Approved", PENDING: "Awaiting approval", REJECTED: "Rejected", ROLLED_BACK: "Rolled back", BLOCKED: "Blocked by guards" };
const decLine = (x) => `<span class="hub-dec ${x.status === "APPROVED" ? "g" : x.status === "PENDING" ? "" : "r"}">${DEC_WORD[x.status] || h(x.status)}${x.by ? ` by ${h(x.by)}` : ""} · ${h(hhmm(x.ts))}</span>
  <span class="small muted">${h(x.title)}${x.note ? ` · ${h(shortIds(x.note))}` : ""}</span>`;

// Returns open(area) so the checks in step 2 can send the manager to a stage.
function hubApprove(id, s, bad, d) {
  const box = $("#hub-ap"), acts = s.actions || [], hubStart = Date.now();
  const areas = HUB_AREAS.map(([a, l, kinds, href, page]) => {
    const items = hubItems(a, s, d);
    return { a, l, kinds, href: href(id), page, items, key: `${id}|${a}|${JSON.stringify(items.map((x) => x.what))}` };
  });
  const need = areas.filter((x) => x.items.length), seen = (x) => !!hubSeen[x.key];
  let openA = null, decs = null, known = null;
  const mine = () => S.hubApproved?.[id] && decs?.find((x) => x.id === S.hubApproved[id].id);
  const latest = (x) => decs?.find((dc) => dc.kinds.some((kd) => x.kinds.includes(kd)));
  const draw = () => {
    const done = mine(), left = need.filter((x) => !seen(x)), ready = !done && need.length && !left.length && !bad.length;
    const fresh = decs && known ? decs.filter((x) => !known.has(x.id) && x.id !== S.hubApproved?.[id]?.id) : [];
    box.innerHTML = (fresh.length ? `<div class="hub-upd"><b>Updated from another page.</b> ${fresh.slice(0, 3).map((x) => `${h(x.title)}: ${DEC_WORD[x.status] || h(x.status)}${x.by ? ` by ${h(x.by)}` : ""} at ${h(hhmm(x.ts))}`).join(" · ")}.
        These scenarios were built before that; regenerate to plan from the new state.</div>` : "") +
      `<div class="hub-ar">${areas.map((x) => { const last = latest(x), st = done && x.items.length ? ["g", "✓ Approved"] : !x.items.length ? ["n", "Nothing to approve"] : seen(x) ? ["g", "✓ Reviewed"] : ["w", "Review needed"];
        return `<div class="hub-arow ${openA === x.a ? "open" : ""}" id="hub-a-${x.a}"><div class="hub-arh"><span class="hub-ico"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICO[x.a]}</svg></span>
          <b>${h(x.l)}</b><span class="hub-pillst ${st[0]}">${st[1]}</span>${x.items.length ? `<button class="hub-rvbtn" data-a="${x.a}">${openA === x.a ? "Close" : seen(x) ? "Review again" : "Review stage"}</button>` : ""}</div>
          ${x.items.length ? `<div class="hub-ai">${x.items.map((it) => `<div class="hub-it"><div><small>APPROVE</small>${h(it.what)}</div><div><small>RESOLVES</small>${h(it.resolves)}</div></div>`).join("")}</div>` : ""}
          ${last ? `<div class="hub-last"><small>LATEST DECISION</small>${decLine(last)}</div>` : ""}
          ${openA === x.a ? `<div class="hub-stage">${hubStage(x.a, s, d)}<a class="hub-pg" data-back="${x.a}" href="${x.href}">Open the full ${h(x.page)} →</a></div>` : ""}</div>`; }).join("")}</div>
      <div class="hub-ap ${done ? "g" : bad.length ? "r" : ready ? "g" : ""}"><div>${done ? `<h3>Plan approved</h3><p>${decLine(done)}</p><p class="small muted" style="margin-top:6px">Applied as one step to ${need.map((x) => x.l).join(", ") || "the plan"}. Each page and the Decision log show the same decision.</p>`
        : `<h3>${bad.length ? `${bad.length} issue${bad.length > 1 ? "s" : ""} to fix first` : !need.length ? "Nothing to approve" : ready ? "Reviewed and ready" : `Review ${plural(left.length, "more stage")}`}</h3>
        <p>${bad.length ? h(bad.map((x) => x[3]).join(" ")) : need.map((x) => `${seen(x) ? "✓" : "○"} ${h(x.l)}`).join(" · ") || "This scenario has no actions."}</p>`}</div>
        ${done ? "" : `<div class="hub-apr"><button id="hub-go" ${ready ? "" : "disabled"}>Approve operational plan</button><small>${ready ? `Runs ${plural(acts.length, "action")} as one step. Nothing is partly applied.` : "Unlocks once every stage that needs action has been reviewed and every check is ready."}</small></div>`}</div>`;
    box.querySelector(".hub-ar").onclick = (e) => {
      const g = e.target.closest("[data-back]");
      if (g) { const x = areas.find((y) => y.a === g.dataset.back); S.hubBack = { fid: id, href: x.href, keys: [x.key] }; return; }
      const b = e.target.closest(".hub-rvbtn"); if (b) open(b.dataset.a, true);
    };
    const go = $("#hub-go");
    if (go) go.onclick = () => ready && decide(id, s.title, acts, (r) => {
      if (r?.status !== "APPROVED") return;
      (S.hubApproved ||= {})[id] = { id: `C${r.id}` };
      need.forEach((x) => delete hubSeen[x.key]); saveSeen();
      poll();
    });
  };
  const open = (a, toggle) => {
    const x = areas.find((y) => y.a === a); if (!x) return;
    openA = toggle && openA === a ? null : a;
    if (openA && x.items.length) { hubSeen[x.key] = Date.now(); saveSeen(); }
    draw(); $(`#hub-a-${a}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  // Decisions made on any other page (crew swaps, sign-offs, rebookings, approval queue) show up here within a few seconds.
  const poll = async () => {
    if (!box.isConnected) return clearInterval(S.hubTimer);
    try { decs = (await api(`/api/hub/${id}`)).decisions; known ||= new Set(decs.filter((x) => new Date(x.ts.replace(" ", "T")) < hubStart).map((x) => x.id)); draw(); } catch { /* keep the last view */ }
  };
  clearInterval(S.hubTimer); S.hubTimer = setInterval(poll, 8000);
  draw(); poll();
  return open;
}

// ---------- shell ----------
async function refreshBell() {
  try { const { notifications } = await api("/api/decisions"); $("#bellN").textContent = notifications.length;
    $("#bell").innerHTML = `<h3>Notifications to personnel</h3>${notifList(notifications.slice(0, 30))}`; } catch { /* ignore */ }
}
$("#bellBtn").onclick = () => ($("#bell").hidden = !$("#bell").hidden);
// hamburger menu: sections open from a left sidebar
const menu = (open) => { document.body.classList.toggle("menu-open", open); $("#menuBtn").setAttribute("aria-expanded", open); };
$("#menuBtn").onclick = () => menu(!document.body.classList.contains("menu-open"));
$("#scrim").onclick = () => menu(false);
$("#sidebar").onclick = (e) => { const k = e.target.closest("[data-sec]")?.dataset.sec; if (k) { menu(false); location.hash = `#/tab/${k}`; } };
const drawMenu = () => ($("#sidebar nav").innerHTML = SECTIONS.map(([k, l, g], i) =>
  `${g !== SECTIONS[i - 1]?.[2] ? `<div class="nav-group">${g}</div>` : ""}<button data-sec="${k}" class="${S.tab === k && !location.hash.match(/flight/) ? "on" : ""}">${l}</button>`).join(""));
document.addEventListener("keydown", (e) => e.key === "Escape" && menu(false));
$("#reset").onclick = async () => { if (confirm("Reset the whole demo dataset?")) { await api("/api/reset", {}); S.tab = "map"; location.hash = "#/"; route(); } };
async function route() {
  const [, view, id] = location.hash.split("/");
  $("#view").onclick = null;
  DecisionLog.stopPlayback(); // a live demo call in the Decision log stops (and its transcript drawer closes) when you leave it
  globe?._destructor(); globe = null; // stop the globe's render loop when leaving the map
  if (view === "tab" && SECTIONS.some(([k]) => k === id)) S.tab = id;
  if (view === "lab") { S.flight = id || S.flight; S.tab = "hub"; S.hubBack = null; } // old hub links open the Decision hub tab
  if (S.tab !== "hub") clearInterval(S.hubTimer);
  try { view === "flight" ? await reportView(id) : await mainView(); } catch (e) { toast(e.message, "bad"); }
  // a page opened from a hub stage counts as reviewing that stage; offer the way back
  if (S.hubBack && location.hash === S.hubBack.href) {
    S.hubBack.keys.forEach((k) => (hubSeen[k] = Date.now())); saveSeen();
    $("#view").insertAdjacentHTML("afterbegin", `<a class="hub-back" href="#/lab/${h(S.hubBack.fid)}">← Back to Decision hub · ${h(S.hubBack.fid)}</a>`);
  }
  refreshBell();
  drawMenu();
  globeScroll();
}
window.onhashchange = () => { // after the intro, page changes land at the top of the console, not back in the sky
  const top = $("#app").offsetTop; // skip past the intro
  if (window.scrollY > top) window.scrollTo(0, top);
  route();
};
route();
if (window.createFlight) createFlight().openShade(); // intro: shade lifts, scroll flies through the window into the OCC
