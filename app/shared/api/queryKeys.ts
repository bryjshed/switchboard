/**
 * Hierarchical React Query key builders. Every key is scoped by userId so an
 * account switch can never serve another user's cache, then narrows by
 * org/project/env. Pure functions — unit-tested in __tests__/query-keys.test.ts.
 */
export const queryKeys = {
  all: (userId: string) => ['sb', userId] as const,

  me: (userId: string) => ['sb', userId, 'me'] as const,

  orgs: {
    list: (userId: string) => ['sb', userId, 'orgs'] as const,
    detail: (userId: string, orgId: string) => ['sb', userId, 'orgs', orgId] as const,
    settings: (userId: string, orgId: string) =>
      ['sb', userId, 'orgs', orgId, 'settings'] as const,
    members: (userId: string, orgId: string) =>
      ['sb', userId, 'orgs', orgId, 'members'] as const,
  },

  projects: {
    list: (userId: string, orgId: string) => ['sb', userId, 'orgs', orgId, 'projects'] as const,
    detail: (userId: string, projectId: string) => ['sb', userId, 'projects', projectId] as const,
  },

  flags: {
    /** All flag data for a project (lists across envs + details). */
    all: (userId: string, projectId: string) =>
      ['sb', userId, 'projects', projectId, 'flags'] as const,
    /**
     * One entry per project, NOT per env: the list response carries every
     * environment's summary, so switching envs is a re-render, not a refetch.
     */
    list: (userId: string, projectId: string) =>
      ['sb', userId, 'projects', projectId, 'flags', 'list'] as const,
    detail: (userId: string, projectId: string, flagKey: string) =>
      ['sb', userId, 'projects', projectId, 'flags', 'detail', flagKey] as const,
    versions: (userId: string, projectId: string, flagKey: string, envKey: string) =>
      ['sb', userId, 'projects', projectId, 'flags', 'detail', flagKey, 'versions', envKey] as const,
    stats: (userId: string, projectId: string, flagKey: string, envKey: string) =>
      ['sb', userId, 'projects', projectId, 'flags', 'detail', flagKey, 'stats', envKey] as const,
  },

  segments: {
    list: (userId: string, projectId: string) =>
      ['sb', userId, 'projects', projectId, 'segments'] as const,
    detail: (userId: string, projectId: string, segmentKey: string) =>
      ['sb', userId, 'projects', projectId, 'segments', segmentKey] as const,
  },

  audit: {
    /** Org-wide feed (Activity tab). Project filtering happens client-side per page. */
    list: (userId: string, orgId: string) => ['sb', userId, 'orgs', orgId, 'audit'] as const,
    /** Project-scoped feed; optional env/flag narrowing. */
    project: (userId: string, projectId: string, flagKey?: string, envKey?: string) =>
      ['sb', userId, 'projects', projectId, 'audit', flagKey ?? 'all', envKey ?? 'all'] as const,
  },

  sdkKeys: {
    list: (userId: string, envId: string) =>
      ['sb', userId, 'environments', envId, 'sdk-keys'] as const,
  },

  /**
   * AI proposals. The list is project-scoped (that is the only list endpoint);
   * a single proposal is fetched by id alone (`GET /api/ai/proposals/{id}`), so
   * its key hangs off the user rather than a project the route may not know.
   */
  proposals: {
    /** Invalidation root for every proposal list in a project. */
    all: (userId: string, projectId: string) =>
      ['sb', userId, 'projects', projectId, 'proposals'] as const,
    list: (userId: string, projectId: string, status?: string) =>
      ['sb', userId, 'projects', projectId, 'proposals', 'list', status ?? 'all'] as const,
    detail: (userId: string, proposalId: string) =>
      ['sb', userId, 'ai', 'proposals', proposalId] as const,
  },

  /**
   * Anomaly findings are keyed by ENVIRONMENT ID, not env key: the endpoint is
   * `/api/environments/{envId}/anomalies` and env keys repeat across projects.
   */
  anomalies: {
    all: (userId: string) => ['sb', userId, 'anomalies'] as const,
    list: (userId: string, envId: string, status?: string) =>
      ['sb', userId, 'anomalies', envId, status ?? 'all'] as const,
  },

  /** Rollout stats, keyed by env id + flag + window so each window caches apart. */
  rolloutStats: {
    all: (userId: string) => ['sb', userId, 'rollout-stats'] as const,
    detail: (userId: string, envId: string, flagKey: string, hours: number) =>
      ['sb', userId, 'rollout-stats', envId, flagKey, hours] as const,
  },
} as const;
