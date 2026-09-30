# Self-hosting Switchboard

The first thing to read if your company is running Switchboard itself. It takes you from an
empty server to a working instance with your identity provider, your first admin and your team
signed in. After that, [getting-started.md](getting-started.md) is the same for everyone.

[DEPLOYMENT.md](DEPLOYMENT.md) is the operator reference behind this page: every configuration
variable, the management port, migrations, retention, backups and scaling past one node.

---

## What you need

- **A Linux host with Docker and Docker Compose v2.** The bundled stack is Postgres, the backend
  and the dashboard, as three containers on one host.
- **A clone of this repository on that host.** Images are not published to a registry yet, so
  Compose builds them from source on the first `up`.
- **A hostname and TLS**, e.g. `https://switchboard.example.com`, terminated by a reverse proxy
  you already run or by the one in [step 5](#5-put-it-behind-your-public-url).
- **An identity provider.** Any OIDC provider — Okta, Entra ID, Auth0, Keycloak, Google, Cognito —
  or a Firebase project. Switchboard never stores passwords; it verifies tokens your provider
  issues.

## 1. Get the source

```bash
git clone <your-fork-or-mirror-of-switchboard> switchboard
cd switchboard
cp .env.prod.example .env
```

Everything below edits `.env`. It is gitignored.

## 2. Choose an identity provider

Pick one before the first build. The dashboard **compiles in** one sign-in implementation,
chosen by `VITE_AUTH_PROVIDER` at build time; switching later means rebuilding the dashboard
image, not restarting it.

### Option A: OIDC (Okta, Entra ID, Auth0, Keycloak, Google, Cognito)

The usual choice for a company, because your people already have accounts there.

1. In your IdP, create a **single-page application** using the authorization code flow with
   PKCE. There is no client secret.
   - Sign-in redirect URIs: `https://switchboard.example.com/auth/callback` **and**
     `https://switchboard.example.com/auth/silent-callback`
   - Sign-out redirect URI: `https://switchboard.example.com/login`
   - Allowed origin: `https://switchboard.example.com`
   - Scopes: `openid profile email`
2. If your IdP issues access tokens for an API audience (Okta, Auth0 and Cognito do), give it
   one, e.g. `switchboard-api`. Otherwise leave the audience out on **both** sides below.
3. Tell the dashboard, in `.env`:

   ```dotenv
   VITE_AUTH_PROVIDER=oidc
   OIDC_AUTHORITY=https://acme.okta.com/oauth2/default   # exactly the token's `iss`
   OIDC_CLIENT_ID=0oa1b2c3d4EXAMPLE
   OIDC_AUDIENCE=switchboard-api                         # omit if you skipped step 2
   ```

4. Tell the backend. Identity providers are structured configuration, so they arrive as
   `SPRING_APPLICATION_JSON`, which the compose file passes to the backend. Add it to `.env` on
   one line:

   ```dotenv
   SPRING_APPLICATION_JSON='{"switchboard":{"auth":{"providers":[{"id":"corp-sso","type":"oidc","issuer":"https://acme.okta.com/oauth2/default","audience":"switchboard-api"}]}}}'
   ```

   The `issuer` must be byte-identical to `OIDC_AUTHORITY` and to the `iss` claim in the
   token (Auth0's ends in a slash). Set `audience` on both sides or neither: one side only is
   the mistake that produces a 401 with nothing wrong in the logs. The per-IdP issuer and
   audience values are in the [backend README](../backend/README.md#pointing-it-at-auth0-okta-entra-id-keycloak-or-cognito);
   if your IdP puts the email somewhere other than `email`, set `email-claim` too.

### Option B: Firebase Authentication

1. Create a Firebase project and enable **Email/Password** sign-in.
2. Copy its web app config into `.env`:

   ```dotenv
   VITE_AUTH_PROVIDER=firebase
   FIREBASE_PROJECT_ID=acme-switchboard
   FIREBASE_API_KEY=AIza...
   FIREBASE_AUTH_DOMAIN=acme-switchboard.firebaseapp.com
   FIREBASE_APP_ID=1:1234:web:abcd
   ```

3. Create each person's account in the Firebase console (**Authentication → Users**). The
   dashboard signs people in; it does not sign them up.

**Email verification matters here.** Switchboard lets someone into an organization by email only
once their address is verified (see [step 8](#8-invite-your-team)). Firebase email/password
accounts start unverified, including ones you create in the console. Either tick *email
verified* when you create the account, or let the person verify it themselves: after signing in,
the dashboard offers **Send verification email**, then **I’ve verified — check again**. OIDC
providers normally assert verified addresses already, which is one more reason to prefer them.

Never set `FIREBASE_AUTH_EMULATOR_HOST` on a deployment. It exists for the local emulator, and
in production it would verify real people's tokens against something that is not Google.

## 3. Fill in the rest of `.env`

```dotenv
POSTGRES_PASSWORD=<a long random string>          # required; there is no default on purpose
PUBLIC_API_BASE_URL=https://switchboard.example.com
SWITCHBOARD_ORG_CREATION=bootstrap                # the default; see "Org creation" below
BACKEND_PORT=127.0.0.1:28080                      # publish on loopback only; the proxy fronts it
DASHBOARD_PORT=127.0.0.1:8080
JOB_TOKEN=<another long random string>            # for the maintenance jobs in step 6
```


**`PUBLIC_API_BASE_URL` is resolved by your users' browsers**, not by the dashboard container, so
it must be the public URL — never `http://backend:28080`. Getting this wrong is the most common
first-deploy failure, and it looks like "the dashboard loads but nothing works".

The remaining variables — `ANTHROPIC_API_KEY`, rate limits, event and audit retention — have working defaults and are explained in [DEPLOYMENT.md](DEPLOYMENT.md#configuration).

## 4. Start it

```bash
docker compose -f docker-compose.prod.yml up --build -d --wait
```

The first build compiles the backend and the
dashboard and takes a few minutes. The backend creates the database schema on boot, so the first
`up` on an empty volume is a complete install. `--wait` returns once all three containers report
healthy.

## 5. Put it behind your public URL

The dashboard and the API are two containers on two ports. Serve both from one hostname by
routing the API's paths to the backend and everything else to the dashboard:

| Path | Goes to |
|---|---|
| `/api/*`, `/ofrep/*`, `/scim/*` | backend, `127.0.0.1:28080` |
| everything else | dashboard, `127.0.0.1:8080` |

With [Caddy](https://caddyserver.com), which also obtains the certificate:

```caddyfile
switchboard.example.com {
    @api path /api/* /ofrep/* /scim/*
    reverse_proxy @api 127.0.0.1:28080
    reverse_proxy 127.0.0.1:8080
}
```

With nginx, the one setting that matters is on the API location: `proxy_buffering off;`. SDKs
hold a server-sent-events stream open at `/api/stream` and `/ofrep/v1/stream`, and a buffering
proxy delays every flag change until the buffer fills. The server sends a keep-alive every 15
seconds, so any read timeout above that is fine.

Do not route the management port (28081). Health and metrics live there, unauthenticated by
design; it is for probes and scrapers inside the network. See
[DEPLOYMENT.md](DEPLOYMENT.md#the-management-port).

Check it:

```bash
curl -fsS https://switchboard.example.com/config.js     # shows your API URL and auth settings
docker compose -f docker-compose.prod.yml exec -T backend \
  curl -fsS http://localhost:28081/actuator/health/readiness
```

## 6. Schedule the maintenance jobs

The rollout scan and webhook retries run inside the backend on their own. Three other jobs run
only when called: creating next months' event partitions and expiring old ones, sweeping for
stale flags, and (if you set a window) expiring old audit entries. Add them to the host's crontab:

```cron
15 3 * * *  curl -fsS -X POST -H "X-Job-Token: <JOB_TOKEN>" http://127.0.0.1:28080/api/jobs/partition-roll
30 3 * * *  curl -fsS -X POST -H "X-Job-Token: <JOB_TOKEN>" http://127.0.0.1:28080/api/jobs/stale-flag-scan
45 3 * * *  curl -fsS -X POST -H "X-Job-Token: <JOB_TOKEN>" http://127.0.0.1:28080/api/jobs/audit-retention
```

Skip this and nothing breaks at first — events land in a catch-all partition — but old events are
never expired and stale flags are never reported. [DEPLOYMENT.md](DEPLOYMENT.md#scheduled-jobs)
has the details.

## 7. The first admin signs in and creates the organization

1. Open `https://switchboard.example.com` and sign in with your IdP.
2. Switchboard creates your user on first sign-in. Because nobody has created an organization
   yet, you see **Create your organization**. Choose **Create organization** and name it.
3. You are its **owner**, and it has no projects yet. Continue with
   [getting-started.md, step 2](getting-started.md#2-create-a-project).

Under `bootstrap` mode that screen appears only for the first person. Everyone after them sees
**You need an invitation**, which names the email they signed in with and asks them to have an
admin invite it, with a **Reload** button for afterwards.

## 8. Invite your team

1. **Settings → Organization → Invite.** Enter a teammate's email and choose **Owner** or
   **Member**.
2. Send them the dashboard URL yourself. Switchboard does not send email.
3. When they sign in with that email **and it is verified**, they land in the organization with
   that role. If they already have a verified account, they are added immediately.

An invitation is accepted only for a verified address: one the identity provider asserts as
verified, or an account SCIM created. Otherwise anyone who could register the address with your
IdP without proving they own the mailbox could let themselves into your org. With OIDC this is
usually invisible. With Firebase, see [the note in step 2](#option-b-firebase-authentication):
an unverified person sees **Verify your email to join organizations you’ve been invited to** on
their first sign-in, and the invitation is accepted as soon as they verify and choose **I’ve
verified — check again**.

Pending invitations are listed on the same tab, where you can revoke one or copy the sign-in
link (the instance's sign-in page). Finer-grained roles (read-only, approver, per-environment access) are granted under
**Settings → Roles & access**; [governance.md](governance.md) has the table.

**SCIM (optional).** If your IdP provisions users by SCIM 2.0, point it at
`https://switchboard.example.com/scim/v2/orgs/<orgId>` with a personal access token from an
account holding *Manage people and roles*. It provisions and deactivates users (with the `MEMBER`
role); anything finer is assigned in Switchboard. A provisioned address that already has a
*verified* Switchboard account is adopted; otherwise SCIM creates a new account, which the person
lands in at their first verified sign-in. Your org id is in the `memberships` of `GET /api/users/me`. The
reasoning, including why there is no `/Groups`, is in
[DECISIONS.md](DECISIONS.md#scim-provisioning).

## 9. Build the SDKs for your developers

The SDKs are not on Maven Central or npm yet. Build them once from this repository and publish
them to your internal artifact repository, so your application teams install them the ordinary
way.

**Java** (needs JDK 25 to build, and your applications must run on Java 25 or newer):

```bash
./mvnw -pl evaluation,sdk/java -am install -DskipTests
# then, to your internal repository (both artifacts: the SDK depends on switchboard-evaluation):
./mvnw -pl evaluation,sdk/java deploy -DskipTests \
  -DaltDeploymentRepository=internal::https://maven.example.com/repository/releases
```

Neither pom declares a deployment repository, so name one on the command line as `id::url`; the
`id` matches a `<server>` in your `~/.m2/settings.xml` that holds the credentials.

**TypeScript / Node.js:**

```bash
cd sdk/typescript
npm ci && npm run build && npm pack          # -> switchboard-openfeature-provider-0.1.0.tgz
npm publish --registry https://npm.example.com/   # or keep the .tgz and install it by path
```

Details, including installing without an internal registry, are in each SDK's README:
[Java](../sdk/java/README.md#install), [TypeScript](../sdk/typescript/README.md#install).

## 10. Point your applications at the instance

Every SDK defaults to `http://localhost:28080`, which is the development stack. Set the base URL
to your public URL:

```java
SwitchboardConfig.builder(sdkKey).baseUri("https://switchboard.example.com").build()
```

```ts
new SwitchboardProvider({ sdkKey, baseUrl: 'https://switchboard.example.com' })
```

The OFREP providers and plain HTTP clients use the same origin. Keys come from
**Settings → SDK keys**; [integrating.md](integrating.md) covers the rest.

## Org creation: `open` or `bootstrap`

`SWITCHBOARD_ORG_CREATION` decides who may create an organization.

| Mode | Who can create an org | Use it when |
|---|---|---|
| `bootstrap` | Only the first person to try, while no org exists. Everyone else joins by invitation. | One company runs the instance. This is the default in `docker-compose.prod.yml`. |
| `open` | Any signed-in user, any number of times. | The instance is multi-tenant — a hosted service, or an internal platform where each team runs its own org. This is the default everywhere else, including the development stack. |

Under `bootstrap`, anyone else who tries is refused with *"Organization creation is disabled on
this instance; ask an admin for an invitation."* A second org can still be made: switch the
variable to `open`, create it, and switch back. Existing orgs are never affected by the setting.
Any value other than `open` or `bootstrap` stops the backend from starting, rather than guessing.

## Keeping it running

- **Upgrades:** `git pull`, then the same `up --build` command. Migrations run on boot. Take a
  backup first.
- **Backups:** everything is in Postgres; see [DEPLOYMENT.md](DEPLOYMENT.md#backups).
- **Retention:** event data is dropped by month after `EVENT_RETENTION_MONTHS` (default 3); the
  audit log is kept forever unless you set `AUDIT_RETENTION_MONTHS`. See
  [DEPLOYMENT.md](DEPLOYMENT.md#retention).
- **More than one backend instance:** read
  [DEPLOYMENT.md](DEPLOYMENT.md#scaling-past-one-node) first. The bundled compose file is
  deliberately single-node.
