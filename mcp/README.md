# Switchboard MCP server

Feature flags as agent tools. A thin layer over Switchboard's REST API — no backend surface of its
own, so anything a tool can do, an operator could do with `curl`.

## Setup

Create a personal access token in the dashboard (**Settings → Tokens**), then point the server at
your Switchboard:

```json
{
  "mcpServers": {
    "switchboard": {
      "command": "node",
      "args": ["/path/to/switchboard/mcp/dist/index.js"],
      "env": {
        "SWITCHBOARD_TOKEN": "sb_pat_…",
        "SWITCHBOARD_BASE_URL": "http://localhost:28080"
      }
    }
  }
}
```

```bash
npm install && npm run build
```

## The permission model

A token **acts as the person who created it**, with exactly their permissions, checked by the same
RBAC a browser request goes through. There is deliberately no separate scope model: a second
authorization vocabulary would be a second place for a permission bug to live, and it would only
ever be exercised by whoever used a token.

The practical consequence: give an agent a token from an account that has the access you want it to
have, and no more. To narrow it, create a user with a narrower role and mint the token as them.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Orgs, projects and environments. Start here — most tools need an id from it. |
| `list_flags` | Flags in a project, with per-environment state. Search and tag filter. |
| `get_flag` | One flag in full, including the `version` a write needs. |
| `update_targeting` | Replace targeting in one environment, guarded by `expectedVersion`. |
| `set_kill_switch` | Emergency stop. Bypasses approval by design. |
| `list_versions` | Append-only history, for finding a version to roll back to. |
| `rollback` | Roll back to an earlier version, by writing a new one. |
| `list_change_requests` | Writes waiting for review, and their outcomes. |
| `approve_change_request` | Approve a pending request. Self-approval is refused. |
| `list_anomalies` | What the rollout monitor found. |
| `get_rollout_stats` | Per-variation telemetry: subjects, error rate, conversion rate. |
| `list_audit` | Who changed what, when, and why. |

## The one thing to understand about writes

A gated environment answers a write with **202 and changes nothing** — the flag is untouched and a
change request is waiting for a human. Every write tool returns an explicit `applied` field for
exactly this reason:

```json
{
  "applied": false,
  "queued": true,
  "summary": "Targeting for new-checkout in production was NOT applied. This environment requires
              approval, so the change is waiting for a human reviewer. Do not report it as done.",
  "changeRequest": { "id": "…", "status": "PENDING" }
}
```

An agent that reads 202 as success will tell its user a rollout happened when nothing did, which is
worse than an error would have been. The wording is deliberate.

Writes also carry `expectedVersion`, so a flag that changed since you read it produces a conflict
rather than silently overwriting somebody else's change. Re-read with `get_flag` and retry.

## Verifying

```bash
npm run check                       # typecheck + unit tests
node scripts/live-check.mjs         # 19 assertions against a running stack
```

The live check mints a real token, drives every tool through it, and confirms that revoking the
token stops it working.
