import { WebStorageStateStore, type UserManagerSettings, type User } from 'oidc-client-ts'
import type { OidcAuthConfig } from '../config'

/**
 * `UserManagerSettings` for an `OidcAuthConfig`.
 *
 * Split out from the provider so the live check script can build a `UserManager` over exactly
 * the settings the dashboard uses — same storage keys, same authority, same client id — rather
 * than a hand-copied approximation that could drift.
 */
export function oidcSettings(config: OidcAuthConfig, store: Storage): UserManagerSettings {
  return {
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    silent_redirect_uri: config.silentRedirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,

    // Authorization code + PKCE. oidc-client-ts derives the verifier/challenge itself for the
    // code flow; there is no implicit-flow option here on purpose, and no client secret, because
    // a browser SPA is a public client and cannot keep one.
    response_type: 'code',
    scope: config.scope,

    // Keep the access token fresh in the background rather than surprising someone mid-edit.
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 60,

    // Session monitoring needs a third-party-cookie iframe against the IdP, which modern
    // browsers block anyway. Sign-out is driven by this app, not by polling the IdP.
    monitorSession: false,

    userStore: new WebStorageStateStore({ store, prefix: 'switchboard.oidc.' }),
    stateStore: new WebStorageStateStore({ store, prefix: 'switchboard.oidc.state.' }),

    // Auth0 (and Cognito) want the API audience as an authorization-request parameter; without
    // it they mint an opaque access token that no resource server can verify.
    ...(config.audience ? { extraQueryParams: { audience: config.audience } } : {}),
  }
}

/**
 * Which token goes to Switchboard as the bearer.
 *
 * When an audience is configured the IdP has been asked for a resource-scoped **access token**
 * carrying `aud: <audience>`, and that is what the backend's `audience` validator checks. With
 * no audience the deployment is running the plain-OIDC shape where the **id token** is the only
 * JWT the client is given, and the backend is configured without an audience to match.
 */
export function tokenFor(user: Pick<User, 'access_token' | 'id_token'>, config: OidcAuthConfig): string | null {
  return (config.audience ? user.access_token : user.id_token) ?? null
}
