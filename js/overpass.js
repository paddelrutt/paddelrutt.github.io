// Landing spots (slipways, beaches) from OSM via the Overpass API.

const OVERPASS = 'https://overpass-api.de/api/interpreter';

export async function fetchLandingSpots(south, west, north, east) {
  const bbox = `${south},${west},${north},${east}`;
  const query = `
[out:json][timeout:25];
(
  node["leisure"="slipway"](${bbox});
  way["leisure"="slipway"](${bbox});
  node["natural"="beach"](${bbox});
  way["natural"="beach"](${bbox});
);
out center 300;`;
  const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = await res.json();
  return data.elements
    .map((el) => ({
      lat: el.lat ?? el.center?.lat,
      lon: el.lon ?? el.center?.lon,
      type: el.tags?.leisure === 'slipway' ? 'slipway' : 'beach',
      name: el.tags?.name || null,
    }))
    .filter((s) => s.lat != null);
}
