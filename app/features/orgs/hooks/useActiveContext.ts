import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { useAuthStore } from '@features/auth/stores/authStore';
import type { EnvironmentResponse, ProjectResponse, UserMembership } from '@shared/api/types';

import { orderEnvironments, resolveEnvKey } from '@shared/lib/env';
import { meQueryOptions } from '../queries/meQuery';
import { projectsListOptions } from '../queries/orgQueries';
import { useActiveOrgStore } from '../stores/activeOrgStore';

export interface ActiveContext {
  userId: string | undefined;
  memberships: UserMembership[];
  org: UserMembership | undefined;
  orgId: string | undefined;
  projects: ProjectResponse[];
  project: ProjectResponse | undefined;
  projectId: string | undefined;
  /** Ordered dev → staging → production → extras. */
  environments: EnvironmentResponse[];
  envKey: string | undefined;
  /** True while the org/project selection is still resolving. */
  loading: boolean;
  error: Error | null;
  /** No memberships at all — the app has nothing to show. */
  hasNoOrgs: boolean;
  /** Org has no projects yet. */
  hasNoProjects: boolean;
}

/**
 * Single source of truth for "which org/project/env am I looking at".
 *
 * Bootstraps the persisted selection against live data: an org or project that
 * disappeared (or was never chosen) falls back to the first available one, and
 * the env falls back to production. Selection writes happen in effects, never
 * during render, so concurrent renders stay pure.
 */
export function useActiveContext(): ActiveContext {
  const userId = useAuthStore((s) => s.user?.id);
  const storedOrgId = useActiveOrgStore((s) => s.activeOrgId);
  const storedProjectId = useActiveOrgStore((s) => s.activeProjectId);
  const storedEnvKey = useActiveOrgStore((s) => s.activeEnvKey);
  const setActiveOrg = useActiveOrgStore((s) => s.setActiveOrg);
  const setActiveProject = useActiveOrgStore((s) => s.setActiveProject);
  const setActiveEnvKey = useActiveOrgStore((s) => s.setActiveEnvKey);

  const meQuery = useQuery(meQueryOptions(userId));
  const memberships = useMemo(() => meQuery.data?.memberships ?? [], [meQuery.data]);

  // Resolve the org before firing the projects query so a stale persisted org
  // never issues a 403 request.
  const orgId = useMemo(() => {
    if (storedOrgId && memberships.some((m) => m.orgId === storedOrgId)) return storedOrgId;
    return memberships[0]?.orgId;
  }, [memberships, storedOrgId]);

  useEffect(() => {
    if (orgId && orgId !== storedOrgId) setActiveOrg(orgId);
  }, [orgId, storedOrgId, setActiveOrg]);

  const projectsQuery = useQuery(projectsListOptions(userId, orgId));
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  const project = useMemo(() => {
    if (storedProjectId) {
      const match = projects.find((p) => p.id === storedProjectId);
      if (match) return match;
    }
    return projects[0];
  }, [projects, storedProjectId]);

  useEffect(() => {
    if (project && project.id !== storedProjectId) setActiveProject(project.id);
  }, [project, storedProjectId, setActiveProject]);

  const environments = useMemo(
    () => (project ? orderEnvironments(project.environments) : []),
    [project],
  );

  const envKey = useMemo(
    () => resolveEnvKey(environments.map((e) => e.key), storedEnvKey),
    [environments, storedEnvKey],
  );

  useEffect(() => {
    if (envKey && envKey !== storedEnvKey) setActiveEnvKey(envKey);
  }, [envKey, storedEnvKey, setActiveEnvKey]);

  const org = useMemo(() => memberships.find((m) => m.orgId === orgId), [memberships, orgId]);
  const loading =
    (meQuery.isLoading && !meQuery.data) || (projectsQuery.isLoading && !projectsQuery.data);

  return {
    userId,
    memberships,
    org,
    orgId,
    projects,
    project,
    projectId: project?.id,
    environments,
    envKey,
    loading,
    error: (meQuery.error ?? projectsQuery.error) as Error | null,
    hasNoOrgs: !meQuery.isLoading && memberships.length === 0,
    hasNoProjects: !!orgId && !projectsQuery.isLoading && projects.length === 0,
  };
}
