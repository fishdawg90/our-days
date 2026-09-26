import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';

const port = 5174;
const baseURL = `http://127.0.0.1:${port}/our-days/`;
const isoLocal = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const daysFromToday = count => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + count); return isoLocal(date); };
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

  // A partial or older saved draft must be repaired instead of blanking the app on refresh.
  await page.evaluate(() => localStorage.setItem('our-days-draft-v1', JSON.stringify({
    selectedDates: [], descriptionParts: [], time: 'not-a-time', durationMinutes: 45,
  })));
  await page.reload();
  await page.getByRole('heading', { name: 'Choose your days' }).waitFor();

  // Past dates are unavailable; one tap waits for an end and the second creates a range.
  if (await page.locator('.month-section h2').count() < 2)
    throw new Error('The date view should show several clearly labelled months at once.');
  await page.getByText('End optional').waitFor();
  const selectionState = page.locator('.date-selection-state');
  const stateHeightBefore = await selectionState.evaluate(element => element.getBoundingClientRect().height);
  const pastCells = page.locator('.month-grid button[data-past="true"]');
  for (const cell of await pastCells.all()) if (await cell.isEnabled()) throw new Error('A past date remained selectable.');
  const today = page.locator(`[data-iso="${daysFromToday(0)}"]`);
  if (await today.getAttribute('aria-current') !== 'date') throw new Error('Today was not identified independently from selection.');
  await today.click();
  await page.getByText('Continue for one day, or choose an end date.').waitFor();
  await page.getByText('Tap another day').waitFor();
  const stateHeightAfter = await selectionState.evaluate(element => element.getBoundingClientRect().height);
  if (Math.abs(stateHeightAfter - stateHeightBefore) > 2) throw new Error('Date feedback caused a layout shift after the first selection.');
  const rangeEnd = page.locator(`[data-iso="${daysFromToday(4)}"]`);
  await rangeEnd.click();
  if (await page.locator('.month-grid button[aria-pressed="true"]').count() !== 5)
    throw new Error('Selecting an end date did not fill the inclusive range.');
  if (await page.locator('.month-grid button.range-start, .month-grid button.range-end').count() !== 2 ||
      await page.locator('.month-grid button.range-middle').count() !== 3)
    throw new Error('The selected range did not expose distinct endpoints and a continuous middle.');
  const adjustedEnd = page.locator(`[data-iso="${daysFromToday(2)}"]`);
  const fromBox = await rangeEnd.boundingBox(); const toBox = await adjustedEnd.boundingBox();
  if (!fromBox || !toBox) throw new Error('Range endpoints were not visible for drag testing.');
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  const dragActivated = await page.locator('.month-grid button.active-drag').count();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 5 });
  const countBeforeRelease = await page.locator('.month-grid button[aria-pressed="true"]').count();
  await page.mouse.up();
  const adjustedCount = await page.locator('.month-grid button[aria-pressed="true"]').count();
  if (adjustedCount !== 3) {
    const selectedIsos = await page.locator('.month-grid button[aria-pressed="true"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-iso')));
    throw new Error(`Dragging the range end did not adjust the selected range (active ${dragActivated}, before release ${countBeforeRelease}, final ${adjustedCount}: ${selectedIsos.join(', ')}).`);
  }
  await page.getByRole('button', { name: 'Continue with 3 days' }).click();
  await page.getByRole('heading', { name: 'Description' }).waitFor();
  const workTrip = page.getByRole('button', { name: 'Work Trip' });
  await workTrip.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await workTrip.click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('3 separate all-day events', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Skip location' }).click();
  await page.getByText('3 separate events were confirmed.', { exact: true }).waitFor();

  // Single-day timed appointment uses the ten-minute one-finger control.
  await page.getByRole('button', { name: 'Another appointment' }).click();
  await page.locator(`[data-iso="${daysFromToday(1)}"]`).click();
  await page.getByRole('button', { name: 'Continue with this day' }).click();
  await page.getByRole('heading', { name: 'When?' }).waitFor();
  await page.getByRole('button', { name: 'Set a time' }).getAttribute('aria-pressed').then(value => {
    if (value !== 'true') throw new Error('Timed entry should be the single-date default.');
  });
  await page.getByRole('slider', { name: 'Start time' }).fill('61');
  await page.locator('output').getByText('10:10', { exact: true }).waitFor();
  await page.getByRole('complementary', { name: 'Appointment so far' }).getByText('10:10').waitFor();
  await page.getByRole('button', { name: '30 min' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  if (await page.locator('.month-grid button[aria-pressed="true"]').count() !== 1)
    throw new Error('Back from time should preserve the selected date.');
  await page.getByRole('button', { name: 'Continue with this day' }).click();
  await page.locator('output').getByText('09:00', { exact: true }).waitFor();
  if (await page.getByRole('button', { name: '1 hr' }).getAttribute('aria-pressed') !== 'true')
    throw new Error('Back from time did not clear the time-step selections.');
  await page.getByRole('slider', { name: 'Start time' }).fill('61');
  await page.getByRole('button', { name: '30 min' }).click();
  const timeAction = page.getByRole('button', { name: 'Continue to description' });
  const actionRect = await timeAction.evaluate(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight }; });
  if (actionRect.top < 0 || actionRect.bottom > actionRect.height) throw new Error('The time-page action was not fixed inside the viewport.');
  await timeAction.click();
  const description = page.getByRole('textbox', { name: 'Description' });
  await description.fill('Family checkup');
  await description.press('Enter');
  await page.getByRole('button', { name: 'Dentist' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Location' }).fill('Royal');
  await page.getByRole('button', { name: 'Royal Surrey' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('heading', { name: 'Description' }).waitFor();
  await page.getByRole('button', { name: 'Continue' }).click();
  if (await page.locator('.chosen-phrases[aria-label="Selected location"]').count())
    throw new Error('Back from location did not clear the location selection.');
  await page.getByRole('textbox', { name: 'Location' }).fill('Royal');
  await page.getByRole('button', { name: 'Royal Surrey' }).click();
  await page.locator('.summary-card').getByText('Family checkup Dentist', { exact: true }).waitFor();
  await page.getByText('10:10 · 30 min', { exact: true }).waitFor();
  const appointmentStrip = page.getByRole('complementary', { name: 'Appointment so far' });
  const stripRect = await appointmentStrip.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, height: rect.height, viewportWidth: innerWidth };
  });
  if (stripRect.left < 0 || stripRect.right > stripRect.viewportWidth || stripRect.height > 42)
    throw new Error('The compact appointment summary escaped the phone viewport or became too tall.');
  const addAppointment = page.getByRole('button', { name: 'Add appointment' });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const addAction = await addAppointment.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const container = element.closest('.flow-actions');
    return { top: rect.top, bottom: rect.bottom, height: innerHeight, position: container ? getComputedStyle(container).position : '' };
  });
  if (addAction.position !== 'fixed' || addAction.top < 0 || addAction.bottom > addAction.height)
    throw new Error('The final Add appointment action was not fixed inside the viewport after scrolling.');
  await addAppointment.click();
  await page.getByRole('heading', { name: 'Test save confirmed locally.' }).waitFor();

  // Draft date survives refresh and the calendar is keyboard-operable.
  await page.getByRole('button', { name: 'Another appointment' }).click();
  const firstDay = page.locator('.month-section').nth(1).locator('.month-grid button:not([disabled])').first();
  await firstDay.focus(); await page.keyboard.press('Enter');
  await page.reload();
  await page.getByRole('button', { name: /^Continue with/ }).isEnabled().then(enabled => {
    if (!enabled) throw new Error('Saved draft date was not restored after refresh.');
  });

  // An offline save remains honest, then retries when connectivity returns.
  await page.getByRole('button', { name: /^Continue with/ }).click();
  await page.getByRole('button', { name: 'Continue to description' }).click();
  await page.getByRole('button', { name: 'Scan' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Skip location' }).click();
  await page.getByText('Not confirmed yet').waitFor();
  await page.getByText('A closed app cannot guarantee background delivery.', { exact: false }).waitFor();
  await context.setOffline(false);
  await page.getByRole('heading', { name: 'Test save confirmed locally.' }).waitFor({ timeout: 10_000 });

  // Cancel abandons the entire draft and returns to an empty date picker.
  await page.getByRole('button', { name: 'Another appointment' }).click();
  await page.locator(`[data-iso="${daysFromToday(3)}"]`).click();
  await page.getByRole('button', { name: 'Continue with this day' }).click();
  await page.getByRole('button', { name: 'Continue to description' }).click();
  await page.getByRole('button', { name: 'Scan' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('heading', { name: 'Choose your days' }).waitFor();
  if (await page.locator('.month-grid button[aria-pressed="true"]').count()) throw new Error('Cancel retained selected dates.');
  if (await page.getByRole('button', { name: 'Continue with this day' }).isEnabled()) throw new Error('Cancel did not return to an empty draft.');

  console.log('Browser flow passed: range/drag, reversible steps, cancel reset, sticky flow, keyboard, draft and offline retry.');
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
}
