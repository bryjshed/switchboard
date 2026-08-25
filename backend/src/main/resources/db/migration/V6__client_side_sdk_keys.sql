-- Client-side SDK keys.
--
-- Until now there was exactly one kind of SDK key, and it carried the full rule set plus every
-- segment's raw includedKeys to whoever held it. That is fine for a server-side key held in an
-- environment variable and completely wrong for a key shipped inside a browser bundle: it hands
-- out the entire targeting configuration and every cohort's membership list, which is usually
-- user ids or email addresses.
--
-- Splitting the kinds is what makes an evaluated (rather than rule-set) payload expressible.

ALTER TABLE sdk_keys
    -- MOBILE is reserved but not yet mintable: there is no mobile SDK to hold one. It earns its
    -- own kind for one real reason -- rotation latency. A browser key is re-served on every page
    -- load, so revoking it costs a refresh; a mobile key is compiled into a shipped binary, and
    -- revoking it locks out every installed version until users update. That belongs in the
    -- revocation UX and the audit trail, not in the capability model: a browser key and a mobile
    -- key are both public and both get exactly the same reduced surface.
    ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'SERVER'
        CHECK (kind IN ('SERVER', 'CLIENT', 'MOBILE'));

-- Backfill is the DEFAULT: every existing row was minted as sb_srv_, so SERVER is correct for all
-- of them with no data migration. The default stays in place afterwards - it makes the insert path
-- forgiving and can never be the wrong answer for a legacy caller.

-- Per-flag exposure, on `flags` rather than on `flag_env_configs`, and that placement is
-- load-bearing rather than a coin flip.
--
-- flag_env_configs is the head row that every mutation locks FOR UPDATE and snapshots into
-- flag_env_config_versions. Putting exposure there would mean toggling it creates a config
-- version, enters the approval queue, and -- worst -- GETS SILENTLY REVERTED BY A TARGETING
-- ROLLBACK. Someone rolls back a bad rule from 3pm and unpublishes a flag from every browser as a
-- side effect. On `flags` it travels the ordinary updateFlag path beside name/description/tags,
-- which is the right neighbourhood: whether a flag's existence is a secret is a property of the
-- flag, not of one environment's targeting.
--
-- DEFAULT FALSE fails closed. Defaulting true would publish every existing flag to the public
-- internet the instant somebody mints a client key.
ALTER TABLE flags
    ADD COLUMN client_side_available BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial: the client bootstrap only ever asks for the available ones.
CREATE INDEX idx_flags_client_side ON flags (project_id) WHERE client_side_available;
