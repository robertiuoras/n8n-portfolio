// Screenshot of the ops dashboard page (GET /webhook/ops) in light and dark mode, plus a phone-width check.
// Prints sampled pixel colours so both themes are checked by numbers, not only by eye.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/homebrew/lib/node_modules/@playwright/cli/');
const { chromium } = require('playwright');
const root = new URL('..', import.meta.url).pathname;
const password = fs.readFileSync(root + 'data/dashboard-password.txt', 'utf8').trim();
const browser = await chromium.launch({ headless: true, executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
for (const [scheme, width, file] of [['light', 1280, 'ops-dashboard-page.png'], ['dark', 1280, null], ['light', 390, null]]) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme, httpCredentials: { username: 'ops', password } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5678/webhook/ops');
  const m = await page.evaluate(() => {
    const css = (sel, p) => getComputedStyle(document.querySelector(sel))[p];
    return { scrollX: document.documentElement.scrollWidth > innerWidth, body: css('body', 'backgroundColor'), card: css('.tile', 'backgroundColor'), text: css('body', 'color'), muted: css('p', 'color'), height: document.documentElement.scrollHeight };
  });
  const shot = await page.screenshot({ fullPage: true, ...(file ? { path: root + 'screenshots/' + file } : {}) });
  console.log(scheme, width, JSON.stringify(m), file || '', shot.length);
  await ctx.close();
}
await browser.close();
