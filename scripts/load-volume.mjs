#!/usr/bin/env node
// Switchboard volume harness: the half of performance testing that is about DATA size
// rather than request rate.
//
// Three claims in the docs have never been checked against real volume, and all three are
// about the partitioned event tables:
//
//   1. "Retention drops whole partitions, so lowering it is immediate."  DROP TABLE on a
//      partition is O(unlink), not O(rows) -- but it takes an ACCESS EXCLUSIVE lock on the
//      PARENT, which is the table concurrent ingest is writing to. The interesting number
//      is therefore not how long the drop takes but what it blocks while it runs.
//   2. "The rollout aggregation is the most expensive query in the system."  It is a
//      GROUP BY across both event tables over the evidence window, and the metric_events
//      side cannot filter by flag_key because a metric event does not carry one.
//   3. The rollout monitor scan reads that aggregate for every live rollout.
//
// Rows are generated with generate_series inside Postgres rather than through the API:
// millions of rows through HTTP would measure the ingest path (which load-test.mjs already
// covers) and take hours. Here the point is to make the tables big and then time the reads.
//
// TRAP, and it will be the first thing that confuses you: the monitor measures from the
// ALLOCATION EPOCH, so version rows must be backdated or every scan reports itemsScanned=0
// with the tables full. This script backdates them for exactly that reason.
//
// Usage:
//   node scripts/load-volume.mjs --db switchboard_load --events 5000000
//   node scripts/load-volume.mjs --db switchboard_load --events 20000000 --keep
//
// Requires the compose postgres to be up. Exit 0 = measured, 1 = failed.

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const has = (n) => argv.includes(`--${n}`);

const DB = arg('db', 'switchboard_load');
const EVENTS = Number(arg('events', 5_000_000));
const SUBJECTS = Number(arg('subjects', 200_000));
const METRIC_RATIO = Number(arg('metric-ratio', 10));   // 1 metric event per N eval events
const BASE = arg('base', 'http://localhost:28090');
const MGMT = arg('mgmt', BASE.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`));
const JOB_TOKEN = arg('job-token', process.env.JOB_TOKEN ?? '');
const KEEP = has('keep');

function psql(sql, { quiet = true } = {}) {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: quiet ? ['pipe', 'pipe', 'pipe'] : 'inherit' },
  );
  return out.trim();
}

/** Wall-clock a block and return [result, ms]. */
async function timed(fn) {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

const ms = (v) => `${v.toFixed(0)} ms`;
const commas = (n) => Number(n).toLocaleString('en-US');

async function api(method, path, token) {
  // Job endpoints sit outside the bearer chain -- Cloud Scheduler has no user -- so the
  // shared secret goes in X-Job-Token, not Authorization.
  const res = await fetch(BASE + path, {
    method,
    headers: token ? { 'X-Job-Token': token } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`Switchboard volume harness — database "${DB}"`);
  console.log(`target ${commas(EVENTS)} eval events over ${commas(SUBJECTS)} subjects, 1 metric per ${METRIC_RATIO}\n`);

  // ---------------------------------------------------------------- topology
  // Pick the environment and flag with the most existing eval events, falling back to any
  // rollout-configured flag. The load-test fixture leaves plenty of both behind.
  const target = psql(`
    SELECT e.id || '|' || f.key || '|' || (f.variations->0->>'id') || '|' || (f.variations->1->>'id')
    FROM flag_env_configs c
    JOIN flags f ON f.id = c.flag_id
    JOIN environments e ON e.id = c.environment_id
    WHERE jsonb_array_length(f.variations) >= 2 AND e.key = 'production'
    ORDER BY c.updated_at DESC LIMIT 1`);
  if (!target) throw new Error(`No suitable flag in "${DB}". Run load-test.mjs against it first to build a fixture.`);
  const [envId, flagKey, varA, varB] = target.split('|');
  console.log(`environment ${envId}  flag ${flagKey}\n`);

  // ---------------------------------------------------------------- generate
  // Spread over 47h so everything lands inside the monitor's window but inside the current
  // partition; occurred_at drives partition routing.
  process.stdout.write(`generating ${commas(EVENTS)} eval events… `);
  const [, genEval] = await timed(async () => psql(`
    INSERT INTO eval_events (environment_id, flag_key, context_key, variation_id, reason, occurred_at)
    SELECT '${envId}'::uuid, '${flagKey}',
           'vol-subject-' || (g % ${SUBJECTS}),
           CASE WHEN (g % 2) = 0 THEN '${varA}'::uuid ELSE '${varB}'::uuid END,
           'ROLLOUT',
           now() - ((g % 169200) * interval '1 second')
    FROM generate_series(1, ${EVENTS}) g`));
  console.log(ms(genEval));

  const metrics = Math.floor(EVENTS / METRIC_RATIO);
  process.stdout.write(`generating ${commas(metrics)} metric events… `);
  const [, genMetric] = await timed(async () => psql(`
    INSERT INTO metric_events (environment_id, context_key, metric_key, value, occurred_at)
    SELECT '${envId}'::uuid,
           'vol-subject-' || (g % ${SUBJECTS}),
           CASE WHEN (g % 3) = 0 THEN 'error' ELSE 'conversion' END,
           1,
           now() - ((g % 169200) * interval '1 second')
    FROM generate_series(1, ${metrics}) g`));
  console.log(ms(genMetric));

  process.stdout.write('ANALYZE… ');
  const [, analyzed] = await timed(async () => psql('ANALYZE eval_events; ANALYZE metric_events;'));
  console.log(ms(analyzed));

  // The epoch trap: without this the scan reports itemsScanned=0 against full tables.
  psql(`UPDATE flag_env_config_versions SET created_at = now() - interval '49 hours'
        WHERE environment_id = '${envId}'::uuid`);
  psql(`UPDATE flag_env_configs SET updated_at = now() - interval '49 hours'
        WHERE environment_id = '${envId}'::uuid`);

  const sizes = psql(`
    SELECT string_agg(rel || '=' || sz, ' ') FROM (
      SELECT c.relname AS rel, pg_size_pretty(pg_total_relation_size(c.oid)) AS sz
      FROM pg_class c WHERE c.relname IN ('eval_events','metric_events')
         OR c.relname LIKE 'eval_events_2%' OR c.relname LIKE 'metric_events_2%'
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 6) s`);
  const counts = psql(`SELECT (SELECT count(*) FROM eval_events) || '|' || (SELECT count(*) FROM metric_events)`);
  const [evalRows, metricRows] = counts.split('|');
  console.log(`\nnow holding ${commas(evalRows)} eval events, ${commas(metricRows)} metric events`);
  console.log(`sizes: ${sizes}\n`);

  // ---------------------------------------------------------------- read cost
  console.log('--- the aggregation (claim: "the most expensive query in the system") ---');
  // Straight from RolloutMetricsRepositoryAdapter.AGGREGATE_SQL, totals variant. Timed in
  // the database so the number is the query and not the R2DBC round trip.
  const aggSql = `
    WITH ev AS (
        SELECT timestamptz 'epoch' AS bucket, variation_id, context_key, reason, COUNT(*)::bigint AS n
        FROM eval_events
        WHERE environment_id = '${envId}'::uuid AND flag_key = '${flagKey}'
          AND occurred_at >= now() - interval '48 hours' AND variation_id IS NOT NULL
        GROUP BY 1,2,3,4),
    totals AS (SELECT variation_id, context_key, SUM(n)::bigint AS n FROM ev GROUP BY 1,2),
    assign AS (SELECT DISTINCT ON (context_key) context_key, variation_id FROM totals
               ORDER BY context_key, n DESC, variation_id),
    exposure AS (SELECT context_key, MIN(bucket) AS bucket FROM ev GROUP BY 1),
    evc AS (SELECT bucket, variation_id, SUM(n)::bigint AS eval_count,
                   COUNT(DISTINCT context_key)::bigint AS subject_count
            FROM ev GROUP BY 1,2),
    mt AS (SELECT x.bucket, a.variation_id, m.metric_key, COUNT(*)::bigint AS n,
                  COUNT(DISTINCT m.context_key)::bigint AS subjects
           FROM metric_events m
           JOIN assign a ON a.context_key = m.context_key
           JOIN exposure x ON x.context_key = m.context_key
           WHERE m.environment_id = '${envId}'::uuid AND m.occurred_at >= now() - interval '48 hours'
           GROUP BY 1,2,3)
    SELECT (SELECT count(*) FROM evc) + (SELECT count(*) FROM mt)`;
  for (const label of ['cold-ish run 1', 'run 2', 'run 3']) {
    const [, t] = await timed(async () => psql(aggSql));
    console.log(`  aggregate over 48h  ${label.padEnd(14)} ${ms(t)}`);
  }

  const plan = psql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${aggSql}`);
  const worst = plan.split('\n').filter((l) => /Seq Scan|Parallel Seq Scan|Index Scan|Sort Method|Execution Time|Planning Time/.test(l));
  console.log('  plan highlights:');
  worst.slice(0, 14).forEach((l) => console.log(`    ${l.trim().slice(0, 150)}`));

  // ---------------------------------------------------------------- the jobs
  if (JOB_TOKEN) {
    console.log('\n--- the scan jobs, against this volume ---');
    for (const job of ['rollout-scan', 'stale-flag-scan']) {
      const [r, t] = await timed(() => api('POST', `/api/jobs/${job}`, JOB_TOKEN));
      console.log(`  POST /api/jobs/${job.padEnd(16)} ${ms(t)}  ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
    }
  } else {
    console.log('\n--- scan jobs skipped: pass --job-token <JOB_TOKEN> to time them ---');
  }

  // ---------------------------------------------------------------- retention
  console.log('\n--- retention (claim: partition DROP is O(1) in rows) ---');
  // Build an old, FULL partition and drop it the way PartitionMaintenanceService does, so
  // the cost is measured against real rows rather than an empty table.
  const oldMonth = psql(`SELECT to_char(date_trunc('month', now()) - interval '4 months', 'YYYY_MM')`);
  const oldStart = psql(`SELECT to_char(date_trunc('month', now()) - interval '4 months', 'YYYY-MM-DD')`);
  const part = `eval_events_${oldMonth}`;
  const exists = psql(`SELECT count(*) FROM pg_class WHERE relname = '${part}'`);
  if (exists === '0') {
    psql(`CREATE TABLE ${part} PARTITION OF eval_events FOR VALUES
          FROM ('${oldStart} 00:00:00+00') TO ('${oldStart}'::date + interval '1 month')`);
  }
  const fillRows = Math.min(EVENTS, 2_000_000);
  process.stdout.write(`  filling ${part} with ${commas(fillRows)} rows… `);
  const [, filled] = await timed(async () => psql(`
    INSERT INTO eval_events (environment_id, flag_key, context_key, variation_id, reason, occurred_at)
    SELECT '${envId}'::uuid, '${flagKey}', 'old-' || g, '${varA}'::uuid, 'ROLLOUT',
           '${oldStart}'::timestamptz + ((g % 86400) * interval '1 second')
    FROM generate_series(1, ${fillRows}) g`));
  console.log(ms(filled));
  const partSize = psql(`SELECT pg_size_pretty(pg_total_relation_size('${part}'::regclass))`);
  const partRows = psql(`SELECT count(*) FROM ${part}`);

  const [, dropped] = await timed(async () => psql(`DROP TABLE ${part}`));
  console.log(`  DROP TABLE ${part} (${commas(partRows)} rows, ${partSize})  ${ms(dropped)}`);
  console.log('  -- compare against a row-wise DELETE of the same data:');
  const [, deleted] = await timed(async () => psql(`
    DELETE FROM eval_events WHERE context_key LIKE 'vol-subject-1%' AND occurred_at < now() - interval '40 hours'`));
  console.log(`  DELETE (row-wise, a subset only)                      ${ms(deleted)}`);

  if (!KEEP) {
    process.stdout.write('\ncleaning up generated rows… ');
    const [, cleaned] = await timed(async () => psql(`
      DELETE FROM eval_events WHERE context_key LIKE 'vol-subject-%' OR context_key LIKE 'old-%';
      DELETE FROM metric_events WHERE context_key LIKE 'vol-subject-%';`));
    console.log(ms(cleaned));
    console.log('(--keep retains them for repeat measurement)');
  }
}

main().catch((e) => {
  console.error('\nVolume harness failed:', e.message ?? e);
  process.exit(1);
});
