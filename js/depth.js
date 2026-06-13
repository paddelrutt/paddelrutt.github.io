// Sea depth from EMODnet Bathymetry (free, CORS-open WCS, ~100 m grid).
// IMPORTANT: this resolution shows the broad depth picture only — it cannot
// see rocks, skerries or shoals. Use for comfort filtering ("avoid deep
// water"), never as a navigation or grounding-safety guarantee.
// Coverage is marine: lakes and land carry positive (elevation) values and
// are simply unconstrained by the depth filter.

import { fromArrayBuffer } from 'https://esm.sh/geotiff@2.1.3';
import { cellToLonLat } from './grid.js';

const WCS = 'https://ows.emodnet-bathymetry.eu/wcs';

/**
 * Fetch EMODnet mean depth for the grid area and resample it onto the grid.
 * Returns Float32Array of depth in meters per cell (positive = below surface,
 * 0 = land/lake/no marine data), or null if the service fails.
 * bounds: [[south, west], [north, east]] (from gridBounds).
 */
export async function fetchDepthPerCell(grid, bounds) {
  const [[s, w], [n, e]] = bounds;
  const url = `${WCS}?service=WCS&version=2.0.1&request=GetCoverage` +
    `&coverageId=emodnet__mean&format=image/tiff` +
    `&subset=Lat(${s.toFixed(4)},${n.toFixed(4)})&subset=Long(${w.toFixed(4)},${e.toFixed(4)})`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`EMODnet WCS ${res.status}`);
    const tiff = await fromArrayBuffer(await res.arrayBuffer());
    const img = await tiff.getImage();
    const raster = (await img.readRasters())[0];
    const tw = img.getWidth(), th = img.getHeight();
    const [bw, bs, be, bn] = img.getBoundingBox();

    const depth = new Float32Array(grid.W * grid.H);
    for (let i = 0; i < depth.length; i++) {
      const [lon, lat] = cellToLonLat(grid, i);
      const px = Math.floor(((lon - bw) / (be - bw)) * tw);
      const py = Math.floor(((bn - lat) / (bn - bs)) * th);
      if (px < 0 || py < 0 || px >= tw || py >= th) continue;
      const v = raster[py * tw + px];
      // EMODnet stores elevation: negative = below sea level
      if (isFinite(v) && v < 0 && v > -12000) depth[i] = -v;
    }
    return depth;
  } catch (err) {
    console.warn('EMODnet depth unavailable:', err.message);
    return null;
  }
}
