// Fetches hourly sensor data and writes site/data/readings.json.
//  - HAMN (Hamilton Air Monitoring Network): industry fenceline monitors, hourly, unverified real-time data.
//    History is kept in data/archive/hamn.json; each run only fetches the days it doesn't have yet.
//  - ECCC AQHI observations for Hamilton (api.weather.gc.ca, OGC API).
//  - Open-Meteo hourly wind as a fallback for stations without their own anemometer.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { POLLUTANTS, MODEL, BBOX } from './lib/config.mjs';
import { torontoWallClockToUtc, torontoDateParts } from './lib/time.mjs';
import { gridToMaps, mapsToGrid } from './lib/grid.mjs';

const OUT = new URL('../site/data/readings.json', import.meta.url);
const ARCHIVE_DIR = new URL('../data/archive/', import.meta.url);
const ARCHIVE = new URL('hamn.json', ARCHIVE_DIR);
// Longest window on the site + 1 day so the 24-h average exists from the window's first hour.
const HISTORY_DAYS = Math.max(...MODEL.windows) + 1;
const KEEP_ARCHIVE_DAYS = 400;  // archive grows up to this; the site only gets HISTORY_DAYS
const REQUEST_GAP_MS = 120;     // be gentle with HAMN's server
const HAMN = 'https://newreporting.hamnair.ca/';
const UA = { 'User-Agent': 'hamilton-air-watch/0.1 (public-data research tool)' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- HAMN ----------
async function hamnSession() {
  const res = await fetch(HAMN, { headers: UA });
  const cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('HAMN did not return a session cookie');
  return async (method, body = {}) => {
    const r = await fetch(HAMN + 'ChartDataQueryHelper.aspx/' + method, {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/json; charset=utf-8', cookie },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HAMN ${method} → ${r.status}`);
    return (await r.json()).d;
  };
}

// HAMN timestamps are local (Toronto) wall-clock times encoded as if they were UTC epochs.
const hamnTsToUtc = ms => {
  const d = new Date(ms);
  return torontoWallClockToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours());
};

// Fetches only the days missing from the archive (plus one day of overlap), merges them in.
async function fetchHamn(archive) {
  const call = await hamnSession();
  const stations = (await call('GetStations')).filter(s => !s.isMobile || s.name === 'COH_MBL1')
    .map(s => ({ id: s.name, name: prettyStation(s.name), lat: s.lat, lon: s.lon, network: 'HAMN', mobile: !!s.isMobile }));
  const latest = await call('getLatestDate'); // { date: "2026 Nov 15", hr: 16 }
  const [ly, lmon, ld] = latest.date.split(' ');
  const latestDay = Date.UTC(+ly, MONTHS.indexOf(lmon), +ld);

  const series = gridToMaps(archive?.grid); // stationId -> param -> Map(utcIso -> value)
  const units = { ...(archive?.units || {}) };
  // Newest archived hour, in local wall-clock days. Re-fetch from the day before it to fill late data.
  let backDays = HISTORY_DAYS;
  if (archive?.grid?.t0) {
    const lastMs = Date.parse(archive.grid.t0) + (archive.grid.hours - 1) * 3600e3;
    const lastLocal = Date.parse(torontoDateParts(new Date(lastMs)).slice(0, 10) + 'T00:00Z');
    backDays = Math.min(HISTORY_DAYS, Math.max(1, Math.round((latestDay - lastLocal) / 864e5) + 1));
  }
  console.log(`  HAMN: fetching ${backDays + 1} day(s)${archive?.grid ? ' (incremental)' : ' (initial backfill)'}`);

  const params = [...Object.values(POLLUTANTS).map(p => p.hamn), 'WD', 'WS', 'O3'];
  for (let back = backDays; back >= 0; back--) {
    const day = new Date(latestDay - back * 864e5);
    const hour = back === 0 ? latest.hr : 23;
    const sdate = `${MONTHS[day.getUTCMonth()]}/${String(day.getUTCDate()).padStart(2, '0')}/${day.getUTCFullYear()}`;
    await call('InitSelectedDateTime', { sdate, hour });
    for (const param of params) {
      const chart = await call('GetSelectedChartData', { parameterTitle: param });
      if (!chart?.colDef) continue;
      for (const row of chart.colection || []) {
        const t = hamnTsToUtc(row.date);
        const vals = row.values.split(',');
        chart.colDef.forEach((col, i) => {
          const v = vals[i];
          if (v === '' || v == null || +v <= -999) return;
          const key = normParam(col.parameter);
          ((series[col.station] ??= {})[key] ??= new Map()).set(t, +v);
          units[key] = col.units;
        });
      }
      await sleep(REQUEST_GAP_MS);
    }
    if (back % 10 === 0 || back < 3) process.stdout.write(`  HAMN ${sdate} ✓\n`);
  }
  return { stations: stations.filter(s => series[s.id]), series, units };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const PARAM_ALIASES = { 'PM2.5': 'PM25', NOX: 'NOX' };
const normParam = p => PARAM_ALIASES[p] || p;

function prettyStation(name) {
  if (name === 'COH_MBL1') return 'City of Hamilton mobile unit';
  if (name === 'STN29667') return 'Station 29667 (Burlington St / Wentworth)';
  if (name === 'STN29164') return 'Station 29164 (Kenilworth Ave N)';
  if (/^RC /.test(name)) return name.replace(/^RC (\w+)/,'Rain Carbon fenceline – $1');
  return name.replace(/^STN(\d+)\s+/, '').replace(/_/g, ' ') + (/^STN/.test(name) ? ` (Stn ${name.match(/\d+/)[0]})` : '');
}

// ---------- ECCC AQHI ----------
async function fetchAqhi() {
  const since = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 19) + 'Z';
  const url = `https://api.weather.gc.ca/collections/aqhi-observations-realtime/items?f=json&limit=5000` +
    `&bbox=${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}&datetime=${since}/..`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`AQHI ${res.status}`);
  const gj = await res.json();
  const stations = {};
  for (const f of gj.features) {
    const p = f.properties;
    const s = stations[p.location_id] ??= {
      id: p.location_id, name: p.location_name_en, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], series: [],
    };
    s.series.push([p.observation_datetime.replace('Z', '').slice(0, 13) + ':00Z', p.aqhi]);
  }
  for (const s of Object.values(stations)) s.series.sort((a, b) => a[0] < b[0] ? -1 : 1);
  // AQHI forecast (today/tomorrow) for the headline
  let forecast = null;
  try {
    const fr = await fetch(`https://api.weather.gc.ca/collections/aqhi-forecasts-realtime/items?f=json&limit=200&location_id=${Object.keys(stations)[0]}&sortby=-publication_datetime`, { headers: UA });
    const fj = await fr.json();
    const pub = fj.features[0]?.properties.publication_datetime;
    const now = new Date().toISOString();
    forecast = fj.features.map(f => f.properties)
      .filter(p => p.publication_datetime === pub && p.forecast_datetime >= now.slice(0, 13))
      .sort((x, y) => x.forecast_datetime < y.forecast_datetime ? -1 : 1)
      .slice(0, 24).map(p => ({ t: p.forecast_datetime, aqhi: p.aqhi }));
  } catch { /* optional */ }
  return { stations: Object.values(stations), forecast };
}

// ---------- Open-Meteo wind fallback ----------
async function fetchWindFallback() {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=43.255&longitude=-79.80' +
    `&hourly=wind_speed_10m,wind_direction_10m&past_days=${Math.min(92, HISTORY_DAYS + 1)}&forecast_days=1&timezone=GMT`;
  const j = await (await fetch(url, { headers: UA })).json();
  return j.hourly.time.map((t, i) => [t + ':00Z', j.hourly.wind_direction_10m[i], j.hourly.wind_speed_10m[i]])
    .filter(r => r[1] != null);
}

// ---------- main ----------
const archive = existsSync(ARCHIVE) ? JSON.parse(readFileSync(ARCHIVE, 'utf8')) : null;
const settled = await Promise.allSettled([fetchHamn(archive), fetchAqhi(), fetchWindFallback()]);
const [hamn, aqhi, wind] = settled.map((r, i) => {
  if (r.status === 'rejected') console.warn(`! source ${['HAMN', 'AQHI', 'wind'][i]} failed: ${r.reason.message}`);
  return r.status === 'fulfilled' ? r.value : null;
});
if (!hamn) { console.error('HAMN data is required — aborting without overwriting readings.json'); process.exit(1); }

// Save the full archive, then hand the site only the history it needs.
let newestMs = -Infinity; // (a loop — spreading ~150k values into Math.max overflows the stack)
for (const ps of Object.values(hamn.series)) for (const m of Object.values(ps)) for (const t of m.keys()) newestMs = Math.max(newestMs, Date.parse(t));
mkdirSync(ARCHIVE_DIR, { recursive: true });
writeFileSync(ARCHIVE, JSON.stringify({
  updated: new Date().toISOString(), units: hamn.units, stations: hamn.stations,
  grid: mapsToGrid(hamn.series, newestMs - KEEP_ARCHIVE_DAYS * 864e5),
}));
const grid = mapsToGrid(hamn.series, newestMs - (HISTORY_DAYS * 24 - 1) * 3600e3);

writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  localNow: torontoDateParts(new Date()),
  sources: {
    hamn: 'Hamilton Air Monitoring Network (newreporting.hamnair.ca) — real-time, unverified',
    aqhi: 'Environment and Climate Change Canada AQHI observations (api.weather.gc.ca)',
    wind: 'Open-Meteo (fallback for stations without wind sensors)',
  },
  units: hamn.units,
  stations: hamn.stations,
  grid,            // compact hourly grid, see scripts/lib/grid.mjs
  aqhi,
  windFallback: wind || [],
}));
const n = Object.values(grid.series).reduce((a, s) => a + Object.values(s).reduce((b, x) => b + x.filter(v => v != null).length, 0), 0);
console.log(`Wrote ${hamn.stations.length} HAMN stations, ${grid.hours} hours (${(grid.hours / 24).toFixed(1)} days), ${n} values, ${aqhi?.stations.length ?? 0} AQHI stations`);
