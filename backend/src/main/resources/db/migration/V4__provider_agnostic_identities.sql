-- Identity moves out of the users table and away from any one vendor.
--
-- Before this migration a user WAS a Firebase uid: users.firebase_uid was NOT NULL UNIQUE, and
-- the dev-token path smuggled its own convention ('dev:<email>') through the same column. That
-- made the schema, and therefore the domain model above it, unable to describe a person who
-- signs in through Okta, Auth0, Entra ID, Keycloak, Cognito or plain Google.
--
-- After it, an identity is (issuer, subject) - an OIDC 'iss' and 'sub' - and the relationship to
-- a user is MANY-TO-ONE. That is the point of the table rather than an accident of normalising:
--   * an org migrating IdPs keeps one user, gaining a second linked identity;
--   * a person can hold a Google identity and a corporate SSO identity at the same time;
--   * the local dev token is just another issuer instead of a special case in a NOT NULL column.
--
-- Breaking change, deliberately: firebase_uid is dropped rather than kept in sync. Nothing is
-- deployed, and leaving it would leave the vendor name in the schema, which is the defect.

CREATE TABLE user_identities (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id   UUID NOT NULL REFERENCES users (id),
    issuer    TEXT NOT NULL,
    subject   TEXT NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One provider identity belongs to exactly one user; one user may hold many.
    UNIQUE (issuer, subject)
);
CREATE INDEX idx_user_identities_user ON user_identities (user_id);

-- Carry every existing uid across, splitting the two conventions the old column carried.
--
-- 'dev:<email>' rows were provisioned by the local dev token, never by Google: they become the
-- Switchboard-issued 'switchboard:dev' issuer with the email as subject, which is exactly what
-- DevTokenIdentityProvider now emits.
--
-- Everything else is a real Firebase uid, and Firebase's issuer is
-- https://securetoken.google.com/<projectId>. The project id is not knowable from SQL, so it
-- arrives as the Flyway placeholder ${firebase_issuer}, defaulted in application.yml from
-- FIREBASE_PROJECT_ID. Point a deployment at a different Firebase project and that deployment's
-- migration writes that project's issuer.
INSERT INTO user_identities (user_id, issuer, subject, linked_at)
SELECT id,
       CASE WHEN firebase_uid LIKE 'dev:%' THEN 'switchboard:dev' ELSE '${firebase_issuer}' END,
       CASE WHEN firebase_uid LIKE 'dev:%' THEN substring(firebase_uid FROM 5) ELSE firebase_uid END,
       created_at
FROM users;

ALTER TABLE users DROP COLUMN firebase_uid;
