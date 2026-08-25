-- Anytime-valid rollout monitoring.
--
-- The monitor used to run a fixed-horizon two-proportion z-test on a rolling 48h window,
-- hourly. Three things about that are wrong and this migration supports fixing all of them:
--
--   1. A fixed-horizon statistic evaluated repeatedly inflates its false-positive rate
--      without bound. The replacement is a mixture SPRT whose e-value is a supermartingale
--      under the null, so Ville's inequality holds however often it is inspected.
--   2. That guarantee needs a FILTRATION - an increasing sequence of information. A rolling
--      window is not one: observations leave and n can shrink, and the statistic resets its
--      own information content every 48 hours. The evidence window must therefore run from a
--      fixed origin, and the right origin is the last change to traffic allocation.
--   3. The dedupe key ended in floor(windowStart / 1 hour), and windowStart was now - 48h,
--      so the key CHANGED EVERY HOUR. One incident could file up to 48 findings. Findings
--      now key on the epoch instead; nothing here enforces that, but the new column is what
--      makes it expressible.

-- ---------------------------------------------------------------- allocation epoch

-- Which parts of a config actually move traffic between variations.
--
-- Deliberately EXCLUDES offVariationId, defaultVariationId, rule descriptions and flag
-- metadata: changing those does not reallocate anyone, and resetting the evidence for them
-- would throw away accumulated power for nothing. Deliberately INCLUDES individualTargets,
-- which errs broad - editing a target list resets the epoch. Over-resetting costs power and
-- stays valid; under-resetting is invalid, so the asymmetry is on purpose.
--
-- IMMUTABLE so it can be indexed later if the run-length scan ever needs it.
CREATE FUNCTION rollout_allocation_fingerprint(
    p_enabled BOOLEAN,
    p_kill BOOLEAN,
    p_config JSONB
) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_array(
        p_enabled,
        p_kill,
        p_config -> 'fallthrough',
        COALESCE((
            SELECT jsonb_agg(r -> 'serve' ORDER BY ord)
            FROM jsonb_array_elements(COALESCE(p_config -> 'rules', '[]'::jsonb))
                 WITH ORDINALITY AS t(r, ord)
        ), '[]'::jsonb),
        COALESCE(p_config -> 'individualTargets', '[]'::jsonb)
    )
$$;

-- ---------------------------------------------------------------- findings

ALTER TABLE anomaly_findings
    -- SRM findings are not degradations and must not be rendered as one.
    ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'DEGRADATION'
        CHECK (kind IN ('DEGRADATION', 'IMPROVEMENT', 'SRM')),
    ADD COLUMN test_kind VARCHAR(32) NOT NULL DEFAULT 'TWO_PROPORTION_Z'
        CHECK (test_kind IN ('TWO_PROPORTION_Z', 'MSPRT_GAUSSIAN_MIXTURE', 'DIRICHLET_MULTINOMIAL')),
    -- Stored in logs: a genuine effect overflows a double long before the comparison happens.
    ADD COLUMN log_e_value DOUBLE PRECISION,
    -- Always-valid: min(1, 1 / sup E) over every look in the epoch, not the latest look.
    ADD COLUMN p_value DOUBLE PRECISION,
    -- The e-BH threshold actually applied, which depends on how many hypotheses were screened
    -- alongside this one. Without it a reviewer cannot reconstruct why this finding survived.
    ADD COLUMN alpha DOUBLE PRECISION,
    ADD COLUMN family_size INT,
    ADD COLUMN family_rank INT,
    ADD COLUMN srm_p_value DOUBLE PRECISION,
    ADD COLUMN tau DOUBLE PRECISION,
    ADD COLUMN epoch_started_at TIMESTAMPTZ,
    -- True when max-lookback clipped the epoch. The guarantee then weakens honestly from
    -- "<= alpha forever" to "<= alpha per lookback window", and that must be visible in the
    -- data rather than assumed away.
    ADD COLUMN window_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    -- Subject counts, not event counts. See VariantAggregate for why the distinction is the
    -- larger of the two defects being fixed here.
    ADD COLUMN variant_subjects BIGINT,
    ADD COLUMN variant_hits BIGINT,
    ADD COLUMN baseline_subjects BIGINT,
    ADD COLUMN baseline_hits BIGINT,
    -- Pinned from configuration rather than picked as the arm with the most traffic, which
    -- made the control a function of the same noise being tested.
    ADD COLUMN baseline_variation_id UUID;

-- An SRM finding has no z-score, and a misleading 0.00 in the UI is worse than an absent
-- value. z_score itself stays: it is required in AnomalyFindingResponse, the dashboard
-- renders it, and it remains a useful DESCRIPTIVE effect size. It just no longer decides.
ALTER TABLE anomaly_findings ALTER COLUMN z_score DROP NOT NULL;

-- ---------------------------------------------------------------- e-process state

-- The running supremum of each hypothesis's e-process within one epoch.
--
-- This is what makes p* = min(1, 1/sup E) monotone. Reading the LATEST e-value instead would
-- let an acknowledged finding quietly un-justify itself as evidence ebbed, which is not what
-- a p-value means and would be confusing in exactly the situation where clarity matters.
CREATE TABLE rollout_epoch_evidence (
    environment_id        UUID        NOT NULL REFERENCES environments (id),
    flag_key              TEXT        NOT NULL,
    epoch_started_at      TIMESTAMPTZ NOT NULL,
    metric_key            TEXT        NOT NULL,
    variation_id          UUID        NOT NULL,
    baseline_variation_id UUID        NOT NULL,
    max_log_e             DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_log_e            DOUBLE PRECISION NOT NULL DEFAULT 0,
    tau                   DOUBLE PRECISION NOT NULL,
    observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (environment_id, flag_key, epoch_started_at, metric_key, variation_id)
);

-- Rows accumulate one per hypothesis per epoch forever otherwise; the partition-maintenance
-- job prunes them.
CREATE INDEX idx_epoch_evidence_gc ON rollout_epoch_evidence (observed_at);
