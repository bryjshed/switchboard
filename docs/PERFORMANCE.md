# Performance

Measured numbers, the method that produced them, and what they do **not** cover.

Until 2026-08-25 every latency claim in this repo was unmeasured, and
[REMAINING-WORK.md](REMAINING-WORK.md) said so. This document replaces the claims with
measurements. It is deliberately written to be falsifiable: the rig, the load shape, and the
instrument's own error are all stated, so a reader can disagree with a number by re-running it.

> **Why this is worth having at all.** No feature-flag vendor publishes p50/p95/p99 for its
> delivery path — every figure in the market is a marketing average, a laptop benchmark, or
> an adjective, and several trace back to 2021. See
> [competitive-gaps.md](competitive-gaps.md#latency). The bar here is therefore **internal
> honesty**, not a public benchmark: numbers we believe, with the caveats attached.

Reproduce with:

```bash
node scripts/load-test.mjs   --base http://localhost:28090 --flags 50 --rate 500 --workers 3
node scripts/load-volume.mjs --db switchboard_load --events 2000000 --job-token <token>
```

---

## The rig

| | |
|---|---|
| Machine | Apple Silicon laptop, 10 cores, 16 GB. **Server and load generator share it.** |
| Postgres | 18, in Docker, default `work_mem` (4 MB), default `shared_buffers` |
| Backend | **packaged jar** (`java -jar`), full tiered JIT |
| Database | `switchboard_load`, isolated from the dev database |
| Disabled | rate limiting, scheduled jobs — see [What was turned off](#what-was-turned-off) |
| Fixture | 50 flags (every third carrying 3 rules), one 500-key segment, server + client keys |
| Generator | 3 forked Node processes, open-loop |

**Do not measure against `make backend`.** `mvnw spring-boot:run` passes
`-XX:TieredStopAtLevel=1`, which caps the JIT at C1 and leaves the hot path permanently
un-optimised. It is the right default for a dev loop and the wrong one for a benchmark; every
number below is from the jar, which is also the shape CI's `containers` job and any real
deployment run.

---

## Method

Three things decide whether a latency number means anything. All three are easy to get wrong
in a way that flatters the result, so each is handled explicitly.

**1. Coordinated omission.** A closed-loop generator — N workers looping request → response →
request — stops sending while the server is stalled, so the stall never enters the sample. It
measures *service time*, not what a client experiences. The default mode here is **open loop**:
requests are scheduled at a fixed arrival rate and latency is measured from when each request
was **due**, not when it was sent. Both numbers are reported, and the gap between them is the
queueing a closed-loop view would have hidden.

**2. The generator being the bottleneck.** Node is single-threaded. The first honest run of
this harness saturated its own event loop at ~28k req/s while reporting 40% loop lag — the
numbers described the generator, not the server. Load is now split across forked processes,
event-loop delay is sampled throughout, and a run that is generator-bound says so in its own
output.

**3. Instrument floor.** The dispatcher wakes on a 1 ms timer and the loop-delay monitor has
1 ms resolution, so "queue delay" and "event-loop lag" both have a floor of roughly a
millisecond that exists against an infinitely fast server. That floor is **measured, not
assumed**: a calibration pass runs the identical dispatch loop against a transport that
resolves immediately. On this rig it is ~2.4 ms at p99. Any queue delay below that is
instrument, not server.

Percentiles are nearest-rank over the full retained sample, not a histogram approximation.
Warmup traffic is run and discarded (JVM C2 needs thousands of iterations; it also settles the
connection pool and the caches).

---

## Latency

Open loop, **500 req/s**, 30 s per scenario after 10 s warmup, 15,000 responses each, 50 flags.
All scenarios held the target rate (499.9/s achieved) with zero unexpected statuses.

Service time is measured from send to last byte — the server's own cost. Response time adds
dispatch lateness and is the upper bound a client at this arrival rate would see.

| Path | p50 | p90 | p99 | p99.9 | bytes/resp |
|---|---|---|---|---|---|
| `POST /api/eval/{key}` — single eval | **0.68** | 2.45 | 4.91 | 33.5 | 0.2 kB |
| `POST /api/eval` — bulk, 50 flags | **0.57** | 1.85 | 4.59 | 25.0 | 7.2 kB |
| `GET /api/eval/bootstrap` — 304 | **0.74** | 3.12 | 8.08 | 37.0 | 0 |
| `GET /api/eval/bootstrap` — full | **0.79** | 2.56 | 15.77 | 101.1 | 48.1 kB |
| `POST /ofrep/v1/evaluate/flags` | **0.84** | 3.23 | 6.24 | 55.2 | 13.1 kB |
| `POST /api/eval/bootstrap` — client | **0.78** | 3.01 | 17.48 | 83.0 | 9.4 kB |
| `POST /api/events/eval` — ingest | **2.06** | 4.95 | **62.10** | 104.7 | — |
| `GET /projects/{id}/flags` — dashboard | **2.87** | 6.13 | **73.82** | 103.5 | 30.7 kB |

p50/p90/p99/p99.9 in ms, service time. Queue delay at p99 was 1.0–7.9 ms against a measured
2.4 ms instrument floor, i.e. **no measurable server queueing at this rate**.

**What this says.** Every cache-served path is sub-millisecond at p50 and single-digit at p99.
The two outliers — telemetry ingest and the dashboard flag list — are precisely the two paths
that touch Postgres on **every** request, and they are an order of magnitude worse than
everything else. That is the caching seam working: the paths that go through it are fast, and
the ones that do not are where the remaining time is.

Cache hit rates over the run were effectively 100% (`env_snapshot`, `sdk_key`,
`permissions`, `user_identity` — one miss each at first touch, then hits). The caches added on
2026-08-25 were sized by argument; this is the first evidence they hold up under load.

Server CPU averaged **0.41 of 10 cores** across the whole suite. There is a great deal of headroom.

### Throughput

Closed loop, 64 workers: **28,457 eval/s** sustained, zero errors.

Treat that as a **floor, not a ceiling**. The harness reported 40–67% event-loop lag at that
rate — the generator and the JVM were competing for the same 10 cores, so the number describes
the rig. The server's actual ceiling is higher and this machine cannot measure it. Measuring it
honestly needs a separate load box.

---

## Volume

2.4 M eval events + 200 k metric events over a 48-hour window, 200 k distinct subjects.
`eval_events_2026_08` = 282 MB, its lookup index 38 MB.

### Retention — the claim holds

Retention drops whole partitions rather than deleting rows, and the docs have always claimed
that makes lowering it immediate. It does:

| operation | rows | size | time |
|---|---|---|---|
| `DROP TABLE` one partition | 828,000 | 91 MB | **259 ms** |
| row-wise `DELETE` of a *subset* | fewer | — | 991 ms |
| `POST /api/jobs/partition-roll` end to end | — | — | **54 ms** (dropped 1) |

A partition drop is an unlink, not a scan, so it is flat in row count — and it beat a
row-wise delete of *less* data by 4×. The design is confirmed. The cost that does **not** show
up here is the `ACCESS EXCLUSIVE` lock a drop takes on the parent table; on this rig, with no
concurrent ingest during the drop, it was not observable. Under live ingest it would be, and
54 ms is a short enough window that it is unlikely to matter.

### The rollout aggregation is the real scaling limit

The `GROUP BY` across both event tables — described in
[REMAINING-WORK.md](REMAINING-WORK.md#3-caching) as "the most expensive query in the system" —
is exactly that, and it is worse than the phrase suggests.

| `work_mem` | sort | execution |
|---|---|---|
| 4 MB (Postgres default) | external merge, 31 MB spilled to disk | **4.2 – 5.6 s** |
| 64 MB | quicksort in memory | 2.81 s |
| 256 MB | quicksort in memory | 2.02 s |

That is **per flag, per scan**, at 2.4 M events. And `RolloutMonitorService` iterates
candidates with `concatMap` — serially:

```
POST /api/jobs/rollout-scan   5,884 ms   itemsScanned=1
POST /api/jobs/stale-flag-scan    55 ms  itemsScanned=265
```

**5.9 seconds for one rollout.** Fifty live rollouts at this volume would be roughly five
minutes of serial scanning. This is not a user-facing latency problem — the query sits behind
the 60-second `ROLLOUT_STATS` cache and the scan is a background job — but it is a wall, and
it is the one that arrives first.

Two things follow, in cost order:

1. **Raise `work_mem` for the connection that runs this query.** The default 4 MB forces a
   31 MB spill to disk that roughly doubles the cost. This is a configuration change and the
   cheapest performance win available anywhere in the system.
2. **Incremental rollups.** [REMAINING-WORK.md](REMAINING-WORK.md#3-caching) named these as the
   alternative to a short-TTL cache and picked the cache, correctly, as the cheaper first move.
   The cache fixes repeated reads; it does nothing for the scan, which needs a *fresh* number
   every time by construction. Rollups are what the scan actually wants.

Note also that the `mt` CTE filters `metric_events` by `environment_id` and `occurred_at` but
**cannot filter by flag key** — a metric event does not carry one — so it reads every metric
event in the environment over the window regardless of which flag is being scanned. That is
inherent to the current event model, not a missing index.

---

## What was turned off

Both would otherwise have measured themselves rather than the server, but both are real and
both matter in production:

**Rate limiting** (`switchboard.ratelimit.enabled=false`). The default is 6,000 requests per
minute per credential — **100 req/s**. A single SDK key is a single credential, so a server
fleet sharing one key is capped at 100 req/s in aggregate, well below the 28k/s the server can
serve. That is a sensible anti-abuse default and a surprising throughput ceiling; it is also
per-instance, so two instances mean 200 req/s. Anyone load-testing Switchboard will hit this
first and should know it is a limiter, not a server limit.

**Scheduled jobs** (`switchboard.jobs.scheduled-enabled=false`), so a background rollout scan
could not land in the middle of a latency measurement. Given the scan takes 5.9 s per rollout,
one landing mid-run would have been visible in the tail.

---

## What this does not cover

Stated so nobody reads more into the numbers than is there.

- **One machine, one instance, loopback.** No network latency, no TLS termination, no load
  balancer, no cross-AZ hop. Real p99 for a real client is dominated by things absent here.
- **No multi-instance run.** `NOTIFY` invalidation fan-out, and the per-instance rate limiter
  and cache cold-start costs described in
  [DEPLOYMENT.md](DEPLOYMENT.md#scaling-past-one-node), are unmeasured.
- **No SSE fan-out measurement.** Connection-count scaling on `/api/stream` — the number
  LaunchDarkly's Relay quotes ~20,000 for — has not been tested at all.
- **50 flags, one environment.** The bootstrap payload was 48.1 kB, so roughly 1 kB per flag.
  A 1,000-flag project implies a ~1 MB bootstrap, and nothing here measures that or the
  large-segment case flagged in [competitive-gaps.md](competitive-gaps.md).
- **Sustained soak.** The longest run was 30 seconds. Nothing here would catch a leak, and the
  p99.9 figures (25–105 ms across scenarios) are consistent with GC pauses that a longer run
  would characterise properly.
- **The generator shares the machine with the server**, which inflates the tail on both sides.

The honest summary: **the steady-state read path is fast and well inside its headroom, the two
uncached database paths are the slow ones, retention works as designed, and the rollout scan is
the first thing that will fall over as the product grows.**
