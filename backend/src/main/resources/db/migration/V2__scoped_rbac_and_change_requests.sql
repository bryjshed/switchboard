-- Scoped RBAC (roles, permissions, scoped assignments) and approval workflows
-- (change requests + reviews).
--
-- Two deliberate choices are encoded here.
--
-- 1. Roles are DATA, permissions are CODE. A permission is a capability the Java
--    code checks by name, so it ships with a release. A role is a named bundle of
--    permissions, so it is a row: adding "release manager" is an INSERT, not a
--    deploy. role_permissions.permission therefore carries no CHECK constraint -
--    a name the running binary does not know is ignored by the resolver rather
--    than breaking the query, which keeps rollbacks safe.
--
-- 2. Effective permissions UNION across scopes (see AccessRepository). A grant at
--    a narrower scope adds capability; it never takes any away.

-- ============================== Roles & permissions ==============================

CREATE TABLE roles (
    key         VARCHAR(32) PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    built_in    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
    role_key   VARCHAR(32) NOT NULL REFERENCES roles (key) ON DELETE CASCADE,
    permission VARCHAR(32) NOT NULL,
    PRIMARY KEY (role_key, permission)
);

INSERT INTO roles (key, name, description, built_in) VALUES
    ('OWNER',      'Owner',      'Full control, including org settings and billing.', TRUE),
    ('ADMIN',      'Admin',      'Everything an owner can do except org settings.', TRUE),
    ('MEMBER',     'Member',     'The pre-RBAC org member: full flag control, no member, key or settings management.', TRUE),
    ('MAINTAINER', 'Maintainer', 'Flag write, kill switch and rollback. No member or key management.', TRUE),
    ('WRITER',     'Writer',     'Proposes and writes flag changes. Cannot approve its own or anyone else''s.', TRUE),
    ('APPROVER',   'Approver',   'Reads everything and approves change requests. Writes nothing directly.', TRUE),
    ('VIEWER',     'Viewer',     'Read-only.', TRUE);

INSERT INTO role_permissions (role_key, permission) VALUES
    -- OWNER: every permission the binary knows about.
    ('OWNER', 'FLAG_READ'), ('OWNER', 'FLAG_WRITE'), ('OWNER', 'FLAG_KILL'), ('OWNER', 'FLAG_ROLLBACK'),
    ('OWNER', 'SEGMENT_WRITE'), ('OWNER', 'APPROVE_CHANGES'), ('OWNER', 'MANAGE_MEMBERS'),
    ('OWNER', 'MANAGE_SDK_KEYS'), ('OWNER', 'MANAGE_SETTINGS'), ('OWNER', 'MANAGE_PROJECTS'),
    ('OWNER', 'MANAGE_ENVIRONMENTS'), ('OWNER', 'VIEW_AUDIT'),
    -- ADMIN: OWNER minus MANAGE_SETTINGS (org-wide settings stay with the owner).
    ('ADMIN', 'FLAG_READ'), ('ADMIN', 'FLAG_WRITE'), ('ADMIN', 'FLAG_KILL'), ('ADMIN', 'FLAG_ROLLBACK'),
    ('ADMIN', 'SEGMENT_WRITE'), ('ADMIN', 'APPROVE_CHANGES'), ('ADMIN', 'MANAGE_MEMBERS'),
    ('ADMIN', 'MANAGE_SDK_KEYS'), ('ADMIN', 'MANAGE_PROJECTS'), ('ADMIN', 'MANAGE_ENVIRONMENTS'),
    ('ADMIN', 'VIEW_AUDIT'),
    -- MEMBER: exactly what org_memberships.role = 'MEMBER' could do before this
    -- migration - flags, segments, project create/rename, audit. Nothing more.
    -- Changing this row changes the meaning of every legacy membership.
    ('MEMBER', 'FLAG_READ'), ('MEMBER', 'FLAG_WRITE'), ('MEMBER', 'FLAG_KILL'), ('MEMBER', 'FLAG_ROLLBACK'),
    ('MEMBER', 'SEGMENT_WRITE'), ('MEMBER', 'MANAGE_PROJECTS'), ('MEMBER', 'VIEW_AUDIT'),
    -- MAINTAINER: MEMBER without project management.
    ('MAINTAINER', 'FLAG_READ'), ('MAINTAINER', 'FLAG_WRITE'), ('MAINTAINER', 'FLAG_KILL'),
    ('MAINTAINER', 'FLAG_ROLLBACK'), ('MAINTAINER', 'SEGMENT_WRITE'), ('MAINTAINER', 'VIEW_AUDIT'),
    -- WRITER: edits targeting, but cannot pull the emergency stop, roll back, or approve.
    ('WRITER', 'FLAG_READ'), ('WRITER', 'FLAG_WRITE'), ('WRITER', 'SEGMENT_WRITE'), ('WRITER', 'VIEW_AUDIT'),
    -- APPROVER: reviews, never writes.
    ('APPROVER', 'FLAG_READ'), ('APPROVER', 'APPROVE_CHANGES'), ('APPROVER', 'VIEW_AUDIT'),
    ('VIEWER', 'FLAG_READ'), ('VIEWER', 'VIEW_AUDIT');

-- A user holds at most one role per scope. Scope ids are polymorphic (org,
-- project, or environment id), so there is no FK - the resolver joins through
-- the topology instead, which also means a deleted scope simply stops matching.
CREATE TABLE role_assignments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users (id),
    scope_type VARCHAR(16) NOT NULL CHECK (scope_type IN ('ORG', 'PROJECT', 'ENVIRONMENT')),
    scope_id   UUID NOT NULL,
    role_key   VARCHAR(32) NOT NULL REFERENCES roles (key),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL,
    UNIQUE (user_id, scope_type, scope_id)
);
CREATE INDEX idx_role_assignments_scope ON role_assignments (scope_type, scope_id);
CREATE INDEX idx_role_assignments_user ON role_assignments (user_id);

-- Backwards compatibility: every existing org membership becomes an ORG-scope
-- assignment of the same-named role. OWNER -> OWNER, MEMBER -> MEMBER, and the
-- MEMBER role above is defined to be exactly today's member. Nothing anyone
-- could do yesterday changes today.
INSERT INTO role_assignments (user_id, scope_type, scope_id, role_key, created_by)
SELECT user_id, 'ORG', org_id, role, 'migration:V2'
FROM org_memberships
ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING;

-- ============================== Approval settings ==============================

-- Per-environment and not a side table: there is exactly one row per environment,
-- it is read on every flag write (the write path already loads the environment
-- row, so this costs no extra query), and it has no lifecycle of its own. A
-- settings table would add a nullable join plus a "row missing" case forever.
--
-- Everything defaults OFF. Turning production on is a deliberate act, so no
-- existing environment, test, or client changes behaviour when this migration runs.
ALTER TABLE environments
    ADD COLUMN require_approval          BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN min_approvals             INT     NOT NULL DEFAULT 1,
    ADD COLUMN allow_self_approval       BOOLEAN NOT NULL DEFAULT FALSE,
    -- The kill switch is an emergency stop. It bypasses approval by default,
    -- because a review queue in front of "turn it off now" is a liability.
    ADD COLUMN require_approval_for_kill BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT ck_environments_min_approvals CHECK (min_approvals BETWEEN 1 AND 10);

-- ============================== Change requests ==============================

CREATE TABLE change_requests (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES orgs (id),
    project_id           UUID NOT NULL REFERENCES projects (id),
    environment_id       UUID NOT NULL REFERENCES environments (id),
    flag_id              UUID NOT NULL REFERENCES flags (id),
    flag_key             TEXT NOT NULL,
    kind                 VARCHAR(24) NOT NULL
        CHECK (kind IN ('TARGETING_UPDATE', 'KILL_SWITCH', 'ROLLBACK')),
    -- The FlagTargetingService call the request stands for, by kind:
    --   TARGETING_UPDATE {"enabled": bool, "config": {...}}
    --   KILL_SWITCH      {"active": bool}
    --   ROLLBACK         {"toVersion": int}
    payload              JSONB NOT NULL,
    -- The head version the author edited against; the staleness check compares it
    -- to the head at apply time, exactly like expectedVersion on a direct write.
    base_version         INT NOT NULL,
    -- Snapshotted from the environment at creation so that retuning the policy
    -- mid-flight cannot silently change the bar for an open request.
    min_approvals        INT NOT NULL,
    allow_self_approval  BOOLEAN NOT NULL,
    status               VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'APPLIED', 'WITHDRAWN', 'STALE')),
    requested_by_user_id UUID NOT NULL REFERENCES users (id),
    requested_by         TEXT NOT NULL,
    comment              TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at           TIMESTAMPTZ,
    applied_version      INT
);
CREATE INDEX idx_change_requests_project ON change_requests (project_id, created_at DESC, id DESC);
CREATE INDEX idx_change_requests_env ON change_requests (environment_id, status, created_at DESC);
CREATE INDEX idx_change_requests_flag ON change_requests (flag_id, status, created_at DESC);

-- One row per reviewer per request: a reviewer who changes their mind updates
-- their row, so a single human can never count twice toward the threshold.
CREATE TABLE change_request_reviews (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_request_id UUID NOT NULL REFERENCES change_requests (id) ON DELETE CASCADE,
    reviewer_user_id  UUID NOT NULL REFERENCES users (id),
    reviewer          TEXT NOT NULL,
    decision          VARCHAR(8) NOT NULL CHECK (decision IN ('APPROVE', 'DECLINE')),
    comment           TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (change_request_id, reviewer_user_id)
);

-- The same backstop the AI proposals use: a change request may stamp exactly one
-- version snapshot, so two racing applies cannot both write a version even if
-- both somehow got past the status compare-and-set.
ALTER TABLE flag_env_config_versions ADD COLUMN created_from_change_request_id UUID;
CREATE UNIQUE INDEX uq_flag_versions_change_request
    ON flag_env_config_versions (created_from_change_request_id)
    WHERE created_from_change_request_id IS NOT NULL;

-- ============================== Audit vocabulary ==============================

ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
    'CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'ROLLBACK',
    'AI_APPLY', 'ARCHIVE', 'SEGMENT_CREATE', 'SEGMENT_UPDATE', 'SEGMENT_DELETE',
    'SDK_KEY_CREATE', 'SDK_KEY_REVOKE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'SETTINGS_UPDATE',
    'CHANGE_REQUEST_OPEN', 'CHANGE_REQUEST_APPLY', 'CHANGE_REQUEST_DECLINE',
    'ROLE_GRANT', 'ROLE_REVOKE'));
