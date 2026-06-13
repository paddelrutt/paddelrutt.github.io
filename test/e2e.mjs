// End-to-end browser check: load the app, set a put-in in the Sankt Anna
// archipelago, generate a round trip with live data, then exercise GPX export
// and live GPS navigation (with emulated geolocation). Screenshot at the end.
// Requires the dev server on :8420. Run: node test/e2e.mjs

import { chromium } from 'playwright';

const PUT_IN = { latitude: 58.365, longitude: 16.87 };

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  permissions: ['geolocation'],
  geolocation: PUT_IN,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  // Transient 5xx from shared public services (Overpass, tile servers) are
  // handled gracefully by the app and shouldn't fail the run.
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
    errors.push('console: ' + m.text());
  }
});

await page.goto('http://localhost:8420/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__paddle, null, { timeout: 30000 });

// Put-in on water near Tyrislöt, Sankt Anna
await page.evaluate(({ latitude, longitude }) => {
  const { map } = window.__paddle;
  map.fire('click', { latlng: L.latLng(latitude, longitude) });
}, PUT_IN);
await page.fill('#duration', '2');
await page.fill('#depth', '20'); // exercise the EMODnet depth constraint
await page.click('#generate');

// Live tile fetch + routing can take a while on first run
await page.waitForFunction(
  () => !document.getElementById('stats').classList.contains('hidden') ||
        document.getElementById('status').textContent.startsWith('Error') ||
        document.getElementById('status').textContent.startsWith('No water') ||
        document.getElementById('status').textContent.startsWith('Could not'),
  null, { timeout: 240000 });

const status = await page.textContent('#status');
const stats = await page.evaluate(() => document.getElementById('statsBody')?.innerText ?? '(none)');
const wind = await page.evaluate(() => document.getElementById('windText')?.textContent ?? '(none)');
console.log('STATUS:', status);
console.log('WIND:', wind);
console.log('STATS:\n' + stats);
const depthLine = stats.match(/Deepest point: ~(\d+) m/);
const depthOk = depthLine && parseInt(depthLine[1]) <= 22; // limit 20 m + grid slack
console.log('DEPTH CONSTRAINT:', depthLine ? depthLine[0] + (depthOk ? ' (within 20 m limit)' : ' EXCEEDS LIMIT') : 'no depth stat shown');

// --- GPX export: capture the download ---
let gpxOk = false;
try {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#gpxBtn'),
  ]);
  const path = await download.path();
  const { readFileSync } = await import('fs');
  const gpx = readFileSync(path, 'utf8');
  gpxOk = gpx.includes('<gpx') && gpx.includes('<trkpt') && gpx.includes('Put-in');
  console.log(`GPX: ${gpxOk ? 'OK' : 'BAD'} (${gpx.length} bytes, ${(gpx.match(/<trkpt/g) || []).length} track points)`);
} catch (e) {
  console.log('GPX: FAILED —', e.message);
}

// --- Live navigation with emulated GPS ---
await page.click('#navBtn');
await page.waitForFunction(
  () => document.getElementById('navBody').textContent.includes('Remaining'),
  null, { timeout: 30000 });
const nav1 = await page.evaluate(() => document.getElementById('navBody').innerText);
console.log('NAV (at put-in):', nav1.replace(/\n/g, ' | '));

// Drift 400 m east — off-route warning should appear or remaining change
await context.setGeolocation({ latitude: PUT_IN.latitude, longitude: PUT_IN.longitude + 0.012 });
await page.waitForTimeout(2500);
const nav2 = await page.evaluate(() => document.getElementById('navBody').innerText);
console.log('NAV (moved ~700m):', nav2.replace(/\n/g, ' | '));
const navOk = nav1.includes('Remaining') && nav2.includes('Remaining');

// --- Via-stops tour: add two stops near the put-in and regenerate ---
await page.click('#navBtn'); // stop navigation
await page.fill('#depth', '52'); // lift depth limit so stops stay reachable
await page.evaluate(() => {
  const { map } = window.__paddle;
  map.fire('click', { latlng: L.latLng(58.368, 16.876) }); // stop 1
  map.fire('click', { latlng: L.latLng(58.362, 16.879) }); // stop 2
});
const stopsLabel = await page.textContent('#stopsLabel');
await page.click('#generate');
await page.waitForFunction(
  () => document.getElementById('status').textContent.startsWith('Done') ||
        document.getElementById('status').textContent.includes("can't") ||
        document.getElementById('status').textContent.includes('not on water'),
  null, { timeout: 120000 });
const tourStatus = await page.textContent('#status');
const tourStats = await page.evaluate(() => document.getElementById('statsBody')?.innerText ?? '(none)');
console.log('STOPS LABEL:', stopsLabel);
console.log('TOUR STATUS:', tourStatus);
console.log('TOUR STATS:\n' + tourStats);
const tourOk = tourStatus.startsWith('Done') &&
  tourStats.includes('tour via 2 stops') &&
  tourStats.includes('To stop 1') && tourStats.includes('To stop 2') &&
  tourStats.includes('Back to put-in');

// GPX of the tour should carry the stop waypoints
let tourGpxOk = false;
try {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#gpxBtn'),
  ]);
  const { readFileSync } = await import('fs');
  const gpx = readFileSync(await dl.path(), 'utf8');
  tourGpxOk = gpx.includes('Stop 1') && gpx.includes('Stop 2') && (gpx.match(/<trkseg>/g) || []).length === 3;
  console.log(`TOUR GPX: ${tourGpxOk ? 'OK' : 'BAD'} (${(gpx.match(/<trkseg>/g) || []).length} segments)`);
} catch (e) {
  console.log('TOUR GPX: FAILED —', e.message);
}

if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
await page.screenshot({ path: 'test/e2e-result.png' });
console.log('Screenshot saved to test/e2e-result.png');

await browser.close();
const ok = stats.includes('Total:') && gpxOk && navOk && depthOk !== false &&
  tourOk && tourGpxOk && errors.length === 0;
console.log(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
