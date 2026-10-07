// Live natural-language capture (needs the backend started with ANTHROPIC_API_KEY).
// Opens Ask AI on the Flags page as alice, sends ONE real prompt, waits for the drafted proposal,
// screenshots the dialog in light then dark (same proposal: the theme is switched in place),
// and saves the proposal the API returned. The proposal is left as a draft: nothing is applied.
//
// usage: npm run nl   (the backend must have been started with ANTHROPIC_API_KEY set)
// Afterwards, update ../nl-data.js by hand from scripts/nl-proposal.json: it shows the prompt, the
// rationale and the rule, with variation ids replaced by names.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD as BASE, DEMO_DIR as dir, signIn, workspace } from './lib.mjs';
const { orgId, projectId } = await workspace();
const PROMPT = "Release planner-v2's compact variant to 10% of iOS users on the Pro plan in staging";

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await ctx.addInitScript(({ orgId, projectId }) => {
    localStorage.setItem('switchboard-theme', 'light');
    localStorage.setItem('switchboard.orgId', orgId);
    localStorage.setItem('switchboard.projectId', projectId);
    localStorage.setItem('switchboard.envKey', 'staging');
  }, { orgId, projectId });
  const page = await ctx.newPage();
  await signIn(page, 'alice@switchboard.dev');
  await page.goto(BASE + '/flags');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Ask AI/ }).first().click();
  await page.fill('[data-testid="ask-ai-prompt"]', PROMPT);
  const respP = page.waitForResponse((r) => /\/ai\/proposals$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 180000 });
  await page.click('[data-testid="ask-ai-submit"]');
  const resp = await respP;
  const body = await resp.text();
  if (resp.status() >= 400) throw new Error(`draft failed: HTTP ${resp.status()} ${body.slice(0, 400)}`);
  writeFileSync(join(dir, 'scripts', 'nl-proposal.json'), body);
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle');
  if (await page.locator('[data-testid="ask-ai-error"]').count()) {
    throw new Error('dialog shows an error: ' + (await page.locator('[data-testid="ask-ai-error"]').innerText()));
  }
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.screenshot({ path: join(dir, 'shots', 'ask-ai-light.jpg'), type: 'jpeg', quality: 86 });
  await page.evaluate(() => { document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); });
  await page.waitForTimeout(400);
  await dialog.screenshot({ path: join(dir, 'shots', 'ask-ai-dark.jpg'), type: 'jpeg', quality: 86 });
  console.log('shots ask-ai-light/dark');
  const p = JSON.parse(body);
  console.log('proposal', p.id, p.status, '| keys:', Object.keys(p).join(','));
  await ctx.close();
} finally {
  await browser.close();
}
