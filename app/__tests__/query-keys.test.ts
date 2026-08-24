import { queryKeys } from '@shared/api/queryKeys';
import { flagsListOptions } from '@features/flags/queries/flagQueries';
import { meQueryOptions } from '@features/orgs/queries/meQuery';
import { proposalsListOptions } from '@features/ai/queries/aiQueries';
import { anomaliesOptions, rolloutStatsOptions } from '@features/ai/queries/monitorQueries';

describe('queryKeys', () => {
  it('scopes every key under the user', () => {
    expect(queryKeys.me('u1')).toEqual(['sb', 'u1', 'me']);
    expect(queryKeys.orgs.list('u1')[0]).toBe('sb');
    expect(queryKeys.orgs.list('u1')[1]).toBe('u1');
    expect(queryKeys.flags.list('u1', 'p1')[1]).toBe('u1');
  });

  it('narrows hierarchically: flags.list extends flags.all', () => {
    const all = queryKeys.flags.all('u1', 'p1');
    const list = queryKeys.flags.list('u1', 'p1');
    expect(list.slice(0, all.length)).toEqual([...all]);
    const detail = queryKeys.flags.detail('u1', 'p1', 'my-flag');
    expect(detail.slice(0, all.length)).toEqual([...all]);
  });

  it('separates users: same resource under two users never collides', () => {
    expect(queryKeys.flags.list('u1', 'p1')).not.toEqual(queryKeys.flags.list('u2', 'p1'));
  });

  it('is pure: same inputs always build the same key', () => {
    expect(queryKeys.flags.versions('u1', 'p1', 'f1', 'staging')).toEqual(
      queryKeys.flags.versions('u1', 'p1', 'f1', 'staging'),
    );
  });
});

describe('AI / monitoring keys', () => {
  it('nests every proposal list under one invalidation root', () => {
    const all = queryKeys.proposals.all('u1', 'p1');
    expect(queryKeys.proposals.list('u1', 'p1').slice(0, all.length)).toEqual([...all]);
    expect(queryKeys.proposals.list('u1', 'p1', 'DRAFT').slice(0, all.length)).toEqual([...all]);
    // Status is part of the key, so two filters cache apart.
    expect(queryKeys.proposals.list('u1', 'p1', 'DRAFT')).not.toEqual(
      queryKeys.proposals.list('u1', 'p1', 'APPLIED'),
    );
  });

  it('keys a single proposal by id alone — the endpoint is project-free', () => {
    expect(queryKeys.proposals.detail('u1', 'prop-1')).toEqual(['sb', 'u1', 'ai', 'proposals', 'prop-1']);
  });

  it('keys anomalies by environment ID, not env key', () => {
    const all = queryKeys.anomalies.all('u1');
    const list = queryKeys.anomalies.list('u1', 'env-uuid', 'OPEN');
    expect(list.slice(0, all.length)).toEqual([...all]);
    expect(list).toContain('env-uuid');
    // Same env key in two projects means two different env ids, so no collision.
    expect(queryKeys.anomalies.list('u1', 'env-a')).not.toEqual(
      queryKeys.anomalies.list('u1', 'env-b'),
    );
  });

  it('caches each stats window separately', () => {
    expect(queryKeys.rolloutStats.detail('u1', 'e1', 'f1', 24)).not.toEqual(
      queryKeys.rolloutStats.detail('u1', 'e1', 'f1', 48),
    );
    const all = queryKeys.rolloutStats.all('u1');
    expect(queryKeys.rolloutStats.detail('u1', 'e1', 'f1', 48).slice(0, all.length)).toEqual([
      ...all,
    ]);
  });
});

describe('queryOptions factories', () => {
  it('meQueryOptions keys by user and disables when signed out', () => {
    const signedIn = meQueryOptions('u1');
    expect(signedIn.queryKey).toEqual(queryKeys.me('u1'));
    expect(signedIn.enabled).toBe(true);

    const signedOut = meQueryOptions(undefined);
    expect(signedOut.enabled).toBe(false);
  });

  it('flagsListOptions keys by user/project (not env) and stays disabled without a project', () => {
    const opts = flagsListOptions({ userId: 'u1', projectId: 'p1' });
    // Env is deliberately absent: one cached list serves every env switch.
    expect(opts.queryKey).toEqual(queryKeys.flags.list('u1', 'p1'));
    expect(opts.enabled).toBe(true);

    const stub = flagsListOptions({ userId: 'u1', projectId: undefined });
    expect(stub.enabled).toBe(false);
  });

  it('anomaly and stats options stay disabled without an environment id', () => {
    expect(anomaliesOptions('u1', undefined).enabled).toBe(false);
    expect(anomaliesOptions('u1', 'e1', 'OPEN').enabled).toBe(true);
    expect(rolloutStatsOptions('u1', 'e1', undefined, 48).enabled).toBe(false);
    expect(rolloutStatsOptions('u1', 'e1', 'new-checkout', 48).queryKey).toEqual(
      queryKeys.rolloutStats.detail('u1', 'e1', 'new-checkout', 48),
    );
  });

  it('proposalsListOptions keys by status and needs a project', () => {
    expect(proposalsListOptions('u1', 'p1', 'DRAFT').queryKey).toEqual(
      queryKeys.proposals.list('u1', 'p1', 'DRAFT'),
    );
    expect(proposalsListOptions('u1', undefined).enabled).toBe(false);
  });
});
