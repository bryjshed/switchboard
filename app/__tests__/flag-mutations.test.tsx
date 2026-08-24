import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { useKillSwitchMutation } from '@features/flags/mutations/flagMutations';
import { queryKeys } from '@shared/api/queryKeys';
import type { FlagListResponse } from '@shared/api/types';

const mockSetKillSwitch = jest.fn();

jest.mock('@features/flags/services/flagService', () => ({
  flagService: {
    setKillSwitch: (...args: unknown[]) => mockSetKillSwitch(...args),
  },
}));

const USER = 'u1';
const PROJECT = 'p1';
const ORG = 'o1';
const ENV = 'production';

function seededList(killSwitchActive: boolean): FlagListResponse {
  return {
    items: [
      {
        id: 'flag-1',
        key: 'new-checkout',
        name: 'New checkout',
        kind: 'BOOLEAN',
        tags: [],
        environments: [
          { envKey: 'dev', enabled: false, killSwitchActive: false, version: 1 },
          { envKey: ENV, enabled: true, killSwitchActive, version: 5 },
        ],
      },
    ],
  };
}

const clients: QueryClient[] = [];
const unmounts: (() => void)[] = [];

async function setup() {
  const client = new QueryClient({
    // gcTime must stay non-zero: these caches have no observer, and a 0 gcTime
    // collects the optimistic write before the assertion can read it.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(queryKeys.flags.list(USER, PROJECT), seededList(false));
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = await renderHook(
    () => useKillSwitchMutation({ userId: USER, orgId: ORG, projectId: PROJECT }),
    { wrapper },
  );
  unmounts.push(unmount);
  const readKill = () =>
    client
      .getQueryData<FlagListResponse>(queryKeys.flags.list(USER, PROJECT))
      ?.items[0].environments.find((e) => e.envKey === ENV)?.killSwitchActive;
  return { client, result, readKill };
}

describe('useKillSwitchMutation', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockSetKillSwitch.mockReset();
    // The mutation logs before rolling back; keep the expected noise out of the run.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    // Clearing drops each query's gcTime timer; otherwise jest's worker is held
    // open by the default 5-minute collection timeout.
    unmounts.splice(0).forEach((unmount) => unmount());
    clients.splice(0).forEach((client) => {
      client.clear();
      client.unmount();
    });
  });

  it('flips the pill before the request resolves and keeps it on success', async () => {
    let resolve: (value: unknown) => void = () => {};
    mockSetKillSwitch.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { result, readKill } = await setup();
    expect(readKill()).toBe(false);

    await act(async () => {
      result.current.mutate({ flagKey: 'new-checkout', envKey: ENV, active: true });
    });

    // Optimistic: the cache flipped while the request is still in flight.
    await waitFor(() => expect(readKill()).toBe(true));
    expect(mockSetKillSwitch).toHaveBeenCalledWith(PROJECT, 'new-checkout', ENV, {
      active: true,
      reason: undefined,
    });

    await act(async () => {
      resolve({ killSwitchActive: true });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(readKill()).toBe(true);
  });

  it('restores the pre-mutation snapshot when the write fails', async () => {
    let reject: (error: Error) => void = () => {};
    mockSetKillSwitch.mockImplementation(
      () =>
        new Promise((_r, rj) => {
          reject = rj;
        }),
    );
    const { result, readKill } = await setup();

    await act(async () => {
      result.current.mutate({ flagKey: 'new-checkout', envKey: ENV, active: true });
    });
    await waitFor(() => expect(readKill()).toBe(true));

    await act(async () => {
      reject(new Error('boom'));
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // Rolled back to exactly what was cached before the mutation.
    expect(readKill()).toBe(false);
  });
});
