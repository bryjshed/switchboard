// Proves the demo's simulations run the product's real algorithms.
// usage: npm run verify
// java-values.json holds MixtureSequentialTest outputs printed by the compiled backend class; regenerate
// it after changing the statistic (see demo/README.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEMO_DIR, REPO_DIR as repo } from './lib.mjs';

// sim.js is a plain browser script; loaded here it defines globalThis.SB, exactly as it defines window.SB.
await import(pathToFileURL(join(DEMO_DIR, 'sim.js')).href);
const SB = globalThis.SB;
const conf = (f) => JSON.parse(readFileSync(join(repo, 'spec/conformance', f), 'utf8'));
let pass = 0, fail = 0, skipped = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('FAIL', msg); } };

// 1. MD5 + bucket against every bucket vector.
for (const v of conf('bucket.json').bucketVectors) {
  ok(SB.md5(v.input) === v.md5Hex, `md5 ${v.input}`);
  ok(SB.bucket(v.flagKey, v.contextKey) === v.bucket, `bucket ${v.input}`);
}

// 2. The spec's distribution claim (spec 5.6): user-1..1000 splits 512/488 at 50/50, 119/881 at 10/90.
const first = (w) => { let n = 0; for (let i = 1; i <= 1000; i++) if (SB.bucket('new-checkout', `user-${i}`) < w * 100) n++; return n; };
ok(first(50) === 512, `50/50 split ${first(50)}/${1000 - first(50)}`);
ok(first(10) === 119, `10/90 split ${first(10)}/${1000 - first(10)}`);

// 3. Full evaluation cases from the vector files the demo's flags rely on.
for (const f of ['stickiness.json', 'ramp-at-10.json', 'ramp-at-25.json', 'precedence-boolean.json',
  'precedence-multivariate.json', 'segments.json', 'clauses.json']) {
  const d = conf(f);
  const flags = Object.fromEntries(d.flags.map((x) => [x.key, x]));
  const segs = Object.fromEntries((d.segments || []).map((s) => [s.key, s]));
  for (const c of d.cases) {
    const flag = flags[c.flagKey];
    if (!flag) { skipped++; continue; }
    let r;
    try { r = SB.evaluate(flag, c.context, segs); }
    catch (e) { skipped++; continue; }
    const value = flag.variations.find((v) => v.id === r.variationId)?.value;
    const good = value === c.expected.value && r.reason === c.expected.reason
      && (!c.expected.ruleId || c.expected.ruleId === r.ruleId);
    ok(good, `${f}: ${c.name} -> got ${value}/${r.reason}, want ${c.expected.value}/${c.expected.reason}`);
  }
}

// 4. The e-value port against values printed by the compiled Java class.
{
  const javaVals = JSON.parse(readFileSync(join(DEMO_DIR, 'scripts', 'java-values.json'), 'utf8'));
  for (const j of javaVals) {
    const js = SB.logEValueOneSided(...j.args);
    ok(Math.abs(js - j.logE) <= 1e-9 * Math.max(1, Math.abs(j.logE)), `logE ${j.args} js=${js} java=${j.logE}`);
  }
}

// 5. The A/A peeking claim at PeekingTest's parameters.
const pt = SB.peekingRates({ trials: 2000, peeks: 48, perPeek: 100, baseRate: 0.05, alpha: 0.01, tau: 0.02, z: 3.0, seed: 20260824 });
console.log(`info: PeekingTest params -> z>3 fired ${pt.naive}, mixture fired ${pt.mixture} (Java measured 0.0090 / 0.0025)`);
ok(pt.mixture <= 0.01, 'mixture holds alpha=0.01 across 48 peeks');
ok(pt.naive > 3 * 0.00135, 'z>3 overshoots its nominal 0.00135');

console.log(`\n${pass} passed, ${fail} failed, ${skipped} vectors skipped (operators outside the demo's subset)`);
process.exit(fail ? 1 : 0);
