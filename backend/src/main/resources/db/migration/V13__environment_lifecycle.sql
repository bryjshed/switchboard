-- Environments can be renamed and archived.
--
-- Until now an environment could only be created, which meant one made by mistake was permanent
-- and appeared in every picker and on every flag detail page forever.
--
-- ARCHIVED, NOT DELETED, and the reason is in the foreign keys. Eight tables reference
-- environments: sdk_keys, flag_env_configs, flag_env_config_versions, ai_proposals,
-- anomaly_findings, change_requests, rollout_epoch_evidence and webhooks. Two of those -
-- flag_env_config_versions and the audit trail beside it - are the immutable history the whole
-- product rests on ("rollback writes a NEW version; history is never rewritten"). A hard delete
-- would either destroy that history or leave it orphaned, so there is no hard delete. Archiving
-- is reversible; deleting the evidence of what an environment served would not be.
--
-- The key stays UNIQUE (project_id, key) INCLUDING archived rows. An archived environment still
-- owns its history, so its key stays reserved: creating `staging-eu` while an archived
-- `staging-eu` exists is a 409 that says so, rather than silently splitting that key's past
-- across two rows.

ALTER TABLE environments
    ADD COLUMN archived_at TIMESTAMPTZ;

COMMENT ON COLUMN environments.archived_at IS
    'Set when the environment is archived: hidden from pickers and frozen against ordinary '
    'config writes. It KEEPS SERVING EVALUATIONS - SDK keys pointed at it still work - because '
    'tidying the dashboard must not take an environment down. The kill switch stays available '
    'for exactly that reason.';

-- Environment lifecycle is a structural change and belongs in the audit trail. Creating one was
-- not audited at all before this, which is its own small gap: an environment could appear in a
-- workspace with no record of who added it.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
    'CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'ROLLBACK',
    'AI_APPLY', 'ARCHIVE', 'SEGMENT_CREATE', 'SEGMENT_UPDATE', 'SEGMENT_DELETE',
    'SDK_KEY_CREATE', 'SDK_KEY_REVOKE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'SETTINGS_UPDATE',
    'CHANGE_REQUEST_OPEN', 'CHANGE_REQUEST_APPLY', 'CHANGE_REQUEST_DECLINE',
    'APPROVAL_BYPASS', 'ROLE_GRANT', 'ROLE_REVOKE',
    'PAT_CREATE', 'PAT_REVOKE',
    'SCIM_PROVISION', 'SCIM_ACTIVATE', 'SCIM_DEACTIVATE',
    'ENVIRONMENT_CREATE', 'ENVIRONMENT_RENAME', 'ENVIRONMENT_ARCHIVE', 'ENVIRONMENT_RESTORE'));
