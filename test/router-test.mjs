// Synthetic-grid test of the router: a 6x6 km "lake" with an island,
// 6 m/s wind from SSW. Verifies fetch DP, time-varying round trips,
// budget adherence, smoothing, and that routes stay on water.

import { computeFetch, computeShoreDistance, planRoundTrip, planRoundTripOptions, planViaRoute, dijkstra, smoothPath } from '../js/router.js';

const W = 300, H = 300, cellMeters = 20;
const mask = new Uint8Array(W * H);

// Water everywhere except a 3-cell border of land and a central island
for (let y = 3; y < H - 3; y++)
  for (let x = 3; x < W - 3; x++) mask[y * W + x] = 1;
for (let y = 120; y < 180; y++)
  for (let x = 130; x < 200; x++) mask[y * W + x] = 0;

const wind = { ws: 6, wdDeg: 200 };
const speedMs = 5 / 3.6;       // 5 km/h
const comfortWs = 5;            // wind is above comfort -> shelter matters
const budgetSec = 2 * 3600;     // 2 hour trip

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- fetch field ---
const fetchField = computeFetch(mask, W, H, wind.wdDeg, cellMeters);
const sheltered = fetchField[(110 * W) + 160]; // just downwind (lee) of the island
const open = fetchField[(60 * W) + 60];        // open water, long upwind distance
check('fetch: land = 0', fetchField[(150 * W) + 160] === 0);
check('fetch: lee of island is sheltered', sheltered < 600, `${Math.round(sheltered)} m`);
check('fetch: open water is exposed', open > 1500, `${Math.round(open)} m`);

// --- round trip with constant wind timeline ---
const timeline = [wind, wind, wind];
const fetchFields = [fetchField, fetchField, fetchField];
const params = { mask, W, H, cellMeters, timeline, fetchFields, speedMs, comfortWs };
const startIdx = (280 * W) + 150; // southern shore, near land
const route = planRoundTrip(params, startIdx, budgetSec);

check('round trip found', route !== null);
if (route) {
  const total = route.outTimeS + route.backTimeS;
  check('starts at put-in', route.outPath[0] === startIdx);
  check('returns to put-in', route.backPath[route.backPath.length - 1] === startIdx);
  check('total time within 75–115% of budget',
    total >= 0.75 * budgetSec && total <= 1.15 * budgetSec,
    `${(total / 3600).toFixed(2)} h of ${(budgetSec / 3600).toFixed(1)} h budget`);
  const allWater = [...route.outPath, ...route.backPath].every((i) => mask[i] === 1);
  check('route stays on water', allWater);

  const outSet = new Set(route.outPath);
  const overlap = route.backPath.filter((i) => outSet.has(i)).length / route.backPath.length;
  check('return path mostly distinct from outbound', overlap < 0.5,
    `${Math.round(overlap * 100)}% overlap`);

  // --- smoothing ---
  const smooth = smoothPath(mask, W, H, route.outPath);
  check('smoothing reduces point count', smooth.length < route.outPath.length,
    `${route.outPath.length} -> ${smooth.length} pts`);
  let onWater = true;
  for (let k = 0; k < smooth.length - 1 && onWater; k++) {
    const [x0, y0] = smooth[k], [x1, y1] = smooth[k + 1];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.floor(x0 + (x1 - x0) * t), y = Math.floor(y0 + (y1 - y0) * t);
      if (!mask[y * W + x]) { onWater = false; break; }
    }
  }
  check('smoothed route stays on water', onWater);
}

// --- wind effect on speed: downwind should be faster than upwind ---
const d = dijkstra(params, (150 * W) + 60);
const north = d.time[(50 * W) + 60];   // ~downwind from wind @ 200°
const south = d.time[(250 * W) + 60];  // ~upwind
check('downwind travel faster than upwind', north < south,
  `north ${Math.round(north)} s vs south ${Math.round(south)} s over equal distance`);

// --- time-varying wind: calm now, strong headwind north in hour 2 ---
// Compare against constant-calm: trips planned under the worsening forecast
// should see a slower hour-2 leg (bucket switching works).
const calm = { ws: 1, wdDeg: 200 };
const strongN = { ws: 10, wdDeg: 0 }; // hour 2+: strong wind from north
const calmField = computeFetch(mask, W, H, calm.wdDeg, cellMeters);
const strongField = computeFetch(mask, W, H, strongN.wdDeg, cellMeters);
const varyParams = { mask, W, H, cellMeters, speedMs, comfortWs: 12,
  timeline: [calm, strongN, strongN], fetchFields: [calmField, strongField, strongField] };
const constParams = { mask, W, H, cellMeters, speedMs, comfortWs: 12,
  timeline: [calm, calm, calm], fetchFields: [calmField, calmField, calmField] };
const start2 = (290 * W) + 150;
const farNorth = (10 * W) + 150;
const tVary = dijkstra(varyParams, start2).time[farNorth];
const tConst = dijkstra(constParams, start2).time[farNorth];
check('worsening forecast slows the later legs', tVary > tConst * 1.05,
  `${Math.round(tVary)} s vs ${Math.round(tConst)} s`);

// --- lunch bonus steers turn-point choice ---
const lunchBonus = new Uint8Array(W * H);
// Mark an area on the north-eastern shore as "near a beach" — at a similar
// travel time as the unbiased turn point, but a different location
for (let y = 60; y < 100; y++)
  for (let x = 268; x < 297; x++) lunchBonus[y * W + x] = 1;
const lunchRoute = planRoundTrip({ ...params, lunchBonus }, startIdx, budgetSec);
if (lunchRoute) {
  const tx = lunchRoute.turnIdx % W, ty = (lunchRoute.turnIdx / W) | 0;
  console.log(`info: lunch-biased turn point at (${tx},${ty})`);
  check('lunch-biased turn point lands near the beach area', lunchBonus[lunchRoute.turnIdx] === 1);
} else {
  check('lunch-biased round trip found', false);
}

// --- shore distance + max-distance-from-shore constraint ---
const shore = computeShoreDistance(mask, W, H, cellMeters);
// Center of the SW open-water quadrant: ~57 cells from the border (x=3),
// ~60 from the island edge; expect roughly min(57,60)*20 = ~1150 m
const midOpen = shore[(150 * W) + 60];
check('shore distance: open water plausible', midOpen > 900 && midOpen < 1400,
  `${Math.round(midOpen)} m`);
check('shore distance: shoreline cell is small', shore[(295 * W) + 150] < 100,
  `${Math.round(shore[(295 * W) + 150])} m`);

const MAX_SHORE = 200;
const constrained = new Uint8Array(W * H);
for (let i = 0; i < mask.length; i++) constrained[i] = mask[i] && shore[i] <= MAX_SHORE ? 1 : 0;
// The app snaps the put-in to the nearest allowed water cell; start on the
// shoreline band here (the unconstrained startIdx sits 340 m out).
const cStart = (295 * W) + 150;
const cRoute = planRoundTrip(
  { mask: constrained, W, H, cellMeters, timeline, fetchFields, speedMs, comfortWs },
  cStart, budgetSec);
check('constrained round trip found', cRoute !== null);
if (cRoute) {
  let worst = 0;
  for (const i of [...cRoute.outPath, ...cRoute.backPath]) worst = Math.max(worst, shore[i]);
  check(`constrained route never beyond ${MAX_SHORE} m from shore`, worst <= MAX_SHORE,
    `worst ${Math.round(worst)} m`);
  const cTotal = cRoute.outTimeS + cRoute.backTimeS;
  console.log(`info: constrained trip ${(cTotal / 3600).toFixed(2)} h, ` +
    `${((cRoute.outDistM + cRoute.backDistM) / 1000).toFixed(1)} km (hugs the shoreline)`);
}

// --- via-route through fixed stops ---
const stop1 = (150 * W) + 250; // east of the island
const stop2 = (60 * W) + 60;   // open NW quadrant
const via = planViaRoute(params, startIdx, [stop1, stop2]);
check('via route found', via.legs !== undefined);
if (via.legs) {
  check('via: three legs for two stops', via.legs.length === 3);
  check('via: leg 1 ends at stop 1', via.legs[0][via.legs[0].length - 1] === stop1);
  check('via: leg 2 ends at stop 2', via.legs[1][via.legs[1].length - 1] === stop2);
  check('via: returns to put-in', via.legs[2][via.legs[2].length - 1] === startIdx);
  check('via: legs connect', via.legs[1][0] === stop1 && via.legs[2][0] === stop2);
  const viaWater = via.legs.flat().every((i) => mask[i] === 1);
  check('via: route stays on water', viaWater);
  const sumLegs = via.legTimesS.reduce((a, b) => a + b, 0);
  check('via: leg times sum to total', Math.abs(sumLegs - via.totalTimeS) < 1,
    `${Math.round(via.totalTimeS)} s total`);
  console.log(`info: via tour ${(via.totalTimeS / 3600).toFixed(2)} h, ` +
    `${(via.totalDistM / 1000).toFixed(1)} km`);
}
// Unreachable stop (on the island) reports which leg failed
const badVia = planViaRoute(params, startIdx, [(150 * W) + 160]);
check('via: unreachable stop reported', badVia.unreachableLeg === 0);

// --- scenery preference hugs the shore ---
{
  const tgt = (30 * W) + 60; // open NW water; straight path crosses open middle
  const meanShore = (parent) => {
    let s = 0, n = 0;
    for (let i = tgt; i !== -1; i = parent[i]) { s += shore[i]; n++; }
    return s / n;
  };
  const plain = dijkstra({ ...params, shoreDist: shore, sceneryW: 0 }, startIdx);
  const scenic = dijkstra({ ...params, shoreDist: shore, sceneryW: 3 }, startIdx);
  const mp = meanShore(plain.parent), ms = meanShore(scenic.parent);
  check('scenery preference routes closer to shore', ms < mp,
    `mean dist-from-shore ${Math.round(ms)} m scenic vs ${Math.round(mp)} m direct`);
}

// --- three distinct round-trip options ---
{
  const opts = planRoundTripOptions(params, startIdx, budgetSec, 3);
  check('returns multiple route options', opts.length >= 2, `${opts.length} options`);
  check('options have distinct turn points',
    new Set(opts.map((o) => o.turnIdx)).size === opts.length);
  check('every option is a complete loop on water',
    opts.every((o) => o.outPath[0] === startIdx &&
      o.backPath[o.backPath.length - 1] === startIdx &&
      [...o.outPath, ...o.backPath].every((i) => mask[i] === 1)));
  console.log('info: option totals ' +
    opts.map((o) => (o.totalTimeS / 3600).toFixed(2) + 'h').join(', '));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
