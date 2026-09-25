import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';

const port = 5174;
const baseURL = `http://127.0.0.1:${port}/our-days/`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(), env: { ...process.env, VITE_E2E_MODE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite stopped early:\n${output}`);
    try { if ((await fetch(baseURL)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${output}`);
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
  await page.goto(baseURL);
  await page.getByText('Local test mode — no Google events are created.').waitFor();

  // Single-day timed appointment, keyboard input, phrase selection and direct save.
  await page.getByRole('button', { name: /^Tomorrow/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'When?' }).waitFor();
  await page.getByRole('button', { name: 'Set a time' }).getAttribute('aria-pressed').then(value => {
    if (value !== 'true') throw new Error('Timed entry should be the single-date default.');
  });
  await page.getByRole('button', { name: '30 min' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const description = page.getByRole('textbox', { name: 'Description' });
  await description.fill('Family checkup');
  await description.press('Enter');
  await page.getByRole('button', { name: 'Dentist' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Location' }).fill('Royal');
  await page.getByRole('button', { name: 'Royal Surrey' }).click();
  await page.getByText('Family checkup Dentist', { exact: true }).waitFor();
  await page.getByText('09:00 · 30 min', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add appointment' }).click();
  await page.getByRole('heading', { name: 'Test save confirmed locally.' }).waitFor();

  // Multi-date skips time and creates separate all-day events.
  await page.getByRole('button', { name: 'Another appointment' }).click();
  await page.getByRole('button', { name: /^Today/ }).click();
  await page.getByRole('button', { name: /^Tomorrow/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'What is it?' }).waitFor();
  await page.getByRole('button', { name: 'Work Trip' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('2 separate all-day events', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Skip location' }).click();
  await page.getByText('2 separate events were confirmed.', { exact: true }).waitFor();

  // Draft date survives refresh and the calendar is keyboard-operable.
  await page.getByRole('button', { name: 'Another appointment' }).click();
  const nextMonth = page.getByRole('button', { name: 'Next month' });
  await nextMonth.focus(); await page.keyboard.press('Enter');
  const firstDay = page.locator('.month-grid button').first();
  await firstDay.focus(); await page.keyboard.press('Enter');
  await page.reload();
  await page.getByRole('button', { name: 'Continue' }).isEnabled().then(enabled => {
    if (!enabled) throw new Error('Saved draft date was not restored after refresh.');
  });

  // An offline save remains honest, then retries when connectivity returns.
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Scan' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Skip location' }).click();
  await page.getByText('Not confirmed yet').waitFor();
  await page.getByText('A closed app cannot guarantee background delivery.', { exact: false }).waitFor();
  await context.setOffline(false);
  await page.getByRole('heading', { name: 'Test save confirmed locally.' }).waitFor({ timeout: 10_000 });

  console.log('Browser flow passed: timed, multi-date, keyboard, draft refresh, offline outbox retry.');
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
}
