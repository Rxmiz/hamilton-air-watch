// Hamilton Air Watch — front end. Plain JS + Leaflet, data from ./data/*.json (built by scripts/).
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const [readings, fac, attrAll] = await Promise.all(
  ['readings', 'facilities', 'attribution'].map(f => fetch(`data/${f}.json`, { cache: 'no-cache' }).then(r => r.json())));

// readings.grid is a compact hourly grid (see scripts/lib/grid.mjs) → [[utcIso, value], ...] per series
readings.series = {};
{
  const t0 = Date.parse(readings.grid.t0);
  for (const [st, ps] of Object.entries(readings.grid.series)) {
    readings.series[st] = {};
    for (const [p, arr] of Object.entries(ps)) {
      const pairs = [];
      arr.forEach((v, i) => { if (v != null) pairs.push([new Date(t0 + i * 3600e3).toISOString().slice(0, 13) + ':00Z', v]); });
      readings.series[st][p] = pairs;
    }
  }
}

const P = attrAll.pollutants;
const WINDOWS = attrAll.model.windows;
const facilities = new Map(fac.facilities.map(f => [f.id, f]));
const stations = new Map(readings.stations.map(s => [s.id, s]));

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };
const savedWindow = +store.get('haw.window');
const state = { pollutant: 'ALL', window: WINDOWS.includes(savedWindow) ? savedWindow : 30, tab: 'culprits', detail: null, history: [] };

// `attr` = the scoring results for the selected history window (+ shared fields)
let attr, culpritById;
function selectWindow(days) {
  state.window = days;
  const w = attrAll.windows[days];
  attr = { ...attrAll, ...w, window: { days, from: w.from } };
  culpritById = new Map(attr.culprits.map(c => [c.id, c]));
}
selectWindow(state.window);
const inWindow = data => { const from = Date.parse(attr.window.from); return data.filter(([t]) => Date.parse(t) >= from); };

// ---------- formatting ----------
const tFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', weekday: 'short', hour: 'numeric', hour12: true });
const dFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const when = iso => tFmt.format(new Date(iso));
const fmtNum = (v, d = 1) => v == null ? '–' : (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (+v.toFixed(d)).toString());
const tonnes = t => t >= 1 ? `${fmtNum(t)} t` : `${fmtNum(t * 1000)} kg`;
const compass = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(d / 22.5) % 16];

// Status = reading as a fraction of Ontario's Ambient Air Quality Criterion (AAQC):
//   Normal < 50 % ≤ Elevated < 80 % ≤ High ≤ 100 % < Above limit.
// Pollutants with a 1-hour AAQC are judged on the hourly reading. Pollutants that only have a 24-hour AAQC
// (PM2.5, PM10, benzene) are judged on the 24-hour average ending at that hour, as the criterion intends.
const BANDS = { elevated: 0.5, high: 0.8 };
const STATUS = {
  good: { label: 'Normal', color: '--good' },
  warning: { label: 'Elevated', color: '--warning' },
  serious: { label: 'High', color: '--serious' },
  critical: { label: 'Above Ontario limit', color: '--critical' },
  none: { label: 'No data', color: '--nodata' },
};
const limitOf = key => P[key].aaqc1h != null
  ? { value: P[key].aaqc1h, basis: '1h' } : { value: P[key].aaqc24h, basis: '24h' };

// Mean of the readings in the 24 h ending at `t`; null if fewer than 18 of those hours have data.
function avg24(stationId, key, t) {
  const s = readings.series[stationId]?.[key];
  if (!s) return null;
  const end = Date.parse(t), start = end - 24 * 3600e3;
  let sum = 0, n = 0;
  for (const [tt, v] of s) { const ms = Date.parse(tt); if (ms > start && ms <= end) { sum += v; n++; } }
  return n >= 18 ? sum / n : null;
}

// The value a reading is judged on: the hourly value, or the 24-h average for 24-h criteria.
function assessed(key, v, stationId, t) {
  return limitOf(key).basis === '1h' ? v : avg24(stationId, key, t);
}

function statusOf(key, v, stationId, t) {
  // Banded on the same rounded % the UI displays, so "80%" never reads as Elevated.
  const pct = pctOfLimit(key, v, stationId, t);
  if (pct == null) return 'none';
  if (pct > 100) return 'critical';
  if (pct >= BANDS.high * 100) return 'serious';
  if (pct >= BANDS.elevated * 100) return 'warning';
  return 'good';
}
const pctOfLimit = (key, v, stationId, t) => {
  const val = assessed(key, v, stationId, t);
  return val == null ? null : Math.round(100 * val / limitOf(key).value);
};
const rankStatus = ['none', 'good', 'warning', 'serious', 'critical'];
const badge = st => `<span class="badge"><span class="dot" style="background:var(${STATUS[st].color})"></span>${STATUS[st].label}</span>`;

function latest(stationId, key) {
  const s = readings.series[stationId]?.[key];
  if (!s?.length) return null;
  const [t, v] = s.at(-1);
  // stale if older than 3 h behind the newest HAMN hour
  return { t, v, stale: Date.parse(newestHour) - Date.parse(t) > 3 * 3600e3 };
}
const newestHour = Object.values(readings.series).flatMap(s => Object.values(s).map(x => x.at(-1)?.[0])).filter(Boolean).sort().at(-1);

function stationStatus(id) {
  const keys = state.pollutant === 'ALL' ? Object.keys(P) : [state.pollutant];
  let worst = 'none';
  for (const k of keys) {
    const l = latest(id, k);
    if (!l || l.stale) continue;
    const st = statusOf(k, l.v, id, l.t);
    if (rankStatus.indexOf(st) > rankStatus.indexOf(worst)) worst = st;
  }
  return worst;
}
const measures = (id, key) => key === 'ALL' ? Object.keys(P).some(k => readings.series[id]?.[k]) : !!readings.series[id]?.[key];

// ---------- header ----------
function renderHeader() {
  $('#updated').textContent = `Sensor data through ${dFmt.format(new Date(newestHour))} · ${attr.window.days}-day window · built ${dFmt.format(new Date(attr.generated))}`;
  const aq = readings.aqhi?.stations || [];
  if (!aq.length) { $('#aqhi').innerHTML = '<span class="muted">AQHI unavailable</span>'; return; }
  const cat = v => v <= 3 ? ['Low risk', 'good'] : v <= 6 ? ['Moderate risk', 'warning'] : v <= 10 ? ['High risk', 'serious'] : ['Very high risk', 'critical'];
  const vals = aq.map(s => ({ name: s.name.replace('Hamilton ', ''), v: s.series.at(-1)?.[1], t: s.series.at(-1)?.[0] })).filter(x => x.v != null);
  const worst = vals.reduce((a, b) => (b.v > a.v ? b : a), vals[0]);
  const [label, st] = cat(Math.round(worst.v));
  const fc = readings.aqhi.forecast?.length ? Math.max(...readings.aqhi.forecast.map(f => f.aqhi)) : null;
  $('#aqhi').innerHTML = `
    <div class="aqhi-hero" title="Highest current AQHI among Hamilton-area federal stations">
      <span class="aqhi-value">${Math.round(worst.v)}</span>
      <div class="aqhi-meta"><strong><span class="dot" style="background:var(${STATUS[st].color})"></span> AQHI · ${label}</strong><br>
      ${esc(worst.name)} · ${when(worst.t)}${fc != null ? ` · next 24 h peak ${fc}` : ''}</div>
    </div>
    <div class="aqhi-stations">${vals.map(x => `<span class="aqhi-pill">${esc(x.name)} <b>${fmtNum(x.v)}</b></span>`).join('')}</div>`;
}

// ---------- chips ----------
function renderChips() {
  const opts = [['ALL', 'All'], ...Object.entries(P).map(([k, p]) => [k, p.short])];
  $('#chips').innerHTML = opts.map(([k, l]) => `<button class="chip" role="radio" aria-checked="${state.pollutant === k}" data-k="${k}">${l}</button>`).join('');
  $('#chips').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.pollutant = b.dataset.k; renderChips(); renderMap(); renderPanel();
  };
  $('#windows').innerHTML = WINDOWS.map(d => `<button class="chip" role="radio" aria-checked="${state.window === d}" data-w="${d}">${d} days</button>`).join('');
  $('#windows').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    selectWindow(+b.dataset.w); store.set('haw.window', b.dataset.w);
    // spike ids are per-window, so drop any open spike (and history that might reference one)
    if (state.detail?.type === 'event') { state.detail = null; state.tab = 'culprits'; $('#detailTab').hidden = true; }
    state.history = state.history.filter(d => d.type !== 'event');
    renderHeader(); renderChips(); renderMap(); setTab(state.tab);
  };
}

// ---------- map ----------
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([43.255, -79.80], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'basemap',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Data: HAMN, ECCC (NPRI, AQHI), Open-Meteo',
}).addTo(map);
map.createPane('stationsPane').style.zIndex = 650; // monitors draw above facility squares
const layers = { overlay: L.layerGroup().addTo(map), facilities: L.layerGroup().addTo(map), wind: L.layerGroup().addTo(map), stations: L.layerGroup().addTo(map) };

function facScore(id) {
  const c = culpritById.get(id);
  if (!c) return 0;
  return state.pollutant === 'ALL' ? c.score : (c.byPollutant[state.pollutant] || 0);
}
function emits(f) { return state.pollutant === 'ALL' || (f.air[state.pollutant] || 0) > 0; }

function renderMap() {
  layers.facilities.clearLayers(); layers.stations.clearLayers(); layers.wind.clearLayers();
  const max = Math.max(...[...facilities.keys()].map(facScore), 1e-9);
  const cand = new Set(state.detail?.type === 'event' ? attr.events[state.detail.id].candidates.map(c => c.id) : []);
  for (const f of facilities.values()) {
    const s = facScore(f.id);
    const size = Math.round(10 + 22 * Math.sqrt(s / max));
    const cls = ['fac-icon', s === 0 || !emits(f) ? 'dim' : '', state.detail?.type === 'facility' && state.detail.id === f.id ? 'sel' : '', cand.has(f.id) ? 'cand' : ''].join(' ');
    const m = L.marker([f.lat, f.lon], {
      icon: L.divIcon({ className: '', html: `<div class="${cls}" style="width:${size}px;height:${size}px"></div>`, iconSize: [size, size] }),
      zIndexOffset: Math.round(s / max * 100), keyboard: true, title: f.name,
    });
    const share = culpritById.get(f.id);
    m.bindTooltip(`<b>${esc(f.name)}</b><br>${esc(f.sector || f.naics)}<br>${share ? `Culprit share: <b>${share.pct}%</b>` : `Not implicated in the last ${attr.window.days} days`}`, { direction: 'top', offset: [0, -size / 2] });
    m.on('click', () => openDetail({ type: 'facility', id: f.id }));
    m.addTo(layers.facilities);
  }
  for (const s of stations.values()) {
    const has = measures(s.id, state.pollutant);
    const st = stationStatus(s.id);
    const isWindOnly = !Object.keys(P).some(k => readings.series[s.id]?.[k]);
    if (isWindOnly && state.pollutant !== 'ALL') { addWind(s); continue; }
    const m = L.circleMarker([s.lat, s.lon], {
      pane: 'stationsPane', radius: isWindOnly ? 4 : 8, weight: 2, color: css('--surface-1'),
      fillColor: has ? css(STATUS[st].color) : css('--nodata'), fillOpacity: has ? 1 : 0.6,
    });
    const keys = Object.keys(P).filter(k => readings.series[s.id]?.[k]);
    const lines = keys.map(k => {
      const l = latest(s.id, k), pct = pctOfLimit(k, l.v, s.id, l.t);
      const avg = limitOf(k).basis === '24h' ? ` · 24-h avg ${fmtNum(avg24(s.id, k, l.t))}` : '';
      return `${P[k].short}: <b>${fmtNum(l.v)}</b> ${P[k].units}${avg}${pct != null ? ` (${pct}% of limit)` : ''}${l.stale ? ' <span style="opacity:.6">(stale)</span>' : ''}`;
    });
    m.bindTooltip(`<b>${esc(s.name)}</b><br>${lines.join('<br>') || 'Wind only'}`, { direction: 'top', offset: [0, -8] });
    m.on('click', () => openDetail({ type: 'station', id: s.id }));
    m.addTo(layers.stations);
    addWind(s);
  }
  renderOverlay();
  renderLegend();
}

function addWind(s) {
  const wd = readings.series[s.id]?.WD?.at(-1), ws = readings.series[s.id]?.WS?.at(-1);
  if (!wd || !ws || wd[0] !== newestHour) return;
  const rot = (wd[1] + 180) % 360; // arrow points where the wind blows TO
  const len = Math.min(34, 14 + ws[1]);
  const html = `<svg width="40" height="40" viewBox="-20 -20 40 40" style="transform:rotate(${rot}deg)"><line x1="0" y1="${len / 2}" x2="0" y2="${-len / 2}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M-4 ${-len / 2 + 5} L0 ${-len / 2} L4 ${-len / 2 + 5}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'wind-icon', html, iconSize: [40, 40] }), interactive: false, zIndexOffset: -500 }).addTo(layers.wind);
}

// Upwind cone + candidate links for a selected spike
function renderOverlay() {
  layers.overlay.clearLayers();
  if (state.detail?.type !== 'event') return;
  const e = attr.events[state.detail.id];
  const s = stations.get(e.station);
  const R = attr.model.maxDistanceKm, half = attr.model.coneHalfWidthDeg;
  const dest = (b, km) => {
    const δ = km / 6371, θ = b * Math.PI / 180, φ1 = s.lat * Math.PI / 180, λ1 = s.lon * Math.PI / 180;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI];
  };
  const pts = [[s.lat, s.lon]];
  for (let b = e.wind.dir - half; b <= e.wind.dir + half; b += 5) pts.push(dest(b, R));
  L.polygon(pts, { color: css('--warning'), weight: 1, fillColor: css('--warning'), fillOpacity: 0.12, interactive: false }).addTo(layers.overlay);
  for (const c of e.candidates) {
    const f = facilities.get(c.id);
    L.polyline([[s.lat, s.lon], [f.lat, f.lon]], { color: css('--text-secondary'), weight: 1 + 3 * c.share, dashArray: '4 4', interactive: false }).addTo(layers.overlay);
  }
}

function renderLegend() {
  const pl = state.pollutant === 'ALL' ? 'worst current reading' : `current ${P[state.pollutant].short}`;
  const wasOpen = $('#legend details')?.open ?? !matchMedia('(max-width: 900px)').matches;
  $('#legend').innerHTML = `<details ${wasOpen ? 'open' : ''}><summary>Legend</summary>
    <h4>Monitors · ${pl}</h4>
    ${[['good', '< 50%'], ['warning', '50–80%'], ['serious', '80–100%'], ['critical', '> 100%'], ['none', '']].map(([k, r]) =>
      `<div class="row"><span class="dot" style="background:var(${STATUS[k].color})"></span>${STATUS[k].label}${r ? ` <span class="muted">${r}</span>` : ''}</div>`).join('')}
    <div class="row muted" style="font-size:11px">% of Ontario's limit (24-h avg for PM, benzene)</div>
    <h4 style="margin-top:8px">Facilities (NPRI)</h4>
    <div class="row"><span class="sq"></span>Bigger square = larger culprit share</div>
    <div class="row"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 13V2M3 6l4-4 4 4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"/></svg>Wind blowing toward</div></details>`;
}

// ---------- panel ----------
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === tab));
  renderPanel();
}
document.querySelector('.tabs').onclick = e => { const t = e.target.closest('.tab'); if (t) setTab(t.dataset.tab); };

function openDetail(d, push = true) {
  if (push && state.detail) state.history.push(state.detail);
  state.detail = d;
  $('#detailTab').hidden = false;
  setTab('detail');
  renderMap();
  if (d.type === 'facility') { const f = facilities.get(d.id); map.panTo([f.lat, f.lon]); }
  if (d.type === 'station') { const s = stations.get(d.id); map.panTo([s.lat, s.lon]); }
  if (d.type === 'event') {
    const e = attr.events[d.id], s = stations.get(e.station);
    const pts = [[s.lat, s.lon], ...e.candidates.map(c => facilities.get(c.id)).map(f => [f.lat, f.lon])];
    map.flyToBounds(L.latLngBounds(pts).pad(0.3), { duration: 0.5, maxZoom: 14 });
  }
}

function renderPanel() {
  const body = $('#panelBody');
  if (state.tab === 'culprits') body.innerHTML = culpritsView();
  else if (state.tab === 'spikes') body.innerHTML = spikesView();
  else body.innerHTML = detailView();
  body.scrollTop = 0;
  bindPanel(body);
}

function culpritsView() {
  const k = state.pollutant;
  const rows = attr.culprits.map(c => ({ c, s: k === 'ALL' ? c.score : (c.byPollutant[k] || 0) })).filter(r => r.s > 0).sort((a, b) => b.s - a.s);
  const tot = rows.reduce((a, r) => a + r.s, 0) || 1;
  const lbl = k === 'ALL' ? 'all tracked pollutants' : P[k].label;
  if (!rows.length) return `<p class="intro">No elevated ${esc(lbl)} readings with a usable wind direction in the last ${attr.window.days} days. Either it's been quiet, or no monitor measures it.</p>`;
  return `<p class="intro">Share of the past ${attr.window.days} days' pollution spikes (${esc(lbl)}) that points back to each facility, based on wind direction, distance and reported emissions. <a href="#" data-how>How is this calculated?</a></p>
    <ol class="rank">${rows.slice(0, 20).map((r, i) => {
      const f = facilities.get(r.c.id), pct = 100 * r.s / tot;
      const top = Object.entries(r.c.norm).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => P[p].short).join(', ');
      return `<li><button data-fac="${f.id}"><span class="pos">${i + 1}</span><span class="name">${esc(f.name)}</span><span class="val">${pct.toFixed(pct < 10 ? 1 : 0)}%</span>
        <span class="bar"><i style="width:${(100 * r.s / rows[0].s).toFixed(1)}%"></i></span>
        <span class="meta">${esc(f.sector || f.naics)}${k === 'ALL' ? ` · mostly ${top}` : ` · reports ${tonnes(f.air[k] || 0)}/yr`}</span></button></li>`;
    }).join('')}</ol>`;
}

function spikesView() {
  const k = state.pollutant;
  const evs = attr.events.map((e, i) => ({ e, i })).filter(x => k === 'ALL' || x.e.pollutant === k)
    .sort((a, b) => b.e.excess - a.e.excess).slice(0, 40);
  if (!evs.length) return `<p class="intro">No spikes recorded for this pollutant in the window.</p>`;
  return `<p class="intro">The biggest hourly readings above trigger levels. Pick one to see the upwind cone and the facilities inside it.</p>
    <ol class="rank spike">${evs.map(({ e, i }) => {
      const s = stations.get(e.station), top = e.candidates[0] && facilities.get(e.candidates[0].id);
      const st = statusOf(e.pollutant, e.value, e.station, e.t);
      return `<li><button data-ev="${i}"><span class="dot" style="background:var(${STATUS[st].color})" title="${STATUS[st].label}"></span>
        <span class="name">${P[e.pollutant].short} ${fmtNum(e.value)} ${P[e.pollutant].units}</span><span class="val muted" style="font-weight:400">${when(e.t)}</span>
        <span class="meta">${esc(s.name)}<br>Wind from ${compass(e.wind.dir)} at ${fmtNum(e.wind.speed, 0)} km/h · ${top ? `likely: <b>${esc(top.name)}</b> (${Math.round(e.candidates[0].share * 100)}%)` : 'no reporting facility upwind'}</span></button></li>`;
    }).join('')}</ol>`;
}

function backLink() { return state.history.length ? `<button class="back" data-back>← Back</button>` : ''; }

function detailView() {
  const d = state.detail;
  if (!d) return '';
  if (d.type === 'station') return stationView(d.id);
  if (d.type === 'facility') return facilityView(d.id);
  return eventView(d.id);
}

function stationView(id) {
  const s = stations.get(id);
  const keys = Object.keys(P).filter(k => readings.series[id]?.[k]);
  const stats = attr.stationStats[id] || {};
  const focus = state.pollutant !== 'ALL' && keys.includes(state.pollutant) ? state.pollutant : keys[0];
  const implicated = attr.culprits.map(c => ({ c, v: c.byStation[id] || 0 })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 5);
  const totImp = implicated.reduce((a, x) => a + x.v, 0) || 1;
  return `${backLink()}<div class="detail-head"><h2>${esc(s.name)}</h2><p>HAMN monitor${s.mobile ? ' (mobile)' : ''} · ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</p></div>
    ${keys.length ? `<div class="section-title">Latest readings</div>
    <div class="kv"><div class="hdr"><span>Pollutant</span><span>Now</span><span>% of limit</span></div>
    ${keys.map(k => {
      const l = latest(id, k), is24 = limitOf(k).basis === '24h', pct = pctOfLimit(k, l.v, id, l.t);
      const a = is24 ? avg24(id, k, l.t) : null;
      return `<div><span>${P[k].label} ${l.stale ? '<span class="muted">(stale)</span>' : badge(statusOf(k, l.v, id, l.t))}</span>
        <span>${fmtNum(l.v)} ${P[k].units}${is24 ? `<br><span class="muted">24-h avg ${fmtNum(a)}</span>` : ''}</span>
        <span>${pct == null ? '–' : pct + '%'}</span></div>`;
    }).join('')}</div>
    <p class="chart-caption">% of Ontario's limit: under 50% Normal, 50–80% Elevated, 80–100% High. PM and benzene limits apply to 24-hour averages, so those are judged on the average.</p>
    ${focus ? `<div class="section-title">${P[focus].label} — last ${attr.window.days} days</div>
      <div class="chips" style="margin-bottom:6px">${keys.map(k => `<button class="chip" data-focus="${k}" aria-checked="${k === focus}">${P[k].short}</button>`).join('')}</div>
      <div class="chart-wrap" id="ts"></div>
      <div class="section-title">Where ${P[focus].short} comes from</div>
      <div class="chart-wrap" id="rose"></div>
      <p class="chart-caption">Average ${P[focus].short} by the direction the wind blew <em>from</em>. A long petal pointing at a plant is strong evidence.</p>` : ''}` : '<p class="callout">This station only measures wind. It\'s used to work out where pollution at nearby monitors came from.</p>'}
    ${implicated.length ? `<div class="section-title">Facilities most implicated here</div>
    <ol class="rank">${implicated.map((x, i) => { const f = facilities.get(x.c.id); return `<li><button data-fac="${f.id}"><span class="pos">${i + 1}</span><span class="name">${esc(f.name)}</span><span class="val">${Math.round(100 * x.v / totImp)}%</span><span class="bar"><i style="width:${100 * x.v / implicated[0].v}%"></i></span></button></li>`; }).join('')}</ol>` : ''}`;
}

function facilityView(id) {
  const f = facilities.get(id), c = culpritById.get(id);
  const tracked = Object.entries(f.air).sort((a, b) => b[1] - a[1]);
  return `${backLink()}<div class="detail-head"><h2>${esc(f.name)}</h2><p>${esc(f.company)}<br>${esc(f.address)} · ${esc(f.sector || f.naics)}</p></div>
    ${c ? `<div class="callout"><strong>${c.pct}%</strong> of all spike "blame" in the last ${attr.window.days} days points here (rank #${attr.culprits.indexOf(c) + 1} of ${attr.culprits.length}).</div>` : `<div class="callout">Not upwind of any elevated readings in the last ${attr.window.days} days.</div>`}
    ${c ? `<div class="section-title">Blame by pollutant</div>
      <ol class="rank">${Object.entries(c.norm).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li><button data-setp="${k}"><span class="pos"></span><span class="name">${P[k].label}</span><span class="val">${Math.round(100 * v / c.score)}%</span><span class="bar"><i style="width:${100 * v / c.score}%"></i></span></button></li>`).join('')}</ol>
      <div class="section-title">Strongest evidence</div>
      <ol class="rank spike">${c.topEvents.slice(0, 8).map(i => { const e = attr.events[i], s = stations.get(e.station), mine = e.candidates.find(x => x.id === id);
        return `<li><button data-ev="${i}"><span class="dot" style="background:var(${STATUS[statusOf(e.pollutant, e.value, e.station, e.t)].color})"></span><span class="name">${P[e.pollutant].short} ${fmtNum(e.value)} at ${esc(s.name)}</span><span class="val muted" style="font-weight:400">${when(e.t)}</span>
        <span class="meta">${mine ? `${mine.distKm} km upwind, ${mine.offAxisDeg}° off-axis · ${Math.round(mine.share * 100)}% of this spike` : ''}</span></button></li>`; }).join('')}</ol>` : ''}
    <div class="section-title">Reported air releases (NPRI ${f.year})</div>
    <div class="kv"><div class="hdr"><span>Substance</span><span>Per year</span><span></span></div>
      ${tracked.map(([k, t]) => `<div><span>${P[k].label}</span><span>${tonnes(t)}</span><span></span></div>`).join('')}</div>
    <p class="chart-caption">Other top air releases: ${f.topAir.filter(x => !Object.values(P).some(p => p.npri.includes(x.substance))).slice(0, 5).map(x => `${esc(x.substance)} (${tonnes(x.tonnes)})`).join(', ') || '—'}.</p>
    <p class="chart-caption"><a href="https://pollution-waste.canada.ca/national-release-inventory/archives/index.cfm?do=facility_substance_summary&lang=en&opt_npri_id=${encodeURIComponent(f.id)}&opt_report_year=${f.year}" target="_blank" rel="noopener">Full NPRI report for this facility ↗</a></p>`;
}

function eventView(i) {
  const e = attr.events[i], s = stations.get(e.station), p = P[e.pollutant], st = statusOf(e.pollutant, e.value, e.station, e.t);
  const L = limitOf(e.pollutant), a24 = L.basis === '24h' ? avg24(e.station, e.pollutant, e.t) : null;
  const bg = attr.stationStats[e.station]?.[e.pollutant]?.background;
  return `${backLink()}<div class="detail-head"><h2>${p.short} spike at ${esc(s.name)}</h2><p>${dFmt.format(new Date(e.t))}</p></div>
    <div class="kv" style="margin-top:12px">
      <div><span>Hourly reading</span><span>${fmtNum(e.value)} ${p.units}</span><span>${L.basis === '1h' ? badge(st) : ''}</span></div>
      ${L.basis === '24h' ? `<div><span>24-h average to this hour</span><span>${fmtNum(a24)} ${p.units}</span><span>${badge(st)}</span></div>` : ''}
      <div><span>Station's usual level (median)</span><span>${fmtNum(bg)} ${p.units}</span><span></span></div>
      <div><span>Ontario limit</span><span>${L.value} ${p.units} (${L.basis === '1h' ? '1-h' : '24-h avg'})</span><span>${pctOfLimit(e.pollutant, e.value, e.station, e.t) ?? '–'}%</span></div>
      <div><span>Wind</span><span>from ${compass(e.wind.dir)} (${Math.round(e.wind.dir)}°), ${fmtNum(e.wind.speed, 0)} km/h</span><span></span></div>
    </div>
    <p class="chart-caption">${e.wind.from === 'own' ? 'Wind measured at this station.' : e.wind.from === 'model' ? 'Wind from Open-Meteo (no nearby anemometer reading).' : `Wind borrowed from nearest station: ${esc(stations.get(e.wind.from)?.name)}.`} The shaded cone on the map is the upwind search area.</p>
    <div class="section-title">Facilities in the upwind cone</div>
    ${e.candidates.length ? `<ol class="rank">${e.candidates.map((c, j) => { const f = facilities.get(c.id); return `<li><button data-fac="${f.id}"><span class="pos">${j + 1}</span><span class="name">${esc(f.name)}</span><span class="val">${c.share < 0.005 ? '<1' : Math.round(c.share * 100)}%</span><span class="bar"><i style="width:${c.share * 100}%"></i></span><span class="meta">${c.distKm} km away · ${c.offAxisDeg}° off the wind line · reports ${tonnes(f.air[e.pollutant])}/yr</span></button></li>`; }).join('')}</ol>`
      : '<p class="callout">No NPRI facility reporting this pollutant sits upwind. Likely a non-industrial source (traffic, rail, ships, construction) or a facility below reporting thresholds.</p>'}`;
}

function bindPanel(body) {
  body.onclick = e => {
    const t = e.target.closest('[data-fac],[data-ev],[data-back],[data-focus],[data-setp],[data-how]');
    if (!t) return;
    if (t.dataset.how !== undefined) { e.preventDefault(); $('#how').showModal(); return; }
    if (t.dataset.fac) openDetail({ type: 'facility', id: t.dataset.fac });
    else if (t.dataset.ev) openDetail({ type: 'event', id: +t.dataset.ev });
    else if (t.dataset.back !== undefined) { openDetail(state.history.pop(), false); }
    else if (t.dataset.setp) { state.pollutant = t.dataset.setp; renderChips(); setTab('culprits'); renderMap(); }
    else if (t.dataset.focus) { state.focus = t.dataset.focus; drawStationCharts(state.detail.id, t.dataset.focus); body.querySelectorAll('[data-focus]').forEach(b => b.setAttribute('aria-checked', b === t)); }
  };
  if (state.tab === 'detail' && state.detail?.type === 'station') {
    const keys = Object.keys(P).filter(k => readings.series[state.detail.id]?.[k]);
    const focus = state.pollutant !== 'ALL' && keys.includes(state.pollutant) ? state.pollutant : keys[0];
    if (focus) drawStationCharts(state.detail.id, focus);
  }
}

// ---------- charts ----------
const tip = $('#tip');
function showTip(html, x, y) { tip.innerHTML = html; tip.hidden = false; const r = tip.getBoundingClientRect(); tip.style.left = Math.min(x + 12, innerWidth - r.width - 8) + 'px'; tip.style.top = (y - r.height - 12) + 'px'; }
function hideTip() { tip.hidden = true; }

function drawStationCharts(id, key) {
  drawTimeSeries($('#ts'), inWindow(readings.series[id][key]), P[key]);
  drawRose($('#rose'), attr.roses[id]?.[key], P[key]);
}

function drawTimeSeries(el, data, p) {
  if (!el) return;
  const W = el.clientWidth || 380, H = 170, m = { l: 34, r: 8, t: 10, b: 22 };
  const ts = data.map(d => Date.parse(d[0])), vs = data.map(d => d[1]);
  const limit = p.aaqc1h ?? p.aaqc24h;
  const yMax = Math.max(...vs, p.trigger) * 1.1 || 1;
  const showLimit = limit <= yMax * 1.6;
  const top = showLimit ? Math.max(yMax, limit * 1.08) : yMax;
  const x0 = ts[0], x1 = ts.at(-1);
  const X = t => m.l + (t - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
  const Y = v => H - m.b - v / top * (H - m.t - m.b);
  const ticks = niceTicks(top, 4);
  let path = '', area = '', prev = null;
  data.forEach(([t, v], i) => {
    const tt = ts[i], gap = prev != null && tt - prev > 2 * 3600e3;
    path += `${!i || gap ? 'M' : 'L'}${X(tt).toFixed(1)},${Y(v).toFixed(1)}`; prev = tt;
  });
  area = `M${X(ts[0])},${Y(0)}` + data.map((d, i) => `L${X(ts[i]).toFixed(1)},${Y(d[1]).toFixed(1)}`).join('') + `L${X(ts.at(-1))},${Y(0)}Z`;
  const days = [];
  const spanDays = (x1 - x0) / 864e5, stepDays = spanDays <= 8 ? 1 : spanDays <= 31 ? 7 : 14;
  for (let t = new Date(x0 + stepDays * 864e5); t <= x1; t = new Date(t.getTime() + stepDays * 864e5)) days.push(t);
  const dayFmt = new Intl.DateTimeFormat('en-CA', stepDays === 1 ? { timeZone: 'America/Toronto', weekday: 'short' } : { timeZone: 'America/Toronto', month: 'short', day: 'numeric' });
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(p.label)} hourly readings">
    ${ticks.map(v => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${showLimit ? `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${Y(limit)}" y2="${Y(limit)}"/><text class="ref-label" x="${W - m.r}" y="${Y(limit) - 4}" text-anchor="end">Ontario ${p.aaqc1h ? '1-h' : '24-h'} limit ${limit}</text>` : ''}
    ${days.map(d => `<text x="${X(d.getTime())}" y="${H - 6}" text-anchor="middle">${dayFmt.format(d)}</text>`).join('')}
    <path class="area" d="${area}"/><path class="line" d="${path}"/>
    <g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/><circle class="marker" r="4.5"/></g>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/>
  </svg><p class="chart-caption">${esc(p.units)} · hourly${showLimit ? '' : ` · Ontario limit (${limit}) is far above this range`}</p>`;
  const svg = el.querySelector('svg'), g = svg.querySelector('.hover');
  svg.querySelector('.hit').addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
    const t = x0 + (px - m.l) / (W - m.l - m.r) * (x1 - x0);
    let i = 0, best = Infinity; ts.forEach((tt, j) => { const d = Math.abs(tt - t); if (d < best) { best = d; i = j; } });
    g.style.display = ''; g.querySelector('line').setAttribute('x1', X(ts[i])); g.querySelector('line').setAttribute('x2', X(ts[i]));
    const c = g.querySelector('circle'); c.setAttribute('cx', X(ts[i])); c.setAttribute('cy', Y(vs[i]));
    showTip(`${dFmt.format(new Date(ts[i]))}<br><b>${fmtNum(vs[i])}</b> ${esc(p.units)}`, ev.clientX, ev.clientY);
  });
  svg.querySelector('.hit').addEventListener('pointerleave', () => { g.style.display = 'none'; hideTip(); });
}

function niceTicks(max, n) {
  const raw = max / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw);
  const out = []; for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6)); return out;
}

function drawRose(el, rose, p) {
  if (!el) return;
  if (!rose || rose.every(v => v == null)) { el.innerHTML = '<p class="chart-caption">Not enough wind data.</p>'; return; }
  const S = 220, c = S / 2, R = c - 22, max = Math.max(...rose.filter(v => v != null)) || 1;
  const steps = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'];
  const petal = (i, v) => {
    const r = 6 + (R - 6) * Math.sqrt(v / max), a0 = (i * 22.5 - 10) * Math.PI / 180, a1 = (i * 22.5 + 10) * Math.PI / 180;
    const pt = (a, rr) => `${(c + rr * Math.sin(a)).toFixed(1)},${(c - rr * Math.cos(a)).toFixed(1)}`;
    return `M${pt(a0, 4)}L${pt(a0, r)}A${r},${r} 0 0 1 ${pt(a1, r)}L${pt(a1, 4)}Z`;
  };
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" style="max-width:${S}px;margin:0 auto" role="img" aria-label="Pollution rose">
    ${[0.33, 0.66, 1].map(f => `<circle class="ring" cx="${c}" cy="${c}" r="${6 + (R - 6) * Math.sqrt(f)}"/>`).join('')}
    ${['N', 'E', 'S', 'W'].map((l, i) => { const a = i * Math.PI / 2; return `<text x="${c + (R + 12) * Math.sin(a)}" y="${c - (R + 12) * Math.cos(a) + 4}" text-anchor="middle">${l}</text>`; }).join('')}
    ${rose.map((v, i) => v == null ? '' : `<path class="petal" d="${petal(i, v)}" fill="var(${steps[Math.min(4, Math.floor(v / max * 4.999))]})" data-i="${i}" data-v="${v}"/>`).join('')}
  </svg>`;
  el.querySelectorAll('.petal').forEach(pt => {
    pt.addEventListener('pointermove', ev => showTip(`Wind from <b>${compass(pt.dataset.i * 22.5)}</b><br>avg <b>${fmtNum(+pt.dataset.v)}</b> ${esc(p.units)}`, ev.clientX, ev.clientY));
    pt.addEventListener('pointerleave', hideTip);
  });
}

// ---------- boot ----------
map.fitBounds(L.latLngBounds([...stations.values()].filter(s => !s.mobile).map(s => [s.lat, s.lon])).pad(0.15));
$('#howBtn').onclick = () => $('#how').showModal();
$('#howMeta').textContent = `Model: ±${attr.model.coneHalfWidthDeg}° upwind cone, ≤${attr.model.maxDistanceKm} km, winds ≥${attr.model.minWindKmh} km/h. ${attr.elevatedHours} elevated station-hours analysed. NPRI facilities: ${fac.facilities.length}.`;
renderHeader();
renderChips();
renderMap();
renderPanel();
