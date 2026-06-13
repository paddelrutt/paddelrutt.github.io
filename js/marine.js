// Sea surface temperature + wave height from Open-Meteo Marine (free, no key,
// CORS-open). Used for the safety strip (cold-water warning) and difficulty.
// Returns null on failure or inland points (marine model has no data there).

export async function fetchMarine(lat, lon) {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(4)}` +
    `&longitude=${lon.toFixed(4)}&current=sea_surface_temperature,wave_height&timezone=UTC`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    const c = d.current;
    if (!c || c.sea_surface_temperature == null) return null;
    return { waterTempC: c.sea_surface_temperature, waveHeightM: c.wave_height ?? null };
  } catch {
    return null;
  }
}
