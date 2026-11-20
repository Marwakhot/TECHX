// AeroTurn OCC front end: hash router, no build step. All server text is escaped with h().
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

function decide(fid, title, actions, after, chaos = false) {
  askAuth(`Controller approval: ${h(title)}<div class="small muted" style="margin-top:6px">${actionsText(actions)}</div>` +
    (chaos ? '<p class="bad small">Chaos on: a competing booking grabs a seat mid-batch</p>' : ""),
  async (a) => { const r = await api("/api/decide", { flight_id: fid, title, actions, chaos, ...a }); resultToast(r); after(r); refreshBell(); },
  () => after(null));
}

// ---------- main page (sections are chosen from the sidebar menu) ----------
// Operations = the controller's daily workflow; Assurance = safety / compliance tools that prove the system can be trusted
const SECTIONS = [["map", "Live overview", "Operations"], ["crew", "Crew", "Operations"], ["pax", "Connecting passengers", "Operations"],
  ["mx", "Maintenance", "Operations"], ["log", "Decision log", "Operations"], ["attack", "Guard Attack Mode", "Assurance"], ["replay", "Audit replay", "Assurance"]];
async function mainView() {
  $("#view").innerHTML = `<section id="tab"></section><section id="cb-slot"></section>`; // cb-slot: U-4 curveball panels (curveballs.js)
  await { map: mapTab, crew: crewTab, pax: paxTab, mx: mxTab, log: logTab, attack: () => Extras.attackTab($("#tab")), replay: () => Extras.replayTab($("#tab")) }[S.tab]();
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
      <div class="brand"><h2 class="brand-name" aria-label="AeroTurn">${[..."AeroTurn"].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}</h2>
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
  render(d, $("#sub"));
}

// Crew: duty-time bars against the legal ceiling, grouped by role, with the nearest guard-approved standby suggested per member.
// Display only: swaps still go through decide() (controller name + PIN), and the dropdowns list only guard-approved standby.
const CREW_F = { f: "all" };
const crewTab = () => pickerTab((d, el) => {
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
  // each standby is suggested to at most one person, most over-limit first (the dropdown still lists every legal option)
  const sug = new Map(), given = new Set(busy);
  [...crew].sort((x, y) => x.margin - y.margin).forEach((c) => { const s = c.options.find((o) => !given.has(o.id)); if (s) { sug.set(c.id, s); given.add(s.id); } });
  const best = (c) => sug.get(c.id);
  const row = (c) => {
    const b = best(c), k = st(c);
    return `<div class="cw-row ${k}">
      <div class="cw-who"><span class="cw-av">${h(c.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2))}</span>
        <div><b>${h(c.name)}</b><small>${h(c.id)} · ${h(c.role)} · ${h(c.type_rating)}</small></div></div>
      <div class="cw-time">${bar(c)}<small>${c.duty_used} min used · ${c.projected_fdp} min projected at departure</small></div>
      <div class="cw-m ${k}"><b>${c.margin > 0 ? "+" : ""}${c.margin} min</b><small>${{ over: "over limit", tight: "tight", ok: "legal" }[k]}</small></div>
      <div class="cw-act">${k === "over" ? (b ? `<div class="cw-sug"><small>Suggested standby</small><b>${h(b.id)} · ${h(b.name)}</b><small>${h(b.location)} · ${b.walk_min} min walk</small>
          <button data-swap="${h(c.id)}|${h(b.id)}">Propose swap</button></div>` : `<p class="small bad">${c.options.length ? "Matching standby already suggested for a more urgent crew member" : "No legal standby available"}</p>`) : ""}
        <select data-crew="${h(c.id)}" aria-label="Choose standby for ${h(c.name)}"><option value="">${c.options.length ? (k === "over" ? "or choose another…" : "Swap with standby…") : "no legal standby"}</option>${c.options.map((s) =>
          `<option value="${h(s.id)}" ${busy.has(s.id) ? "disabled" : ""}>${h(s.id)} · ${h(s.name)} · ${h(s.location)} (${s.walk_min} min)${busy.has(s.id) ? " · already proposed" : ""}</option>`).join("")}</select></div></div>`;
  };
  const vis = crew.filter((c) => CREW_F.f === "all" || st(c) === CREW_F.f);
  const deck = vis.filter((c) => /^(CPT|FO|SO|CAP|CAPT)/i.test(c.role)), cabin = vis.filter((c) => !deck.includes(c));
  const group = (t, list) => list.length ? `<section class="cw-group"><div class="cw-gh"><h3>${t}</h3><span class="small muted">${list.filter((c) => c.margin < 0).length} of ${list.length} over limit</span></div>${list.map(row).join("")}</section>` : "";
  el.className = "cw";
  el.innerHTML = `
    <section class="px-kpis" aria-label="Crew summary">
      <div class="k main"><span>Outbound</span><b>${h(o.id)} <em>→ ${h(o.dest)}</em></b><small>${h(o.aircraft_type)} · departs T${sign(o.eff)}</small></div>
      <div class="k"><span>Over the legal limit</span><b class="${over.length ? "bad" : ""}">${over.length}</b><small>of ${crew.length} crew</small></div>
      <div class="k"><span>Tightest margin</span><b class="${worst < 0 ? "bad" : ""}">${worst > 0 ? "+" : ""}${worst} min</b><small>legal ceiling ${MAX} min</small></div>
      <div class="k"><span>Standby available</span><b>${[...pool.keys()].filter((x) => !busy.has(x)).length}</b><small>${busy.size ? `${busy.size} already proposed` : "guard-approved only"}</small></div>
    </section>
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
});

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
  $("#save").onclick = async () => {
    try { await api("/api/comms", { flight_id: id, speaker: $("#spk").value, text: $("#txt").value }); toast("Transcript saved, report updating"); reportView(id); }
    catch (e) { toast(e.message, "bad"); } };
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
    $("#rsrc").textContent = `${ai ? "AI" : "Rule-based fallback (AI unavailable)"}${ai && !sAi ? " · options rule-based" : ""} · ${String(r.generated || "").slice(11, 16)}`;
    $("#rsrc").title = `Report: ${r.source} · Options: ${r.suggestions_source || r.source} · ${r.generated} · from call transcripts + live data`;
    $("#sugg").innerHTML = r.suggestions.map((s, i) => `<div class="sugg x-pick" data-opt="${i}"><div class="muted small">Option ${i + 1}</div><b>${h(s.title)}</b>
      <p class="small clamp2" title="${h(s.why)}">${h(s.why)}</p><div class="small">${actionsText(s.actions)}</div>${s.revised_from ? `<div class="small warn" title="${h(shortIds(s.revised_from))}">↻ Revised after a guard refusal</div>` : ""}</div>`).join("");
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
  const net = k.network_delay_added > 30;
  c.push(["net", "Downstream network", !net, k.network_delay_added ? `Adds ${k.network_delay_added} min of delay to onward flights.` : "No onward flights are affected.", `Affected: ${k.network_delay_added} min of onward delay. Pick a plan with a shorter hold.`, null]);
  return c;
}
async function labView(id) {
  S.flight = id; S.hubPick = 0;
  $("#view").innerHTML = `<div class="row"><a href="#/flight/${h(id)}">← Live report ${h(id)}</a></div>
    <div class="hub"><h2 class="hub-title">Decision hub · ${h(id)}</h2><p class="hub-sub">Everything a scenario depends on, checked in one place.</p>
    <div class="hub-sec"><i>1</i>PRIORITIES</div>
    <div class="hub-row"><div class="hub-pills" id="hub-p">${HUB_P.map(([k, l]) => `<button class="hub-pill" data-p="${k}">${l}</button>`).join("")}</div>
      <button class="hub-regen" id="regen">Regenerate scenarios</button><span id="lsrc" class="muted small"></span></div>
    <p class="hub-note" id="hub-note"></p><div id="scen" class="hub-scen"></div><div id="hub-rest"></div></div>`;
  const mark = () => { const on = hubOn(S.prio); document.querySelectorAll("#hub-p .hub-pill").forEach((b) => b.classList.toggle("on", on.includes(b.dataset.p))); };
  $("#hub-p").onclick = (e) => { const b = e.target.closest("[data-p]"); if (!b) return; const ks = HUB_P.find(([k]) => k === b.dataset.p)[2], on = !ks.some((k) => S.prio[k]);
    ks.forEach((k) => (S.prio[k] = on)); mark(); $("#hub-note").innerHTML = '<b>Priorities changed.</b> Regenerate to build new scenarios for them.'; };
  $("#regen").onclick = () => loadLab(id, true);
  mark(); loadLab(id);
}
async function loadLab(id, regenerate = false) {
  $("#scen").innerHTML = `<p class="muted">${regenerate ? "Asking the agent for new scenarios, then dry-running them…" : "Dry-running the recommended scenarios…"}</p>`; $("#hub-rest").innerHTML = "";
  try {
    const c = await api("/api/compare", { flight_id: id, priorities: S.prio, regenerate, narrate: false }), rows = c.rows.slice(0, 3), used = hubOn(c.priorities);
    $("#lsrc").textContent = `Source: ${c.scenario_source}`;
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
          <div class="hub-st">${ok ? "✓ Ready" : "⚑ Issue"}</div><p>${h(txt)}</p>${ok ? "" : `<div class="hub-fix"><b>Fix this:</b> ${h(fix)}</div>${link ? `<a class="hub-go" href="${link[0]}">Go to ${h(link[1])} →</a>` : ""}`}</div>`).join("")}</div>
        <div class="hub-sec"><i>3</i>COST IMPACT · ESTIMATES</div>
        <div class="hub-cost"><div class="hub-box"><div class="hub-bh">TOTAL COST BY SCENARIO</div>${rows.map((r, i) => `<div class="hub-cr ${i === pick ? "on" : ""}"><span>Scenario ${L[i]}${r.ok && r.kpis.total_cost_eur === low ? "<em>Lowest</em>" : ""}</span>
            <div class="hub-tr"><i style="width:${r.ok ? (r.kpis.total_cost_eur / max) * 100 : 0}%"></i></div><b>${r.ok ? eur(r.kpis.total_cost_eur) : "—"}</b></div>`).join("")}</div>
          <div class="hub-box"><div class="hub-bh">WHERE THE COST COMES FROM: SCENARIO ${L[pick]}</div>
            <div class="hub-split">${parts.map(([l, v, c]) => `<div style="flex:${v};background:${c}"><small>${l}</small><b>${eur(v)}</b></div>`).join("") || '<p class="muted small">No cost estimate.</p>'}</div>
            <div class="hub-tot"><span>Estimated total</span><b>${s.ok ? eur(k.total_cost_eur) : "—"}</b></div></div></div>
        <div class="hub-sec"><i>4</i>REVIEW AND APPROVE</div><div id="hub-ap"></div>`;
      hubApprove(id, s, bad);
    };
    $("#scen").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) { S.hubPick = +b.dataset.i; draw(); } };
    S.hubPick = 0; draw();
  } catch (e) { toast(e.message, "bad"); $("#scen").innerHTML = `<p class="bad">${h(e.message)}</p>`; }
}

// Approval: what gets triggered, split by area. Approve unlocks only after every area tab has been opened (and all checks pass).
const HUB_AREAS = [["pax", "Passengers", ["REBOOK", "REBOOK_AT_RISK", "REBOOK_TIERS", "DELAY", "GATE_CHANGE", "DEPARTURE_RELEASE"]], ["crew", "Crew", ["CREW_SWAP", "CREW_AUTOSWAP"]], ["mx", "Maintenance", ["ASSIGN_ENGINEER"]]];
function hubApprove(id, s, bad) {
  const box = $("#hub-ap"), k = s.kpis || {}, acts = s.actions || [], rev = new Set(), of = (ks) => acts.filter((a) => ks.includes(a.kind));
  let tab = null;
  const summary = {
    pax: () => { const rb = of(["REBOOK", "REBOOK_AT_RISK", "REBOOK_TIERS"]), n = rb.filter((a) => a.kind === "REBOOK").length, batch = rb.some((a) => a.kind !== "REBOOK");
      return [[batch ? k.protected ?? "—" : n, "passengers rebooked"], [k.vulnerable_at_risk ?? "—", "vulnerable still at risk"], [k.at_risk ?? "—", "still miss their connection"], [`${k.network_delay_added ?? 0} min`, "onward delay added"]]; },
    crew: () => { const sw = of(["CREW_SWAP"]).length, auto = of(["CREW_AUTOSWAP"]).length;
      return [[auto ? "All illegal" : sw, auto ? "crew swapped to legal standby" : "crew swaps"], [k.crew_illegal ?? 0, "crew over the duty limit after"], [`${k.crew_min_margin ?? "—"} min`, "smallest duty margin"]]; },
    mx: () => [[of(["ASSIGN_ENGINEER"]).length, "engineer assignments"], [k.open_nogo ?? 0, "NO-GO items still open after"]] };
  const draw = () => {
    const all = rev.size === HUB_AREAS.length, ready = all && !bad.length, area = HUB_AREAS.find(([a]) => a === tab);
    box.innerHTML = `<div class="hub-rv"><div class="hub-rvt">${HUB_AREAS.map(([a, l, ks]) => `<button class="hub-rvb ${tab === a ? "on" : ""} ${rev.has(a) ? "seen" : ""}" data-a="${a}">
        <span>${rev.has(a) ? "✓" : "○"}</span>${l}<small>${of(ks).length} action${of(ks).length === 1 ? "" : "s"}</small></button>`).join("")}</div>
      <div class="hub-rvp">${area ? `<div class="hub-rvs">${summary[tab]().map(([v, l]) => `<div><b>${h(String(v))}</b><span>${h(l)}</span></div>`).join("")}</div>
        <div class="hub-bh">ACTIONS THAT WILL RUN ON APPROVAL</div><div class="hub-rva">${of(area[2]).length ? actionsText(of(area[2])) : '<span class="muted">No actions in this area. Nothing changes here.</span>'}</div>`
        : '<p class="muted">Open each area to see exactly what you are authorising. Approve unlocks once all three have been reviewed.</p>'}</div></div>
      <div class="hub-ap ${bad.length ? "r" : ready ? "g" : ""}"><div><h3>${bad.length ? `${bad.length} issue${bad.length > 1 ? "s" : ""} to fix first` : ready ? "Reviewed and ready" : `Review ${HUB_AREAS.length - rev.size} more area${HUB_AREAS.length - rev.size === 1 ? "" : "s"}`}</h3>
        <p>${bad.length ? h(bad.map((x) => x[3]).join(" ")) : `${rev.size} of ${HUB_AREAS.length} reviewed: ${HUB_AREAS.map(([a, l]) => `${rev.has(a) ? "✓" : "○"} ${l}`).join(" · ")}`}</p></div>
        <div class="hub-apr"><button id="hub-go" ${ready ? "" : "disabled"}>Approve operational plan</button><small>${ready ? `Runs ${acts.length} action${acts.length === 1 ? "" : "s"} as one step. Nothing is partly applied.` : "Locked until every area is reviewed and every check is ready."}</small></div></div>`;
    box.querySelector(".hub-rvt").onclick = (e) => { const b = e.target.closest("[data-a]"); if (!b) return; tab = b.dataset.a; rev.add(tab); draw(); };
    $("#hub-go").onclick = () => ready && decide(id, s.title, s.actions, (res) => res?.status === "APPROVED" && (location.hash = `#/flight/${id}`), false);
  };
  draw();
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
  `${g !== SECTIONS[i - 1]?.[2] ? `<div class="nav-group">${g}</div>` : ""}<button data-sec="${k}" class="${S.tab === k && !location.hash.match(/flight|lab/) ? "on" : ""}">${l}</button>`).join(""));
document.addEventListener("keydown", (e) => e.key === "Escape" && menu(false));
$("#reset").onclick = async () => { if (confirm("Reset the whole demo dataset?")) { await api("/api/reset", {}); S.tab = "map"; location.hash = "#/"; route(); } };
async function route() {
  const [, view, id] = location.hash.split("/");
  $("#view").onclick = null;
  DecisionLog.stopPlayback(); // a live demo call in the Decision log stops (and its transcript drawer closes) when you leave it
  globe?._destructor(); globe = null; // stop the globe's render loop when leaving the map
  if (view === "tab" && SECTIONS.some(([k]) => k === id)) S.tab = id;
  try { view === "flight" ? await reportView(id) : view === "lab" ? await labView(id) : await mainView(); } catch (e) { toast(e.message, "bad"); }
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
