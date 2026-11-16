// Shared configuration for the pipeline and attribution model.

// Area of interest: City of Hamilton plus the Burlington border.
export const BBOX = { south: 43.12, north: 43.37, west: -80.10, east: -79.60 };

// Pollutants we track. `hamn` = parameter title in HAMN's API, `npri` = NPRI substances that
// directly emit it, `aaqc1h` / `aaqc24h` = Ontario Ambient Air Quality Criteria (same units as data).
// `trigger` = 1-hour level above which an hour counts as "elevated" for attribution.
export const POLLUTANTS = {
  SO2: {
    label: 'Sulphur dioxide', short: 'SO₂', units: 'ppb', hamn: 'SO2', aaqc1h: 40, aaqc24h: 100, trigger: 10,
    npri: ['Sulphur dioxide'],
  },
  NO2: {
    label: 'Nitrogen dioxide', short: 'NO₂', units: 'ppb', hamn: 'NO2', aaqc1h: 200, aaqc24h: 100, trigger: 25,
    npri: ['Nitrogen oxides (expressed as nitrogen dioxide)'],
  },
  TRS: {
    label: 'Total reduced sulphur', short: 'TRS', units: 'ppb', hamn: 'TRS', aaqc1h: 10, aaqc24h: 4.8, trigger: 3,
    npri: ['Total reduced sulphur (expressed as hydrogen sulphide)', 'Hydrogen sulphide', 'Carbon disulphide'],
  },
  PM25: {
    label: 'Fine particulate (PM2.5)', short: 'PM2.5', units: 'µg/m³', hamn: 'PM2.5', aaqc24h: 27, trigger: 20,
    npri: ['PM2.5 - Particulate Matter <= 2.5 Micrometers'],
  },
  PM10: {
    label: 'Coarse particulate (PM10)', short: 'PM10', units: 'µg/m³', hamn: 'PM10', aaqc24h: 50, trigger: 40,
    npri: ['PM10 - Particulate Matter <= 10 Micrometers'],
  },
  Benzene: {
    label: 'Benzene', short: 'Benzene', units: 'µg/m³', hamn: 'Benzene', aaqc24h: 2.3, trigger: 4,
    npri: ['Benzene'],
  },
  CO: {
    label: 'Carbon monoxide', short: 'CO', units: 'ppm', hamn: 'CO', aaqc1h: 30, trigger: 1,
    npri: ['Carbon monoxide'],
  },
};

// Attribution model parameters.
export const MODEL = {
  coneHalfWidthDeg: 35,   // facilities within ±this of the upwind bearing are candidates
  maxDistanceKm: 12,      // ignore sources further than this
  minWindKmh: 3,          // below this, wind direction is unreliable -> hour skipped
  windows: [7, 30, 60, 90], // selectable history windows (days) on the site
};
