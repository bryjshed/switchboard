# Concepts

The vocabulary the rest of the docs use, in the order you meet it. Each entry says what the thing
is, where you see it in the dashboard, and anything about it that surprises people.

---

## The workspace

**Organization (org).** The top-level container and the boundary of isolation: members, roles,
settings, webhooks and the audit log all belong to one org, and nothing crosses between orgs.
A person can belong to several and switches between them in the header. Who may create an org
depends on the instance — see [org creation](self-hosting.md#org-creation-open-or-bootstrap).

**Project.** One product or codebase inside an org. Flags, segments and metric definitions are
per project. Creating a project also creates three environments (`dev`, `staging`,
`production`) and the two default metrics (`error`, `conversion`).

**Environment.** Where a flag's behaviour lives. The same flag can be fully on in `dev`, at 25%
in `production` and killed in `staging`. Each environment has its own SDK keys, its own approval
policy and its own version history per flag. Environments can be added, renamed, archived and
restored under **Settings → Environments**; an archived environment keeps serving its existing
SDK keys until you revoke them.

## Flags

**Flag.** A named decision your code asks about, identified by a **key** (`new-checkout`) that
is lower-case letters, digits and hyphens, starting with a letter. The key is what your code
uses and cannot be changed; the name is a label for people.

**Kind.** `BOOLEAN` (the variations are `true` and `false`) or `STRING` (multivariate: you
define the variations). Numbers and JSON are string variations that the SDK parses when you ask
for `numberValue`/`doubleValue` or `jsonValue`; a value that does not parse serves your default.

**Variation.** One of the values a flag can serve. Every environment config names an **off
variation** (served when the flag is off or killed) and a **default variation**.

**Targeting.** An environment's configuration for one flag, evaluated top to bottom:

1. **Kill switch** — if on, serve the off variation and stop.
2. **Enabled** — if the flag is off in this environment, serve the off variation.
3. **Individual targets** — specific context keys pinned to a variation.
4. **Rules** — the first rule whose clauses all match decides. A rule serves one variation or a
   percentage rollout.
5. **Fallthrough** — what everyone else gets: one variation or a percentage rollout.

The reason attached to every answer (`KILL_SWITCH`, `FLAG_OFF`, `TARGET_MATCH`, `RULE_MATCH`,
`ROLLOUT`, `DEFAULT`, `SDK_DEFAULT`) names the rung that decided it. The normative version is
[`spec/evaluation.md`](../spec/evaluation.md).

**Rule and clause.** A rule is a list of clauses joined by AND. A clause is `attribute operator
values`, optionally negated — `plan IN pro,enterprise`, `appVersion SEMVER_GREATER_THAN 4.1.9`.
The operators are in [targeting.md](targeting.md#operators).

**Segment.** A reusable audience defined once per project — included keys, excluded keys and
rules — and referenced from any flag with `SEGMENT_MATCH`. Editing a segment changes every flag
that points at it.

**Context.** What your application tells Switchboard about the subject of a decision: a **key**
(usually a user id; it can be a tenant id or an agent run id) plus typed **attributes**. Rules
read the attributes; percentage rollouts bucket on the key. See
[integrating.md](integrating.md#the-context).

**Rollout.** A percentage split across variations, with weights that sum to exactly 100.
Bucketing is deterministic — the same flag key and context key always land in the same bucket —
and monotonic: widening a rollout from 10% to 25% only adds subjects, it never reshuffles the
ones already in.

**Kill switch.** The emergency stop. Serves the off variation to everyone in one environment
without touching the targeting underneath, so clearing it restores exactly what was there. It
bypasses approvals by default, because an emergency stop behind a queue turns an incident into
an outage.

**Version.** Every change to a flag in an environment writes a new, numbered, immutable version
and an audit entry. **Rollback** restores an earlier version by writing it again as a *new*
version, so history is never rewritten and a rollback can itself be rolled back.

**Client-side availability.** A per-flag switch (flag **Settings** tab) that makes a flag
visible to client-side keys. Off by default.

## Credentials

Three kinds of token, told apart by their prefix. All are shown once when created and stored
only as a hash.

| Prefix | What it is | Where it comes from | What it can do |
|---|---|---|---|
| `sb_srv_` | **Server SDK key**, scoped to one environment | **Settings → SDK keys**, kind *Server* | Read the full rule set, evaluate every flag, report events and metrics. Secret: keep it on your servers. |
| `sb_cli_` | **Client-side SDK key**, scoped to one environment | **Settings → SDK keys**, kind *Client-side* | Evaluated values for client-available flags only; no rules, no metric events. Public: safe to ship in a browser bundle. |
| `sb_pat_` | **Personal access token**, scoped to a person | **Settings → Tokens** | The management API, acting as you with exactly your permissions. Used by scripts, CI, SCIM and the MCP server. |

## People and access

**Member.** A person who belongs to an org, with an org role of `OWNER` or `MEMBER`.

**Invitation.** How someone joins an org. An admin invites an email address; if it belongs to a
*verified* Switchboard account they are added immediately, otherwise the invitation waits and is
accepted automatically once they sign in with that email verified. Access by email is never
granted to an address nobody has proved they own. No email is
sent — you tell them the dashboard URL. See [governance.md](governance.md#inviting-people).

**Role.** A named bundle of permissions — `OWNER`, `ADMIN`, `MEMBER`, `MAINTAINER`, `WRITER`,
`APPROVER`, `VIEWER` — granted at a **scope**: the whole org, one project, or one environment.
Permissions **add up** across scopes; a narrower grant never takes anything away. The full table
is in [governance.md](governance.md#roles-and-permissions).

**Change request.** What a write becomes in an environment that requires approval. The flag is
untouched (the API answers **202**, not 200) until enough reviewers approve; then it is applied
through the normal versioned write path.

## The AI layer

**Metric key.** The name your application reports an outcome under — `error`, `conversion`,
`checkout.latency-ms`. Metric events are attributed to a variation through the context key they
carry.

**Metric definition.** A project's declaration that a metric key matters: which direction is
good, how large a difference is worth reacting to, and whether the monitor may act on it. Every
project starts with `error` (lower is better) and `conversion` (higher is better). Only defined
metrics drive healing and optimizing.

**Rollout monitor.** The scan that compares each variation of an in-flight rollout against its
baseline, per distinct subject, using a statistic that stays valid however often it is run. It
raises a **finding** (an anomaly) when a variation is measurably worse, or an optimization when
one is measurably better. See [ai-layer.md](ai-layer.md).

**Healing.** Acting on a "worse" finding: rolling the rollout back to the baseline. A proposal by
default; automatic when the org turns on auto-rollback.

**Optimizing.** Acting on a "better" finding: the next ramp step (25 → 50 → 75 → 100). A
proposal by default; automatic when the org turns on auto-optimize.

**AI proposal.** A change the AI layer has drafted — from the monitor, from the stale-flag sweep,
or from a natural-language request. Nothing in a proposal has been applied until someone (or an
enabled automatic setting) applies it, and applying goes through the same versioned, audited
write path as a human edit.
