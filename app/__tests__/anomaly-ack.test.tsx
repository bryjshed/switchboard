import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import { useAckAnomalyMutation } from '@features/ai/mutations/monitorMutations';
import { queryKeys } from '@shared/api/queryKeys';
import type { AnomalyFindingResponse } from '@shared/api/types';

const mockAck = jest.fn();

jest.mock('@features/ai/services/monitorService', () => ({
  monitorService: {
    ackAnomaly: (...args: unknown[]) => mockAck(...args),
  },
}));

const USER = 'u1';
const ENV = 'env-prod';
const FINDING = 'finding-1';

function seeded(): AnomalyFindingResponse[] {
  return [
    {
      id: FINDING,
      environmentId: ENV,
      flagKey: 'heal-me',
      metricKey: 'error',
      baselineRate: 0.018,
      variantRate: 0.2,
      zScore: 6.08,
      status: 'OPEN',
      createdAt: '2026-08-22T22:00:00Z',
    },
    {
      id: 'finding-2',
      environmentId: ENV,
      flagKey: 'optimize-me',
      metricKey: 'error',
      baselineRate: 0.01,
      variantRate: 0.011,
      zScore: 1.2,
      status: 'OPEN',
      createdAt: '2026-08-22T21:00:00Z',
    },
  ];
}

const clients: QueryClient[] = [];
const unmounts: (() => void)[] = [];

async function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  // Two cached lists for this env (unfiltered and OPEN-only), as the Monitor
  // tab and the flag detail each hold one.
  client.setQueryData(queryKeys.anomalies.list(USER, ENV), seeded());
  client.setQueryData(queryKeys.anomalies.list(USER, ENV, 'OPEN'), seeded());
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = await renderHook(
    () => useAckAnomalyMutation({ userId: USER, envId: ENV }),
    { wrapper },
  );
  unmounts.push(unmount);
  const readStatus = (status?: string) =>
    client
      .getQueryData<AnomalyFindingResponse[]>(queryKeys.anomalies.list(USER, ENV, status))
      ?.find((a) => a.id === FINDING)?.status;
  return { client, result, readStatus };
}

describe('useAckAnomalyMutation', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockAck.mockReset();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    unmounts.splice(0).forEach((unmount) => unmount());
    clients.splice(0).forEach((client) => {
      client.clear();
      client.unmount();
    });
  });

  it('marks the finding acknowledged in every cached list before the request resolves', async () => {
    let resolve: (value: unknown) => void = () => {};
    mockAck.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { result, readStatus } = await setup();
    expect(readStatus()).toBe('OPEN');

    await act(async () => {
      result.current.mutate({ anomalyId: FINDING });
    });

    await waitFor(() => expect(readStatus()).toBe('ACKED'));
    // Both status filters cached for this env move together.
    expect(readStatus('OPEN')).toBe('ACKED');
    expect(mockAck).toHaveBeenCalledWith(FINDING);

    await act(async () => {
      resolve({ id: FINDING, status: 'ACKED' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(readStatus()).toBe('ACKED');
  });

  it('leaves the other findings alone', async () => {
    mockAck.mockResolvedValue({ id: FINDING, status: 'ACKED' });
    const { client, result } = await setup();
    await act(async () => {
      result.current.mutate({ anomalyId: FINDING });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const other = client
      .getQueryData<AnomalyFindingResponse[]>(queryKeys.anomalies.list(USER, ENV))
      ?.find((a) => a.id === 'finding-2');
    expect(other?.status).toBe('OPEN');
  });

  it('restores the snapshot when the ack fails (409 on a re-ack)', async () => {
    let reject: (error: Error) => void = () => {};
    mockAck.mockImplementation(
      () =>
        new Promise((_r, rj) => {
          reject = rj;
        }),
    );
    const { result, readStatus } = await setup();

    await act(async () => {
      result.current.mutate({ anomalyId: FINDING });
    });
    await waitFor(() => expect(readStatus()).toBe('ACKED'));

    await act(async () => {
      reject(new Error('already acknowledged'));
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readStatus()).toBe('OPEN');
    expect(readStatus('OPEN')).toBe('OPEN');
  });
});
