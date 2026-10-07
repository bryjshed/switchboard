// Captures the real dashboard for the demo page, in light and dark.
// Signs in through the real login page (Firebase emulator), so every shot is what a user sees.
// A shot that shows an error alert or fails to load stops the run: nothing broken gets published.
//
// usage: npm run shots [-- name,name]   (needs a running, seeded stack staged by `npm run stage`)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD as BASE, DEMO_DIR, EMULATOR, signIn, workspace } from './lib.mjs';

const onlyArg = process.argv[2];
const only = onlyArg ? new Set(onlyArg.split(',')) : null;
const outDir = process.env.SHOTS_OUT ?? join(DEMO_DIR, 'shots');  // override to test without touching the committed shots
mkdirSync(outDir, { recursive: true });
const { orgId, projectId } = await workspace();

// Bring a section heading to the top of its scroll container (the targeting editor is taller than one screen).
function scrollTo(heading) {
  return async (page) => {
    await page.getByText(heading, { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  };
}

// name, path, user, prepare(page)?, viewport width?
const SHOTS = [
  ['flags', '/flags', 'alice'],
  ['targeting-pro', '/flags/pro-plan-features?tab=targeting', 'alice', scrollTo('Rules')],
  ['rollout-checkout', '/flags/new-checkout?tab=targeting', 'alice', scrollTo('Default (fallthrough)')],
  ['history-checkout', '/flags/new-checkout?tab=history', 'alice', null, 1760],
  ['history-heal', '/flags/payment-provider-v3?tab=history', 'alice', null, 1760],
  ['monitor-heal', '/flags/payment-provider-v3?tab=monitor', 'alice'],
  ['proposals', '/ai/proposals', 'alice'],
  ['activity', '/activity', 'alice'],
  ['change-request', '/change-requests', 'alice', async (page) => {
    await page.locator('a[href^="/change-requests/"]').first().click();
    await page.waitForURL(/\/change-requests\/.+/);
  }],
  ['settings-organization', '/settings?tab=organization', 'alice'],
  ['settings-webhooks', '/settings?tab=webhooks', 'alice'],
  ['first-run', '/flags', 'erin'],
];

const USERS = {
  alice: { email: 'alice@switchboard.dev', workspace: true },
  erin: { email: 'erin@newco.dev', workspace: false }, // brand-new account, no org: the first-run screen
};

async function ensureEmulatorUser(email) {
  await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
  });
}

async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => !document.querySelector('.animate-pulse, .animate-spin'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const alerts = await page.locator('[role="alert"]').allInnerTexts();
  const bad = alerts.filter((t) => t.trim() && !/verify your email/i.test(t));
  if (bad.length) throw new Error('error alert on page: ' + bad.join(' | ').slice(0, 300));
}

const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    for (const [userKey, user] of Object.entries(USERS)) {
      const mine = SHOTS.filter(([name, , u]) => u === userKey && (!only || only.has(name)));
      if (!mine.length) continue;
      if (userKey === 'erin') await ensureEmulatorUser(user.email);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
      await ctx.addInitScript(({ theme, orgId, projectId, workspace }) => {
        try {
          localStorage.setItem('switchboard-theme', theme);
          if (workspace) {
            localStorage.setItem('switchboard.orgId', orgId);
            localStorage.setItem('switchboard.projectId', projectId);
            localStorage.setItem('switchboard.envKey', 'production');
          }
        } catch { /* ignore */ }
      }, { theme, orgId, projectId, workspace: user.workspace });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await signIn(page, user.email);
      for (const [name, path, , prepare, width] of mine) {
        await page.setViewportSize({ width: width || 1440, height: width ? Math.round(width * 0.625) : 900 });
        await page.goto(BASE + path);
        await settle(page);
        if (prepare) { await prepare(page); await settle(page); }
        const file = `${outDir}/${name}-${theme}.jpg`;
        // Crop to the content area (no sidebar or top bar) so a projected shot stays legible.
        // The Flags page keeps the full frame: the hero shows the whole product.
        if (name === 'flags') {
          await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
        } else if (name === 'targeting-pro' || name === 'rollout-checkout') {
          // a scrolled editor: clip to the visible part of the tab panel
          const panel = await page.locator('main [role="tabpanel"]').first().boundingBox();
          const main = await page.locator('main').first().boundingBox();
          await page.screenshot({ path: file, type: 'jpeg', quality: 84,
            clip: { x: panel.x - 8, y: main.y, width: panel.width + 16, height: main.height } });
        } else {
          await page.locator('main').first().screenshot({ path: file, type: 'jpeg', quality: 84 });
        }
        console.log('shot', file);
      }
      if (pageErrors.length) throw new Error(`page errors for ${userKey}/${theme}: ${pageErrors.join(' | ').slice(0, 300)}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
