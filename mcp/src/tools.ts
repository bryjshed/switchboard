import { z } from 'zod';
import type { SwitchboardClient, WriteOutcome } from './client.js';

/**
 * The tool surface.
 *
 * Chosen to cover what an agent actually needs to do with flags — read the state of the world,
 * change one thing safely, and see what the automated monitor has been doing — rather than to
 * mirror every REST endpoint. A tool per endpoint would be a larger surface that is harder for a
 * model to choose correctly from.
 *
 * Every write goes through the versioned path, so `expectedVersion` conflicts surface as conflicts
 * rather than silently clobbering somebody else's change.
 */

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: (client: SwitchboardClient, args: never) => Promise<unknown>;
}

/** Renders a write outcome so a queued change can never be mistaken for an applied one. */
function describeWrite(outcome: WriteOutcome<unknown>, what: string): unknown {
  if (outcome.applied) {
    return { applied: true, summary: `${what} applied.`, result: outcome.value };
  }
  return {
    applied: false,
    queued: true,
    summary:
      `${what} was NOT applied. This environment requires approval, so the change is waiting ` +
      `for a human reviewer. Do not report it as done.`,
    changeRequest: outcome.changeRequest,
  };
}

function tool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  run: (client: SwitchboardClient, args: z.infer<S>) => Promise<unknown>,
): Tool {
  return { name, description, schema, run: run as Tool['run'] };
}

export const TOOLS: Tool[] = [
  tool(
    'list_projects',
    'List the organisations and projects this token can see, with each project\'s environments. ' +
      'Start here: most other tools need a projectId or environmentId.',
    z.object({}),
    async (client) => {
      const orgs = (await client.get<Array<{ id: string; name: string }>>('/api/orgs')) ?? [];
      return Promise.all(
        orgs.map(async (org) => ({
          org,
          projects: await client.get(`/api/orgs/${encodeURIComponent(org.id)}/projects`),
        })),
      );
    },
  ),

  tool(
    'list_flags',
    'List flags in a project, with their per-environment state. Supports a search query and a tag ' +
      'filter.',
    z.object({
      projectId: z.string().describe('Project UUID, from list_projects'),
      query: z.string().optional().describe('Substring match on key or name'),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (client, args) => {
      const params = new URLSearchParams();
      if (args.query) params.set('query', args.query);
      if (args.tag) params.set('tag', args.tag);
      if (args.limit) params.set('limit', String(args.limit));
      const suffix = params.toString() ? `?${params}` : '';
      return client.get(`/api/projects/${encodeURIComponent(args.projectId)}/flags${suffix}`);
    },
  ),

  tool(
    'get_flag',
    'Read one flag in full: its variations, and its targeting configuration in every environment. ' +
      'The per-environment `version` here is what update_targeting needs as expectedVersion.',
    z.object({
      projectId: z.string(),
      flagKey: z.string(),
    }),
    async (client, args) =>
      client.get(
        `/api/projects/${encodeURIComponent(args.projectId)}/flags/${encodeURIComponent(args.flagKey)}`,
      ),
  ),

  tool(
    'update_targeting',
    'Replace a flag\'s targeting in one environment. Pass expectedVersion from get_flag: if ' +
      'somebody else has changed the flag since you read it, this fails with a conflict rather ' +
      'than overwriting their change. May be queued for approval instead of applied — check the ' +
      '`applied` field of the result.',
    z.object({
      projectId: z.string(),
      flagKey: z.string(),
      envKey: z.string().describe('Environment key, e.g. "production"'),
      enabled: z.boolean(),
      config: z.unknown().describe('The full FlagTargetingConfig, as returned by get_flag'),
      expectedVersion: z.number().int().describe('From get_flag; guards against a lost update'),
      comment: z.string().optional().describe('Why. Shows up in the audit trail.'),
    }),
    async (client, args) => {
      const outcome = await client.write(
        'PUT',
        `/api/projects/${encodeURIComponent(args.projectId)}/flags/` +
          `${encodeURIComponent(args.flagKey)}/environments/${encodeURIComponent(args.envKey)}`,
        {
          enabled: args.enabled,
          config: args.config,
          expectedVersion: args.expectedVersion,
          comment: args.comment,
        },
      );
      return describeWrite(outcome, `Targeting for ${args.flagKey} in ${args.envKey}`);
    },
  ),

  tool(
    'set_kill_switch',
    'Turn a flag\'s kill switch on or off in one environment. The kill switch bypasses approval by ' +
      'design — an emergency stop behind a review queue turns an incident into an outage — so this ' +
      'takes effect immediately even in a gated environment. It is fully audited.',
    z.object({
      projectId: z.string(),
      flagKey: z.string(),
      envKey: z.string(),
      active: z.boolean(),
      reason: z.string().describe('Required. Goes into the audit trail.'),
    }),
    async (client, args) => {
      const outcome = await client.write(
        'PUT',
        `/api/projects/${encodeURIComponent(args.projectId)}/flags/` +
          `${encodeURIComponent(args.flagKey)}/environments/${encodeURIComponent(args.envKey)}/kill-switch`,
        { active: args.active, reason: args.reason },
      );
      return describeWrite(outcome, `Kill switch ${args.active ? 'on' : 'off'} for ${args.flagKey}`);
    },
  ),

  tool(
    'list_versions',
    'The append-only version history of one flag in one environment. Use it to find the version ' +
      'number to roll back to.',
    z.object({ projectId: z.string(), flagKey: z.string(), envKey: z.string() }),
    async (client, args) =>
      client.get(
        `/api/projects/${encodeURIComponent(args.projectId)}/flags/` +
          `${encodeURIComponent(args.flagKey)}/environments/${encodeURIComponent(args.envKey)}/versions`,
      ),
  ),

  tool(
    'rollback',
    'Roll a flag in one environment back to an earlier version. This writes a NEW version that ' +
      'copies the old one rather than rewinding history, so the rollback is itself reversible.',
    z.object({
      projectId: z.string(),
      flagKey: z.string(),
      envKey: z.string(),
      toVersion: z.number().int().describe('From list_versions'),
      comment: z.string().optional(),
    }),
    async (client, args) => {
      const outcome = await client.write(
        'POST',
        `/api/projects/${encodeURIComponent(args.projectId)}/flags/` +
          `${encodeURIComponent(args.flagKey)}/environments/${encodeURIComponent(args.envKey)}/rollback`,
        { toVersion: args.toVersion, comment: args.comment },
      );
      return describeWrite(outcome, `Rollback of ${args.flagKey} to v${args.toVersion}`);
    },
  ),

  tool(
    'list_change_requests',
    'Change requests in a project: writes that are waiting for review, and their outcomes.',
    z.object({
      projectId: z.string(),
      status: z.string().optional().describe('PENDING, APPROVED, APPLIED, DECLINED, STALE...'),
    }),
    async (client, args) => {
      const suffix = args.status ? `?status=${encodeURIComponent(args.status)}` : '';
      return client.get(
        `/api/projects/${encodeURIComponent(args.projectId)}/change-requests${suffix}`,
      );
    },
  ),

  tool(
    'approve_change_request',
    'Approve a pending change request. Self-approval is refused with a 403 rather than silently ' +
      'ignored, so approving your own request will fail and say so.',
    z.object({ changeRequestId: z.string(), comment: z.string().optional() }),
    async (client, args) =>
      client.post(`/api/change-requests/${encodeURIComponent(args.changeRequestId)}/approve`, {
        comment: args.comment,
      }),
  ),

  tool(
    'list_anomalies',
    'Findings from the rollout monitor in one environment: degradations it detected, improvements ' +
      'it proposes, and allocation mismatches that suspended a comparison.',
    z.object({
      environmentId: z.string(),
      status: z.string().optional().describe('OPEN, ACKED or AUTO_ROLLED_BACK'),
    }),
    async (client, args) => {
      const suffix = args.status ? `?status=${encodeURIComponent(args.status)}` : '';
      return client.get(
        `/api/environments/${encodeURIComponent(args.environmentId)}/anomalies${suffix}`,
      );
    },
  ),

  tool(
    'get_rollout_stats',
    'Per-variation telemetry for one flag: exposed subjects, error rate and conversion rate, plus ' +
      'an hourly series. Subject counts are distinct contexts, not evaluation events.',
    z.object({
      environmentId: z.string(),
      flagKey: z.string(),
      hours: z.number().int().min(1).max(720).optional(),
    }),
    async (client, args) => {
      const suffix = args.hours ? `?hours=${args.hours}` : '';
      return client.get(
        `/api/environments/${encodeURIComponent(args.environmentId)}/flags/` +
          `${encodeURIComponent(args.flagKey)}/rollout-stats${suffix}`,
      );
    },
  ),

  tool(
    'list_audit',
    'The audit trail for a project: who changed what, when, and why.',
    z.object({
      projectId: z.string(),
      flagKey: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (client, args) => {
      const params = new URLSearchParams();
      if (args.flagKey) params.set('flagKey', args.flagKey);
      if (args.limit) params.set('limit', String(args.limit));
      const suffix = params.toString() ? `?${params}` : '';
      return client.get(`/api/projects/${encodeURIComponent(args.projectId)}/audit${suffix}`);
    },
  ),
];
