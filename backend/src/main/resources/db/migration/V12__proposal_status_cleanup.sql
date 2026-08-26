-- Removes a status nothing has ever written.
--
-- ai_proposals.status has allowed 'EXPIRED' since V1 and no code path sets it: proposals do not
-- expire, they are applied, rejected, or left in DRAFT indefinitely. A value in an enum that
-- nothing produces is worse than no value at all - every reader has to decide whether to handle
-- it, every client switch needs a branch for it, and the honest answer ("it cannot happen") is
-- not discoverable from the schema.
--
-- Safe to remove precisely because nothing produced it: there is no row to migrate. The DELETE
-- guard below is belt-and-braces for a database that somehow acquired one by hand, and would
-- fail loudly rather than silently dropping the constraint on bad data.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM ai_proposals WHERE status = 'EXPIRED') THEN
        RAISE EXCEPTION 'ai_proposals still contains EXPIRED rows; migrate them before V12';
    END IF;
END $$;

ALTER TABLE ai_proposals DROP CONSTRAINT IF EXISTS ai_proposals_status_check;
ALTER TABLE ai_proposals ADD CONSTRAINT ai_proposals_status_check
    CHECK (status IN ('DRAFT', 'APPLIED', 'REJECTED'));
