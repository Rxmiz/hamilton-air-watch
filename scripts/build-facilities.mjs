// Builds site/data/facilities.json from the federal National Pollutant Release Inventory (NPRI).
// Source: Environment and Climate Change Canada, Open Government Licence – Canada.
// Run `npm run download-npri` first (or let this script download the files).
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readCsv } from './lib/csv.mjs';
import { POLLUTANTS, BBOX } from './lib/config.mjs';

const RAW = new URL('../data/raw/', import.meta.url);
const OUT = new URL('../site/data/facilities.json', import.meta.url);
const NPRI_BASE = 'https://data-donnees.az.ec.gc.ca/api/file?path=' + encodeURIComponent(
  '/substances/plansreports/reporting-facilities-pollutant-release-and-transfer-data/' +
  'bulk-data-files-for-all-years-releases-disposals-transfers-and-facility-locations/');
const FILES = {
  geo: 'NPRI-INRP_GeolocationsGeolocalisation_1993-present.csv',
  releases: 'NPRI-INRP_ReleasesRejets_1993-present.csv',
};
const LOCAL = { geo: 'npri_geo.csv', releases: 'npri_releases.csv' };

async function ensureDownloaded(force = process.argv.includes('--download')) {
  mkdirSync(RAW, { recursive: true });
  for (const k of Object.keys(FILES)) {
    const dest = new URL(LOCAL[k], RAW);
    if (existsSync(dest) && !force) continue;
    console.log(`Downloading ${FILES[k]} …`);
    const res = await fetch(NPRI_BASE + encodeURIComponent(FILES[k]));
    if (!res.ok) throw new Error(`NPRI download failed: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  }
}

// substance name (NPRI) -> pollutant keys it can explain at a sensor
const substanceToPollutant = new Map();
for (const [key, p] of Object.entries(POLLUTANTS)) {
  for (const s of p.npri || []) {
    if (!substanceToPollutant.has(s)) substanceToPollutant.set(s, []);
    substanceToPollutant.get(s).push(key);
  }
}

// Some NPRI facility names are just the city ("Hamilton") — fall back to the company name.
function displayName(company, facility, city) {
  const f = (facility || '').trim(), c = company.trim().replace(/,?\s+(Inc|Ltd|Limited|Corp|Corporation)\.?$/i, '');
  if (!f || f.toLowerCase() === city.trim().toLowerCase() || /^(plant|site|facility)/i.test(f)) return c + (f && f.toLowerCase() !== city.trim().toLowerCase() ? ' – ' + f : '');
  return f;
}

const inBox = (lat, lon) => lat > BBOX.south && lat < BBOX.north && lon > BBOX.west && lon < BBOX.east;

await ensureDownloaded();

const facilities = new Map();
let header = true;
for await (const r of readCsv(new URL(LOCAL.geo, RAW))) {
  if (header) { header = false; continue; }
  const lat = +r[11], lon = +r[12];
  if (!inBox(lat, lon)) continue;
  facilities.set(r[1], {
    id: r[1],
    lastYear: +r[0],
    company: r[2].trim(),
    name: displayName(r[2], r[3], r[6]),
    address: [r[4], r[6]].filter(Boolean).join(', ').trim(),
    lat, lon,
    naics: r[15].trim(),
    sector: r[18].trim(),
    year: null,
    air: {},        // pollutantKey -> tonnes/yr (latest year)
    topAir: [],     // top substances released to air, any kind
  });
}

// First pass collects air releases per facility per year; keep latest year only.
const byFacYear = new Map(); // id -> year -> {substance -> tonnes}
header = true;
for await (const r of readCsv(new URL(LOCAL.releases, RAW))) {
  if (header) { header = false; continue; }
  const f = facilities.get(r[1]);
  if (!f || !r[11].startsWith('Releases to Air')) continue;
  const year = +r[0];
  let qty = +r[15];
  if (!Number.isFinite(qty)) continue;
  if (r[16] === 'kg') qty /= 1000;
  else if (r[16] === 'grams') qty /= 1e6;
  else if (r[16] !== 'tonnes') continue; // g TEQ (dioxins) etc. — not comparable
  if (!byFacYear.has(f.id)) byFacYear.set(f.id, new Map());
  const years = byFacYear.get(f.id);
  if (!years.has(year)) years.set(year, new Map());
  const subs = years.get(year);
  subs.set(r[9], (subs.get(r[9]) || 0) + qty);
}

const out = [];
for (const f of facilities.values()) {
  const years = byFacYear.get(f.id);
  if (!years) continue;
  const year = Math.max(...years.keys());
  if (year < new Date().getFullYear() - 4) continue; // closed / no recent reports
  const subs = years.get(year);
  f.year = year;
  for (const [s, t] of subs) {
    for (const key of substanceToPollutant.get(s) || []) f.air[key] = (f.air[key] || 0) + t;
  }
  f.topAir = [...subs].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([substance, tonnes]) => ({ substance, tonnes: +tonnes.toPrecision(3) }));
  for (const k in f.air) f.air[k] = +f.air[k].toPrecision(4);
  if (Object.keys(f.air).length === 0) continue;
  out.push(f);
}
out.sort((a, b) => (b.air.PM10 || 0) - (a.air.PM10 || 0));

writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), source: 'NPRI (ECCC)', facilities: out }, null, 1));
console.log(`Wrote ${out.length} facilities to site/data/facilities.json`);
