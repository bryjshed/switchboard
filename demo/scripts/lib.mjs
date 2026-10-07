// Shared plumbing for the demo capture scripts. They drive a LOCAL stack (make deps-up, make backend,
// make seed, make dashboard) through the public API with dev tokens, exactly like the check scripts.
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = join(DEMO_DIR, '..');
export const API = process.env.API_BASE_URL ?? 'http://localhost:28080';
export const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:5273';
export const EMULATOR = process.env.FIREBASE_EMULATOR_URL ?? 'http://localhost:29099';
export const JOB_TOKEN = process.env.JOB_TOKEN ?? 'local-job-token';
export const ALICE = 'dev:alice@switchboard.dev';
export const BOB = 'dev:bob@switchboard.dev';

export async function api(method, path, token, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

/** The seeded Acme Mobile org and its storefront-app project (scripts/seed-local.mjs). */
export async function workspace() {
  const org = (await api('GET', '/api/orgs', ALICE)).body.find((o) => o.name === 'Acme Mobile');
  if (!org) throw new Error('No "Acme Mobile" org for alice. Run `make seed` against a fresh database first.');
  const project = (await api('GET', `/api/orgs/${org.id}/projects`, ALICE)).body.find((p) => p.key === 'storefront-app');
  const envs = (await api('GET', `/api/projects/${project.id}/environments`, ALICE)).body;
  return { orgId: org.id, projectId: project.id, envs: Object.fromEntries(envs.map((e) => [e.key, e])) };
}

export function psql(sql) {
  return execSync(
    `docker exec switchboard-postgres-1 psql -U postgres -d switchboard -tAc ${JSON.stringify(sql)}`,
    { encoding: 'utf8' }).trim();
}

/** Signs in through the real login page, so every capture is what a user sees. */
export async function signIn(page, email) {
  await page.goto(DASHBOARD + '/login');
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'password123');
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}
