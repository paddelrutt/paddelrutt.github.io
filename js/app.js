import {
  makeGrid, lonLatToCell, cellToLonLat, pointToLonLat, gridBounds,
  rasterizeWater, floodFill, nearestWater,
} from './grid.js';
import { fetchWaterFeatures } from './tiles.js';
import { computeFetch, computeShoreDistance, planRoundTripOptions, planViaRoute, smoothPath } from './router.js';
import { fetchForecastSeries, sliceTimeline } from './smhi.js';
import { fetchLandingSpots, fetchRestPOIs } from './overpass.js';
import { fetchDepthPerCell } from './depth.js';
import { fetchMarine } from './marine.js';
import { sunTimes } from './sun.js';

// Register the service worker for offline support (no-op on http without SW).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Open on an overview of Sweden; a shared link (#r=) or first map click takes over.
const SWEDEN_BOUNDS = L.latLngBounds([[55.2, 10.8], [69.1, 24.2]]);
const map = L.map('map').fitBounds(SWEDEN_BOUNDS);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const generateBtn = $('generate');

// Mobile bottom-sheet: start collapsed so the map is visible, toggle on tap.
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
function setCollapsed(on) {
  document.body.classList.toggle('panel-collapsed', on);
  $('panelToggleLabel').textContent = on ? 'Settings & route ▲' : 'Settings & route ▼';
}
if (isMobile()) setCollapsed(true);
$('panelToggle').addEventListener('click', () =>
  setCollapsed(!document.body.classList.contains('panel-collapsed')));
window.addEventListener('resize', () => map.invalidateSize());

// On a phone, after a route is generated, open the sheet and scroll the
// route summary into view so it doesn't hide below the fold.
function revealRoute() {
  if (!isMobile()) return;
  setCollapsed(false);
  const panel = $('panel'), stats = $('stats');
  requestAnimationFrame(() =>
    panel.scrollTo({ top: Math.max(0, stats.offsetTop - 56), behavior: 'smooth' }));
}

let putIn = null;        // L.LatLng
let putInMarker = null;
let stops = [];          // [{latlng, marker}]
let routeLayers = [];
let maskOverlay = null;
let spotLayer = null;
let restLayer = null;
let lastMaskCanvas = null;
let lastResult = null;   // selected option, for GPX/nav/share
let windSeries = null;   // cached SMHI series for the current put-in
let routeOptions = [];   // up to 3 suggested loops (round trips)
let routeCtx = null;     // shared context for rendering an option's stats
let selectedOption = 0;

function setStatus(msg) { statusEl.textContent = msg; }
const havM = (a, b) => map.distance(a, b);

// --- sliders ---------------------------------------------------------------
const bind = (id, outId, fmt) => {
  const el = $(id), out = $(outId);
  const update = () => (out.textContent = fmt(parseFloat(el.value)));
  el.addEventListener('input', update);
  update();
};
bind('duration', 'durationOut', (v) => v.toFixed(1) + ' h');
bind('speed', 'speedOut', (v) => v.toFixed(1) + ' km/h');
bind('scenery', 'sceneryOut', (v) =>
  v <= 0.25 ? 'direct' : v < 1 ? 'mostly direct' : v < 2.25 ? 'scenic' : 'very scenic');
bind('comfort', 'comfortOut', (v) => v.toFixed(0) + ' m/s');
bind('shore', 'shoreOut', (v) => (v > 2000 ? 'no limit' : v.toFixed(0) + ' m'));
bind('depth', 'depthOut', (v) => (v > 50 ? 'no limit' : v.toFixed(0) + ' m'));

// --- stops: markers + list -------------------------------------------------
function makeStopIcon(n) {
  return L.divIcon({
    className: '', html: `<div class="stop-icon">${n}</div>`,
    iconSize: [20, 20], iconAnchor: [10, 10],
  });
}

function updateStopsUI() {
  $('stopsLabel').textContent = stops.length === 0
    ? 'No stops' : `${stops.length} stop${stops.length > 1 ? 's' : ''}`;
  $('undoStop').disabled = stops.length === 0;
  $('clearAll').disabled = !putIn;
  $('shareBtn').disabled = !putIn;
  generateBtn.textContent = stops.length === 0
    ? 'Generate round trip' : `Generate tour via ${stops.length} stop${stops.length > 1 ? 's' : ''}`;
  renderStopsList();
}

function renderStopsList() {
  const ol = $('stopsList');
  ol.innerHTML = '';
  stops.forEach((s, i) => {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'si-num'; num.textContent = i + 1;
    const label = document.createElement('span');
    label.className = 'si-label';
    label.textContent = `${s.latlng.lat.toFixed(4)}, ${s.latlng.lng.toFixed(4)}`;
    const up = document.createElement('button');
    up.className = 'si-btn'; up.textContent = '▲'; up.title = 'Move earlier';
    up.disabled = i === 0;
    up.addEventListener('click', () => moveStop(i, -1));
    const down = document.createElement('button');
    down.className = 'si-btn'; down.textContent = '▼'; down.title = 'Move later';
    down.disabled = i === stops.length - 1;
    down.addEventListener('click', () => moveStop(i, +1));
    const del = document.createElement('button');
    del.className = 'si-btn del'; del.textContent = '✕'; del.title = 'Remove';
    del.addEventListener('click', () => removeStop(stops[i]));
    li.append(num, label, up, down, del);
    ol.appendChild(li);
  });
}

function renumberStops() {
  stops.forEach((s, i) => s.marker.setIcon(makeStopIcon(i + 1)));
  updateStopsUI();
}

function moveStop(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= stops.length) return;
  [stops[i], stops[j]] = [stops[j], stops[i]];
  renumberStops();
  setStatus('Stop order changed — regenerate to replan.');
}

function removeStop(stopObj) {
  const idx = stops.indexOf(stopObj);
  if (idx === -1) return;
  stopObj.marker.remove();
  stops.splice(idx, 1);
  renumberStops();
  setStatus(stops.length ? 'Stop removed — regenerate to replan.' : 'All stops removed.');
}

function stopPopup(stopObj) {
  const div = document.createElement('div');
  div.className = 'marker-popup';
  div.innerHTML = `<div class="mp-title">Stop ${stops.indexOf(stopObj) + 1}</div>`;
  const btn = document.createElement('button');
  btn.className = 'popup-remove';
  btn.textContent = '✕ Remove stop';
  btn.addEventListener('click', () => { map.closePopup(); removeStop(stopObj); });
  div.appendChild(btn);
  return div;
}

function addStop(latlng, silent) {
  const stopObj = { latlng: L.latLng(latlng), marker: null };
  const marker = L.marker(stopObj.latlng, { icon: makeStopIcon(stops.length + 1), draggable: true });
  stopObj.marker = marker;
  marker.bindPopup(() => stopPopup(stopObj));
  marker.on('dragend', () => {
    stopObj.latlng = marker.getLatLng();
    renderStopsList();
    setStatus('Stop moved — regenerate to replan.');
  });
  marker.addTo(map);
  stops.push(stopObj);
  if (!silent) updateStopsUI();
}

function setPutIn(latlng, silent) {
  putIn = L.latLng(latlng);
  if (putInMarker) putInMarker.remove();
  putInMarker = L.marker(putIn, { draggable: true })
    .addTo(map).bindPopup('Put-in — drag to move');
  putInMarker.on('dragend', () => {
    putIn = putInMarker.getLatLng();
    windSeries = null; // forecast depends on location
    refreshWindPreview();
    setStatus('Put-in moved — regenerate to replan.');
  });
  generateBtn.disabled = false;
  if (!silent) { windSeries = null; refreshWindPreview(); }
}

map.on('click', (e) => {
  if (!putIn) {
    setPutIn(e.latlng);
    setStatus('Put-in set. Click to add stops; drag any marker to move, tap a stop to remove.');
  } else {
    addStop(e.latlng);
    setStatus(`Stop ${stops.length} added.`);
  }
  updateStopsUI();
});

$('undoStop').addEventListener('click', () => {
  const s = stops.pop();
  if (s) s.marker.remove();
  renumberStops();
});

$('clearAll').addEventListener('click', () => {
  for (const s of stops) s.marker.remove();
  stops = [];
  if (putInMarker) { putInMarker.remove(); putInMarker = null; }
  putIn = null;
  windSeries = null;
  generateBtn.disabled = true;
  stopNav();
  clearRoute();
  updateStopsUI();
  $('wind').classList.add('hidden');
  $('windTimeline').innerHTML = '';
  // Drop the saved plan from the URL so a reload doesn't resurrect it
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  setStatus('Click the map to set your put-in point.');
});

$('showMask').addEventListener('change', (e) => {
  if (maskOverlay) { maskOverlay.remove(); maskOverlay = null; }
  if (e.target.checked && lastMaskCanvas) {
    maskOverlay = L.imageOverlay(lastMaskCanvas.canvas.toDataURL(), lastMaskCanvas.bounds, { opacity: 0.45 }).addTo(map);
  }
});

$('showRest').addEventListener('change', () => updateRestLayer());

function clearRouteLayers() {
  for (const l of routeLayers) l.remove();
  routeLayers = [];
}
function clearRoute() {
  clearRouteLayers();
  routeOptions = []; routeCtx = null;
  lastResult = null;
  $('stats').classList.add('hidden');
  $('nav').classList.add('hidden');
  $('options').innerHTML = '';
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

// --- "When to go": wind preview timeline -----------------------------------
async function refreshWindPreview() {
  const tl = $('windTimeline');
  if (!putIn) { tl.innerHTML = ''; return; }
  tl.innerHTML = '<span class="h">loading…</span>';
  try {
    if (!windSeries) windSeries = await fetchForecastSeries(putIn.lat, putIn.lng);
    renderWindTimeline();
  } catch {
    tl.innerHTML = '<span class="h">forecast unavailable</span>';
  }
}

function renderWindTimeline() {
  const tl = $('windTimeline');
  const comfort = parseFloat($('comfort').value);
  const sel = parseInt($('depart').value, 10);
  const now = Date.now();
  const hours = 11;
  tl.innerHTML = '';
  for (let h = 0; h <= hours; h++) {
    const e = sliceTimeline(windSeries, now + h * 3600 * 1000, 1)[0];
    const div = document.createElement('div');
    div.className = 'h' + (e.ws > comfort ? ' windy' : '') + (h === sel ? ' sel' : '');
    const hh = new Date(now + h * 3600 * 1000).getHours();
    div.innerHTML =
      `${h === 0 ? 'now' : hh + ':00'}` +
      `<span class="wsv">${e.ws.toFixed(0)}</span>` +
      `<span class="dir" style="transform:rotate(${e.wdDeg + 180}deg)">↑</span>`;
    div.title = `${e.ws.toFixed(1)} m/s from ${Math.round(e.wdDeg)}° at ${h === 0 ? 'now' : hh + ':00'}`;
    div.addEventListener('click', () => { $('depart').value = h; updateDepartOut(); });
    tl.appendChild(div);
  }
}

function updateDepartOut() {
  const h = parseInt($('depart').value, 10);
  $('departOut').textContent = h === 0 ? 'now' : `${h} h (≈${new Date(Date.now() + h * 3600000).getHours()}:00)`;
  if (windSeries) renderWindTimeline();
}
$('depart').addEventListener('input', updateDepartOut);
$('comfort').addEventListener('input', () => { if (windSeries) renderWindTimeline(); });

// --- difficulty ------------------------------------------------------------
function difficultyBadge(distKm, wsMax, maxFetchM, waterTempC) {
  let score = 0;
  score += distKm > 18 ? 3 : distKm > 12 ? 2 : distKm > 6 ? 1 : 0;
  score += wsMax > 9 ? 3 : wsMax > 7 ? 2 : wsMax > 5 ? 1 : 0;
  score += maxFetchM > 2500 ? 2 : maxFetchM > 1200 ? 1 : 0;
  if (waterTempC != null) score += waterTempC < 8 ? 2 : waterTempC < 12 ? 1 : 0;
  const levels = [
    [2, 'diff-easy', 'Easy'],
    [4, 'diff-mod', 'Moderate'],
    [6, 'diff-hard', 'Challenging'],
    [99, 'diff-extreme', 'Advanced'],
  ];
  const [, cls, label] = levels.find(([t]) => score <= t);
  return `<span class="diffbadge ${cls}">${label}</span>`;
}

// --- rest POIs (shelters / campsites / water) ------------------------------
let restPOIs = null;
async function updateRestLayer() {
  if (restLayer) { restLayer.remove(); restLayer = null; }
  if (!$('showRest').checked || !putIn) return;
  const r = 0.09; // ~10 km box around put-in
  const b = [putIn.lat - r, putIn.lng - 2 * r, putIn.lat + r, putIn.lng + 2 * r];
  try {
    restPOIs = await fetchRestPOIs(b[0], b[1], b[2], b[3]);
  } catch { restPOIs = []; }
  const icon = { shelter: ['⛺', '#90be6d'], camp: ['🏕', '#90be6d'], hut: ['🛖', '#f9c74f'], water: ['🚰', '#7cc4e8'] };
  restLayer = L.layerGroup(restPOIs.map((p) => {
    const [emoji] = icon[p.category] || ['•', '#fff'];
    return L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: 'rest-icon', html: emoji, iconSize: [20, 20], iconAnchor: [10, 10] }),
    }).bindPopup(`${p.category}${p.name ? ': ' + p.name : ''}`);
  })).addTo(map);
}

// --- generate --------------------------------------------------------------
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
    const departH = parseInt($('depart').value, 10);
    const departMs = Date.now() + departH * 3600 * 1000;

    const radiusM = Math.min(16000, Math.max(3000, speedMs * budgetSec * 0.5 * 1.3 + 1500));
    const grid = makeGrid(putIn.lat, putIn.lng, radiusM, 14); // z14 for finer islets

    setStatus('Fetching wind forecast (SMHI)…');
    const seriesP = windSeries
      ? Promise.resolve(windSeries)
      : fetchForecastSeries(putIn.lat, putIn.lng);
    const b = gridBounds(grid);
    const spotsP = fetchLandingSpots(b[0][0], b[0][1], b[1][0], b[1][1]).catch(() => []);
    const depthP = fetchDepthPerCell(grid, b);
    const marineP = fetchMarine(putIn.lat, putIn.lng);

    setStatus('Fetching water geometry…');
    const features = await fetchWaterFeatures(grid, (done, total) =>
      setStatus(`Fetching water geometry… ${done}/${total} tiles`));

    setStatus('Building water grid…');
    const mask = rasterizeWater(grid, features);

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

    windSeries = await seriesP;
    const timeline = sliceTimeline(windSeries, departMs, Math.ceil(durationH) + 1);
    const marine = await marineP;
    showConditions(timeline, departH, durationH, comfortWs, marine);

    setStatus('Computing wind exposure per forecast hour…');
    await new Promise((r) => setTimeout(r, 20));
    const fieldCache = new Map();
    const fetchFields = timeline.map((w) => {
      const key = Math.round(w.wdDeg / 22.5) % 16;
      if (!fieldCache.has(key)) {
        fieldCache.set(key, computeFetch(mask, grid.W, grid.H, key * 22.5, grid.cellMeters));
      }
      return fieldCache.get(key);
    });

    const spots = await spotsP;
    const lunchBonus = new Uint8Array(grid.W * grid.H);
    const spotCells = [];
    for (const s of spots) {
      let idx = lonLatToCell(grid, s.lon, s.lat);
      idx = nearestWater(reach, grid.W, grid.H, idx, 6);
      if (idx !== -1) spotCells.push({ idx, spot: s });
    }
    {
      const dpt = Math.ceil(500 / grid.cellMeters);
      let frontier = spotCells.map((s) => s.idx);
      for (const i of frontier) lunchBonus[i] = 1;
      for (let d = 0; d < dpt; d++) {
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
      shoreDist, sceneryW: parseFloat($('scenery').value),
    };

    // Build raw routes: one tour for via-stops, or up to 3 round-trip options.
    let rawRoutes;
    if (stopIdxs.length) {
      const via = planViaRoute(params, startIdx, stopIdxs);
      if (via.unreachableLeg !== undefined) {
        setStatus(`Leg ${via.unreachableLeg + 1} of the tour can't be completed on connected water.`);
        generateBtn.disabled = false;
        return;
      }
      rawRoutes = [{ legsPaths: via.legs, legTimesS: via.legTimesS, totalTimeS: via.totalTimeS, turnIdx: null, maxFetchM: via.maxFetchM }];
    } else {
      const opts = planRoundTripOptions(params, startIdx, budgetSec, 3);
      if (!opts.length) {
        setStatus('Could not fit a round trip here — water body may be too small for that duration.');
        generateBtn.disabled = false;
        return;
      }
      rawRoutes = opts.map((o) => ({
        legsPaths: [o.outPath, o.backPath], legTimesS: [o.outTimeS, o.backTimeS],
        totalTimeS: o.totalTimeS, turnIdx: o.turnIdx, maxFetchM: o.maxFetchM,
      }));
    }
    const planMs = Math.round(performance.now() - t0);

    const toLatLngs = (path) =>
      smoothPath(reach, grid.W, grid.H, path).map(([x, y]) => {
        const [lon, lat] = pointToLonLat(grid, x, y);
        return [lat, lon];
      });
    const legDistM = (ll) => {
      let d = 0;
      for (let i = 1; i < ll.length; i++) d += havM(ll[i - 1], ll[i]);
      return d;
    };

    // Turn each raw route into a renderable option with its own stats.
    routeOptions = rawRoutes.map((r) => {
      const legsLatLngs = r.legsPaths.map(toLatLngs);
      const legDists = legsLatLngs.map(legDistM);
      let maxShoreOnRoute = 0, maxDepthOnRoute = 0;
      for (const path of r.legsPaths) for (const i of path) {
        maxShoreOnRoute = Math.max(maxShoreOnRoute, shoreDist[i]);
        if (depth) maxDepthOnRoute = Math.max(maxDepthOnRoute, depth[i]);
      }
      let lunch = null, turnLatLng = null;
      if (r.turnIdx != null) {
        const [tLon, tLat] = cellToLonLat(grid, r.turnIdx);
        turnLatLng = [tLat, tLon];
        let bestScore = Infinity;
        for (const { spot } of spotCells) {
          const d = havM([tLat, tLon], [spot.lat, spot.lon]);
          const sc = d * (spot.type === 'beach' ? 1 : 1.4);
          if (d < 1200 && sc < bestScore) { bestScore = sc; lunch = spot; }
        }
      }
      return {
        legsLatLngs, legDists, legTimesS: r.legTimesS, totalTimeS: r.totalTimeS,
        totalDistKm: legDists.reduce((a, b2) => a + b2, 0) / 1000,
        maxFetchM: r.maxFetchM, maxShoreOnRoute, maxDepthOnRoute, turnLatLng, lunch,
      };
    });

    routeCtx = {
      timeline, comfortWs, durationH, budgetSec, departMs, planMs,
      hasDepth: !!depth, marine, stopCount: stopIdxs.length,
      putLat: putIn.lat, putLng: putIn.lng,
      stops: stops.map((s, k) => ({ lat: s.latlng.lat, lon: s.latlng.lng, name: `Stop ${k + 1}` })),
    };
    selectedOption = 0;
    $('stats').classList.remove('hidden');
    $('nav').classList.remove('hidden');
    selectRouteOption(0);
    revealRoute();
    writeUrl();
    setStatus('Done. Caching map for offline use…');

    if (spotLayer) spotLayer.remove();
    spotLayer = L.layerGroup(spots.map((s) =>
      L.circleMarker([s.lat, s.lon], {
        radius: 4, color: s.type === 'slipway' ? '#90be6d' : '#f9c74f',
        fillOpacity: 0.8, weight: 1,
      }).bindPopup(`${s.type}${s.name ? ': ' + s.name : ''}`)
    )).addTo(map);

    if ($('showRest').checked) updateRestLayer();
    // Cache tiles covering every option so switching/offline all work.
    let cacheBounds = null;
    for (const o of routeOptions)
      for (const ll of o.legsLatLngs) {
        const lb = L.latLngBounds(ll);
        cacheBounds = cacheBounds ? cacheBounds.extend(lb) : lb;
      }
    await prefetchTiles(cacheBounds);
    setStatus('Done. Map cached for offline — drag sliders and regenerate to explore.');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
  }
  generateBtn.disabled = false;
}

const ROUTE_PALETTE = ['#e76f51', '#2a9d8f'];

// Draw the selected option boldly (out solid, back dashed) and the others as
// thin, clickable lines, then render the selected option's stats.
function selectRouteOption(idx) {
  selectedOption = idx;
  clearRouteLayers();
  routeOptions.forEach((opt, k) => {
    if (k === idx) return;
    const line = L.polyline(opt.legsLatLngs.flat(), { color: '#6c8aa0', weight: 3, opacity: 0.5 })
      .addTo(map).bindTooltip(`Option ${k + 1}`);
    line.on('click', () => selectRouteOption(k));
    routeLayers.push(line);
  });
  const opt = routeOptions[idx];
  let bounds = null;
  opt.legsLatLngs.forEach((ll, k) => {
    const line = L.polyline(ll, {
      color: ROUTE_PALETTE[k % 2], weight: 4,
      dashArray: k === opt.legsLatLngs.length - 1 ? '8 6' : null,
    }).addTo(map);
    routeLayers.push(line);
    bounds = bounds ? bounds.extend(line.getBounds()) : line.getBounds();
  });
  if (opt.turnLatLng) {
    routeLayers.push(L.circleMarker(opt.turnLatLng, { radius: 7, color: '#f4a261', fillOpacity: 0.9 })
      .addTo(map).bindPopup('Turning point'));
    if (opt.lunch) {
      routeLayers.push(L.marker([opt.lunch.lat, opt.lunch.lon]).addTo(map)
        .bindPopup(`🍴 Lunch stop: ${opt.lunch.name || opt.lunch.type}`));
    }
  }
  if (bounds) map.fitBounds(bounds, { padding: [30, 30] });
  renderRouteStats();
}

function renderRouteStats() {
  const ctx = routeCtx, opt = routeOptions[selectedOption];

  const sw = $('options');
  if (routeOptions.length > 1) {
    sw.innerHTML = routeOptions.map((o, k) =>
      `<button class="optbtn${k === selectedOption ? ' sel' : ''}" data-i="${k}">Option ${k + 1}` +
      `<span>${o.totalDistKm.toFixed(1)} km · ${fmtTime(o.totalTimeS)}</span></button>`).join('');
    sw.querySelectorAll('.optbtn').forEach((btn) =>
      btn.addEventListener('click', () => selectRouteOption(+btn.dataset.i)));
  } else {
    sw.innerHTML = '';
  }

  const wsMax = Math.max(...ctx.timeline.slice(0, Math.ceil(opt.totalTimeS / 3600) + 1).map((w) => w.ws));
  const exposed = opt.maxFetchM >= 2500 && wsMax > ctx.comfortWs;
  const legLabel = (k) => ctx.stopCount === 0
    ? (k === 0 ? 'Out' : 'Back')
    : (k < ctx.stopCount ? `To stop ${k + 1}` : 'Back to put-in');
  const legLines = opt.legsLatLngs.map((ll, k) =>
    `<span style="color:${ROUTE_PALETTE[k % 2]}">●</span> ${legLabel(k)}: ` +
    `${(opt.legDists[k] / 1000).toFixed(1)} km, ${fmtTime(opt.legTimesS[k])}`).join('<br>');
  const overBudget = ctx.stopCount > 0 && opt.totalTimeS > 1.15 * ctx.budgetSec;

  const sun = sunTimes(new Date(ctx.departMs), ctx.putLat, ctx.putLng);
  const returnMs = ctx.departMs + opt.totalTimeS * 1000;
  let daylight = '';
  if (sun) {
    const back = new Date(returnMs);
    const hm = (d) => d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    if (returnMs > sun.sunset.getTime()) {
      daylight = `<br><span class="warn">⚠ Returns ${hm(back)}, after sunset (${hm(sun.sunset)}).</span>`;
    } else {
      daylight = `<br>Back ~${hm(back)}, ${Math.round((sun.sunset.getTime() - returnMs) / 60000)} min before sunset (${hm(sun.sunset)}).`;
    }
  }

  $('statsBody').innerHTML = `
    <b>Total:</b> ${opt.totalDistKm.toFixed(1)} km, ~${fmtTime(opt.totalTimeS)}
    ${ctx.stopCount ? ` <small style="color:#6c7f8d">(tour via ${ctx.stopCount} stop${ctx.stopCount > 1 ? 's' : ''})</small>` : ''}<br>
    ${legLines}<br>
    ${overBudget ? `<span class="warn">⚠ Tour needs ~${fmtTime(opt.totalTimeS)} — longer than your ${ctx.durationH} h budget.</span><br>` : ''}
    ${opt.lunch ? `🍴 Lunch: ${opt.lunch.name || opt.lunch.type} near the turning point<br>` : ''}
    Max open-water fetch: ${(opt.maxFetchM / 1000).toFixed(1)} km<br>
    Farthest from shore: ${Math.round(opt.maxShoreOnRoute)} m
    ${ctx.hasDepth && opt.maxDepthOnRoute > 0
      ? `<br>Deepest point: ~${Math.round(opt.maxDepthOnRoute)} m
         <small style="color:#6c7f8d">(EMODnet ~100 m grid — indicative, not for navigation)</small>` : ''}
    ${daylight}
    ${exposed ? '<br><span class="warn">⚠ Route crosses exposed water in wind above your comfort level.</span>' : ''}
    <br><small style="color:#6c7f8d">route computed in ${ctx.planMs} ms</small>`;
  $('difficulty').innerHTML =
    'Difficulty: ' + difficultyBadge(opt.totalDistKm, wsMax, opt.maxFetchM, ctx.marine?.waterTempC);

  lastResult = {
    legsLatLngs: opt.legsLatLngs, lunch: opt.lunch, totalTimeS: opt.totalTimeS,
    totalDistKm: opt.totalDistKm, departMs: ctx.departMs, stops: ctx.stops,
    isRoundTrip: ctx.stopCount === 0, sunset: sun ? sun.sunset.getTime() : null,
  };
}

function showConditions(timeline, departH, durationH, comfortWs, marine) {
  const now = timeline[0];
  $('wind').classList.remove('hidden');
  $('windArrow').style.transform = `rotate(${now.wdDeg + 180 - 90}deg)`;
  $('windText').textContent =
    `${now.ws.toFixed(1)} m/s from ${Math.round(now.wdDeg)}°` +
    (departH ? ` (at start, in ${departH} h)` : '');
  const wsMax = Math.max(...timeline.map((w) => w.ws));
  const warn = wsMax > comfortWs ? ' — above your comfort limit!' : '';
  $('windExtra').textContent =
    `Gusts ${now.gust?.toFixed(1) ?? '?'} m/s · air ${now.tempC?.toFixed(0) ?? '?'} °C · ` +
    `peak ${wsMax.toFixed(1)} m/s over the trip${warn}`;
  if (marine && marine.waterTempC != null) {
    const t = marine.waterTempC;
    const cold = t < 12;
    $('safety').innerHTML =
      `Water ${t.toFixed(1)} °C` +
      (marine.waveHeightM != null ? ` · waves ~${marine.waveHeightM.toFixed(1)} m` : '') +
      (cold ? ` · <span class="cold">cold — dress for immersion (wetsuit/drysuit)</span>` : '');
  } else {
    $('safety').innerHTML = '';
  }
}

// --- offline tile prefetch -------------------------------------------------
async function prefetchTiles(bounds) {
  if (!bounds || !('caches' in window)) return;
  const note = $('offlineNote');
  const z0 = Math.max(10, map.getZoom());
  const urls = [];
  for (let z = z0; z <= Math.min(16, z0 + 2); z++) {
    const n = 2 ** z;
    const latRad = (l) => (l * Math.PI) / 180;
    const xT = (lon) => Math.floor(((lon + 180) / 360) * n);
    const yT = (lat) => Math.floor((1 - Math.log(Math.tan(latRad(lat)) + 1 / Math.cos(latRad(lat))) / Math.PI) / 2 * n);
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    for (let x = xT(sw.lng); x <= xT(ne.lng); x++)
      for (let y = yT(ne.lat); y <= yT(sw.lat); y++)
        urls.push(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
    if (urls.length > 160) break; // keep the prefetch polite (OSM tile policy)
  }
  let done = 0;
  await Promise.allSettled(urls.slice(0, 160).map((u) =>
    fetch(u, { mode: 'no-cors' }).then(() => { done++; })));
  note.textContent = `Offline map: ${done} tiles cached for this route.`;
}

// --- GPX export ------------------------------------------------------------
function buildGpx() {
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaddlePlanner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>PaddlePlanner ${name}</name><time>${new Date().toISOString()}</time></metadata>
${wpts.join('\n')}
  <trk><name>${name}</name>
${legsLatLngs.map(seg).join('\n')}
  </trk>
</gpx>`;
}

function downloadGpx() {
  if (!lastResult) return;
  const blob = new Blob([buildGpx()], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'paddle-route.gpx';
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- GPX import ------------------------------------------------------------
function importGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const num = (el, a) => parseFloat(el.getAttribute(a));
  const wpts = [...doc.querySelectorAll('wpt')].map((w) => ({
    lat: num(w, 'lat'), lon: num(w, 'lon'),
    name: w.querySelector('name')?.textContent || '',
  })).filter((p) => isFinite(p.lat));
  const trkpts = [...doc.querySelectorAll('trkpt')].map((w) => ({ lat: num(w, 'lat'), lon: num(w, 'lon') }))
    .filter((p) => isFinite(p.lat));

  // Clear existing
  for (const s of stops) s.marker.remove();
  stops = [];
  if (putInMarker) { putInMarker.remove(); putInMarker = null; }
  putIn = null;
  clearRoute();

  const putWpt = wpts.find((p) => /put.?in/i.test(p.name)) || wpts[0] || trkpts[0];
  if (!putWpt) { setStatus('No points found in that GPX.'); return; }
  setPutIn([putWpt.lat, putWpt.lon], true);

  const stopWpts = wpts.filter((p) => /^stop/i.test(p.name));
  for (const s of stopWpts) addStop([s.lat, s.lon], true);

  windSeries = null;
  refreshWindPreview();
  updateStopsUI();
  const allPts = [[putWpt.lat, putWpt.lon], ...stopWpts.map((s) => [s.lat, s.lon]), ...trkpts.map((t) => [t.lat, t.lon])];
  if (allPts.length) map.fitBounds(L.latLngBounds(allPts), { padding: [30, 30] });
  setStatus(`Imported put-in${stopWpts.length ? ` + ${stopWpts.length} stop(s)` : ''}. Tap Generate to plan.`);
}

$('gpxIn').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => importGpx(reader.result);
  reader.readAsText(file);
  e.target.value = '';
});

// --- save / share via URL --------------------------------------------------
function writeUrl() {
  const s = {
    p: putIn ? [+putIn.lat.toFixed(5), +putIn.lng.toFixed(5)] : null,
    s: stops.map((st) => [+st.latlng.lat.toFixed(5), +st.latlng.lng.toFixed(5)]),
    d: +$('duration').value, v: +$('speed').value, c: +$('comfort').value,
    sh: +$('shore').value, dp: +$('depth').value, dep: +$('depart').value,
    se: +$('scenery').value,
  };
  try { history.replaceState(null, '', '#r=' + btoa(JSON.stringify(s))); } catch {}
}

function readUrl() {
  const m = location.hash.match(/#r=(.+)/);
  if (!m) return false;
  let s;
  try { s = JSON.parse(atob(m[1])); } catch { return false; }
  if (!s || !s.p) return false;
  const set = (id, v) => { if (v != null) { $(id).value = v; $(id).dispatchEvent(new Event('input')); } };
  set('duration', s.d); set('speed', s.v); set('comfort', s.c);
  set('shore', s.sh); set('depth', s.dp); set('depart', s.dep); set('scenery', s.se);
  setPutIn(L.latLng(s.p[0], s.p[1]), true);
  for (const st of s.s || []) addStop(L.latLng(st[0], st[1]), true);
  windSeries = null;
  refreshWindPreview();
  updateStopsUI();
  const pts = [s.p, ...(s.s || [])];
  map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  setStatus('Shared plan loaded — tap Generate to plan it.');
  return true;
}

async function copyLink() {
  writeUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('Link copied to clipboard.');
  } catch {
    setStatus('Copy this link: ' + location.href);
  }
}

async function shareFloatPlan() {
  if (!lastResult) return;
  writeUrl();
  const back = lastResult.sunset && lastResult.departMs
    ? new Date(lastResult.departMs + lastResult.totalTimeS * 1000)
    : null;
  const text =
    `My paddling float plan:\n` +
    `Put-in: ${putIn.lat.toFixed(4)}, ${putIn.lng.toFixed(4)}\n` +
    `${lastResult.isRoundTrip ? 'Round trip' : lastResult.stops.length + ' stops'}, ` +
    `${lastResult.totalDistKm.toFixed(1)} km, ~${fmtTime(lastResult.totalTimeS)}\n` +
    (back ? `Expected back ~${back.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}\n` : '') +
    `Route: ${location.href}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'PaddlePlanner float plan', text }); return; } catch {}
  }
  try { await navigator.clipboard.writeText(text); setStatus('Float plan copied to clipboard.'); }
  catch { setStatus('Float plan:\n' + text); }
}

// --- live GPS navigation ---------------------------------------------------
const nav = {
  watchId: null, marker: null, accCircle: null, wakeLock: null,
  cum: null, route: null, progress: 0,
  spokenStops: new Set(), wasOff: false, heading: null,
};

function buildNavRoute() {
  const route = lastResult.legsLatLngs.flat();
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + havM(route[i - 1], route[i]));
  nav.route = route;
  nav.cum = cum;
  nav.progress = 0;
  nav.spokenStops = new Set();
  nav.wasOff = false;
}

function nearestOnRoute(latlng) {
  const R = 6371000, rad = Math.PI / 180;
  const cosLat = Math.cos(latlng.lat * rad);
  const toXY = ([lat, lon]) => [(lon - latlng.lng) * rad * R * cosLat, (lat - latlng.lat) * rad * R];
  const project = (lo, hi) => {
    let best = { dist: Infinity, along: 0, seg: 0, t: 0 };
    for (let i = 0; i < nav.route.length - 1; i++) {
      if (nav.cum[i + 1] < lo || nav.cum[i] > hi) continue;
      const [ax, ay] = toXY(nav.route[i]);
      const [bx, by] = toXY(nav.route[i + 1]);
      const abx = bx - ax, aby = by - ay;
      const len2 = abx * abx + aby * aby || 1e-9;
      let t = (-(ax * abx + ay * aby)) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * abx, ay + t * aby);
      if (d < best.dist) best = { dist: d, along: nav.cum[i] + t * (nav.cum[i + 1] - nav.cum[i]), seg: i, t };
    }
    return best;
  };
  let best = project(nav.progress - 400, nav.progress + 3000);
  if (best.dist > 300) best = project(0, Infinity);
  if (best.dist <= 300) nav.progress = Math.max(nav.progress, best.along);
  return best;
}

function speak(text) {
  if (!$('voice').checked || !('speechSynthesis' in window)) return;
  try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {}
}

// Bearing in degrees from point a to b
function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
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

  // Bearing to a point ~150 m ahead along the route
  let aheadIdx = p.seg;
  let acc = p.along;
  while (aheadIdx < nav.route.length - 1 && acc < p.along + 150) {
    aheadIdx++; acc = nav.cum[aheadIdx];
  }
  const target = nav.route[Math.min(aheadIdx, nav.route.length - 1)];
  const brg = bearing(ll, L.latLng(target[0], target[1]));

  let compassHtml = '';
  if ($('compass').checked) {
    const rel = nav.heading != null ? (brg - nav.heading + 360) % 360 : brg;
    compassHtml = `<div class="compass"><span class="needle" style="transform:rotate(${rel}deg)">⬆</span></div>` +
      `Head ${Math.round(brg)}°${nav.heading != null ? ` (turn ${Math.round(((rel + 180) % 360) - 180)}°)` : ''}<br>`;
  }

  $('navBody').innerHTML =
    (off ? '<span class="warn">⚠ Off route by ' + Math.round(p.dist) + ' m</span><br>' : '') +
    compassHtml +
    `Remaining: ${(remaining / 1000).toFixed(1)} km · ETA ${fmtTime(eta)}<br>` +
    `Speed: ${(spdMs * 3.6).toFixed(1)} km/h · GPS ±${Math.round(accuracy)} m`;

  // Voice cues
  if (off && !nav.wasOff) speak('Off route');
  nav.wasOff = off;
  lastResult.stops.forEach((s, k) => {
    if (!nav.spokenStops.has(k) && havM(ll, [s.lat, s.lon]) < 150) {
      nav.spokenStops.add(k);
      speak(`Approaching stop ${k + 1}`);
    }
  });
  if (remaining < 80 && !nav.spokenStops.has('end')) {
    nav.spokenStops.add('end');
    speak('Arriving back at the put-in');
  }
}

function onHeading(e) {
  // iOS provides webkitCompassHeading (deg from north); others use alpha
  const h = e.webkitCompassHeading != null ? e.webkitCompassHeading
    : (e.alpha != null ? 360 - e.alpha : null);
  if (h != null) nav.heading = h;
}

async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { $('compass').checked = false; return; }
    }
    window.addEventListener('deviceorientation', onHeading, true);
  } catch { $('compass').checked = false; }
}
$('compass').addEventListener('change', (e) => {
  if (e.target.checked) enableCompass();
  else window.removeEventListener('deviceorientation', onHeading, true);
});

async function startNav() {
  if (!lastResult) return;
  if (!('geolocation' in navigator)) {
    $('navBody').textContent = 'Geolocation not available in this browser.';
    return;
  }
  buildNavRoute();
  if ($('compass').checked) enableCompass();
  nav.watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    $('navBody').textContent = 'GPS error: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  try { nav.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  $('navBtn').textContent = 'Stop navigation';
  $('navBtn').classList.add('active');
  $('navBody').textContent = 'Waiting for GPS fix…';
  speak('Navigation started');
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

// --- install prompt --------------------------------------------------------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').hidden = true;
});

// --- online/offline indicator ----------------------------------------------
function updateOnline() {
  const note = $('offlineNote');
  if (!navigator.onLine) {
    note.textContent = 'Offline — cached maps and your last route still work.';
    note.classList.add('offline');
  } else {
    note.classList.remove('offline');
  }
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

// --- wiring ----------------------------------------------------------------
$('navBtn').addEventListener('click', () => (nav.watchId == null ? startNav() : stopNav()));
$('gpxBtn').addEventListener('click', downloadGpx);
$('shareBtn').addEventListener('click', copyLink);
$('floatPlanBtn').addEventListener('click', shareFloatPlan);
generateBtn.addEventListener('click', generate);

if (!readUrl()) setStatus('Click the map to set your put-in point.');
updateDepartOut();

// Test hook for automated e2e verification
window.__paddle = {
  map, generate,
  getState: () => ({
    putIn: putIn ? { lat: putIn.lat, lng: putIn.lng } : null,
    stops: stops.map((s) => ({ lat: s.latlng.lat, lng: s.latlng.lng })),
  }),
  buildGpx: () => (lastResult ? buildGpx() : null),
  importGpx,
};
