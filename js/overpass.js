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

/**
 * Rest points useful on a paddling trip: wind shelters (vindskydd), campsites,
 * and drinking water. Returned with a category for icon/coloring.
 */
export async function fetchRestPOIs(south, west, north, east) {
  const bbox = `${south},${west},${north},${east}`;
  const query = `
[out:json][timeout:25];
(
  node["amenity"="shelter"](${bbox});
  node["shelter_type"="lean_to"](${bbox});
  node["tourism"="camp_site"](${bbox});
  way["tourism"="camp_site"](${bbox});
  node["tourism"="wilderness_hut"](${bbox});
  node["amenity"="drinking_water"](${bbox});
);
out center 300;`;
  const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = await res.json();
  return data.elements
    .map((el) => {
      const t = el.tags || {};
      let category = 'shelter';
      if (t.tourism === 'camp_site') category = 'camp';
      else if (t.tourism === 'wilderness_hut') category = 'hut';
      else if (t.amenity === 'drinking_water') category = 'water';
      return {
        lat: el.lat ?? el.center?.lat,
        lon: el.lon ?? el.center?.lon,
        category,
        name: t.name || null,
      };
    })
    .filter((s) => s.lat != null);
}
