// Compact hourly storage: every series shares one hourly time grid starting at t0.
//   { t0: "2026-08-16T05:00Z", hours: 2200, series: { stationId: { param: [v|null, ...] } } }
// In memory we work with Map(utcIso -> value) per series.
const H = 3600e3;
const iso = ms => new Date(ms).toISOString().slice(0, 13) + ':00Z';

export function gridToMaps(grid) {
  const out = {};
  if (!grid?.series) return out;
  const t0 = Date.parse(grid.t0);
  for (const [st, ps] of Object.entries(grid.series)) {
    out[st] = {};
    for (const [p, arr] of Object.entries(ps)) {
      const m = new Map();
      arr.forEach((v, i) => { if (v != null) m.set(iso(t0 + i * H), v); });
      out[st][p] = m;
    }
  }
  return out;
}

// maps -> grid, keeping only hours >= keepFromMs
export function mapsToGrid(maps, keepFromMs = -Infinity) {
  let min = Infinity, max = -Infinity;
  for (const ps of Object.values(maps)) for (const m of Object.values(ps)) for (const t of m.keys()) {
    const ms = Date.parse(t);
    if (ms < keepFromMs) continue;
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  if (min === Infinity) return { t0: null, hours: 0, series: {} };
  const hours = Math.round((max - min) / H) + 1;
  const series = {};
  for (const [st, ps] of Object.entries(maps)) {
    for (const [p, m] of Object.entries(ps)) {
      const arr = new Array(hours).fill(null);
      let any = false;
      for (const [t, v] of m) {
        const i = Math.round((Date.parse(t) - min) / H);
        if (i >= 0 && i < hours) { arr[i] = v; any = true; }
      }
      if (any) (series[st] ??= {})[p] = arr;
    }
  }
  return { t0: iso(min), hours, series };
}

// grid -> { stationId: { param: [[utcIso, v], ...] } } (sorted, nulls dropped)
export function gridToPairs(grid) {
  const out = {};
  const t0 = Date.parse(grid.t0);
  for (const [st, ps] of Object.entries(grid.series)) {
    out[st] = {};
    for (const [p, arr] of Object.entries(ps)) {
      const pairs = [];
      arr.forEach((v, i) => { if (v != null) pairs.push([iso(t0 + i * H), v]); });
      out[st][p] = pairs;
    }
  }
  return out;
}
