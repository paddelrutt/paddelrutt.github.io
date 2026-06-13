// SMHI open data point forecast (SNOW1g API, the 2026 replacement for PMP3g).
// Free, no API key.

const BASE = 'https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1';

/** Full hourly-ish forecast series for a point, sorted by time. */
export async function fetchForecastSeries(lat, lon) {
  const url = `${BASE}/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SMHI ${res.status}`);
  const data = await res.json();
  return data.timeSeries.map((e) => ({
    t: new Date(e.time).getTime(),
    time: e.time,
    ws: e.data.wind_speed,
    wdDeg: e.data.wind_from_direction,
    gust: e.data.wind_speed_of_gust,
    tempC: e.data.air_temperature,
  })).sort((a, b) => a.t - b.t);
}

/** Pick the series entry closest to a target time. */
function nearest(series, targetMs) {
  let best = series[0], diff = Infinity;
  for (const e of series) {
    const d = Math.abs(e.t - targetMs);
    if (d < diff) { diff = d; best = e; }
  }
  return best;
}

/**
 * Build a per-hour timeline of `hours` entries (index = trip hour) starting at
 * `startMs`. Used for routing (one bucket per elapsed trip hour).
 */
export function sliceTimeline(series, startMs, hours) {
  const out = [];
  for (let h = 0; h < hours; h++) out.push(nearest(series, startMs + h * 3600 * 1000));
  return out;
}

/** Convenience: timeline of `hours` entries starting at now + offsetH hours. */
export async function fetchForecast(lat, lon, hours, offsetH = 0) {
  const series = await fetchForecastSeries(lat, lon);
  return sliceTimeline(series, Date.now() + offsetH * 3600 * 1000, hours);
}
