// Upwind source attribution: for every elevated hourly reading, find the NPRI facilities that lie
// upwind of the sensor and emit that pollutant, then share the "excess" concentration among them.
//
// For one elevated hour at station S (pollutant p, value v, wind FROM direction θ):
//   excess      = (v − background) / trigger           background = station's median over the window
//   for each facility F emitting p within maxDistance:
//     Δ         = angle between θ and the bearing S→F
//     wAngle    = exp(−½ (Δ / σ)²),  σ = coneHalfWidth / 2      (only if Δ ≤ coneHalfWidth)
//     wDist     = 1 / max(d, 0.3 km)^1.5                         (plume dilution with distance)
//     wEmit     = annual air release of p (tonnes, NPRI)
//     w         = wAngle · wDist · wEmit
//   F's share of the excess = w / Σw   (candidates only)
// A facility's culprit score is the sum of its shares across all elevated hours, stations and pollutants.
// This is a screening heuristic, not a dispersion model — see the site's methodology section.
import { readFileSync, writeFileSync } from 'node:fs';
import { POLLUTANTS, MODEL } from './lib/config.mjs';
import { gridToPairs } from './lib/grid.mjs';

const read = f => JSON.parse(readFileSync(new URL(`../site/data/${f}`, import.meta.url), 'utf8'));
const readings = read('readings.json');
readings.series = gridToPairs(readings.grid);
const { facilities } = read('facilities.json');

const R = 6371;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
function distKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) { // degrees clockwise from north, a -> b
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Approximate site radius (km) by sector — integrated steel mills are huge; most plants are not.
function footprintKm(f) {
  if (/iron and steel mills/i.test(f.naics)) return 1.0;
  if (/quarry|mining|lime|cement|chemical|petroleum|waste/i.test(f.naics + ' ' + f.sector)) return 0.4;
  return 0.2;
}

// Monitors within 1 km of each other measuring the same pollutant (e.g. four fenceline units around one
// plant) split one vote between them, so a dense cluster doesn't outweigh the rest of the network.
const clusterCache = new Map();
function clusterWeight(s, key) {
  const k = s.id + '|' + key;
  if (!clusterCache.has(k)) {
    const n = readings.stations.filter(o => readings.series[o.id]?.[key] && distKm(s, o) <= 1).length;
    clusterCache.set(k, 1 / Math.max(1, n));
  }
  return clusterCache.get(k);
}

// ---- wind lookup: own sensor → nearest HAMN sensor with wind (≤6 km) → Open-Meteo ----
const stations = readings.stations;
const windMaps = {};
for (const s of stations) {
  const wd = readings.series[s.id]?.WD, ws = readings.series[s.id]?.WS;
  if (!wd || !ws) continue;
  const wsMap = new Map(ws);
  windMaps[s.id] = new Map(wd.filter(([t]) => wsMap.has(t)).map(([t, d]) => [t, [d, wsMap.get(t)]]));
}
const fallback = new Map(readings.windFallback.map(([t, d, s]) => [t, [d, s]]));
const windDonors = Object.fromEntries(stations.map(s => [s.id,
  stations.filter(o => windMaps[o.id] && o.id !== 'COH_MBL1').map(o => ({ id: o.id, d: distKm(s, o) }))
    .filter(o => o.d <= 6).sort((a, b) => a.d - b.d)]));
function windAt(stationId, t) {
  if (windMaps[stationId]?.has(t)) return { dir: windMaps[stationId].get(t)[0], speed: windMaps[stationId].get(t)[1], from: 'own' };
  for (const o of windDonors[stationId]) if (windMaps[o.id].has(t)) return { dir: windMaps[o.id].get(t)[0], speed: windMaps[o.id].get(t)[1], from: o.id };
  if (fallback.has(t)) return { dir: fallback.get(t)[0], speed: fallback.get(t)[1], from: 'model' };
  return null;
}

// ---- scoring for one history window ----
const σ = MODEL.coneHalfWidthDeg / 2;
const newestMs = Math.max(...Object.values(readings.series).flatMap(ps => Object.values(ps).map(x => Date.parse(x.at(-1)?.[0] ?? 0))));

function scoreWindow(days) {
  const fromMs = newestMs - (days * 24 - 1) * 3600e3; // exactly `days` × 24 hourly slots ending at the newest hour
  const scores = new Map(facilities.map(f => [f.id, { id: f.id, total: 0, byPollutant: {}, byStation: {}, events: [] }]));
  const events = [];
  const stationStats = {};
  const roses = {}; // stationId -> pollutant -> 16 sector means

  for (const s of stations) {
    const series = readings.series[s.id];
    stationStats[s.id] = {};
    for (const [key, p] of Object.entries(POLLUTANTS)) {
      const data = series[key]?.filter(([t]) => Date.parse(t) >= fromMs);
      if (!data?.length) continue;
      const bg = median(data.map(d => d[1]));
      const max = data.reduce((m, d) => d[1] > m[1] ? d : m, data[0]);
      const over1h = p.aaqc1h ? data.filter(d => d[1] > p.aaqc1h).length : 0;
      stationStats[s.id][key] = { background: bg, max: max[1], maxAt: max[0], hoursOverAAQC1h: over1h, n: data.length };

      const rose = Array.from({ length: 16 }, () => ({ sum: 0, n: 0 }));
      // NPRI gives one point per facility, but large sites span hundreds of metres to kilometres.
      // The site's angular half-width as seen from the sensor is subtracted from the off-axis angle.
      const cands = facilities.map(f => {
        const d = distKm(s, f);
        return { f, d, b: bearing(s, f), e: f.air[key] || 0, halfDeg: deg(Math.atan(footprintKm(f) / Math.max(d, 0.05))) };
      }).filter(c => c.e > 0 && c.d <= MODEL.maxDistanceKm);

      for (const [t, v] of data) {
        const w = windAt(s.id, t);
        if (!w) continue;
        if (w.speed >= MODEL.minWindKmh) { const r = rose[Math.round(w.dir / 22.5) % 16]; r.sum += v; r.n++; }
        if (v < p.trigger || w.speed < MODEL.minWindKmh) continue;
        // log scale: a reading 20× the trigger counts more than 1×, but not 20× more. Clustered monitors share a vote.
        const excess = Math.log2(1 + Math.max(0, v - bg) / p.trigger) * clusterWeight(s, key);
        if (excess <= 0) continue;
        const scored = cands.map(c => {
          const Δ = Math.max(0, angDiff(c.b, w.dir) - c.halfDeg);
          if (Δ > MODEL.coneHalfWidthDeg) return null;
          return { c, Δ, w: Math.exp(-0.5 * (Δ / σ) ** 2) / Math.max(c.d, 0.3) ** 1.5 * c.e };
        }).filter(Boolean);
        const total = scored.reduce((a, x) => a + x.w, 0);
        events.push({
          station: s.id, t, pollutant: key, value: v, excess: +excess.toFixed(3), wind: { dir: w.dir, speed: w.speed, from: w.from },
          candidates: scored.sort((a, b) => b.w - a.w).slice(0, 5)
            .map(x => ({ id: x.c.f.id, share: +(x.w / total).toFixed(3), distKm: +x.c.d.toFixed(2), offAxisDeg: Math.round(x.Δ) })),
        });
        for (const x of scored) {
          const share = excess * x.w / total;
          const sc = scores.get(x.c.f.id);
          sc.byPollutant[key] = (sc.byPollutant[key] || 0) + share;
          sc.byStation[s.id] = (sc.byStation[s.id] || 0) + share;
          sc.events.push({ i: events.length - 1, share });
        }
      }
      (roses[s.id] ??= {})[key] = rose.map(r => r.n ? +(r.sum / r.n).toFixed(2) : null);
    }
  }

  // "All pollutants" score: each pollutant's blame is normalised to 1, then averaged, so pollutants
  // with many monitors or big numbers (benzene at fencelines) don't drown out the others.
  const pollTotals = {};
  for (const s of scores.values()) for (const [k, v] of Object.entries(s.byPollutant)) pollTotals[k] = (pollTotals[k] || 0) + v;
  const nPoll = Object.keys(pollTotals).length || 1;
  for (const s of scores.values()) {
    s.norm = Object.fromEntries(Object.entries(s.byPollutant).map(([k, v]) => [k, v / pollTotals[k] / nPoll]));
    s.total = Object.values(s.norm).reduce((a, b) => a + b, 0);
  }
  const ranked = [...scores.values()].filter(s => s.total > 0).sort((a, b) => b.total - a.total);
  const grand = ranked.reduce((a, s) => a + s.total, 0) || 1;
  const culprits = ranked.map(s => ({
    id: s.id,
    score: +s.total.toFixed(5),
    norm: Object.fromEntries(Object.entries(s.norm).map(([k, v]) => [k, +v.toFixed(5)])),
    pct: +(100 * s.total / grand).toFixed(1),
    byPollutant: Object.fromEntries(Object.entries(s.byPollutant).map(([k, v]) => [k, +v.toFixed(3)])),
    byStation: Object.fromEntries(Object.entries(s.byStation).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(3)])),
    topEvents: s.events.sort((a, b) => b.share - a.share).slice(0, 12).map(e => e.i),
  }));

  // keep the events each culprit cites + the biggest ones overall (per pollutant, so filters aren't empty)
  const keep = new Set(culprits.flatMap(c => c.topEvents));
  const byIdx = events.map((e, i) => [e, i]).sort((a, b) => b[0].excess - a[0].excess);
  byIdx.slice(0, 60).forEach(([, i]) => keep.add(i));
  for (const k of Object.keys(POLLUTANTS)) byIdx.filter(([e]) => e.pollutant === k).slice(0, 25).forEach(([, i]) => keep.add(i));
  const remap = new Map([...keep].sort((a, b) => a - b).map((old, idx) => [old, idx]));
  for (const c of culprits) c.topEvents = c.topEvents.map(i => remap.get(i));

  return {
    days, from: new Date(fromMs).toISOString().slice(0, 13) + ':00Z',
    elevatedHours: events.length,
    culprits,
    events: [...remap.keys()].map(i => events[i]),
    stationStats,
    roses,
  };
}

// ---- run every window ----
const windows = {};
for (const d of MODEL.windows) windows[d] = scoreWindow(d);

writeFileSync(new URL('../site/data/attribution.json', import.meta.url), JSON.stringify({
  generated: new Date().toISOString(),
  newest: new Date(newestMs).toISOString().slice(0, 13) + ':00Z',
  model: MODEL,
  pollutants: POLLUTANTS,
  windows,
}));
for (const d of MODEL.windows) {
  const w = windows[d];
  console.log(`${d}-day window: ${w.elevatedHours} elevated station-hours → ${w.culprits.length} facilities implicated`);
  for (const c of w.culprits.slice(0, 5)) {
    const f = facilities.find(x => x.id === c.id);
    console.log(`  ${c.pct.toString().padStart(5)}%  ${f.name}`);
  }
}
