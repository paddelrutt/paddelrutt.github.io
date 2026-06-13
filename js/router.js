// Wind-aware water routing on a raster grid. Pure functions, no DOM —
// this module is also exercised by the Node test in test/router-test.mjs.
//
// Model (deliberately simple for the spike):
//  - Effective paddling speed = base speed +/- a fraction of the head/tailwind
//    component along the direction of travel.
//  - Wind is time-varying: `timeline[h]` holds the forecast for hour h of the
//    trip, and `fetchFields[h]` the matching exposure field. Edge costs use
//    the bucket for the paddler's elapsed time when crossing that edge.
//  - Each water cell has a "fetch" value: open-water distance upwind of the
//    cell. Long fetch + strong wind = waves = discomfort/danger. When wind
//    exceeds the paddler's comfort limit, exposed cells get a cost penalty,
//    so routes hug shorelines and hide behind islands.
//  - Round trips go upwind first (fresh paddler, tailwind home) and return
//    along a different path where possible. Turn-points near a landing spot
//    (lunch beach) get a scoring bonus.

const SQRT2 = Math.SQRT2;
// 8-connected neighbors: dx, dy, distance factor
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

const FETCH_CAP_M = 3000;
// Fraction of the wind's head/tailwind component added to boat speed.
const WIND_SPEED_FACTOR = 0.07;
// How strongly to discourage reusing an already-travelled corridor, and how
// many cells wide that corridor is. Soft (cost multiplier), so a route is
// still found when there is genuinely no alternative water.
const AVOID_PENALTY = 6;
const AVOID_RADIUS = 2;

/** Unit vector (grid coords, y down) for a compass bearing in degrees. */
function bearingVec(deg) {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/**
 * Upwind fetch per cell via a linear DP sweep: each cell inherits the fetch of
 * its upwind 8-neighbor plus one step. Land = 0, off-grid = assumed open.
 */
export function computeFetch(mask, W, H, windFromDeg, cellMeters, capM = FETCH_CAP_M) {
  const fetch = new Float32Array(W * H);
  const [ux, uy] = bearingVec(windFromDeg); // points toward where wind comes from
  // Quantize to the 8-neighbor closest in angle
  let best = 0, bestDot = -Infinity;
  for (let d = 0; d < DIRS.length; d++) {
    const [dx, dy, len] = DIRS[d];
    const dot = (dx * ux + dy * uy) / len;
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  const [nx, ny, lenf] = DIRS[best];
  const step = cellMeters * lenf;

  const ys = ny < 0 ? { from: 0, to: H, inc: 1 } : { from: H - 1, to: -1, inc: -1 };
  const xs = nx < 0 ? { from: 0, to: W, inc: 1 } : { from: W - 1, to: -1, inc: -1 };
  for (let y = ys.from; y !== ys.to; y += ys.inc) {
    for (let x = xs.from; x !== xs.to; x += xs.inc) {
      const i = y * W + x;
      if (!mask[i]) { fetch[i] = 0; continue; }
      const px = x + nx, py = y + ny;
      if (px < 0 || py < 0 || px >= W || py >= H) {
        fetch[i] = capM; // unknown beyond grid: assume exposed
      } else {
        fetch[i] = Math.min(capM, fetch[py * W + px] + step);
      }
    }
  }
  return fetch;
}

/**
 * Distance from each water cell to the nearest land, in meters.
 * Two-pass chamfer distance transform (error < ~8%, linear time).
 * Water at the grid edge with no land in view keeps a large value, which is
 * conservative for a max-distance-from-shore constraint.
 */
export function computeShoreDistance(mask, W, H, cellMeters) {
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? INF : 0;
  const o = cellMeters, dg = cellMeters * SQRT2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + o);
      if (y > 0) {
        v = Math.min(v, d[i - W] + o);
        if (x > 0) v = Math.min(v, d[i - W - 1] + dg);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + dg);
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + o);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + o);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + dg);
        if (x > 0) v = Math.min(v, d[i + W - 1] + dg);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Binary min-heap keyed on a Float64Array of costs. */
class Heap {
  constructor(capacity) {
    this.idx = new Int32Array(capacity);
    this.key = new Float64Array(capacity);
    this.n = 0;
  }
  push(i, k) {
    let c = this.n++;
    this.idx[c] = i; this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      this.swap(p, c); c = p;
    }
  }
  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n]; this.key[0] = this.key[this.n];
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === c) break;
        this.swap(m, c); c = m;
      }
    }
    return top;
  }
  swap(a, b) {
    let t = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = t;
    let k = this.key[a]; this.key[a] = this.key[b]; this.key[b] = k;
  }
}

const bucketOf = (timeline, tSec) =>
  Math.min(Math.max(0, Math.floor(tSec / 3600)), timeline.length - 1);

/**
 * Dijkstra over reachable water with time-varying wind.
 * params: { mask, W, H, cellMeters, timeline: [{ws, wdDeg}],
 *           fetchFields: [Float32Array per hour], speedMs, comfortWs }
 * Returns {cost, time, parent} where `time` is absolute trip seconds.
 * opts.avoid: optional Uint8Array; cells with 1 get cost multiplied
 * opts.target: stop early once this cell is settled
 * opts.startTime: trip seconds already elapsed when departing startIdx
 */
export function dijkstra(params, startIdx, opts = {}) {
  const { mask, W, H, cellMeters, timeline, fetchFields, speedMs, comfortWs } = params;
  const startTime = opts.startTime ?? 0;
  const N = W * H;
  const cost = new Float64Array(N).fill(Infinity);
  const time = new Float64Array(N).fill(Infinity);
  const parent = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new Heap(N * 2);

  // Per-hour-bucket, per-direction effective speed and exposure weight
  const dirSpeed = timeline.map(({ ws, wdDeg }) => {
    const [wfx, wfy] = bearingVec(wdDeg);
    const wtx = -wfx, wty = -wfy; // direction the wind blows toward
    return DIRS.map(([dx, dy, len]) => {
      const ux = dx / len, uy = dy / len;
      const tail = ws * (ux * wtx + uy * wty); // >0 tailwind, <0 headwind
      const v = speedMs + WIND_SPEED_FACTOR * tail;
      return Math.min(1.6 * speedMs, Math.max(0.25 * speedMs, v));
    });
  });
  const overByBucket = timeline.map(({ ws }) => Math.max(0, ws - comfortWs));

  cost[startIdx] = 0; time[startIdx] = startTime;
  heap.push(startIdx, 0);
  while (heap.n > 0) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === opts.target) break;
    const b = bucketOf(timeline, time[i]);
    const speeds = dirSpeed[b];
    const over = overByBucket[b];
    const fetchF = fetchFields[b];
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < DIRS.length; d++) {
      const [dx, dy, len] = DIRS[d];
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const j = py * W + px;
      if (!mask[j] || done[j]) continue;
      // No corner-cutting through diagonal land gaps
      if (dx !== 0 && dy !== 0 && (!mask[y * W + px] || !mask[py * W + x])) continue;
      const dist = cellMeters * len;
      const dt = dist / speeds[d];
      let penalty = 1 + 0.1 * over * (Math.min(fetchF[j], FETCH_CAP_M) / FETCH_CAP_M);
      if (opts.avoid && opts.avoid[j]) penalty *= AVOID_PENALTY;
      const c = cost[i] + dt * penalty;
      if (c < cost[j]) {
        cost[j] = c;
        time[j] = time[i] + dt;
        parent[j] = i;
        heap.push(j, c);
      }
    }
  }
  return { cost, time, parent };
}

function tracePath(parent, from) {
  const path = [];
  for (let i = from; i !== -1; i = parent[i]) path.push(i);
  return path.reverse();
}

/** Mark a path plus a `radius`-cell band around it into the `avoid` mask. */
function dilateInto(avoid, W, H, path, radius) {
  let frontier = [];
  for (const i of path) if (!avoid[i]) { avoid[i] = 1; frontier.push(i); }
  for (let r = 0; r < radius; r++) {
    const next = [];
    for (const i of frontier) {
      const x = i % W, y = (i / W) | 0;
      if (x > 0 && !avoid[i - 1]) { avoid[i - 1] = 1; next.push(i - 1); }
      if (x < W - 1 && !avoid[i + 1]) { avoid[i + 1] = 1; next.push(i + 1); }
      if (y > 0 && !avoid[i - W]) { avoid[i - W] = 1; next.push(i - W); }
      if (y < H - 1 && !avoid[i + W]) { avoid[i + W] = 1; next.push(i + W); }
    }
    frontier = next;
  }
}

function pathDistM(W, cellMeters, path) {
  let d = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const dx = (a % W) - (b % W), dy = ((a / W) | 0) - ((b / W) | 0);
    d += cellMeters * Math.hypot(dx, dy);
  }
  return d;
}

/**
 * Route through fixed stops in order: start -> stop1 -> ... -> stopN -> start.
 * Each leg is wind-aware Dijkstra picking up where the previous leg left off
 * in trip time (so later legs see later forecast hours), and previous legs'
 * corridors are discouraged so the tour doesn't retrace itself.
 * Returns { legs: [paths], legTimesS, totalTimeS, totalDistM, maxFetchM }
 * or { unreachableLeg: k } if leg k can't be completed.
 */
export function planViaRoute(params, startIdx, stopIdxs) {
  const { mask, W, H, timeline, fetchFields, cellMeters } = params;
  const points = [startIdx, ...stopIdxs, startIdx];
  const avoid = new Uint8Array(mask.length);
  const legs = [], legTimesS = [];
  let tAcc = 0, totalDistM = 0, maxFetchM = 0;

  for (let k = 0; k < points.length - 1; k++) {
    const from = points[k], to = points[k + 1];
    const d = dijkstra(params, from, { avoid, target: to, startTime: tAcc });
    if (d.time[to] === Infinity) return { unreachableLeg: k };
    const path = tracePath(d.parent, to);
    legs.push(path);
    legTimesS.push(d.time[to] - tAcc);
    totalDistM += pathDistM(W, cellMeters, path);
    for (const i of path) maxFetchM = Math.max(maxFetchM, fetchFields[bucketOf(timeline, d.time[i])][i]);
    dilateInto(avoid, W, H, path, AVOID_RADIUS);
    tAcc = d.time[to];
  }
  return { legs, legTimesS, totalTimeS: tAcc, totalDistM, maxFetchM };
}

/**
 * Generate a round trip within a time budget.
 * params: as for dijkstra, plus optional `lunchBonus` (Uint8Array: cells near
 * a landing spot get a turn-point scoring bonus).
 * Returns { outPath, backPath, outTimeS, backTimeS, outDistM, backDistM,
 *           turnIdx, maxFetchM } or null if no route fits.
 */
export function planRoundTrip(params, startIdx, budgetSec) {
  const { mask, W, H, timeline, fetchFields, lunchBonus } = params;
  const out = dijkstra(params, startIdx);

  const sx = startIdx % W, sy = (startIdx / W) | 0;

  const candidatesFor = (targetOut) => {
    const b = bucketOf(timeline, targetOut);
    const { ws, wdDeg } = timeline[b];
    const [ux, uy] = bearingVec(wdDeg); // toward wind origin = upwind
    const windFactor = Math.min(ws / 6, 1);
    const fetchF = fetchFields[b];
    const tLo = 0.8 * targetOut, tHi = 1.15 * targetOut;
    // Landing spots slightly off the ideal distance are still worth a look
    const tLoL = 0.6 * targetOut, tHiL = 1.25 * targetOut;
    const cands = [];
    for (let i = 0; i < mask.length; i++) {
      const t = out.time[i];
      const isLunch = lunchBonus && lunchBonus[i];
      if (isLunch ? (t < tLoL || t > tHiL) : (t < tLo || t > tHi)) continue;
      const dx = (i % W) - sx, dy = ((i / W) | 0) - sy;
      const len = Math.hypot(dx, dy) || 1;
      const upwindDot = (dx * ux + dy * uy) / len;
      const score =
        1 - Math.abs(t - targetOut) / targetOut
        + 0.6 * windFactor * upwindDot
        - 0.4 * (Math.min(fetchF[i], FETCH_CAP_M) / FETCH_CAP_M)
        + (isLunch ? 0.5 : 0);
      cands.push([score, i]);
    }
    if (cands.length === 0) {
      // Small water body: farthest reachable point under the target
      let bestT = 0, bestI = -1;
      for (let i = 0; i < mask.length; i++) {
        const t = out.time[i];
        if (t !== Infinity && t < tHi && t > bestT) { bestT = t; bestI = i; }
      }
      if (bestI !== -1) cands.push([0, bestI]);
    }
    cands.sort((a, b2) => b2[0] - a[0]);
    // Up to 4 well-separated candidates
    const picked = [];
    const minSep = Math.max(8, W / 12);
    for (const [, i] of cands) {
      const x = i % W, y = (i / W) | 0;
      if (picked.every(([px, py]) => Math.hypot(x - px, y - py) >= minSep)) {
        picked.push([x, y, i]);
        if (picked.length >= 4) break;
      }
    }
    return picked.map((p) => p[2]);
  };

  const evaluate = (turnIdx) => {
    const outPath = tracePath(out.parent, turnIdx);
    // Discourage (not forbid) reusing the outbound corridor on the way home
    const avoid = new Uint8Array(mask.length);
    dilateInto(avoid, W, H, outPath, AVOID_RADIUS);
    avoid[startIdx] = 0;
    const back = dijkstra(params, turnIdx,
      { avoid, target: startIdx, startTime: out.time[turnIdx] });
    if (back.time[startIdx] === Infinity) return null;
    const total = back.time[startIdx]; // absolute trip time at return
    const fit = Math.abs(total - budgetSec);
    // A turn-point near a landing spot is worth being somewhat further off
    // the requested duration: lunch on a beach beats a perfect time fit.
    const fitAdj = fit - (lunchBonus && lunchBonus[turnIdx] ? 0.12 * budgetSec : 0);
    return { fit, fitAdj, turnIdx, outPath, back,
             total, outTimeS: out.time[turnIdx], backTimeS: total - out.time[turnIdx] };
  };

  // The outbound target adapts to wind asymmetry: with a tailwind home the
  // return leg is faster, so the turn-point must sit further out than T/2.
  let best = null;
  let targetOut = 0.45 * budgetSec;
  const tried = new Set();
  for (let iter = 0; iter < 3; iter++) {
    let iterBest = null;
    for (const turnIdx of candidatesFor(targetOut)) {
      if (tried.has(turnIdx)) continue;
      tried.add(turnIdx);
      const r = evaluate(turnIdx);
      if (r && (!iterBest || r.fitAdj < iterBest.fitAdj)) iterBest = r;
      if (r && r.total <= 1.08 * budgetSec && r.total >= 0.9 * budgetSec) { iterBest = r; break; }
    }
    if (iterBest && (!best || iterBest.fitAdj < best.fitAdj)) best = iterBest;
    if (!best) break; // no route at all from this water body
    if (best.total <= 1.08 * budgetSec && best.total >= 0.9 * budgetSec) break;
    // Rescale the outbound target by how far off we were
    targetOut = Math.min(0.62 * budgetSec,
      Math.max(0.3 * budgetSec, targetOut * (budgetSec / best.total)));
  }
  if (!best) return null;

  const backPath = tracePath(best.back.parent, startIdx);
  const distOf = (path) => {
    let d = 0;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k];
      const ddx = (a % W) - (b % W), ddy = ((a / W) | 0) - ((b / W) | 0);
      d += params.cellMeters * Math.hypot(ddx, ddy);
    }
    return d;
  };
  let maxFetchM = 0;
  for (const i of best.outPath)
    maxFetchM = Math.max(maxFetchM, fetchFields[bucketOf(timeline, out.time[i])][i]);
  for (const i of backPath) {
    const t = best.back.time[i];
    maxFetchM = Math.max(maxFetchM, fetchFields[bucketOf(timeline, isFinite(t) ? t : 0)][i]);
  }

  return {
    outPath: best.outPath,
    backPath,
    turnIdx: best.turnIdx,
    outTimeS: best.outTimeS,
    backTimeS: best.backTimeS,
    outDistM: distOf(best.outPath),
    backDistM: distOf(backPath),
    maxFetchM,
  };
}

// ---------------------------------------------------------------------------
// Route smoothing: line-of-sight simplification removes the grid staircase,
// then Chaikin corner-cutting rounds it off. Every step is validated against
// the water mask so the smoothed route never crosses land.

/** True if the straight segment between two float cell-points stays on water. */
function segmentOnWater(mask, W, H, x0, y0, x1, y1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / 0.3));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.floor(x0 + (x1 - x0) * t);
    const y = Math.floor(y0 + (y1 - y0) * t);
    if (x < 0 || y < 0 || x >= W || y >= H || !mask[y * W + x]) return false;
  }
  return true;
}

/**
 * Smooth a cell-index path. Returns an array of [x, y] float cell coordinates
 * (cell centers), guaranteed to stay on water.
 */
export function smoothPath(mask, W, H, path) {
  if (path.length < 3) return path.map((i) => [(i % W) + 0.5, ((i / W) | 0) + 0.5]);
  const pts = path.map((i) => [(i % W) + 0.5, ((i / W) | 0) + 0.5]);

  // Greedy line-of-sight simplification
  const way = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !segmentOnWater(mask, W, H, pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
    way.push(pts[j]);
    i = j;
  }

  // Chaikin corner cutting (2 rounds), keeping endpoints
  let cur = way;
  for (let round = 0; round < 2; round++) {
    const next = [cur[0]];
    for (let k = 0; k < cur.length - 1; k++) {
      const [ax, ay] = cur[k], [bx, by] = cur[k + 1];
      next.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by]);
      next.push([0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    next.push(cur[cur.length - 1]);
    // Validate; if any cut segment leaves the water, keep the previous level
    let ok = true;
    for (let k = 0; k < next.length - 1 && ok; k++) {
      ok = segmentOnWater(mask, W, H, next[k][0], next[k][1], next[k + 1][0], next[k + 1][1]);
    }
    if (!ok) break;
    cur = next;
  }
  return cur;
}
