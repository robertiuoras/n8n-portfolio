// Headless canvas screenshots of every workflow (1600x1000 @2x). Needs playwright (global install) + owner password secret.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire('/opt/homebrew/lib/node_modules/');
const { chromium } = require('playwright');
const root = new URL('..', import.meta.url).pathname;
const pw = execFileSync('node', [process.env.HOME + '/Projects/claude-memory/claude-config/secrets.mjs', 'get', 'N8N_LOCAL_OWNER_PASSWORD'], { encoding: 'utf8' }).trim();
const ids = JSON.parse(fs.readFileSync(root + 'data/ids.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('http://localhost:5678/signin');
await page.fill('input[type="email"], input[name="emailOrLdapLoginId"]', 'robertiuoras@gmail.com');
await page.fill('input[type="password"]', pw);
await page.keyboard.press('Enter');
await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30000 });
fs.mkdirSync(root + 'screenshots', { recursive: true });
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ids)) {
  await page.goto(`http://localhost:5678/workflow/${ids[name]}`);
  await page.waitForSelector('.vue-flow__node, [data-test-id="canvas-node"]', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.mouse.click(800, 950); // focus the canvas background
  await page.keyboard.press('1');   // "zoom to fit"
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${root}screenshots/${name}.png` });
  console.log('shot', name);
}
await browser.close();
