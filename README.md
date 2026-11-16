# Hamilton Air Watch

A website that tracks air quality in Hamilton, Ontario and points to the factories most likely behind pollution spikes. It only uses public data.

## Data sources

| What | Source | Notes |
|---|---|---|
| Hourly SO₂, NO₂, TRS, PM2.5, PM10, benzene, CO, wind | [Hamilton Air Monitoring Network](https://www.hamnair.ca/) (HAMN) | About 20 monitors, many at plant fencelines. The real-time data is **unverified**. |
| Air Quality Health Index (AQHI) and forecast | ECCC [api.weather.gc.ca](https://api.weather.gc.ca/) | Hamilton Downtown, Mountain, West, and Burlington stations |
| Factory locations and annual air emissions | ECCC [National Pollutant Release Inventory](https://open.canada.ca/data/en/dataset/40e01423-7728-429c-ac9d-2954385ccdfb) (NPRI) | Latest reporting year. Open Government Licence – Canada |
| Fallback wind | [Open-Meteo](https://open-meteo.com/) | Used only where no nearby monitor measures wind |

No API keys are needed.

## Running it

Requires Node 20+. There are no npm dependencies.

```bash
npm run build      # first time: downloads NPRI (~400 MB), builds facilities, fetches sensors, runs the model
npm start          # serves the site at http://localhost:8080
```

The first run backfills 91 days of HAMN history (about 900 small requests, a few minutes). It is saved in `data/archive/hamn.json`. After that, each refresh only fetches the days the archive is missing, and the archive keeps growing up to 400 days.

To refresh the sensor data later (this is quick and does not re-download NPRI):

```bash
npm run update
```

To keep it live, `node server.mjs --refresh 60` re-fetches and re-scores every 60 minutes.

## Publishing

The public site is deployed to GitHub Pages by `.github/workflows/refresh.yml`. It runs every hour (and on every push to `main`):

1. It restores the HAMN archive from the `data` branch.
2. It runs `npm run update`.
3. It force-pushes the updated archive back to `data`. That branch always holds a single commit, so the repo doesn't grow.
4. It deploys `site/`.

`site/data/facilities.json` is committed. After a new NPRI release, run `npm run facilities` locally and commit the result. If HAMN is down, the run fails and the last good version of the site stays up.

## How culprits are found

`scripts/attribute.mjs` is a screening model. It is not a dispersion model.

1. **Find spikes.** An hour counts as elevated when it is above the pollutant's trigger in `scripts/lib/config.mjs`.
2. **Get the wind.** Wind direction comes from the station's own anemometer. If it has none, it comes from the nearest HAMN station within 6 km, and failing that from Open-Meteo.
3. **Pick candidates.** Candidates are NPRI facilities that report emitting that pollutant and sit inside a ±35° upwind cone, up to 12 km away. Large sites are treated as areas, so a steel mill doesn't drop out just because its NPRI point is off-axis.
4. **Weight them.** Each candidate's weight = closeness to the wind line (Gaussian) × 1/distance^1.5 × reported annual tonnes.
5. **Split the blame.** The spike's excess above the station's median is log-compressed and split among the candidates by weight. Monitors within 1 km of each other that measure the same pollutant share one vote.
6. **Rank.** Shares are summed over the selected period: 7, 30, 60 or 90 days, set in `MODEL.windows`. In the "All" view each pollutant is normalised so it counts equally.

The model also builds a **pollution rose** for each station: the average concentration for each of 16 wind sectors. This is the most direct visual evidence.

**Limitations:** NPRI figures are annual totals, so they say nothing about timing. Upset and fugitive events, traffic, rail, ships, and facilities below NPRI reporting thresholds are not modelled. Near-ground wind can swirl around buildings. A monitor placed beside one plant will tend to implicate that plant. Treat a high score as "worth a closer look", not as proof.

## Layout

```
scripts/build-facilities.mjs   NPRI → site/data/facilities.json
scripts/fetch-readings.mjs     HAMN + AQHI + wind → data/archive/hamn.json + site/data/readings.json
scripts/attribute.mjs          model → site/data/attribution.json (one result per period)
scripts/lib/config.mjs         pollutants, Ontario AAQC limits, triggers, model parameters
site/                          static front end (Leaflet + vanilla JS); deploy this folder anywhere
server.mjs                     tiny static server with optional auto-refresh
```
