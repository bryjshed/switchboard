# Contributing

Thanks for looking. A few things are worth knowing before you spend time on a change.

## Licensing and the CLA

Switchboard is under the [PolyForm Noncommercial License 1.0.0](../LICENSE). It is
**source-available, not open source**: use it freely for noncommercial purposes, and talk to the
maintainer about anything else.

Every contributor signs the [CLA](CLA.md) once. The short version: you keep your copyright, and
you grant the maintainer a license broad enough to relicense the project later. Comment on your
pull request with:

> I have read the CLA document and I hereby sign the CLA.

That comment is the record, and it covers all of your future contributions.

## Before you write code

**Read [`docs/DECISIONS.md`](../docs/DECISIONS.md) first** if you are about to fix something that
looks obviously broken. Several things are deliberate and documented there — the kill switch
bypassing approval, MD5 bucketing, permissions unioning rather than narrowing, an unknown flag
returning 200, `/actuator/health` 404ing on the API port. A PR that "fixes" one of those is a PR
that gets closed, which wastes your afternoon and not much of anyone else's.

[`CLAUDE.md`](../CLAUDE.md) has the commands, the conventions, and the environment traps that have
already cost someone time. [`docs/REMAINING-WORK.md`](../docs/REMAINING-WORK.md) is the backlog if
you are looking for something to pick up.

## The two rules that are not style preferences

**Evaluation behaviour is spec-first.** Any change to precedence, operators, segments or bucketing
lands as a [`spec/evaluation.md`](../spec/evaluation.md) edit *plus* regenerated conformance
vectors, **in the same commit** as the code. Not a follow-up PR. The moment the implementation and
the spec disagree, every SDK author is working from a document that lies and the vectors stop
being evidence of anything. Both the Java server and the TypeScript SDK execute those vectors as
tests, and that shared execution is the only thing keeping them in agreement.

**Every flag mutation goes through `FlagTargetingService`** — `SELECT … FOR UPDATE`, validate
`expectedVersion`, head write, immutable snapshot, audit row, `state_version` bump, `pg_notify`
after commit. Including AI-applied and approval-applied ones. Rollback writes a *new* version;
history is never rewritten.

## Verifying

CI runs all of this on your PR, but running it yourself is what keeps CI from being the first
place a failure shows up.

```bash
cd backend        && JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw verify
cd dashboard      && npm run check && npm run build
cd sdk/typescript && npm run check
cd mcp            && npm run check
```

Seven scripts run against a **running** stack and are the real regression net — they catch
contract drift that unit tests cannot. They are listed in
[`docs/development.md`](../docs/development.md#the-live-checks). Run them after any backend
change. If one fails in a tree you did not touch, say so in the PR rather than "fixing" it.

Do not run the full suite to check one thing; `CLAUDE.md` has the tight loops.

## Review

[`CODEOWNERS`](CODEOWNERS) routes every pull request to the maintainer.

> **Note for the maintainer:** CODEOWNERS only *requests* review. To make approval a requirement,
> `main` needs a branch protection rule (or a ruleset) with **Require a pull request before
> merging** → **Require review from Code Owners**. Without it, this file is a routing hint and
> nothing more.

## Commits

The history here is unusually verbose on purpose: commit messages explain *why*, including the
wrong turns, because that is the context a future reader cannot recover from the diff. Match that
where you can. Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`,
`chore:`) are used but not enforced.
