// Fetch water polygons from OpenFreeMap vector tiles (OpenMapTiles schema).
// Tiles are pre-clipped per tile, which makes rasterization simple — no need
// to assemble giant lake multipolygons from raw OSM.

import Pbf from 'https://esm.sh/pbf@3.2.1';
import { VectorTile } from 'https://esm.sh/@mapbox/vector-tile@1.3.1';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const TILE = 256;
let tileTemplate = null;

async function getTileTemplate() {
  if (!tileTemplate) {
    const tj = await (await fetch(TILEJSON_URL)).json();
    tileTemplate = tj.tiles[0];
  }
  return tileTemplate;
}

/**
 * Fetch all water polygons intersecting the grid area.
 * Returns an array of polygons; each polygon is an array of rings of
 * {x, y} in world pixels at grid.zoom (matching grid.js conventions).
 */
export async function fetchWaterFeatures(grid, onProgress) {
  const template = await getTileTemplate();
  const z = grid.zoom;
  const x0 = Math.floor(grid.ox / TILE);
  const y0 = Math.floor(grid.oy / TILE);
  const x1 = Math.floor((grid.ox + grid.W * grid.cellPx) / TILE);
  const y1 = Math.floor((grid.oy + grid.H * grid.cellPx) / TILE);

  const jobs = [];
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) jobs.push({ tx, ty });

  const features = [];
  let done = 0;
  const CONCURRENCY = 8;

  async function worker() {
    while (jobs.length) {
      const { tx, ty } = jobs.shift();
      const url = template.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      try {
        const res = await fetch(url);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const vt = new VectorTile(new Pbf(buf));
          const layer = vt.layers['water'];
          if (layer) {
            const scale = TILE / layer.extent;
            for (let i = 0; i < layer.length; i++) {
              const f = layer.feature(i);
              if (f.type !== 3) continue; // polygons only
              const rings = f.loadGeometry().map((ring) =>
                ring.map((p) => ({ x: tx * TILE + p.x * scale, y: ty * TILE + p.y * scale }))
              );
              features.push(rings);
            }
          }
        }
      } catch (e) {
        console.warn('tile failed', tx, ty, e);
      }
      done++;
      if (onProgress) onProgress(done, (x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return features;
}
