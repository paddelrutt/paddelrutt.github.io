# PaddlePlanner — feasibility spike

A wind-aware kayak round-trip planner, in the spirit of what Kurviger does for
motorcyclists: *"I'm at this put-in and want to paddle for N hours — give me a
loop that goes upwind while I'm fresh, comes home with a tailwind, and hides
behind islands when it blows."*

Fully static web app — **no backend, no API keys, no paid services.** Installable
as a PWA and works offline once a route is cached. Live: https://paddelrutt.github.io/

## Run it

```
npx serve -l 8420 .
```

Open http://localhost:8420, click the map to set a put-in (default view is the
Sankt Anna archipelago), set duration/speed/wind-comfort, hit **Generate**.

## Data sources (all free, CORS-open)

| What | Source | How |
|------|--------|-----|
| Water geometry | [OpenFreeMap](https://openfreemap.org) vector tiles (OSM data) | `water` layer at z14, decoded in-browser, rasterized to a routing grid |
| Wind forecast | [SMHI open data](https://opendata.smhi.se) SNOW1g point forecast | hourly `wind_speed`/`wind_from_direction`/gust — no key |
| Sea temp + waves | [Open-Meteo Marine](https://open-meteo.com) | sea surface temperature + wave height for the safety strip |
| Sea depth | [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) WCS | ~100 m GeoTIFF, decoded in-browser (geotiff.js) |
| Landing & rest POIs | OSM via [Overpass API](https://overpass-api.de) | slipways, beaches, shelters, campsites, drinking water |
| Base map | OpenStreetMap raster tiles | display only; pre-cached per route for offline |

## How it works

1. **Grid** ([js/grid.js](js/grid.js)) — a Web-Mercator-aligned raster grid
   (~10–40 m cells) around the put-in. Vector-tile water polygons are drawn
   onto a canvas (even-odd fill handles islands); pixels become the water
   mask. Flood fill from the put-in finds boat-reachable water.
2. **Exposure** ([js/router.js](js/router.js) `computeFetch`) — per-cell
   upwind *fetch* (open-water distance toward the wind) via a linear DP sweep.
   Long fetch + wind above the paddler's comfort = waves = cost penalty, so
   routes hug shorelines and use island lee.
3. **Routing** (`dijkstra`) — 8-connected Dijkstra where edge time depends on
   the head/tailwind component of each travel direction, times the exposure
   penalty.
4. **Round trip + 3 options** (`planRoundTrip` / `planRoundTripOptions`) —
   candidate turn-points are scored for upwindness (tailwind home), shelter,
   time fit, and lunch-spot proximity; the outbound target adapts to wind
   asymmetry (tailwind home = turn-point further out). The return leg
   discourages reusing the outbound corridor, so you get a loop. The options
   generator picks turn-points in genuinely different directions (≥45° apart)
   and returns up to three distinct loops to choose between.
4c. **Scenic preference** — a "route style" slider adds a cost for being far
   from shore (`sceneryW × min(shoreDist/700m, 1)`), so routes hug coasts and
   thread between islands instead of crossing open water in a straight line —
   the paddling analogue of Kurviger's curvy-roads setting.
4b. **Via-stops tour** (`planViaRoute`) — instead of an automatic loop, click
   to drop ordered stops; the route is chained wind-aware legs
   (put-in → stop 1 → … → put-in). Each leg starts at the previous leg's
   elapsed trip time (later legs see later forecast hours) and discourages
   reusing earlier corridors. With stops set, the duration slider becomes a
   fit check (warns if the tour runs long) rather than the driver.
5. **Time-varying wind** — the SMHI forecast is bucketed per trip hour; edge
   costs and exposure fields use the bucket for the paddler's elapsed time.
6. **Smoothing** (`smoothPath`) — line-of-sight simplification plus Chaikin
   corner-cutting, every segment validated against the water mask.
7. **Lunch stop** — OSM beaches/slipways near the turn point are suggested
   and bias turn-point selection (a beach is worth a slightly imperfect
   duration fit).
8. **GPX export** — waypoints (put-in, turn/stops, lunch) plus the smoothed
   track (one `<trkseg>` per leg); importable in OsmAnd, Garmin, sports
   watches, anything.
9. **Max distance from shore** (`computeShoreDistance`) — chamfer distance
   transform from land; the slider turns it into a hard constraint on
   routable water ("never further out than X m"), and the stats panel shows
   the route's farthest point from shore.
10. **Max sea depth** ([js/depth.js](js/depth.js)) — EMODnet bathymetry
    resampled onto the grid; the slider excludes deeper water, and the route's
    deepest point is reported. **Indicative only**: a ~100 m grid cannot see
    rocks or shoals, so this is a comfort filter, never a grounding-safety or
    navigation guarantee. Marine coverage only — lakes are unconstrained.
11. **Live GPS navigation** — Geolocation `watchPosition` with screen wake
   lock: position on the map, distance remaining, ETA, off-route warning.
   Loop-aware progress tracking (start = finish, so projection respects
   distance already paddled). Optional **compass bearing** to the next point
   ([DeviceOrientation]) and **voice cues** (approaching stops, off-route,
   arrival). Needs HTTPS (or localhost) to get GPS.
12. **Marker editing** — put-in and stops are draggable; tap a stop for a
   Remove button; reorder stops with the ▲/▼ list. **GPX import** loads a
   put-in + stops from a file to re-plan.
13. **When to go** — a 12-hour wind timeline strip and a "start in N hours"
   picker; the route is planned with the forecast for the chosen departure
   (each leg uses its own elapsed-time forecast hour).
14. **Safety strip** — sea-surface temperature with a cold-water warning,
   wave height, a sunrise/sunset daylight check ("back X min before sunset"),
   and a difficulty badge synthesised from distance, wind, fetch and water
   temp.
15. **Offline PWA** — installable to the home screen; a service worker
   precaches the app shell and runtime-caches map tiles + libraries, and each
   Generate pre-fetches the route's map tiles, so navigation survives losing
   signal. Network-first for the shell so deploys still update online.
16. **Save & share** — full plan (put-in, stops, settings) round-trips through
   the URL hash ("Copy link"); "Share float plan" sends a route summary + ETA
   via the Web Share API (or clipboard).

## Tests

```
npm test                       # router on a synthetic lake (pure logic, offline)
node test/tiles-integration.mjs  # live: tile decode + SMHI shape
node test/e2e.mjs              # live: full browser run (needs server on :8420)
```

## Spike findings

- **All data needed is free and CORS-open**; the whole thing runs client-side
  and can be hosted on GitHub Pages for $0.
- Route generation takes **well under a second** (~300 ms for a 2 h trip) on
  top of a few seconds of tile fetching.
- SMHI deprecated its old PMP3g API in March 2026 — this uses the new SNOW1g
  endpoint.
- Known limitations (on the list for a "real" version):
  - Fetch is straight-line upwind distance; real wave height also depends on
    duration and depth (Open-Meteo wave height is shown but not yet used in
    routing cost).
  - No currents/tides (minor in the Baltic, matters elsewhere).
  - Compass heading depends on the device magnetometer; voice cues need the
    screen on (the wake lock keeps it on during navigation).
  - Tile pre-fetch is capped (~160 tiles/route) to respect OSM's tile policy;
    very large trip areas won't fully cache.
