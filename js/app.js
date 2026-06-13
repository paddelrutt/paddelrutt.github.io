import {
  makeGrid, lonLatToCell, cellToLonLat, pointToLonLat, gridBounds,
  rasterizeWater, floodFill, nearestWater,
} from './grid.js';
import { fetchWaterFeatures } from './tiles.js';
import { computeFetch, computeShoreDistance, planRoundTrip, planViaRoute, smoothPath } from './router.js';
import { fetchForecast } from './smhi.js';
import { fetchLandingSpots } from './overpass.js';
import { fetchDepthPerCell } from './depth.js';

// Default view: Sankt Anna archipelago, a classic Swedish paddling area
const map = L.map('map').setView([58.37, 16.78], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const generateBtn = $('generate');

let putIn = null; // L.LatLng
let putInMarker = null;
let stops = []; // [{latlng, marker}]
let routeLayers = [];
let maskOverlay = null;
let spotLayer = null;
let lastMaskCanvas = null; // {canvas, bounds}
let lastResult = null; // {legsLatLngs: [[lat,lon]...][], lunch, stops, totalTimeS}

function setStatus(msg) { statusEl.textContent = msg; }

// Slider readouts
const bind = (id, outId, fmt) => {
  const el = $(id), out = $(outId);
  const update = () => (out.textContent = fmt(parseFloat(el.value)));
  el.addEventListener('input', update);
  update();
};
bind('duration', 'durationOut', (v) => v.toFixed(1) + ' h');
bind('speed', 'speedOut', (v) => v.toFixed(1) + ' km/h');
bind('comfort', 'comfortOut', (v) => v.toFixed(0) + ' m/s');
bind('shore', 'shoreOut', (v) => (v > 2000 ? 'no limit' : v.toFixed(0) + ' m'));
bind('depth', 'depthOut', (v) => (v > 50 ? 'no limit' : v.toFixed(0) + ' m'));

function updateStopsUI() {
  $('stopsLabel').textContent = stops.length === 0
    ? 'No stops' : `${stops.length} stop${stops.length > 1 ? 's' : ''}`;
  $('undoStop').disabled = stops.length === 0;
  $('clearAll').disabled = !putIn;
  generateBtn.textContent = stops.length === 0
    ? 'Generate round trip' : `Generate tour via ${stops.length} stop${stops.length > 1 ? 's' : ''}`;
}

map.on('click', (e) => {
  if (!putIn) {
    putIn = e.latlng;
    putInMarker = L.marker(putIn).addTo(map).bindPopup('Put-in').openPopup();
    generateBtn.disabled = false;
    setStatus('Put-in set. Click again to add stops, or generate.');
  } else {
    const n = stops.length + 1;
    const marker = L.marker(e.latlng, {
      icon: L.divIcon({ className: '', html: `<div class="stop-icon">${n}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
    }).addTo(map).bindPopup(`Stop ${n}`);
    stops.push({ latlng: e.latlng, marker });
    setStatus(`Stop ${n} added.`);
  }
  updateStopsUI();
});

$('undoStop').addEventListener('click', () => {
  const s = stops.pop();
  if (s) s.marker.remove();
  updateStopsUI();
});

$('clearAll').addEventListener('click', () => {
  for (const s of stops) s.marker.remove();
  stops = [];
  if (putInMarker) { putInMarker.remove(); putInMarker = null; }
  putIn = null;
  generateBtn.disabled = true;
  stopNav();
  clearRoute();
  updateStopsUI();
  setStatus('Click the map to set your put-in point.');
});

$('showMask').addEventListener('change', (e) => {
  if (maskOverlay) { maskOverlay.remove(); maskOverlay = null; }
  if (e.target.checked && lastMaskCanvas) {
    maskOverlay = L.imageOverlay(lastMaskCanvas.canvas.toDataURL(), lastMaskCanvas.bounds, { opacity: 0.45 }).addTo(map);
  }
});

function clearRoute() {
  for (const l of routeLayers) l.remove();
  routeLayers = [];
  lastResult = null;
  $('stats').classList.add('hidden');
  $('nav').classList.add('hidden');
}

function fmtTime(sec) {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function renderMaskOverlay(grid, mask, reach) {
  const canvas = document.createElement('canvas');
  canvas.width = grid.W; canvas.height = grid.H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(grid.W, grid.H);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (reach[i]) { img.data[o] = 40; img.data[o + 1] = 170; img.data[o + 2] = 255; img.data[o + 3] = 150; }
    else if (mask[i]) { img.data[o] = 120; img.data[o + 1] = 120; img.data[o + 2] = 255; img.data[o + 3] = 80; }
  }
  ctx.putImageData(img, 0, 0);
  lastMaskCanvas = { canvas, bounds: gridBounds(grid) };
  if ($('showMask').checked) {
    if (maskOverlay) maskOverlay.remove();
    maskOverlay = L.imageOverlay(canvas.toDataURL(), lastMaskCanvas.bounds, { opacity: 0.45 }).addTo(map);
  }
}

const havM = (a, b) => map.distance(a, b); // Leaflet haversine, meters

async function generate() {
  if (!putIn) return;
  generateBtn.disabled = true;
  stopNav();
  clearRoute();
  try {
    const durationH = parseFloat($('duration').value);
    const budgetSec = durationH * 3600;
    const speedMs = parseFloat($('speed').value) / 3.6;
    const comfortWs = parseFloat($('comfort').value);

    // Area to load: half the trip at full speed, plus margin
    const radiusM = Math.min(16000, Math.max(3000, speedMs * budgetSec * 0.5 * 1.3 + 1500));
    const grid = makeGrid(putIn.lat, putIn.lng, radiusM);

    setStatus('Fetching wind forecast (SMHI)…');
    const timelineP = fetchForecast(putIn.lat, putIn.lng, Math.ceil(durationH) + 1);
    const b = gridBounds(grid);
    const spotsP = fetchLandingSpots(b[0][0], b[0][1], b[1][0], b[1][1]).catch(() => []);
    const depthP = fetchDepthPerCell(grid, b); // null on failure, handled below

    setStatus('Fetching water geometry…');
    const features = await fetchWaterFeatures(grid, (done, total) =>
      setStatus(`Fetching water geometry… ${done}/${total} tiles`));

    setStatus('Building water grid…');
    const mask = rasterizeWater(grid, features);

    // Optional hard constraints: max distance from shore, max sea depth
    const shoreDist = computeShoreDistance(mask, grid.W, grid.H, grid.cellMeters);
    const maxShoreM = parseFloat($('shore').value);
    const maxDepthM = parseFloat($('depth').value);
    const depthLimited = maxDepthM <= 50;
    const depth = await depthP;
    if (depthLimited && !depth) {
      setStatus('Depth service (EMODnet) unavailable — generating without the depth limit.');
    }
    let waterMask = mask;
    if (maxShoreM <= 2000 || (depthLimited && depth)) {
      waterMask = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) {
        waterMask[i] = mask[i]
          && (maxShoreM > 2000 || shoreDist[i] <= maxShoreM)
          && (!depthLimited || !depth || depth[i] <= maxDepthM) ? 1 : 0;
      }
    }

    let startIdx = lonLatToCell(grid, putIn.lng, putIn.lat);
    startIdx = nearestWater(waterMask, grid.W, grid.H, startIdx);
    if (startIdx === -1) {
      setStatus('No water found near that point. Click closer to the shoreline.');
      generateBtn.disabled = false;
      return;
    }
    const reach = floodFill(waterMask, grid.W, grid.H, startIdx);
    renderMaskOverlay(grid, mask, reach);

    const timeline = await timelineP;
    showWind(timeline, durationH, comfortWs);

    setStatus('Computing wind exposure per forecast hour…');
    await new Promise((r) => setTimeout(r, 20)); // let the UI paint
    // Fetch field depends only on wind direction; cache by 22.5° sector
    const fieldCache = new Map();
    const fetchFields = timeline.map((w) => {
      const key = Math.round(w.wdDeg / 22.5) % 16;
      if (!fieldCache.has(key)) {
        fieldCache.set(key, computeFetch(mask, grid.W, grid.H, key * 22.5, grid.cellMeters));
      }
      return fieldCache.get(key);
    });

    // Landing spots -> "lunch nearby" bonus field for turn-point scoring
    const spots = await spotsP;
    const lunchBonus = new Uint8Array(grid.W * grid.H);
    const spotCells = [];
    for (const s of spots) {
      let idx = lonLatToCell(grid, s.lon, s.lat);
      idx = nearestWater(reach, grid.W, grid.H, idx, 6);
      if (idx !== -1) spotCells.push({ idx, spot: s });
    }
    {
      // Multi-source BFS: water cells within ~500 m of any landing spot
      const depth = Math.ceil(500 / grid.cellMeters);
      let frontier = spotCells.map((s) => s.idx);
      for (const i of frontier) lunchBonus[i] = 1;
      for (let d = 0; d < depth; d++) {
        const next = [];
        for (const i of frontier) {
          const x = i % grid.W, y = (i / grid.W) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const px = x + dx, py = y + dy;
            if (px < 0 || py < 0 || px >= grid.W || py >= grid.H) continue;
            const j = py * grid.W + px;
            if (reach[j] && !lunchBonus[j]) { lunchBonus[j] = 1; next.push(j); }
          }
        }
        frontier = next;
      }
    }

    // Snap user stops to water reachable from the put-in
    const stopIdxs = [];
    for (let k = 0; k < stops.length; k++) {
      let idx = lonLatToCell(grid, stops[k].latlng.lng, stops[k].latlng.lat);
      idx = nearestWater(reach, grid.W, grid.H, idx);
      if (idx === -1) {
        setStatus(`Stop ${k + 1} is not on water reachable from the put-in (with current limits).`);
        generateBtn.disabled = false;
        return;
      }
      stopIdxs.push(idx);
    }

    setStatus(stopIdxs.length ? 'Planning tour via your stops…' : 'Planning round trip…');
    await new Promise((r) => setTimeout(r, 20));
    const t0 = performance.now();
    const params = {
      mask: reach, W: grid.W, H: grid.H, cellMeters: grid.cellMeters,
      timeline, fetchFields, speedMs, comfortWs, lunchBonus,
    };

    let legsPaths, legTimesS, totalTimeS, turnIdx = null, maxFetchM;
    if (stopIdxs.length) {
      const via = planViaRoute(params, startIdx, stopIdxs);
      if (via.unreachableLeg !== undefined) {
        setStatus(`Leg ${via.unreachableLeg + 1} of the tour can't be completed on connected water.`);
        generateBtn.disabled = false;
        return;
      }
      ({ legs: legsPaths, legTimesS, totalTimeS, maxFetchM } = via);
    } else {
      const route = planRoundTrip(params, startIdx, budgetSec);
      if (!route) {
        setStatus('Could not fit a round trip here — water body may be too small for that duration.');
        generateBtn.disabled = false;
        return;
      }
      legsPaths = [route.outPath, route.backPath];
      legTimesS = [route.outTimeS, route.backTimeS];
      totalTimeS = route.outTimeS + route.backTimeS;
      turnIdx = route.turnIdx;
      maxFetchM = route.maxFetchM;
    }
    const planMs = Math.round(performance.now() - t0);

    // Smooth for display/GPX/navigation (validated against the water mask)
    const toLatLngs = (path) =>
      smoothPath(reach, grid.W, grid.H, path).map(([x, y]) => {
        const [lon, lat] = pointToLonLat(grid, x, y);
        return [lat, lon];
      });
    const legsLatLngs = legsPaths.map(toLatLngs);

    const palette = ['#e76f51', '#2a9d8f'];
    let allBounds = null;
    legsLatLngs.forEach((ll, k) => {
      const line = L.polyline(ll, {
        color: palette[k % 2], weight: 4,
        dashArray: k === legsLatLngs.length - 1 ? '8 6' : null,
      }).addTo(map);
      routeLayers.push(line);
      allBounds = allBounds ? allBounds.extend(line.getBounds()) : line.getBounds();
    });

    // Turning point + lunch suggestion only apply to automatic round trips
    let lunch = null;
    if (turnIdx !== null) {
      const [tLon, tLat] = cellToLonLat(grid, turnIdx);
      const turnMarker = L.circleMarker([tLat, tLon], { radius: 7, color: '#f4a261', fillOpacity: 0.9 })
        .addTo(map).bindPopup('Turning point');
      routeLayers.push(turnMarker);
      let bestScore = Infinity;
      for (const { spot } of spotCells) {
        const d = havM([tLat, tLon], [spot.lat, spot.lon]);
        const score = d * (spot.type === 'beach' ? 1 : 1.4);
        if (d < 1200 && score < bestScore) { bestScore = score; lunch = spot; }
      }
      if (lunch) {
        const lunchMarker = L.marker([lunch.lat, lunch.lon])
          .addTo(map)
          .bindPopup(`🍴 Lunch stop: ${lunch.name || lunch.type}`);
        routeLayers.push(lunchMarker);
      }
    }
    map.fitBounds(allBounds, { padding: [30, 30] });

    const wsMax = Math.max(...timeline.slice(0, Math.ceil(totalTimeS / 3600) + 1).map((w) => w.ws));
    const exposed = maxFetchM >= 2500 && wsMax > comfortWs;
    let maxShoreOnRoute = 0, maxDepthOnRoute = 0;
    for (const path of legsPaths) {
      for (const i of path) {
        maxShoreOnRoute = Math.max(maxShoreOnRoute, shoreDist[i]);
        if (depth) maxDepthOnRoute = Math.max(maxDepthOnRoute, depth[i]);
      }
    }
    const legDistM = (ll) => {
      let d = 0;
      for (let i = 1; i < ll.length; i++) d += havM(ll[i - 1], ll[i]);
      return d;
    };
    const legDists = legsLatLngs.map(legDistM);
    const totalDistKm = legDists.reduce((a, b) => a + b, 0) / 1000;
    const legLabel = (k) => {
      if (stopIdxs.length === 0) return k === 0 ? 'Out' : 'Back';
      return k < stopIdxs.length ? `To stop ${k + 1}` : 'Back to put-in';
    };
    const legLines = legsLatLngs.map((ll, k) =>
      `<span style="color:${palette[k % 2]}">●</span> ${legLabel(k)}: ` +
      `${(legDists[k] / 1000).toFixed(1)} km, ${fmtTime(legTimesS[k])}`).join('<br>');
    const overBudget = stopIdxs.length > 0 && totalTimeS > 1.15 * budgetSec;
    $('statsBody').innerHTML = `
      <b>Total:</b> ${totalDistKm.toFixed(1)} km, ~${fmtTime(totalTimeS)}
      ${stopIdxs.length ? ` <small style="color:#6c7f8d">(tour via ${stopIdxs.length} stop${stopIdxs.length > 1 ? 's' : ''})</small>` : ''}<br>
      ${legLines}<br>
      ${overBudget ? `<span class="warn">⚠ Tour needs ~${fmtTime(totalTimeS)} — longer than your ${$('duration').value} h budget.</span><br>` : ''}
      ${lunch ? `🍴 Lunch: ${lunch.name || lunch.type} near the turning point<br>` : ''}
      Max open-water fetch: ${(maxFetchM / 1000).toFixed(1)} km<br>
      Farthest from shore: ${Math.round(maxShoreOnRoute)} m
      ${depth && maxDepthOnRoute > 0
        ? `<br>Deepest point: ~${Math.round(maxDepthOnRoute)} m
           <small style="color:#6c7f8d">(EMODnet ~100 m grid — indicative, not for navigation)</small>`
        : ''}
      ${exposed ? '<br><span class="warn">⚠ Route crosses exposed water in wind above your comfort level.</span>' : ''}
      <br><small style="color:#6c7f8d">route computed in ${planMs} ms</small>`;
    $('stats').classList.remove('hidden');
    $('nav').classList.remove('hidden');
    lastResult = {
      legsLatLngs, lunch, totalTimeS,
      stops: stops.map((s, k) => ({ lat: s.latlng.lat, lon: s.latlng.lng, name: `Stop ${k + 1}` })),
      isRoundTrip: stopIdxs.length === 0,
    };
    setStatus('Done. Drag sliders and regenerate to explore.');

    if (spotLayer) spotLayer.remove();
    spotLayer = L.layerGroup(spots.map((s) =>
      L.circleMarker([s.lat, s.lon], {
        radius: 4,
        color: s.type === 'slipway' ? '#90be6d' : '#f9c74f',
        fillOpacity: 0.8,
        weight: 1,
      }).bindPopup(`${s.type}${s.name ? ': ' + s.name : ''}`)
    )).addTo(map);
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
  }
  generateBtn.disabled = false;
}

function showWind(timeline, durationH, comfortWs) {
  const now = timeline[0];
  $('wind').classList.remove('hidden');
  // Arrow points where the wind blows TO; base glyph ➤ points east (90°)
  $('windArrow').style.transform = `rotate(${now.wdDeg + 180 - 90}deg)`;
  $('windText').textContent = `${now.ws.toFixed(1)} m/s from ${Math.round(now.wdDeg)}°`;
  const wsMax = Math.max(...timeline.map((w) => w.ws));
  const warn = wsMax > comfortWs ? ' — above your comfort limit!' : '';
  $('windExtra').textContent =
    `Gusts ${now.gust?.toFixed(1) ?? '?'} m/s · ${now.tempC?.toFixed(0) ?? '?'} °C · ` +
    `peak ${wsMax.toFixed(1)} m/s during the next ${timeline.length - 1} h${warn}`;
}

// --- GPX export -------------------------------------------------------------

function downloadGpx() {
  if (!lastResult) return;
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const pt = (tag, [lat, lon], name) =>
    `  <${tag} lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${name ? `<name>${esc(name)}</name>` : ''}</${tag}>`;
  const seg = (latlngs) =>
    `    <trkseg>\n` +
    latlngs.map(([lat, lon]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n') +
    `\n    </trkseg>`;
  const { legsLatLngs, lunch, stops: gpxStops, isRoundTrip } = lastResult;
  const first = legsLatLngs[0];
  const wpts = [pt('wpt', first[0], 'Put-in')];
  if (isRoundTrip) wpts.push(pt('wpt', first[first.length - 1], 'Turning point'));
  for (const s of gpxStops) wpts.push(pt('wpt', [s.lat, s.lon], s.name));
  if (lunch) wpts.push(pt('wpt', [lunch.lat, lunch.lon], `Lunch: ${lunch.name || lunch.type}`));
  const name = isRoundTrip ? 'Round trip' : `Tour via ${gpxStops.length} stops`;
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaddlePlanner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>PaddlePlanner ${name}</name><time>${new Date().toISOString()}</time></metadata>
${wpts.join('\n')}
  <trk><name>${name}</name>
${legsLatLngs.map(seg).join('\n')}
  </trk>
</gpx>`;
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'paddle-roundtrip.gpx';
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- Live GPS navigation -----------------------------------------------------

const nav = { watchId: null, marker: null, accCircle: null, wakeLock: null,
              cum: null, route: null, progress: 0 };

function buildNavRoute() {
  const route = lastResult.legsLatLngs.flat();
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + havM(route[i - 1], route[i]));
  nav.route = route;
  nav.cum = cum;
  nav.progress = 0;
}

/**
 * Project the position onto the route. On a loop, start and finish are the
 * same spot, so projection must respect progress already made: search a
 * window ahead of (and slightly behind) the current progress first, and only
 * fall back to a global search when truly lost.
 */
function nearestOnRoute(latlng) {
  const R = 6371000, rad = Math.PI / 180;
  const cosLat = Math.cos(latlng.lat * rad);
  const toXY = ([lat, lon]) => [(lon - latlng.lng) * rad * R * cosLat, (lat - latlng.lat) * rad * R];
  const project = (lo, hi) => {
    let best = { dist: Infinity, along: 0 };
    for (let i = 0; i < nav.route.length - 1; i++) {
      if (nav.cum[i + 1] < lo || nav.cum[i] > hi) continue;
      const [ax, ay] = toXY(nav.route[i]);
      const [bx, by] = toXY(nav.route[i + 1]);
      const abx = bx - ax, aby = by - ay;
      const len2 = abx * abx + aby * aby || 1e-9;
      let t = (-(ax * abx + ay * aby)) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * abx, ay + t * aby);
      if (d < best.dist) {
        best = { dist: d, along: nav.cum[i] + t * (nav.cum[i + 1] - nav.cum[i]) };
      }
    }
    return best;
  };
  let best = project(nav.progress - 400, nav.progress + 3000);
  if (best.dist > 300) best = project(0, Infinity); // lost: global re-match
  // Only bank progress while actually on the route; a guess made while
  // far off route must not corrupt the remaining-distance estimate.
  if (best.dist <= 300) nav.progress = Math.max(nav.progress, best.along);
  return best;
}

function onPosition(pos) {
  const { latitude, longitude, accuracy, speed } = pos.coords;
  const ll = L.latLng(latitude, longitude);
  if (!nav.marker) {
    nav.marker = L.circleMarker(ll, { radius: 8, color: '#fff', fillColor: '#1e88e5', fillOpacity: 1, weight: 2 }).addTo(map);
    nav.accCircle = L.circle(ll, { radius: accuracy, color: '#1e88e5', weight: 1, fillOpacity: 0.1 }).addTo(map);
  } else {
    nav.marker.setLatLng(ll);
    nav.accCircle.setLatLng(ll).setRadius(accuracy);
  }
  if ($('follow').checked) map.setView(ll, Math.max(map.getZoom(), 14));

  const p = nearestOnRoute(ll);
  const totalLen = nav.cum[nav.cum.length - 1];
  const remaining = Math.max(0, totalLen - p.along);
  const spdMs = speed && speed > 0.3 ? speed : parseFloat($('speed').value) / 3.6;
  const eta = remaining / spdMs;
  const off = p.dist > 100;
  $('navBody').innerHTML = `
    ${off ? '<span class="warn">⚠ Off route by ' + Math.round(p.dist) + ' m</span><br>' : ''}
    Remaining: ${(remaining / 1000).toFixed(1)} km · ETA ${fmtTime(eta)}<br>
    Speed: ${(spdMs * 3.6).toFixed(1)} km/h · GPS ±${Math.round(accuracy)} m`;
}

async function startNav() {
  if (!lastResult) return;
  if (!('geolocation' in navigator)) {
    $('navBody').textContent = 'Geolocation not available in this browser.';
    return;
  }
  buildNavRoute();
  nav.watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    $('navBody').textContent = 'GPS error: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  try { nav.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
  $('navBtn').textContent = 'Stop navigation';
  $('navBtn').classList.add('active');
  $('navBody').textContent = 'Waiting for GPS fix…';
}

function stopNav() {
  if (nav.watchId != null) navigator.geolocation.clearWatch(nav.watchId);
  nav.watchId = null;
  nav.wakeLock?.release().catch(() => {});
  nav.wakeLock = null;
  if (nav.marker) { nav.marker.remove(); nav.marker = null; }
  if (nav.accCircle) { nav.accCircle.remove(); nav.accCircle = null; }
  $('navBtn').textContent = 'Start GPS navigation';
  $('navBtn').classList.remove('active');
  $('navBody').textContent = '';
}

$('navBtn').addEventListener('click', () => (nav.watchId == null ? startNav() : stopNav()));
$('gpxBtn').addEventListener('click', downloadGpx);
generateBtn.addEventListener('click', generate);
setStatus('Click the map to set your put-in point.');

// Test hook for automated e2e verification
window.__paddle = { map, generate };
