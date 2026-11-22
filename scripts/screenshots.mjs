// Regenerates docs/screenshots/*.png by driving a real page with puppeteer-core.
//   npm i --no-save puppeteer-core
//   BROWSER="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" node scripts/screenshots.mjs
// Needs nvim on PATH and any Chromium-based browser (BROWSER, or the first of the usual macOS/Linux paths).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'screenshots');
const candidates = [process.env.BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const executablePath = candidates.find(p => p && existsSync(p));
if (!executablePath) throw new Error('no Chromium-based browser found: set BROWSER');

async function run(scheme) {
const tmp = mkdtempSync(join(tmpdir(), 'markbridge-shots-'));
const doc = join(tmp, 'launch-plan.md');
const sock = join(tmp, 'nvim.sock');
const urlFile = join(tmp, 'url');
copyFileSync(join(root, 'examples', 'demo.md'), doc);
writeFileSync(join(tmp, 'init.lua'), `
vim.opt.rtp:prepend('${root}')
vim.o.swapfile = false
vim.cmd 'runtime plugin/markbridge.lua'
require('markbridge').setup { port = 0, open = function(u) local f = io.open('${urlFile}', 'w'); f:write(u); f:close() end }
vim.cmd.edit('${doc}')
vim.bo.filetype = 'markdown'
require('markbridge').start()
`);
const nvim = spawn('nvim', ['--headless', '--listen', sock, '-u', 'NONE', '-S', join(tmp, 'init.lua')], { stdio: 'ignore' });
const expr = e => execFileSync('nvim', ['--server', sock, '--remote-expr', e]).toString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 50 && !existsSync(urlFile); i++) await sleep(100);
const url = readFileSync(urlFile, 'utf8');

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const shot = async (name, opts = {}) => { await sleep(500); if (!opts.clip) await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: join(out, `${name}-${scheme}.png`), ...opts }); console.log('wrote', `${name}-${scheme}`); };
const load = async (_ignored, w = 1000, h = 760) => {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1200); // mermaid
};
const clip = async sel => { const b = await (await page.$(sel)).boundingBox(); return { x: Math.max(b.x - 16, 0), y: Math.max(b.y - 56, 0), width: b.width + 32, height: b.height + 80 }; };

try {
  await load(scheme); await shot('page', {});

  await load(scheme, 1000, 700);
  await page.hover('#doc > p'); await sleep(200);
  await page.click('#hnd > button'); await sleep(200);
  await shot('block-menu', {});
  await page.keyboard.press('Escape'); await page.mouse.click(900, 650);

  await load(scheme, 1000, 900);
  await page.click('td'); await sleep(300);
  const t = await clip('table'); await shot('table', { clip: t });

  await page.click('pre.mb-raw'); await sleep(300);
  const c = await clip('textarea.mb-raw-edit'); await shot('code-edit', { clip: c });

  await load(scheme, 1000, 700);
  await page.click('[data-f="help"]'); await sleep(300);
  await shot('help', {});

  // A disk conflict: in the buffer you reword the intro and tick a checklist item; on disk the same
  // item is reworded and a table row changes. The intro and the table merge, the checklist item conflicts.
  await load(scheme, 1000, 760);
  expr(`execute("call setline(8, 'We ship the editable preview next week, once the review is done.') | call setline(14, '- [x] Review the release notes')")`);
  writeFileSync(doc, readFileSync(doc, 'utf8').replace('- [ ] Review the release notes', '- [ ] Review the release notes with Ben').replace('Friday    |  Ana  |', 'Friday    |  Ben  |'));
  await sleep(1800);
  await page.click('[data-f="save"]'); await sleep(900);
  await shot('merge-dialog', {});
  // Resolve with both so the file is left consistent.
  await page.evaluate(() => { document.querySelector('#dlg input[value="both"]')?.click(); [...document.querySelectorAll('#dlg .row button')].find(b => /merge/i.test(b.textContent))?.click(); });
  await sleep(1200);

  // Phone width.
  await load(scheme, 390, 800); await shot('narrow', {});
} finally {
  await browser.close();
  nvim.kill();
  rmSync(tmp, { recursive: true, force: true });
}
}

for (const scheme of ['light', 'dark']) await run(scheme);
