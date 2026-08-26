-- Signed outbound webhooks.
--
-- Generalises the single unsigned notification URL that lived in app_settings as
-- 'org.<id>.notifications.webhook' and only ever carried rollout-monitor findings. That
-- setting is migrated below rather than abandoned, so an org that configured one keeps
-- receiving the same notifications - now signed, retried and filterable.
--
-- DELIVERIES ARE A TRANSACTIONAL OUTBOX. A row is inserted in the SAME transaction as the
-- flag write that caused it, and delivery is attempted after commit. The alternative -
-- enqueueing after commit - loses events whenever the process dies in the window between,
-- which is precisely when someone most wants to know what changed. The cost is one INSERT
-- per matching webhook inside a flag mutation, which is a human-paced operation.

CREATE TABLE webhooks (
    id             UUID PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    url            TEXT NOT NULL,
    -- The signing secret, stored as issued: HMAC needs the key itself, so unlike an SDK key
    -- or a PAT this genuinely cannot be a one-way hash. It is returned once, at creation.
    secret         TEXT NOT NULL,
    description    TEXT,
    -- Empty means every event type. Filtering by resource is what keeps a Slack relay for
    -- one project from receiving every other project's traffic.
    event_types    TEXT[] NOT NULL DEFAULT '{}',
    project_id     UUID REFERENCES projects (id) ON DELETE CASCADE,
    environment_id UUID REFERENCES environments (id) ON DELETE CASCADE,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     TEXT
);

CREATE INDEX idx_webhooks_org ON webhooks (org_id);
-- The lookup on every flag mutation: enabled hooks for one org.
CREATE INDEX idx_webhooks_org_enabled ON webhooks (org_id) WHERE enabled;

CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY,
    webhook_id      UUID NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
    -- Shared by every delivery fanned out from one change, so a receiver can dedupe across
    -- retries AND across webhooks pointed at the same consumer.
    event_id        UUID NOT NULL,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    attempts        INT NOT NULL DEFAULT 0,
    response_status INT,
    error           TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at    TIMESTAMPTZ
);

-- The retry sweep's only query: due, still pending, oldest first. Partial so the index stays
-- small as delivered rows accumulate.
CREATE INDEX idx_webhook_deliveries_due
    ON webhook_deliveries (next_attempt_at)
    WHERE status = 'PENDING';
CREATE INDEX idx_webhook_deliveries_hook
    ON webhook_deliveries (webhook_id, created_at DESC);

-- Carry forward any org that had configured the old unsigned notification URL. A generated
-- secret means existing receivers start getting a signature header they were not previously
-- sent; that is additive - an unverified receiver ignores it - and the alternative is
-- silently dropping notifications an org already relies on.
-- The secret is two gen_random_uuid() values with the dashes stripped: 64 hex characters,
-- ~244 bits. NOT gen_random_bytes(), which lives in the pgcrypto extension and would make
-- this migration fail on any database that has not installed it - gen_random_uuid() is core
-- from Postgres 13 and is CSPRNG-backed, so this is both strong and dependency-free.
INSERT INTO webhooks (id, org_id, url, secret, description, event_types, enabled, created_by)
SELECT gen_random_uuid(),
       (regexp_match(key, '^org\.([0-9a-f-]{36})\.notifications\.webhook$'))[1]::uuid,
       value,
       'whsec_' || replace(gen_random_uuid()::text, '-', '')
                || replace(gen_random_uuid()::text, '-', ''),
       'Migrated from the pre-V8 notification setting',
       ARRAY['rollout.finding'],
       TRUE,
       'migration:V8'
FROM app_settings
WHERE key ~ '^org\.[0-9a-f-]{36}\.notifications\.webhook$'
  AND value IS NOT NULL
  AND value <> ''
  AND EXISTS (
      SELECT 1 FROM orgs o
      WHERE o.id = (regexp_match(key, '^org\.([0-9a-f-]{36})\.notifications\.webhook$'))[1]::uuid
  );
