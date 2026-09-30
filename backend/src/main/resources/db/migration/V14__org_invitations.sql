-- Pending org invitations.
--
-- Before this, adding a member required the person to have signed in at least once, because
-- membership points at a users row and there was nothing to point at yet. An invitation is the
-- row that exists in the meantime: it names an email and a role, and the invitee's first sign-in
-- with a verified email turns it into a membership (UserService -> InvitationService).
--
-- An invitation is never deleted. Accepting or revoking stamps a timestamp, so the table doubles
-- as the record of who was let in and by whom, alongside the audit trail.
CREATE TABLE org_invitations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES orgs (id),
    -- Stored lowercased; matching at sign-in is by lower(email), and the CHECK keeps a caller
    -- from ever writing a row that the pending-by-email lookup could not find.
    email            TEXT NOT NULL CHECK (email = lower(email) AND email <> ''),
    role             VARCHAR(16) NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
    invited_by       TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at      TIMESTAMPTZ,
    accepted_user_id UUID REFERENCES users (id),
    revoked_at       TIMESTAMPTZ,
    CHECK (accepted_at IS NULL OR revoked_at IS NULL),
    CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
);

-- At most one PENDING invitation per (org, email): a second invite is a 409, not a duplicate.
CREATE UNIQUE INDEX uq_org_invitations_pending
    ON org_invitations (org_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The sign-in hook looks up pending invitations by email across every org.
CREATE INDEX idx_org_invitations_pending_email
    ON org_invitations (email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Whether an identity's provider has ever vouched for the email of the account it is linked to.
--
-- Recorded because "a users row with this email exists" is not proof that the person behind it
-- owns the address: Firebase email/password sign-up (and any IdP that lets users type an email)
-- creates an account for victim@corp.com without proving anything. Before this, inviting or
-- adding victim@corp.com handed the org to whoever had signed up first. Now an existing account
-- is added on the spot only when it is verified; otherwise the invitation stays pending until a
-- verified token for the address turns up (UserService / GET /api/users/me).
--
-- Set at link time from the token, and UPGRADED (never downgraded) when /users/me later sees a
-- verified token for the same identity - the identity cache means a returning user never passes
-- the link path again, so first-seen alone would leave early sign-ups unverified forever.
ALTER TABLE user_identities ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;

-- Dev tokens exist only on the local profile and are treated as vouched for everywhere else
-- (UserService.mayLinkByEmail), so their identities are verified. Every other existing identity
-- starts false and is upgraded the next time it presents a verified token.
UPDATE user_identities SET email_verified = true WHERE issuer = 'switchboard:dev';

-- A user row SCIM created. The customer's IdP pushed this address as one of its people, which is
-- exactly the assertion email verification stands in for, so such an account counts as verified
-- although it may have no identity at all yet. Set only when SCIM CREATES the row: SCIM adopting
-- an account that already existed says nothing about who created that account.
ALTER TABLE users ADD COLUMN scim_provisioned BOOLEAN NOT NULL DEFAULT false;

-- Backfill, conservatively: only rows that no identity has ever signed into AND that SCIM touched
-- (an externalId, or a SCIM_PROVISION audit entry naming the address - its reason is
-- 'provisioned <email>'). SCIM can also adopt a pre-existing account, and an adopted account
-- somebody already signed into must not become verified by association. SCIM-created rows that
-- have since been signed into are left false; their identities upgrade on the next verified token.
UPDATE users u SET scim_provisioned = true
WHERE NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)
  AND (u.scim_external_id IS NOT NULL
       OR lower(u.email) IN (
           SELECT lower(substring(a.reason FROM 13)) FROM audit_entries a
           WHERE a.action = 'SCIM_PROVISION' AND a.reason LIKE 'provisioned %'));

-- Invitations are membership changes and belong in the audit trail. This restates V13's list
-- (the latest definition) with the three invitation actions appended.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;
ALTER TABLE audit_entries ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
    'CREATE', 'UPDATE', 'KILL_SWITCH_ON', 'KILL_SWITCH_OFF', 'ROLLBACK',
    'AI_APPLY', 'ARCHIVE', 'SEGMENT_CREATE', 'SEGMENT_UPDATE', 'SEGMENT_DELETE',
    'SDK_KEY_CREATE', 'SDK_KEY_REVOKE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'SETTINGS_UPDATE',
    'CHANGE_REQUEST_OPEN', 'CHANGE_REQUEST_APPLY', 'CHANGE_REQUEST_DECLINE',
    'APPROVAL_BYPASS', 'ROLE_GRANT', 'ROLE_REVOKE',
    'PAT_CREATE', 'PAT_REVOKE',
    'SCIM_PROVISION', 'SCIM_ACTIVATE', 'SCIM_DEACTIVATE',
    'ENVIRONMENT_CREATE', 'ENVIRONMENT_RENAME', 'ENVIRONMENT_ARCHIVE', 'ENVIRONMENT_RESTORE',
    'INVITE_CREATE', 'INVITE_REVOKE', 'INVITE_ACCEPT'));
