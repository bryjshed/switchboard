// Page QA: console errors, every simulation runs, keyboard nav, no horizontal scroll at phone width,
// and page screenshots in light and dark for a human look.
// usage: npm run qa   (no stack needed: opens index.html straight from disk, proving it works offline)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEMO_DIR } from './lib.mjs';
const URL = process.argv[2] || pathToFileURL(join(DEMO_DIR, 'index.html')).href;
const OUT = join(DEMO_DIR, 'scripts', 'out');
mkdirSync(OUT, { recursive: true });
const problems = [];
const browser = await chromium.launch();
for (const [label, vp, scheme] of [['desktop-light', { width: 1440, height: 900 }, 'light'], ['desktop-dark', { width: 1440, height: 900 }, 'dark'], ['phone', { width: 390, height: 844 }, 'light']]) {
  // the phone run is a real mobile emulation, so a missing or wrong viewport meta tag shows up
  const mobile = label === 'phone' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {};
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce', ...mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) problems.push(`${label} console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!/fonts\.g/.test(r.url())) problems.push(`${label} failed: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`${label} HTTP ${r.status()}: ${r.url()}`); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.click('#setupNext'); await page.click('#setupNext'); await page.click('#setupInvite'); await page.click('#setupNext');
  await page.selectOption('#ldUser', 'user-101'); await page.check('#ldKill'); await page.uncheck('#ldKill'); await page.selectOption('#ldPlan', 'pro');
  await page.fill('#roPct', '25'); await page.dispatchEvent('#roPct', 'input');
  await page.click('#vRamp'); await page.click('#vRollback'); await page.click('#vStale'); await page.click('#vKill');
  await page.click('#stKill');
  for (const t of await page.$$('#sdkTabs button')) await t.click();
  await page.click('#mtOne'); await page.click('#mtPlay');
  await page.waitForFunction(() => document.querySelector('#mtVerdict').classList.contains('fire'), null, { timeout: 30000 })
    .catch(() => problems.push(`${label}: metrics loop never reached a rollback`));
  await page.click('#hlRun'); await page.waitForTimeout(200);
  await page.click('#pkRun'); await page.waitForFunction(() => /of 1,000/.test(document.querySelector('#pkOut').textContent), null, { timeout: 30000 });
  await page.click('#opRun'); await page.waitForTimeout(200);
  await page.click('#gvNext'); await page.click('#gvNext'); await page.click('#gvNext');
  for (let i = 0; i < 5; i++) await page.click('#mcpNext');
  // every screenshot actually loaded
  const broken = await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('.shot img')];
    await Promise.all(imgs.map((i) => { i.loading = 'eager'; return i.decode().catch(() => {}); }));
    return imgs.filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src'));
  });
  if (broken.length) problems.push(`${label}: images not loaded: ${broken.join(', ')}`);
  const facts = await page.evaluate(() => ({
    ladder: document.querySelector('#ldResult').textContent.trim(),
    rollout: document.querySelector('#roOut').textContent.trim(),
    heal: document.querySelector('#hlOutcome').textContent.trim().slice(0, 100),
    peek: document.querySelector('#pkOut').textContent.trim(),
    metrics: document.querySelector('#mtVerdict').textContent.replace(/\s+/g, ' ').trim().slice(0, 90),
    nl: !document.querySelector('#s-nl').hidden,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sections: document.querySelectorAll('#sideList a').length,
  }));
  if (facts.overflow > 0) problems.push(`${label}: horizontal overflow ${facts.overflow}px`);
  const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
  if (layoutWidth !== vp.width) problems.push(`${label}: lays out at ${layoutWidth}px for a ${vp.width}px screen (viewport meta?)`);
  if (await page.evaluate(() => document.compatMode) !== 'CSS1Compat') problems.push(`${label}: quirks mode (missing doctype)`);
  console.log(label, JSON.stringify(facts));
  await page.evaluate(() => scrollTo(0, 0)); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector('#sideList a.active')?.getAttribute('href'));
  if (after !== '#s-setup') problems.push(`${label}: ArrowRight went to ${after}`);
  if (label === 'phone') {
    // the side menu is a drawer on a phone: closed by default, opens from the Menu button
    const closed = await page.evaluate(() => document.querySelector('#side').getBoundingClientRect().right <= 0);
    await page.click('#menuBtn'); await page.waitForTimeout(400);
    const open = await page.evaluate(() => document.querySelector('#side').getBoundingClientRect().left >= 0);
    await page.screenshot({ path: `${OUT}/phone-menu.png` });
    await page.click('#menuBtn'); await page.waitForTimeout(400);
    if (!closed || !open) problems.push(`phone: drawer closed=${closed} open=${open}`);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${OUT}/${label}-top.png` });
  for (const id of ['s-metrics', 's-heal', 's-nl', 's-perf']) {
    await page.evaluate((i) => document.getElementById(i).scrollIntoView({ block: 'start' }), id);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/${label}-${id}.png` });
  }
  await ctx.close();
}
await browser.close();
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no problems');
process.exit(problems.length ? 1 : 0);
