# Getting started

From "I have a Switchboard URL" to a flag rolling out in production, with the AI layer watching
it. Every step says where it is in the dashboard and gives the API call that does the same thing.

The examples use `https://switchboard.example.com`; substitute your instance's URL. API calls
authenticate with a **personal access token** (`$SWITCHBOARD_TOKEN`) that you create in
[step 4](#4-get-an-sdk-key-and-a-personal-access-token), except the evaluation calls, which use
an SDK key. New to the vocabulary? [concepts.md](concepts.md) is short.

---

## 0. Get an instance

- **Self-hosting:** follow [self-hosting.md](self-hosting.md), which ends with you signed in as
  the first admin. Then continue at [step 2](#2-create-a-project).
- **Hosted:** your provider gives you a URL and tells you how to sign in. Continue at step 1.

## 1. Sign in, then create or join an organization

Open the URL and sign in. What you see next depends on the instance:

- **Create your organization** — you are allowed to create one: you are the first person on a
  self-hosted instance, or the instance lets anyone create an org. Choose **Create
  organization** and name it; you become its owner.
- **You need an invitation** — someone else administers this instance. Ask an admin to invite
  the email address shown on that screen, then **Reload**.

If you were invited before you signed in, you skip both and land straight in the organization —
provided your email is verified. If your identity provider reports it unverified, the screen also
shows **Verify your email to join organizations you’ve been invited to**. With Firebase sign-in,
choose **Send verification email**, open the link, then **I’ve verified — check again**; with
another provider, verify the address there and sign in again.

Already in an org and need another? Use **New organization…** at the bottom of the organization
switcher at the top of the page. It appears only if the instance lets you create one.

API: `POST /api/orgs` with `{"name": "Acme"}`. `GET /api/users/me` reports `canCreateOrg`, which
is what the dashboard uses to decide which screen to show. (You will not have a token yet on your
very first sign-in, so this step is in practice a dashboard step.)

## 2. Create a project

A project is one product or codebase. Use **New project…** in the project switcher, or
**Create project** on the empty Flags page. Give it a name; the key is derived from it.

You get three environments — `dev`, `staging` and `production` — and the two default metrics,
`error` and `conversion`, without doing anything else. Add more environments later under
**Settings → Environments**.

```bash
curl -X POST https://switchboard.example.com/api/orgs/$ORG_ID/projects \
  -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key": "storefront", "name": "Storefront"}'
```

Creating a project needs the *Manage projects* permission, which owners, admins and members have.

## 3. Create a flag

**Flags → New flag.** Give it a name (the key is derived: `New checkout` → `new-checkout`),
choose **Boolean** or **String (multivariate)**, and create it.

A new flag exists in every environment, **switched off**, serving its off variation to everyone.
Nothing changes for your users until you turn it on somewhere.

```bash
curl -X POST https://switchboard.example.com/api/projects/$PROJECT_ID/flags \
  -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key": "new-checkout", "name": "New checkout", "kind": "BOOLEAN"}'
```

## 4. Get an SDK key and a personal access token

**SDK key** — for your application. **Settings → SDK keys**, pick the environment, **New key**.

- Choose **Server** for backend services. It is a secret: put it in your secret manager.
- Choose **Client-side** only for code that ships to a browser. It sees evaluated values for
  flags you have explicitly made client-side available, and nothing else.

The key (`sb_srv_…` or `sb_cli_…`) is shown **once**. Copy it before closing the dialog; if you
lose it, revoke it and make another.

**Personal access token** — for you, in scripts and CI. **Settings → Tokens → New token**. It acts
as you with exactly your permissions, and is also shown once (`sb_pat_…`).

```bash
curl -X POST https://switchboard.example.com/api/environments/$ENV_ID/sdk-keys \
  -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind": "SERVER", "label": "checkout-service"}'
```

## 5. Evaluate the flag from your code

Pick one. [integrating.md](integrating.md) compares them; the short version is that the SDKs
evaluate in your process with no network call per flag check.

**Java** — build the SDK once ([sdk/java/README.md](../sdk/java/README.md#install)), then:

```java
var switchboard = new SwitchboardClient(
    SwitchboardConfig.builder(System.getenv("SWITCHBOARD_SDK_KEY"))
        .baseUri("https://switchboard.example.com")
        .build());
switchboard.start();

boolean on = switchboard.booleanValue("new-checkout", false,
    EvalContexts.builder(userId).put("plan", "pro").build()).value();
```

**Node.js** — install the SDK ([sdk/typescript/README.md](../sdk/typescript/README.md#install)),
then:

```ts
import { SwitchboardClient } from '@switchboard/openfeature-provider/core';

const switchboard = new SwitchboardClient({
  sdkKey: process.env.SWITCHBOARD_SDK_KEY!,
  baseUrl: 'https://switchboard.example.com',
});
await switchboard.start();

const on = switchboard.booleanValue('new-checkout', { key: userId, attributes: { plan: 'pro' } }, false);
```

**Anything else** — one HTTP call:

```bash
curl -X POST https://switchboard.example.com/api/eval/new-checkout \
  -H "Authorization: Bearer $SWITCHBOARD_SDK_KEY" -H 'Content-Type: application/json' \
  -d '{"context": {"key": "user-42", "attributes": {"plan": "pro"}}, "default": "false"}'
```

The flag is off, so you get `false` with reason `FLAG_OFF`. An unknown flag key is not an error:
you get the default you passed in, at HTTP 200.

## 6. Turn it on and roll it out

Open the flag, pick an environment (start with `dev`), and on the **Targeting** tab:

1. Switch the flag **on**.
2. Under **Default (fallthrough)** — what everyone not matched by a rule gets — choose
   **Percentage rollout** and set, say, `true` 10 / `false` 90.
3. Optionally **Add rule** to target by attribute — `plan IN pro` serves `true` to pro users
   regardless of the percentage.
4. **Save changes.** Connected SDKs pick the change up over their streaming connection
   without a restart.

Every save is a new numbered version on the **History** tab, where any earlier version can be
restored. If something goes wrong in production, **Kill in production** (top of the flag page)
serves the off variation to everyone immediately without touching your targeting.

Widen the rollout by raising the percentage. Subjects already in stay in; a wider rollout only
adds people.

API: `PUT /api/projects/$PROJECT_ID/flags/new-checkout/environments/dev` with the whole config
and the `expectedVersion` you read (a stale version is a 409, not a silent overwrite). Variation
ids come from `GET /api/projects/$PROJECT_ID/flags/new-checkout`.

```json
{
  "enabled": true,
  "expectedVersion": 1,
  "config": {
    "offVariationId": "<false-id>",
    "defaultVariationId": "<false-id>",
    "rules": [],
    "fallthrough": { "rollout": [ { "variationId": "<true-id>", "weight": 10 },
                                  { "variationId": "<false-id>", "weight": 90 } ] }
  }
}
```

Kill switch: `POST …/environments/production/kill-switch` with `{"active": true, "reason": "…"}`.

## 7. Report outcomes

The AI layer can only judge what your application tells it. Report errors and conversions from
the code path the flag controls, using the **same context key you evaluated with**:

```java
switchboard.track("error", userId);          // Java
switchboard.track("conversion", userId);
```

```ts
switchboard.track('error', userId);          // Node.js
switchboard.track('conversion', userId);
```

The SDKs also record which variation each context was served, which is how an outcome is
attributed to a variation. If you evaluate over REST or OFREP instead, post those exposures and
the metrics yourself — see [integrating.md](integrating.md#reporting-outcomes).

`error` and `conversion` are the two metrics
every project starts with; other keys are recorded, and drive healing only once they are
defined for the project (see [integrating.md](integrating.md#which-metrics-drive-healing-and-optimizing)).
Metrics must come from a server key — a client-side key is refused.

## 8. Invite your teammates

**Settings → Organization → Invite.** Enter their email and a role (**Owner** or **Member**), then
send them the URL yourself — Switchboard does not send email; **Copy sign-in link** on the
pending row copies it. If the address already belongs to a verified account, they are added
immediately. Otherwise the invitation waits, listed under **Pending invitations**, and is accepted
the first time they sign in with that email **verified** — an invitation never admits an address
nobody has proved they own. **Revoke** withdraws a pending one.

The invite form appears only if you can manage people. Adding someone by email anywhere else
(`POST /members`, or granting a role by email) is refused with 409 for an unverified account;
invite them instead.

For read-only colleagues, reviewers, or access to one project or environment only, grant a
narrower role under **Settings → Roles & access**. [governance.md](governance.md) has the table.

```bash
curl -X POST https://switchboard.example.com/api/orgs/$ORG_ID/invitations \
  -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"email": "sam@example.com", "role": "MEMBER"}'
```

The response's `status` is `ACCEPTED` if they were added immediately, `PENDING` otherwise.

## 9. Require approval in production

**Settings → Approvals**, choose `production`, switch on **Require approval for targeting changes
and rollbacks**, and set how many approvals are needed.

From then on, saving a flag in production opens a **change request** instead of changing the
flag; reviewers approve it under **Change requests**, and it applies itself when it reaches the
threshold. The kill switch still works immediately unless you also require approval for it. See
[governance.md](governance.md#approvals).

API: `PUT /api/environments/$ENV_ID/approval-settings` with `{"requireApproval": true, "minApprovals": 1}`.

## 10. Let the AI layer heal and optimize

AI features are on by default for a new organization, so with outcomes flowing (step 7) the
rollout monitor is already watching every flag that splits traffic. By default it only
**proposes**: findings appear under **Monitor**, and drafted rollbacks and ramp-ups under
**Proposals**, for a person to apply.

To let it act on its own, go to **Settings → AI** (owners only) and turn on either or both:

- **Roll back a rollout automatically when a variant starts erroring**
- **Ramp up a variant that is winning**

Both apply ordinary, reversible versions and are marked as AI changes in **Activity**.
Natural-language flag creation (**Ask AI** on the Flags page) additionally needs an
`ANTHROPIC_API_KEY` on the server. [ai-layer.md](ai-layer.md#turning-it-on) has the details,
including how much traffic the monitor needs before it will say anything.

## 11. Connect an AI assistant (optional)

The [MCP server](../mcp/README.md) lets Claude and other MCP clients list flags, change
targeting, pull the kill switch and approve change requests — as you, with your permissions,
through a personal access token. Set `SWITCHBOARD_BASE_URL=https://switchboard.example.com` and
`SWITCHBOARD_TOKEN` to a token from step 4.

---

## Where to go next

- [Dashboard guide](dashboard-guide.md) — every page and settings tab.
- [Integrating](integrating.md) — OpenFeature, client-side keys, context rules, gating AI agents.
- [Targeting](targeting.md) — operators, segments, and the one limit worth knowing.
- [Governance](governance.md) — roles, approvals, invitations.
