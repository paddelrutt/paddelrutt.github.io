// Web Mercator projection helpers and the routing grid.
// The grid is axis-aligned in world pixels at a fixed zoom, so vector tile
// geometry can be rasterized onto it with a plain canvas transform.

const TILE = 256;

export function lonToWorldX(lon, zoom) {
  return ((lon + 180) / 360) * TILE * 2 ** zoom;
}

export function latToWorldY(lat, zoom) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** zoom;
}

export function worldXToLon(wx, zoom) {
  return (wx / (TILE * 2 ** zoom)) * 360 - 180;
}

export function worldYToLat(wy, zoom) {
  const n = Math.PI * (1 - (2 * wy) / (TILE * 2 ** zoom));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

export function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * Build a grid covering a square of `radiusM` meters around a center point.
 * Cell size is chosen so the grid stays under ~maxSide cells per side.
 */
export function makeGrid(centerLat, centerLon, radiusM, zoom = 13, maxSide = 1100) {
  const mpp = metersPerPixel(centerLat, zoom);
  const halfPx = radiusM / mpp;
  const cellPx = Math.max(1, Math.ceil((2 * halfPx) / maxSide));
  const cx = lonToWorldX(centerLon, zoom);
  const cy = latToWorldY(centerLat, zoom);
  const W = Math.ceil((2 * halfPx) / cellPx);
  const H = W;
  const ox = cx - (W / 2) * cellPx;
  const oy = cy - (H / 2) * cellPx;
  return { zoom, ox, oy, cellPx, W, H, cellMeters: cellPx * mpp };
}

export function lonLatToCell(grid, lon, lat) {
  const x = Math.floor((lonToWorldX(lon, grid.zoom) - grid.ox) / grid.cellPx);
  const y = Math.floor((latToWorldY(lat, grid.zoom) - grid.oy) / grid.cellPx);
  if (x < 0 || y < 0 || x >= grid.W || y >= grid.H) return -1;
  return y * grid.W + x;
}

/** Float cell coordinates (e.g. from smoothPath) to [lon, lat]. */
export function pointToLonLat(grid, x, y) {
  const wx = grid.ox + x * grid.cellPx;
  const wy = grid.oy + y * grid.cellPx;
  return [worldXToLon(wx, grid.zoom), worldYToLat(wy, grid.zoom)];
}

export function cellToLonLat(grid, idx) {
  const x = idx % grid.W;
  const y = Math.floor(idx / grid.W);
  const wx = grid.ox + (x + 0.5) * grid.cellPx;
  const wy = grid.oy + (y + 0.5) * grid.cellPx;
  return [worldXToLon(wx, grid.zoom), worldYToLat(wy, grid.zoom)];
}

export function gridBounds(grid) {
  // Leaflet-style [[south, west], [north, east]]
  return [
    [worldYToLat(grid.oy + grid.H * grid.cellPx, grid.zoom), worldXToLon(grid.ox, grid.zoom)],
    [worldYToLat(grid.oy, grid.zoom), worldXToLon(grid.ox + grid.W * grid.cellPx, grid.zoom)],
  ];
}

/**
 * Rasterize water polygons onto the grid using a canvas.
 * `features` is an array of polygons; each polygon is an array of rings,
 * each ring an array of {x, y} in world pixels at grid.zoom.
 * Returns Uint8Array mask: 1 = water, 0 = land.
 */
export function rasterizeWater(grid, features) {
  const canvas = document.createElement('canvas');
  canvas.width = grid.W;
  canvas.height = grid.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, grid.W, grid.H);
  ctx.fillStyle = '#fff';
  for (const rings of features) {
    ctx.beginPath();
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const px = (ring[i].x - grid.ox) / grid.cellPx;
        const py = (ring[i].y - grid.oy) / grid.cellPx;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const img = ctx.getImageData(0, 0, grid.W, grid.H).data;
  const mask = new Uint8Array(grid.W * grid.H);
  for (let i = 0; i < mask.length; i++) mask[i] = img[i * 4] > 127 ? 1 : 0;
  return mask;
}

/**
 * 4-connected flood fill from startIdx. Returns a mask of water cells
 * actually reachable by boat from the put-in (no portaging).
 */
export function floodFill(mask, W, H, startIdx) {
  const reach = new Uint8Array(W * H);
  if (!mask[startIdx]) return reach;
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  queue[tail++] = startIdx;
  reach[startIdx] = 1;
  while (head < tail) {
    const i = queue[head++];
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && mask[i - 1] && !reach[i - 1]) { reach[i - 1] = 1; queue[tail++] = i - 1; }
    if (x < W - 1 && mask[i + 1] && !reach[i + 1]) { reach[i + 1] = 1; queue[tail++] = i + 1; }
    if (y > 0 && mask[i - W] && !reach[i - W]) { reach[i - W] = 1; queue[tail++] = i - W; }
    if (y < H - 1 && mask[i + W] && !reach[i + W]) { reach[i + W] = 1; queue[tail++] = i + W; }
  }
  return reach;
}

/** Find the nearest water cell to idx within maxR cells (spiral search). */
export function nearestWater(mask, W, H, idx, maxR = 40) {
  if (idx >= 0 && mask[idx]) return idx;
  const x0 = idx % W, y0 = (idx / W) | 0;
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (mask[i]) return i;
      }
    }
  }
  return -1;
}
