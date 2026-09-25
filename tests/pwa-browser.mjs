import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';

if (!existsSync('dist/index.html')) throw new Error('Run pnpm build before the production PWA smoke test.');
const port = 5175;
const baseURL = `http://127.0.0.1:${port}/our-days/`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Preview stopped early:\n${output}`);
    try { if ((await fetch(baseURL)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Preview did not start:\n${output}`);
}

let browser;
try {
  await waitForServer();
  const installedBrowser = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(installedBrowser ? { executablePath: installedBrowser } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const requestFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => requestFailures.push(`${request.url()} ${request.failure()?.errorText || ''}`));
  await page.goto(baseURL);
  await page.getByRole('heading', { name: 'Choose your days' }).waitFor();
  if (await page.getByText('Local test mode — no Google events are created.').count())
    throw new Error('Production build exposed local test mode.');
  await page.evaluate(async () => {
    await caches.open('our-basket-phone-sentinel');
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(async () => (await caches.keys()).includes('our-days-v2'));
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  }
  // Stop the origin rather than using DevTools' synthetic offline mode, which
  // can abort module requests before a service worker sees them in Chromium.
  server.kill();
  if (server.exitCode === null) await once(server, 'exit');
  await page.reload({ waitUntil: 'domcontentloaded' });
  try {
    await page.getByRole('heading', { name: 'Choose your days' }).waitFor({ timeout: 10_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      controller: Boolean(navigator.serviceWorker.controller),
      cacheNames: await caches.keys(),
      entries: await (async () => {
        const cache = await caches.open('our-days-v2');
        return (await cache.keys()).map(request => request.url);
      })(),
      body: document.body.innerText,
      bodyHtml: document.body.innerHTML.slice(0, 300),
      documentHtml: document.documentElement.outerHTML.slice(0, 300),
      href: location.href,
      resources: performance.getEntriesByType('resource').map(entry => entry.name),
      cached: await (async () => {
        const cache = await caches.open('our-days-v2');
        const rows = [];
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          rows.push({ url: request.url, type: response?.headers.get('content-type'), prefix: (await response?.clone().text())?.slice(0, 60) });
        }
        return rows;
      })(),
    })).catch(() => ({ evaluation: 'unavailable' }));
    throw new Error(`Offline shell did not render: ${JSON.stringify({ diagnostics, pageErrors, consoleErrors, requestFailures })}\n${error}`);
  }
  const retained = await page.evaluate(async () => (await caches.keys()).includes('our-basket-phone-sentinel'));
  if (!retained) throw new Error('Our Days service worker removed an unrelated app cache.');
  console.log('Production PWA passed: no test mode, offline shell reload, unrelated cache retained.');
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
}
