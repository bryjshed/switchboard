-- SCIM 2.0 user provisioning.
--
-- Two columns on `users`, and the reason there is no `scim_users` table is that a
-- SCIM-provisioned person is not a different kind of person. They sign in through the same
-- OIDC path, hold the same roles, and appear in the same audit trail; all SCIM changes is WHO
-- created the row and whether an IdP is authoritative for it.
--
-- DEACTIVATION IS A COLUMN, NOT A DELETE, and this is the load-bearing decision here. Audit
-- entries record `actor` and change requests record who approved them; deleting the person who
-- did those things would either break the references or, worse, silently orphan the record of
-- who authorised a production change. SCIM's DELETE and its `active: false` PATCH therefore
-- both land here as a timestamp, which is also what SCIM's own spec expects of a service
-- provider that keeps history.

ALTER TABLE users
    -- The IdP's own identifier for this person, echoed back in every SCIM response. Nullable
    -- because users created before SCIM - or created by signing in directly - have none, and a
    -- SCIM integration must not be a precondition for having an account.
    ADD COLUMN scim_external_id TEXT,
    -- NULL means active. A timestamp rather than a boolean so "when did they lose access" is
    -- answerable, which is the first question asked after an incident.
    ADD COLUMN deactivated_at   TIMESTAMPTZ;

-- externalId is unique per IdP, and there is one IdP per deployment here, so a partial unique
-- index is enough. Partial because NULL is the common case and a plain UNIQUE would be a large
-- index of nothing.
CREATE UNIQUE INDEX idx_users_scim_external_id
    ON users (scim_external_id)
    WHERE scim_external_id IS NOT NULL;

-- SCIM lists filter almost exclusively by userName, which is the email here.
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- The audit action vocabulary is a CHECK constraint, so a new action has to be added here or
-- every write carrying it fails with a constraint violation rather than anything that names the
-- real problem. Re-stated in full rather than patched, which is the pattern V2, V3 and V7 all
-- follow: the constraint is then readable in one place instead of assembled from four diffs.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
    'CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'ROLLBACK',
    'AI_APPLY', 'ARCHIVE', 'SEGMENT_CREATE', 'SEGMENT_UPDATE', 'SEGMENT_DELETE',
    'SDK_KEY_CREATE', 'SDK_KEY_REVOKE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'SETTINGS_UPDATE',
    'CHANGE_REQUEST_OPEN', 'CHANGE_REQUEST_APPLY', 'CHANGE_REQUEST_DECLINE',
    'APPROVAL_BYPASS', 'ROLE_GRANT', 'ROLE_REVOKE',
    'PAT_CREATE', 'PAT_REVOKE',
    'SCIM_PROVISION', 'SCIM_ACTIVATE', 'SCIM_DEACTIVATE'));
