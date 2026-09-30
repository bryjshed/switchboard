# Dashboard guide

What each page of the dashboard is for and how to do the common things on it. Pages follow the
left-hand navigation; settings follow the tabs on the Settings page.

Two things apply everywhere:

- **The header picks where you are.** The organization, project and environment switchers at
  the top decide what every page shows. **New organization…** and **New project…** at the
  bottom of the first two create one.
- **Controls you cannot use stay visible.** If your role lacks a permission, the button is
  disabled and its tooltip says which capability you need and who to ask, rather than the
  control disappearing.

Links are shareable: filters and tabs live in the address bar, so "the production history of
`new-checkout`" is a URL you can paste.

---

## First run

If you belong to no organization yet, the dashboard shows one screen instead of the pages
below:

- **Create your organization**, when this instance lets you create one. **Create organization**
  asks for a name, and you are its owner. Below it, "Joining a team instead?" names the email an
  admin should invite.
- **You need an invitation**, when it does not. It names the email you signed in with; have an
  admin invite it, then **Reload**.

If your identity provider reports that email as unverified, the screen adds **Verify your email
to join organizations you’ve been invited to**, because invitations are accepted only for a
verified address. With Firebase sign-in it offers **Send verification email**, and the reload
button becomes **I’ve verified — check again**, which refreshes your token and accepts any pending
invitation. With another provider it asks you to verify the address there and sign in again.

## Deliver

### Flags

Every flag in the current project, with its state in each environment and when it last changed.
Search by key or name; click a tag to filter by it.

- **New flag** — name, key (derived from the name until you edit it), description, type
  (**Boolean** or **String (multivariate)**), tags, and for string flags the variations. A new
  flag is off in every environment.
- **Ask AI** — describe a change in words ("release new-checkout to 10% of iOS users on pro") and
  review the drafted diff before anything is applied. Needs an `ANTHROPIC_API_KEY` on the server;
  without one the dialog says so and everything else keeps working.
- **Create project** — shown when the project has no flags yet.

### A flag

Pick the environment in the header; the page shows that environment's configuration. The kill
switch sits at the top: **Kill in production** serves the off variation to everyone in that
environment at once, and **Clear kill switch** restores what was there.

- **Targeting** — the flag's on/off switch for this environment, individual targets
  (**Add target**), rules (**Add rule**, **Add clause (AND)**, reorder with the arrows, negate a
  clause with **not**), and **Default (fallthrough)**, each serving one variation or a
  **Percentage rollout**. **Save changes** writes a new version; in an environment that requires
  approval the button reads **Submit for review** and opens a change request instead. If someone
  else saved while you were editing, you are shown the conflict rather than overwriting them.
- **Monitor** — per-variation traffic, error rate and conversion rate for this flag, the
  monitor's findings about it, and any proposal it has drafted (**Review proposal**).
- **History** — every version in this environment, who made it and why. Restoring an earlier
  version writes it again as a new version; nothing is erased.
- **Settings** — name, description, tags, adding variations, **available to client-side SDKs**,
  and **Archive flag**.

### Segments

Reusable audiences for the current project: included keys, excluded keys, and rules. **New
segment**, then reference it from any flag's rules with `SEGMENT_MATCH`. Editing a segment
changes every flag that uses it.

## Observe

### Monitor

What the AI layer is watching in the current environment: rollouts in flight with their
per-variation rates, findings it has raised (a variation erroring, traffic arriving in the wrong
proportions, a variation converting better), and anything it has already done. Choose the time
window at the top right. Acknowledge a finding once someone has looked at it; **Open flag** and
**Review proposal** take you to the flag and the drafted fix.

A rollout appears here only once it is splitting traffic, and the monitor stays quiet until each
variation has enough distinct subjects to judge — see
[ai-layer.md](ai-layer.md#turning-it-on).

### Change requests

Writes waiting for review in environments that require approval, and their outcomes. Nothing
listed here has changed a flag unless it says **Applied**. Filter by environment and status.

On a request: **Approve** or **Decline** if you are a reviewer, **Withdraw** if it is yours.
Approving your own request is refused unless the environment allows self-approval. A request
applies itself when it reaches its approval threshold; one whose flag changed underneath it goes
**Stale** and has to be resubmitted.

### Proposals

Every change the AI layer has drafted: rollbacks and ramp-ups from the monitor, retirement
proposals for stale flags, and what you asked for through **Ask AI**. Each shows the diff.
**Apply** writes it through the normal versioned path (or opens a change request, in a gated
environment); **Reject** leaves the flag untouched.

### Activity

The audit log for the organization, newest first: every change to every flag, segment, key and
member, with AI-made changes marked. Filter by project, environment and flag. For a full export
use the API: `GET /api/orgs/{orgId}/audit/export` (NDJSON or CSV).

## Settings

Most tabs need an administrative permission to change anything, and show read-only content
otherwise.

### Organization

The org's name, slug and your role; its members; and pending invitations.

- **Invite** — an email and a role (**Member** or **Owner**). An address that belongs to a
  verified account is added to **Members** at once; any other waits in **Pending invitations**
  until its owner signs in with that email verified. No email is sent.
- **Pending invitations** — email, role and when it was invited. **Copy sign-in link** copies the
  instance's sign-in page (`/login`) to paste into a message; **Revoke** withdraws the invitation.
- **Members** — remove anyone but yourself.

The invite form, the pending list and the remove buttons appear only if you have *Manage people
and roles*. [governance.md](governance.md#why-verified-matters) explains the verified-address
rule.

### Roles & access

Grant a role to a person at a scope — the whole organization, one project, or one environment —
and revoke grants. **Who has what** lists every grant; **What each role can do** is the
role-by-permission matrix. Permissions add up across scopes: a narrow grant never removes what a
wider one gives. See [governance.md](governance.md#roles-and-permissions).

### Environments

The current project's environments. **New environment** (a new environment gets every existing
flag, switched off, at version 1), **Rename**, **Archive** and **Restore**. Archiving hides an
environment from the pickers and freezes its flag configs, but its SDK keys **keep serving** —
revoke them if you meant to turn it off.

### Approvals

Per environment: **Require approval for targeting changes and rollbacks**, how many approvals
are needed, **Let people approve their own requests**, and **Require approval for the kill switch
too**. The last is off by default so the emergency stop stays immediate. See
[governance.md](governance.md#approvals).

### SDK keys

Keys for the environment you pick. **New key**, choose **Server** or **Client-side**, and label it
with the service that will use it — the label is how you know what to rotate later. The key is
shown once; Switchboard stores only a hash. Revoking a key takes effect immediately.

### Tokens

Your personal access tokens, for scripts, CI, SCIM and the MCP server. **New token**, name it,
optionally set an expiry. A token acts as you, with exactly your permissions. Shown once; revoke
from the list, which also shows when each was last used.

### Webhooks

Signed HTTP callbacks for flag changes, kill switches, rollbacks and monitor findings. **New
webhook** takes an endpoint URL and the events to send, and shows a signing secret **once**; each
delivery carries an `X-Switchboard-Signature` header you verify with it. Recent deliveries and
their responses are listed per webhook.

### AI

Owners only.

- **AI features** — the master switch. On by default. Off, Switchboard stops scanning rollouts and
  drafting proposals.
- **Roll back a rollout automatically when a variant starts erroring** — off by default.
- **Ramp up a variant that is winning** — off by default.
- **Call a flag stale after** — weeks without a decision before a retirement proposal is drafted.
- **Notification webhook** — where the AI layer posts when it raises or acts on a finding.

See [ai-layer.md](ai-layer.md#turning-it-on) for what each switch changes.
