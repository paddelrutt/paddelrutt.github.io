// SMHI open data point forecast (SNOW1g API, the 2026 replacement for PMP3g).
// Free, no API key.

const BASE = 'https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1';

/**
 * Hourly wind timeline for the next `hours` hours, starting now.
 * Returns an array (one entry per hour, index = trip hour) of
 * { ws, wdDeg, gust, tempC, time }.
 */
export async function fetchForecast(lat, lon, hours) {
  const url = `${BASE}/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SMHI ${res.status}`);
  const data = await res.json();
  const entries = data.timeSeries.map((e) => ({
    t: new Date(e.time).getTime(),
    time: e.time,
    ws: e.data.wind_speed,
    wdDeg: e.data.wind_from_direction,
    gust: e.data.wind_speed_of_gust,
    tempC: e.data.air_temperature,
  }));
  const now = Date.now();
  const timeline = [];
  for (let h = 0; h < hours; h++) {
    const target = now + h * 3600 * 1000;
    let best = entries[0], bestDiff = Infinity;
    for (const e of entries) {
      const diff = Math.abs(e.t - target);
      if (diff < bestDiff) { bestDiff = diff; best = e; }
    }
    timeline.push(best);
  }
  return timeline;
}
