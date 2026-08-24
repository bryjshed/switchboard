-- Route AI proposal applies through the same approval gate as human writes, and
-- decide what an AUTOMATED write does when that gate is on.
--
-- The hole this closes: ProposalService called FlagTargetingService directly, so
-- applying an AI proposal - including the ones the rollout monitor auto-applies -
-- wrote straight into an environment whose require_approval was on. An org that
-- turned approvals on for production still had an unreviewed write path into
-- production.
--
-- ============================== The automation decision ==============================
--
-- allow_automation_bypass DEFAULTS TO TRUE, and that default is deliberate.
--
-- Only automation (the rollout monitor's auto-rollback / auto-optimize) can use
-- it; a human applying a proposal from the dashboard is gated exactly like a hand
-- edit and this column does nothing for them. It is also meaningless unless
-- require_approval is on.
--
-- Defaulting to bypass mirrors the kill-switch precedent one column over
-- (require_approval_for_kill): an automated healing rollback fires DURING an
-- error spike, and a rollback that waits for a reviewer at 3am is not healing.
-- The action is also inherently safe - it reverts traffic to the baseline
-- variation that was already live and already known good - so the blast radius of
-- letting it through is bounded by "the flag goes back to how it was".
--
-- The trade is real and it is an org's to make: with this on, an environment with
-- require_approval = TRUE still has one write path that no human reviewed. Set it
-- to FALSE and automated rollbacks park in the review queue like everything else,
-- at the cost of an incident that heals only as fast as somebody clicks approve.
--
-- Either way the write is fully audited: a bypassed write records an
-- APPROVAL_BYPASS entry naming the automation as the actor, ON TOP OF the usual
-- AI_APPLY version entry, so "show me every write that skipped review" is one
-- query.
ALTER TABLE environments
    ADD COLUMN allow_automation_bypass BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN environments.allow_automation_bypass IS
    'When require_approval is on, automated rollout healing/optimization still writes '
    'immediately instead of opening a change request. Default TRUE: a healing rollback '
    'that waits for a reviewer during an error spike is not healing. Bypassed writes are '
    'audited as APPROVAL_BYPASS. Has no effect on human writes or human proposal applies.';

-- ============================== Proposal provenance ==============================

-- The change request a parked AI proposal opened. Nullable because the ordinary
-- human write path opens change requests with no proposal behind them.
--
-- This is what lets the review UI say "an AI proposal caused this" and what keeps
-- the provenance in the audit trail after the request applies: the version
-- snapshot a change request writes is stamped with created_from_change_request_id,
-- and this column is the second hop from there back to the proposal.
ALTER TABLE change_requests
    ADD COLUMN ai_proposal_id UUID REFERENCES ai_proposals (id);

CREATE INDEX idx_change_requests_proposal
    ON change_requests (ai_proposal_id, created_at DESC)
    WHERE ai_proposal_id IS NOT NULL;

-- The same partial-unique-index backstop the proposal and change-request applies
-- already use. A proposal stays DRAFT while its change requests are under review,
-- so nothing in the status machine stops a second apply from opening a second
-- queue entry for the same write. One OPEN (PENDING or APPROVED) request per
-- proposal per environment per kind is the invariant, enforced by the database so
-- it survives two instances racing.
CREATE UNIQUE INDEX uq_change_requests_open_per_proposal
    ON change_requests (ai_proposal_id, environment_id, kind)
    WHERE ai_proposal_id IS NOT NULL AND status IN ('PENDING', 'APPROVED');

-- ============================== Audit vocabulary ==============================

-- APPROVAL_BYPASS: a write that the environment's policy would have sent to
-- review, allowed through because the actor was automation and
-- allow_automation_bypass was on. It is written IN ADDITION to the normal write
-- entry so that the bypass is greppable on its own.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
    'CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'ROLLBACK',
    'AI_APPLY', 'ARCHIVE', 'SEGMENT_CREATE', 'SEGMENT_UPDATE', 'SEGMENT_DELETE',
    'SDK_KEY_CREATE', 'SDK_KEY_REVOKE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'SETTINGS_UPDATE',
    'CHANGE_REQUEST_OPEN', 'CHANGE_REQUEST_APPLY', 'CHANGE_REQUEST_DECLINE',
    'APPROVAL_BYPASS', 'ROLE_GRANT', 'ROLE_REVOKE'));
