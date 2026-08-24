-- Switchboard baseline schema.
-- Conventions: UUID PKs via gen_random_uuid(), TIMESTAMPTZ, enums as VARCHAR + CHECK.

-- ============================== Identity & topology ==============================

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firebase_uid  TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL,
    display_name  TEXT,
    onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_email ON users (email);

CREATE TABLE orgs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org_memberships (
    org_id     UUID NOT NULL REFERENCES orgs (id),
    user_id    UUID NOT NULL REFERENCES users (id),
    role       VARCHAR(16) NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_org_memberships_user ON org_memberships (user_id);

CREATE TABLE projects (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES orgs (id),
    key        TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, key)
);

CREATE TABLE environments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects (id),
    key           TEXT NOT NULL,
    name          TEXT NOT NULL,
    -- Monotonic change cursor: bumped on every flag-config write in this environment.
    -- Serves as the SSE Last-Event-ID and the bootstrap ETag.
    state_version BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, key)
);

CREATE TABLE sdk_keys (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id UUID NOT NULL REFERENCES environments (id),
    key_prefix     TEXT NOT NULL,
    key_hash       TEXT NOT NULL UNIQUE,
    label          TEXT,
    created_by     TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at     TIMESTAMPTZ
);
CREATE INDEX idx_sdk_keys_env_active ON sdk_keys (environment_id) WHERE revoked_at IS NULL;

-- ============================== Flags ==============================

CREATE TABLE flags (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects (id),
    key         TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    kind        VARCHAR(16) NOT NULL CHECK (kind IN ('BOOLEAN', 'STRING')),
    -- [{"id": "<uuid>", "value": "...", "name": "..."}]; boolean flags: exactly true/false.
    variations  JSONB NOT NULL,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_flags_project_key_active ON flags (project_id, key) WHERE archived_at IS NULL;
CREATE INDEX idx_flags_project ON flags (project_id);

-- Head row: the mutable current targeting state per flag x environment.
-- This is the FOR UPDATE lock target for every config mutation.
CREATE TABLE flag_env_configs (
    flag_id            UUID NOT NULL REFERENCES flags (id),
    environment_id     UUID NOT NULL REFERENCES environments (id),
    enabled            BOOLEAN NOT NULL DEFAULT FALSE,
    kill_switch_active BOOLEAN NOT NULL DEFAULT FALSE,
    -- {individualTargets, rules, fallthrough, offVariationId, defaultVariationId}
    config             JSONB NOT NULL,
    version            INT NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by         TEXT NOT NULL,
    PRIMARY KEY (flag_id, environment_id)
);

-- Immutable version snapshots (append-only). Rollback writes a NEW version.
CREATE TABLE flag_env_config_versions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flag_id                  UUID NOT NULL REFERENCES flags (id),
    environment_id           UUID NOT NULL REFERENCES environments (id),
    version_number           INT NOT NULL,
    enabled                  BOOLEAN NOT NULL,
    kill_switch_active       BOOLEAN NOT NULL,
    config                   JSONB NOT NULL,
    version_note             TEXT,
    created_by               TEXT NOT NULL,
    created_from_proposal_id UUID,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (flag_id, environment_id, version_number)
);
-- Hard backstop against double-applying an AI proposal.
CREATE UNIQUE INDEX uq_flag_versions_proposal ON flag_env_config_versions (created_from_proposal_id)
    WHERE created_from_proposal_id IS NOT NULL;
CREATE INDEX idx_flag_versions_lookup ON flag_env_config_versions (flag_id, environment_id, version_number DESC);

CREATE TABLE segments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects (id),
    key           TEXT NOT NULL,
    name          TEXT NOT NULL,
    included_keys TEXT[] NOT NULL DEFAULT '{}',
    excluded_keys TEXT[] NOT NULL DEFAULT '{}',
    rules         JSONB NOT NULL DEFAULT '[]',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, key)
);

-- ============================== Audit ==============================

CREATE TABLE audit_entries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL,
    project_id     UUID,
    environment_id UUID,
    flag_key       TEXT,
    action         VARCHAR(32) NOT NULL CHECK (action IN (
        'CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'ROLLBACK',
        'AI_APPLY', 'ARCHIVE', 'SEGMENT_CREATE', 'SEGMENT_UPDATE', 'SEGMENT_DELETE',
        'SDK_KEY_CREATE', 'SDK_KEY_REVOKE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'SETTINGS_UPDATE')),
    actor          TEXT NOT NULL,
    reason         TEXT,
    version_from   INT,
    version_to     INT,
    diff           JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_project_time ON audit_entries (project_id, created_at DESC);
CREATE INDEX idx_audit_org_time ON audit_entries (org_id, created_at DESC);
CREATE INDEX idx_audit_flag ON audit_entries (flag_key, environment_id, created_at DESC);

-- ============================== Event ingestion (partitioned) ==============================

CREATE TABLE eval_events (
    environment_id UUID NOT NULL,
    flag_key       TEXT NOT NULL,
    context_key    TEXT NOT NULL,
    variation_id   UUID,
    reason         VARCHAR(16) NOT NULL,
    occurred_at    TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (occurred_at);

CREATE TABLE metric_events (
    environment_id UUID NOT NULL,
    context_key    TEXT NOT NULL,
    metric_key     TEXT NOT NULL,
    value          NUMERIC NOT NULL DEFAULT 1,
    occurred_at    TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (occurred_at);

-- Monthly partitions: 4 months back through 12 months ahead, UTC-pinned bounds,
-- plus DEFAULT catch-alls so out-of-range events are never lost.
DO $$
DECLARE
    m DATE;
    part_name TEXT;
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['eval_events', 'metric_events'] LOOP
        m := date_trunc('month', now() AT TIME ZONE 'UTC')::date - INTERVAL '4 months';
        WHILE m < date_trunc('month', now() AT TIME ZONE 'UTC')::date + INTERVAL '12 months' LOOP
            part_name := tbl || '_' || to_char(m, 'YYYY_MM');
            BEGIN
                EXECUTE format(
                    'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                    part_name, tbl,
                    (m::timestamptz AT TIME ZONE 'UTC'),
                    ((m + INTERVAL '1 month')::timestamptz AT TIME ZONE 'UTC'));
            EXCEPTION WHEN duplicate_table OR invalid_object_definition THEN
                NULL;
            END;
            m := (m + INTERVAL '1 month')::date;
        END LOOP;
        BEGIN
            EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', tbl || '_default', tbl);
        EXCEPTION WHEN duplicate_table OR invalid_object_definition THEN
            NULL;
        END;
    END LOOP;
END $$;

CREATE INDEX idx_eval_events_lookup ON eval_events (environment_id, flag_key, occurred_at);
CREATE INDEX idx_eval_events_brin ON eval_events USING brin (occurred_at);
CREATE INDEX idx_metric_events_lookup ON metric_events (environment_id, metric_key, occurred_at);
CREATE INDEX idx_metric_events_brin ON metric_events USING brin (occurred_at);

-- ============================== AI ==============================

CREATE TABLE ai_proposals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES orgs (id),
    project_id      UUID NOT NULL REFERENCES projects (id),
    environment_id  UUID REFERENCES environments (id),
    kind            VARCHAR(16) NOT NULL CHECK (kind IN ('FLAG_CREATE', 'FLAG_UPDATE', 'ROLLBACK', 'RETIREMENT')),
    source_prompt   TEXT,
    diff            JSONB NOT NULL,
    rationale       TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPLIED', 'REJECTED', 'EXPIRED')),
    created_by      TEXT NOT NULL,
    applied_by      TEXT,
    applied_version INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_proposals_project ON ai_proposals (project_id, status, created_at DESC);

CREATE TABLE anomaly_findings (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id        UUID NOT NULL REFERENCES environments (id),
    flag_key              TEXT NOT NULL,
    variation_id          UUID,
    metric_key            TEXT NOT NULL,
    baseline_rate         NUMERIC NOT NULL,
    variant_rate          NUMERIC NOT NULL,
    z_score               NUMERIC NOT NULL,
    summary               TEXT,
    status                VARCHAR(24) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKED', 'AUTO_ROLLED_BACK')),
    suggested_proposal_id UUID REFERENCES ai_proposals (id),
    -- envId:flagKey:variationId:metric:windowStart -- makes the sweep idempotent.
    dedupe_key            TEXT NOT NULL UNIQUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_anomaly_env_status ON anomaly_findings (environment_id, status, created_at DESC);

-- Per-AI-function model config (mirror of nexus ai_function_configs, simplified).
CREATE TABLE ai_function_configs (
    function_key VARCHAR(32) PRIMARY KEY,
    model_id     TEXT NOT NULL,
    temperature  NUMERIC NOT NULL DEFAULT 1.0,
    max_tokens   INT NOT NULL DEFAULT 4096,
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   TEXT NOT NULL DEFAULT 'system'
);

INSERT INTO ai_function_configs (function_key, model_id, temperature, max_tokens) VALUES
    ('nl_flag_ops',     'claude-sonnet-5', 0.2, 4096),
    ('rollout_monitor', 'claude-sonnet-5', 0.2, 2048),
    ('stale_sweep',     'claude-sonnet-5', 0.4, 2048);

-- ============================== Runtime settings (nexus V154 shape) ==============================

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    encrypted  BOOLEAN NOT NULL DEFAULT FALSE,
    category   TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT NOT NULL
);

-- Audit deliberately carries no value column (values may be secrets).
CREATE TABLE app_settings_audit (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key          TEXT NOT NULL,
    action       VARCHAR(16) NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
    performed_by TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
