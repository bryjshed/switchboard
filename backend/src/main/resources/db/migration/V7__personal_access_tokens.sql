-- Personal access tokens: non-interactive authentication for the management API.
--
-- Until now there were exactly three ways to authenticate, and none of them worked for a script:
-- a user bearer token (expires, and is obtained interactively), an SDK key (evaluation surface
-- only, and names an environment rather than a person), or the X-Job-Token shared secret (one
-- secret for the whole deployment, scoped to /api/jobs). So there was no way for an MCP server, a
-- CLI, or CI to act as a particular person with that person's permissions.
--
-- Storage deliberately mirrors sdk_keys: a display prefix, a SHA-256 of the full token, and
-- revoked_at. Same shape, same operational habits, one fewer thing to reason about.

CREATE TABLE personal_access_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users (id),
    -- What it is for, in the owner's words. Not optional: an unlabelled token is one nobody dares
    -- revoke later, because nobody remembers what would break.
    name         TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    -- Null means no expiry. Allowed, because a CI token that expires unattended at 3am is its own
    -- kind of outage, but the UI pushes towards setting one.
    expires_at   TIMESTAMPTZ,
    -- Advisory only, and updated off the request path: it exists so an operator can tell which
    -- tokens are dead weight before revoking them.
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ
);

-- The management surface: "my tokens", newest first, including revoked ones so a revocation is
-- visible rather than a disappearance.
CREATE INDEX idx_pat_user ON personal_access_tokens (user_id, created_at DESC);

-- A token authenticates AS ITS OWNER and inherits their permissions unchanged. There is no scope
-- column on purpose: a second, parallel authorization model is a second place for a permission bug
-- to hide, and the RBAC that already exists is the one that gets exercised on every request. If
-- narrower tokens are ever wanted, the honest way is to grant the token a role assignment of its
-- own rather than to invent a competing scope vocabulary here.

-- Widen the audit action set, exactly as V2 and V3 did. The list is restated in full rather than
-- appended to, because a CHECK constraint has no ALTER ... ADD VALUE.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
    'CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'ROLLBACK',
    'AI_APPLY', 'ARCHIVE', 'SEGMENT_CREATE', 'SEGMENT_UPDATE', 'SEGMENT_DELETE',
    'SDK_KEY_CREATE', 'SDK_KEY_REVOKE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'SETTINGS_UPDATE',
    'CHANGE_REQUEST_OPEN', 'CHANGE_REQUEST_APPLY', 'CHANGE_REQUEST_DECLINE',
    'APPROVAL_BYPASS', 'ROLE_GRANT', 'ROLE_REVOKE',
    'PAT_CREATE', 'PAT_REVOKE'));
