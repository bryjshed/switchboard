-- Epoch evidence is keyed per DIRECTION as well as per metric.
--
-- THE BUG THIS FIXES, which V10 exposed rather than caused:
--
-- rollout_epoch_evidence accumulates a running supremum of the e-value per hypothesis, and its
-- key was (environment, flag, epoch, metric_key, variation). That was sufficient only because
-- the monitor tested exactly two hard-coded metrics in exactly one direction each - 'error'
-- could only ever be a degradation and 'conversion' could only ever be an improvement - so the
-- metric key uniquely determined the direction.
--
-- Once a metric declares its own direction and BOTH questions are asked of it, the degradation
-- and improvement hypotheses for one metric collide on this key. They then share a supremum:
-- the improvement hypothesis reads back the evidence accumulated by the degradation, concludes
-- it has crossed the threshold, and recommends RAMPING a variation that is in fact broken -
-- reported with an always-valid p-value and an e-BH family size, which is what makes it
-- dangerous rather than merely wrong.
--
-- Caught by RolloutScanIT, which asserts a rescan is a no-op and instead saw a second finding.

ALTER TABLE rollout_epoch_evidence
    ADD COLUMN direction VARCHAR(16);

-- Existing rows carry an implied direction, because only two metrics could ever have produced
-- them. Backfilling from the metric key preserves every accumulated supremum rather than
-- resetting the martingales, which would restart evidence gathering for every live rollout.
UPDATE rollout_epoch_evidence
SET direction = CASE WHEN metric_key = 'conversion' THEN 'IMPROVEMENT' ELSE 'DEGRADATION' END
WHERE direction IS NULL;

ALTER TABLE rollout_epoch_evidence
    ALTER COLUMN direction SET NOT NULL,
    ADD CONSTRAINT rollout_epoch_evidence_direction_check
        CHECK (direction IN ('DEGRADATION', 'IMPROVEMENT'));

ALTER TABLE rollout_epoch_evidence
    DROP CONSTRAINT rollout_epoch_evidence_pkey;
ALTER TABLE rollout_epoch_evidence
    ADD PRIMARY KEY (environment_id, flag_key, epoch_started_at, metric_key, variation_id, direction);
