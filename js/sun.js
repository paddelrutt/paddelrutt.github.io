// Sunrise/sunset for a date and location — NOAA solar algorithm, no deps.
// Returns { sunrise: Date, sunset: Date } in local time, or null for polar
// day/night (no event that day).

function toJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}
function fromJulian(j) {
  return new Date((j - 2440587.5) * 86400000);
}

export function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const J = toJulian(date);
  const n = Math.round(J - 2451545.0 + 0.0008);
  const Jstar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const delta = Math.asin(Math.sin(lambda * rad) * Math.sin(23.44 * rad));
  const cosH = (Math.sin(-0.83 * rad) - Math.sin(lat * rad) * Math.sin(delta)) /
    (Math.cos(lat * rad) * Math.cos(delta));
  if (cosH > 1 || cosH < -1) return null; // polar day/night
  const H = Math.acos(cosH) / rad;
  const Jset = Jtransit + H / 360;
  const Jrise = Jtransit - H / 360;
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
}
