/*
 * Switchboard demo: the product's own algorithms, ported for in-browser simulations.
 *
 *   bucket()            spec/evaluation.md 5.1  (md5(flagKey:contextKey)[0:8] % 10000)
 *   resolveRollout()    spec/evaluation.md 5.5
 *   evaluate()          spec/evaluation.md 2    (the precedence ladder)
 *   logEValueOneSided() backend/.../domain/ai/stats/MixtureSequentialTest.java
 *   zScore()            the fixed-horizon two-proportion z-test it replaced
 *
 * Checked against spec/conformance/*.json and the compiled Java by verify-sim.mjs.
 * Plain script: defines window.SB (browser) and module.exports (node).
 */
(function (root) {
  'use strict';

  // ---- MD5 (RFC 1321), UTF-8 input, returns lowercase hex ----
  function md5(str) {
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const words = new Uint32Array(((len + 8) >>> 6) * 16 + 16);
    for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[len >> 2] |= 0x80 << ((len % 4) * 8);
    const bitLen = len * 8;
    const nBlocks = ((len + 8) >>> 6) + 1;
    words[nBlocks * 16 - 2] = bitLen >>> 0;
    words[nBlocks * 16 - 1] = Math.floor(bitLen / 0x100000000);
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let blk = 0; blk < nBlocks; blk++) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + words[blk * 16 + g]) >>> 0;
        A = D; D = C; C = B;
        const s = S[(i >> 4) * 4 + (i % 4)];
        B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    let hex = '';
    for (const w of [a0, b0, c0, d0]) {
      for (let i = 0; i < 4; i++) hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return hex;
  }

  // ---- Bucketing and rollouts (spec 5) ----
  const BUCKET_SPACE = 10000;
  function bucket(flagKey, contextKey) {
    return parseInt(md5(flagKey + ':' + contextKey).slice(0, 8), 16) % BUCKET_SPACE;
  }
  function resolveRollout(rollout, b) {
    let cumulative = 0;
    for (const w of rollout) {
      cumulative += w.weight * (BUCKET_SPACE / 100);
      if (b < cumulative) return w.variationId;
    }
    return rollout[rollout.length - 1].variationId;
  }

  // ---- Precedence ladder (spec 2) ----
  // Returns { variationId, reason, step, trace } so the page can show the walk.
  function evaluate(flag, ctx, segments) {
    const trace = [];
    const done = (step, variationId, reason, extra) => {
      trace.push({ step, hit: true });
      return Object.assign({ variationId, reason, step, trace }, extra || {});
    };
    const miss = (step) => trace.push({ step, hit: false });
    if (flag.killSwitchActive) return done('kill', flag.targeting.offVariationId, 'KILL_SWITCH');
    miss('kill');
    if (!flag.enabled) return done('enabled', flag.targeting.offVariationId, 'FLAG_OFF');
    miss('enabled');
    const target = (flag.targeting.individualTargets || []).find((t) => t.contextKey === ctx.key);
    if (target) return done('targets', target.variationId, 'TARGET_MATCH');
    miss('targets');
    const rules = flag.targeting.rules || [];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i].clauses.every((c) => clauseMatches(c, ctx, segments, false))) {
        const v = rules[i].serve.variationId
          || resolveRollout(rules[i].serve.rollout, bucket(flag.key, ctx.key));
        return done('rules', v, 'RULE_MATCH', { ruleIndex: i, ruleId: rules[i].id });
      }
    }
    miss('rules');
    const ft = flag.targeting.fallthrough;
    if (ft.rollout && ft.rollout.length) return done('fallthrough', resolveRollout(ft.rollout, bucket(flag.key, ctx.key)), 'ROLLOUT');
    return done('fallthrough', ft.variationId, 'DEFAULT');
  }

  // Text operators only (spec 3.2 table): the ones the demo's flags use. Anything else throws, so
  // the verifier reports the vector as unsupported instead of guessing.
  const TEXT_OPS = {
    EQUALS: (a, v) => a === v,
    IN: (a, v) => a === v,
    CONTAINS: (a, v) => a.includes(v),
    STARTS_WITH: (a, v) => a.startsWith(v),
    ENDS_WITH: (a, v) => a.endsWith(v),
  };
  function attributeTexts(c, ctx) {
    // spec 3.1: "key" is reserved and reads context.key; null and objects are absent; arrays flatten.
    if (c.attribute === 'key') return [String(ctx.key)];
    const raw = (ctx.attributes || {})[c.attribute];
    const flat = [].concat(raw === undefined ? [] : raw).flat(Infinity)
      .filter((x) => x !== null && typeof x !== 'object');
    return flat.length ? flat.map(String) : null;
  }
  function clauseMatches(c, ctx, segments, insideSegment) {
    let op = c.op;
    let negate = !!c.negate;
    if (op === 'NOT_SEGMENT_MATCH') { op = 'SEGMENT_MATCH'; negate = !negate; }
    if (op === 'SEGMENT_MATCH') {
      if (insideSegment) return false; // spec 4.2: nested segment clauses fail; negation cannot rescue
      const hit = c.values.some((segKey) => segmentMatches(segments[segKey], ctx, segments));
      return negate ? !hit : hit;
    }
    const test = TEXT_OPS[op];
    if (!test) throw new Error('demo evaluator does not implement ' + op);
    const texts = attributeTexts(c, ctx);
    const hit = texts !== null && texts.some((a) => c.values.some((v) => test(a, String(v))));
    return negate ? !hit : hit;
  }
  function segmentMatches(seg, ctx, segments) {
    if (!seg) return false; // spec 4: unknown segments fail, never error
    if ((seg.excludedKeys || []).includes(ctx.key)) return false;
    if ((seg.includedKeys || []).includes(ctx.key)) return true;
    return (seg.rules || []).some((r) => r.clauses.every((rc) => clauseMatches(rc, ctx, segments, true)));
  }

  // ---- Statistics (MixtureSequentialTest.java + Gaussian.java, line for line) ----
  function erfc(x) {
    const z = Math.abs(x);
    const t = 1.0 / (1.0 + 0.5 * z);
    const series = t * Math.exp(-z * z - 1.26551223
      + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
      + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223
      + t * 0.17087277)))))))));
    return x >= 0.0 ? series : 2.0 - series;
  }
  const cdf = (x) => 0.5 * erfc(-x / Math.SQRT2);
  function logCdf(x) {
    if (x > -8.0) return Math.log(cdf(x));
    const sq = x * x;
    return -0.5 * sq - Math.log(-x) - 0.5 * Math.log(2 * Math.PI)
      + Math.log1p(-1.0 / sq + 3.0 / (sq * sq));
  }
  function inputs(x1, n1, x2, n2, tau) {
    if (n1 < 1 || n2 < 1 || x1 < 0 || x2 < 0 || x1 > n1 || x2 > n2) return null;
    if (!(tau > 0) || !Number.isFinite(tau)) return null;
    const pooled = (x1 + x2) / (n1 + n2);
    const variance = pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2);
    if (!(variance > 0) || !Number.isFinite(variance)) return null;
    const tau2 = tau * tau;
    return { difference: x1 / n1 - x2 / n2, variance, tau2, shifted: variance + tau2 };
  }
  function logTwoSided(i) {
    const shrinkage = 0.5 * (Math.log(i.variance) - Math.log(i.shifted));
    const growth = i.tau2 * i.difference * i.difference / (2.0 * i.variance * i.shifted);
    return shrinkage + growth;
  }
  function logEValueOneSided(x1, n1, x2, n2, tau) {
    const i = inputs(x1, n1, x2, n2, tau);
    if (!i) return 0.0;
    const scaled = i.difference * tau / Math.sqrt(i.variance * i.shifted);
    return Math.log(2.0) + logCdf(scaled) + logTwoSided(i);
  }
  const logThreshold = (alpha) => -Math.log(alpha);
  function zScore(x1, n1, x2, n2) {
    if (n1 < 1 || n2 < 1) return 0;
    const p = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    return se > 0 ? (x1 / n1 - x2 / n2) / se : 0;
  }

  // ---- Deterministic RNG for repeatable demos (mulberry32) ----
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A/A peeking: fraction of null trials where a rule fires at least once over `peeks` looks.
  function peekingRates(opts) {
    const { trials, peeks, perPeek, baseRate, alpha, tau, z, seed } = opts;
    const r = rng(seed);
    let naive = 0, mixture = 0;
    const threshold = logThreshold(alpha);
    for (let t = 0; t < trials; t++) {
      let x1 = 0, n1 = 0, x2 = 0, n2 = 0, fNaive = false, fMix = false;
      for (let p = 0; p < peeks; p++) {
        for (let i = 0; i < perPeek; i++) {
          n1++; if (r() < baseRate) x1++;
          n2++; if (r() < baseRate) x2++;
        }
        if (!fNaive && zScore(x1, n1, x2, n2) > z) fNaive = true;
        if (!fMix && logEValueOneSided(x1, n1, x2, n2, tau) >= threshold) fMix = true;
        if (fNaive && fMix) break;
      }
      if (fNaive) naive++;
      if (fMix) mixture++;
    }
    return { naive: naive / trials, mixture: mixture / trials };
  }

  const SB = {
    md5, bucket, resolveRollout, evaluate, BUCKET_SPACE,
    erfc, cdf, logCdf, logEValueOneSided, logThreshold, zScore, rng, peekingRates,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SB;
  else root.SB = SB;
})(typeof window !== 'undefined' ? window : globalThis);
