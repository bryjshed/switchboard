# The AI layer

Three functions, each backed by a domain port so providers swap, each degrading gracefully when no
API key is configured. The whole product works without one; AI endpoints return
`503 AI_UNAVAILABLE`, and the UI renders that as an explanation rather than an error.

- **Natural-language flag ops** — "release the new planner to 10% of iOS users on Pro" comes back as
  a typed diff you review before applying. The model is forced through a single tool schema, so the
  output is a validated change proposal, never free text applied blind.
- **Healing** — a scan compares per-variant error rates and files an anomaly finding. With
  auto-rollback enabled it applies the rollback itself and marks the finding `AUTO_ROLLED_BACK`.
- **Optimizing** — the same scan spots a variant that converts significantly better and drafts the
  next ramp step (25 → 50 → 75 → 100). Auto-apply is a separate opt-in.

Healing and optimizing work without any API key. Only the natural-language path needs one.

---

## Turning it on

Healing and optimizing need nothing installed and no key. They need three things from you:

1. **AI features on.** **Settings → AI → AI features**. On by default for every organization;
   an owner can turn it off, after which Switchboard scans nothing and drafts nothing.
2. **Outcomes reported, under metric keys the project defines.** Your application reports
   `error` and `conversion` events for the same context keys it evaluates with — the SDKs'
   `track()` does this, and records which variation each context was served. Other keys drive
   the monitor only once they are defined for the project. See
   [integrating.md](integrating.md#reporting-outcomes).
3. **A flag that is splitting traffic** — a percentage rollout in the fallthrough or in a rule,
   in an environment that is not killed.

With that, the monitor scans every hour and its findings appear under **Monitor** and on the
flag's **Monitor** tab, with a drafted rollback or ramp step under **Proposals**. Nothing is
applied until a person applies it — unless an owner turns on, under **Settings → AI**:

- **Roll back a rollout automatically when a variant starts erroring** (auto-rollback), and/or
- **Ramp up a variant that is winning** (auto-optimize).

Both are off by default. Each automatic action is an ordinary new version, reversible from the
flag's **History** tab and marked as an AI change in **Activity**. In an environment that requires
approval, automated rollbacks skip the queue unless the environment turns that off — see
[governance.md](governance.md#the-two-deliberate-bypasses).

**Expect silence at first.** The monitor says nothing about a variation until both it and the
baseline have at least 200 distinct subjects (`rollout-monitor.min-subjects`) since the rollout's
split last changed, and it reacts only to differences at least as large as the metric's
threshold — 1 percentage point for `error`, 2 for `conversion`. A small or brand-new rollout
producing no findings is the monitor working, not failing.

**Natural-language flag creation** (**Ask AI** on the Flags and flag pages) additionally needs
`ANTHROPIC_API_KEY` set on the backend. Without it the dialog explains that and the rest of the
AI layer is unaffected.

**Stale flags** are swept by `POST /api/jobs/stale-flag-scan`, which is not scheduled in-process —
see [DEPLOYMENT.md](DEPLOYMENT.md#scheduled-jobs).

## The closed circuit

Your application reports outcomes, the scan judges them, and the result is an ordinary flag change.

```mermaid
flowchart TD
    app["Your app reports<br/>eval + metric events"] --> scan{{"rollout scan"}}
    scan --> agg["aggregate per variant, per SUBJECT:<br/>exposed subjects, error rate, conversion rate"]
    agg --> srm{"traffic arriving as<br/>configured?"}
    srm -->|no| gate["SRM finding<br/>comparisons suppressed"]
    srm -->|yes| test{"mixture SPRT<br/>vs the configured baseline"}
    test --> ebh{"survives the correction<br/>across the environment?"}
    ebh -->|"errors worse"| heal["anomaly finding<br/>+ rollback proposal"]
    ebh -->|"converts better"| opt["optimization proposal<br/>ramp 25 → 50 → 75 → 100"]
    ebh -->|"no"| none["nothing"]
    heal --> autoR{"auto-rollback<br/>enabled?"}
    opt --> autoO{"auto-optimize<br/>enabled?"}
    autoR -->|yes| apply["apply through the normal<br/>versioned, audited write path"]
    autoR -->|no| queue["wait for a human<br/>on the Monitor screen"]
    autoO -->|yes| apply
    autoO -->|no| queue
    apply --> app
```

Both auto behaviours are per-org settings, off by default, and every application lands as an ordinary
audited version you can roll back.

The rollout scan runs hourly in-process, and `POST /api/jobs/rollout-scan` (shared-secret header)
lets an external scheduler drive it instead — which matters when instances scale to zero, since a
stopped instance fires no timer.

## The statistics, and why they are what they are

This is the part the product leads with, so it is worth being precise about.

### Subjects, not events

Rates are computed over **distinct context keys**, not evaluation events. A server SDK evaluating a
flag in a hot loop emits hundreds of events for one user; dividing metric events by evaluation events
gives a ratio of event counts, not a proportion of anything. Handed to a test that assumes
independent trials it understates the variance by roughly the average evaluations-per-subject, and
inflates the statistic by roughly its square root.

No amount of statistical sophistication fixes a denominator that counts the wrong thing.

### An anytime-valid statistic, not a fixed-horizon one

The monitor runs on a schedule, so whatever it computes gets evaluated again and again. A
fixed-horizon test — a two-proportion z-test, say — is calibrated for **one** look. Re-running it
hourly and reacting to whichever look crosses the threshold inflates the false-positive rate without
bound: given enough looks, a rollout whose two arms are identical will eventually be rolled back.

Switchboard uses a mixture sequential probability ratio test, reported as an e-value. Under the null
that e-value is a non-negative supermartingale, so Ville's inequality bounds the probability that it
*ever* reaches 1/α by α — however often it is inspected, and even though the decision to stop depends
on the data.

**The observable consequence: the scan interval does not appear in any decision.** Set it to a minute
or to a day; the error guarantees are unchanged. That is precisely what was untrue before.

### Evidence accumulates from the allocation epoch

An anytime-valid guarantee rests on evidence that only grows. A rolling window is not that —
observations leave it, so the statistic resets its own information content on a timer, which is the
same pathology as restarting a fixed-horizon test forever.

So the evidence window runs from the **allocation epoch**: the last config write that changed how
traffic is split. Changing weights mid-flight resets the evidence, which is correct rather than
unfortunate — when the split changes, the arms contain different populations, and evidence gathered
across that boundary is testing a null that stopped existing.

A rollout that outruns the configured lookback has its window clipped, which weakens the guarantee
from "at most α forever" to "at most α per window". Findings record when that happened rather than
quietly assuming it away.

Two consequences that surprise people in practice, both correct:

- **A killed flag is not scanned at all.** The kill switch is not a rollout, so there is nothing to
  compare. If you are waiting for a finding on a flag you killed, it will never come.
- **Toggling the kill switch starts a new epoch**, because `killSwitchActive` is one of the
  allocation-bearing fields in the epoch fingerprint. Turning a kill switch off therefore discards
  the evidence gathered before it — the traffic that arrived while the flag was killed is not
  comparable to the traffic after, which is the whole point.

### The baseline comes from configuration

The control arm is the heaviest configured weight, and on an even split the flag's off variation —
never the arm that happens to have the most traffic. Choosing the baseline by observed volume makes
the control a function of the same noise being tested.

### Two gates before anything is believed

**Sample ratio mismatch.** If traffic did not arrive in the configured proportions, the randomizer is
broken — a bucketing bug, a sticky cache, an SDK ignoring weights, telemetry loss correlated with the
variant. The arms are then not comparable populations and every rate difference between them is
confounded. The gate suppresses all comparisons for that flag and raises a finding for a human;
there is nothing safe to automate about a broken randomizer. Only rollout-served traffic counts, so
adding a targeting rule does not trip it.

**Multiplicity.** One scan screens every challenger of every rolling-out flag in an environment, on
two metrics. Judging each against a single-hypothesis threshold means the busier the environment, the
more spurious rollbacks. Switchboard applies e-value Benjamini-Hochberg across the environment,
per direction — which controls the false discovery rate under *arbitrary* dependence, and these
hypotheses are certainly dependent: across flags they share metric-event rows, because a metric event
carries no flag key.

The two alphas are asymmetric on purpose. A false rollback reverts to a known-good baseline, is
audited, and is cheap to undo. A false ramp pushes a worse variant onto more traffic and locks in the
next rung of the ladder.

### What it does not promise

FDR control holds **per scan**. Per-hypothesis type-I error is controlled over all time. There is no
construction giving always-valid FDR across unboundedly many scans, and it would be easy — and wrong
— to imply otherwise.

## Configuration

Instance-wide settings live under `switchboard.rollout-monitor` in `application.yml`: the three
alphas (heal, optimize, SRM), the subject floor, the lookback ceiling, the SRM gate and the scan
concurrency. [DEPLOYMENT.md](DEPLOYMENT.md#backend) lists them.

**Which metrics are tested, their direction and their τ are per project**, in metric definitions
(`/api/projects/{projectId}/metrics`), seeded with `error` and `conversion` on every project. The
older `rollout-monitor.metrics.*` and `rollout-monitor.tau.*` keys in `application.yml` are no
longer read; the definitions replaced them.

One caution, and it is counter-intuitive: **the mixture scale τ must be set from what you consider
worth reacting to, never fitted to what the data is doing.** Validity does not depend on it — only
power does — and making it a function of the sample destroys the guarantee silently, while every
number on the screen still looks respectable.

## Stale flags

Swept too: anything parked at 100% or 0% past the org's threshold earns a retirement proposal with a
generated removal checklist.

The sweep can tell you a flag stopped making a decision, but not whether the code still calls it — a
code-references scanner would close that gap and is on the [backlog](REMAINING-WORK.md).
