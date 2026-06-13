// Integration check against live services: OpenFreeMap tiles decode and
// contain a 'water' layer for the Sankt Anna test area, and SMHI returns
// usable wind data. Run: node test/tiles-integration.mjs

import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const lat = 58.37, lon = 16.78, z = 13;
const n = 2 ** z;
const tx = Math.floor(((lon + 180) / 360) * n);
const r = (lat * Math.PI) / 180;
const ty = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
check('TileJSON has tile template', !!tj.tiles?.[0], tj.tiles?.[0]);

let totalWaterPolys = 0;
for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
  const url = tj.tiles[0].replace('{z}', z).replace('{x}', tx + dx).replace('{y}', ty + dy);
  const res = await fetch(url);
  if (!res.ok) { console.log(`  tile ${tx + dx}/${ty + dy}: HTTP ${res.status}`); continue; }
  const vt = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
  const water = vt.layers['water'];
  const polys = water
    ? Array.from({ length: water.length }, (_, i) => water.feature(i)).filter((f) => f.type === 3).length
    : 0;
  totalWaterPolys += polys;
  console.log(`  tile ${z}/${tx + dx}/${ty + dy}: water polygons = ${polys}, extent = ${water?.extent}`);
}
check('water polygons found in archipelago tiles', totalWaterPolys > 0, `${totalWaterPolys} total`);

const smhi = await (await fetch(
  `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon}/lat/${lat}/data.json`
)).json();
const entry = smhi.timeSeries?.[0]?.data;
check('SMHI wind data present',
  typeof entry?.wind_speed === 'number' && typeof entry?.wind_from_direction === 'number',
  `ws=${entry?.wind_speed} m/s, wd=${entry?.wind_from_direction}°, gust=${entry?.wind_speed_of_gust}`);

// --- EMODnet bathymetry WCS ---
const { fromArrayBuffer } = await import('geotiff');
const wcsUrl = 'https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1' +
  '&request=GetCoverage&coverageId=emodnet__mean&format=image/tiff' +
  '&subset=Lat(58.30,58.42)&subset=Long(16.78,16.95)';
const wcsRes = await fetch(wcsUrl);
check('EMODnet WCS responds', wcsRes.ok, `HTTP ${wcsRes.status}`);
if (wcsRes.ok) {
  const tiff = await fromArrayBuffer(await wcsRes.arrayBuffer());
  const img = await tiff.getImage();
  const raster = (await img.readRasters())[0];
  let sea = 0, deepest = 0;
  for (const v of raster) {
    if (isFinite(v) && v < 0 && v > -12000) { sea++; deepest = Math.min(deepest, v); }
  }
  check('EMODnet has sea depth values for Sankt Anna', sea > 100 && deepest < -5,
    `${sea} sea px, deepest ${(-deepest).toFixed(0)} m`);
}

console.log(failures === 0 ? '\nAll integration checks passed.' : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
