-- User-defined metrics for the rollout monitor.
--
-- Until now the monitor knew exactly two metric keys, 'error' and 'conversion', named in
-- configuration and hard-coded into the aggregation as two pivoted columns. That made the
-- healing/optimizing loop useless for anything a team actually measures - latency, refunds,
-- support contacts, tokens spent - and it is the prerequisite for everything in the
-- experimentation section of the backlog.
--
-- WHAT A METRIC HAS TO DECLARE, and why each field is not optional:
--
--   direction  Which way is GOOD. Without it the monitor cannot tell a regression from an
--              improvement, which is the entire decision it makes. 'error' decreases-is-better,
--              'conversion' increases-is-better.
--   tau        The absolute proportion difference worth reacting to, per metric. It was two
--              global constants; a 1% shift means something different for an error rate than
--              for a refund rate. DECISIONS.md is emphatic that tau is configuration and must
--              NEVER be fitted to observed data - doing so destroys the supermartingale
--              property that makes repeated looks safe.

CREATE TABLE metric_definitions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- Matches metric_events.metric_key. Not a foreign key: events arrive from SDKs before
    -- anyone defines a metric, and refusing telemetry for an undefined key would lose data
    -- that becomes meaningful the moment someone defines it.
    key         TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    direction   VARCHAR(24) NOT NULL
        CHECK (direction IN ('INCREASE_IS_BETTER', 'DECREASE_IS_BETTER')),
    -- Absolute proportion difference. Bounded because a tau outside (0,1) is not a proportion
    -- difference at all, and a zero would make every difference "worth reacting to".
    tau         DOUBLE PRECISION NOT NULL CHECK (tau > 0 AND tau < 1),
    -- Whether the monitor may heal or ramp on this metric, as opposed to only reporting it.
    -- A team measuring something noisy wants to see it without it moving traffic.
    auto_act    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, key)
);

CREATE INDEX idx_metric_definitions_project ON metric_definitions (project_id);

-- Every existing project gets the two built-ins, with the direction and tau the hard-coded
-- versions used (switchboard.rollout-monitor.tau.error=0.01, tau.conversion=0.02). Behaviour
-- for an existing deployment is therefore unchanged on the metrics it already had, and the
-- monitor has something to read on day one rather than silently doing nothing.
INSERT INTO metric_definitions (project_id, key, name, description, direction, tau)
SELECT p.id, 'error', 'Errors',
       'Subjects that hit at least one error. Seeded when metric definitions were introduced.',
       'DECREASE_IS_BETTER', 0.01
FROM projects p;

INSERT INTO metric_definitions (project_id, key, name, description, direction, tau)
SELECT p.id, 'conversion', 'Conversions',
       'Subjects that converted at least once. Seeded when metric definitions were introduced.',
       'INCREASE_IS_BETTER', 0.02
FROM projects p;
