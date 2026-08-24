import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AiCreateScreen from '../app/ai/create';
import { ApiClientError } from '@shared/api/client';

const mockDraft = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
}));

jest.mock('@features/ai/services/aiService', () => ({
  aiService: {
    draft: (...args: unknown[]) => mockDraft(...args),
    apply: jest.fn(),
    reject: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
  },
}));

jest.mock('@features/orgs/hooks/useActiveContext', () => ({
  useActiveContext: () => ({
    userId: 'u1',
    memberships: [],
    org: undefined,
    orgId: 'o1',
    projects: [],
    project: undefined,
    projectId: 'p1',
    environments: [
      { id: 'e1', projectId: 'p1', key: 'dev', name: 'Dev', stateVersion: 1 },
      { id: 'e2', projectId: 'p1', key: 'production', name: 'Production', stateVersion: 1 },
    ],
    envKey: 'production',
    loading: false,
    error: null,
    hasNoOrgs: false,
    hasNoProjects: false,
  }),
}));

// Org settings and flag detail are not what this test is about; keep them quiet.
jest.mock('@features/orgs/services/orgService', () => ({
  orgService: {
    getSettings: jest.fn(() =>
      Promise.resolve({
        aiEnabled: true,
        autoRollbackEnabled: false,
        autoOptimizeEnabled: false,
        staleFlagWeeks: 4,
      }),
    ),
  },
}));

jest.mock('@features/flags/services/flagService', () => ({
  flagService: {
    get: jest.fn(() =>
      Promise.resolve({
        id: 'flag-1',
        projectId: 'p1',
        key: 'new-checkout',
        name: 'New checkout',
        kind: 'BOOLEAN',
        variations: [
          { id: 'v-on', value: 'true', name: 'True' },
          { id: 'v-off', value: 'false', name: 'False' },
        ],
        tags: [],
        envConfigs: [
          {
            flagId: 'flag-1',
            environmentId: 'e2',
            envKey: 'production',
            enabled: true,
            killSwitchActive: false,
            config: {
              fallthrough: { variationId: 'v-off', rollout: [] },
              offVariationId: 'v-off',
              defaultVariationId: 'v-on',
              individualTargets: [],
              rules: [],
            },
            version: 3,
            updatedAt: '2026-08-22T10:00:00Z',
            updatedBy: 'alice@ex.com',
          },
        ],
      }),
    ),
  },
}));

async function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <QueryClientProvider client={client}>
        <AiCreateScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  return { client, ...result };
}

describe('AI create — 503 AI_UNAVAILABLE', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    mockDraft.mockReset();
    mockPush.mockReset();
    // Mutations log before rolling back, and React Query's own act() notice
    // fires from its notify timer; neither is what these assertions are about.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('renders the explanatory panel instead of an error, and disables submit', async () => {
    mockDraft.mockRejectedValue(
      new ApiClientError('AI_UNAVAILABLE', 'No AI provider configured', 503),
    );
    const { client } = await renderScreen();

    await fireEvent.changeText(screen.getByTestId('ai-create-prompt'), 'turn dark mode on in dev');
    await fireEvent.press(screen.getByTestId('ai-create-submit'));

    await waitFor(() => expect(screen.getByTestId('ai-create-unavailable')).toBeTruthy());

    // Explains the fix rather than surfacing the raw failure.
    expect(screen.getByText('AI drafting is not configured')).toBeTruthy();
    expect(screen.getByTestId('ai-create-unavailable-env').props.children).toContain(
      'ANTHROPIC_API_KEY',
    );
    // No error message and no red toast anywhere.
    expect(screen.queryByTestId('ai-create-message')).toBeNull();
    expect(screen.queryByText('No AI provider configured')).toBeNull();

    const submit = screen.getByTestId('ai-create-submit');
    expect(submit.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Unavailable')).toBeTruthy();

    client.clear();
    client.unmount();
  });

  it('surfaces a real failure as a message, not as the AI-unavailable panel', async () => {
    mockDraft.mockRejectedValue(new ApiClientError('VALIDATION_FAILED', 'Prompt too vague', 400));
    const { client } = await renderScreen();

    await fireEvent.changeText(screen.getByTestId('ai-create-prompt'), 'do something');
    await fireEvent.press(screen.getByTestId('ai-create-submit'));

    await waitFor(() => expect(screen.getByTestId('ai-create-message')).toBeTruthy());
    expect(screen.getByText('Prompt too vague')).toBeTruthy();
    expect(screen.queryByTestId('ai-create-unavailable')).toBeNull();
    expect(screen.getByTestId('ai-create-submit').props.accessibilityState.disabled).toBe(false);

    client.clear();
    client.unmount();
  });

  it('shows the diff preview, not raw JSON, once a draft comes back', async () => {
    mockDraft.mockResolvedValue({
      id: 'prop-1',
      orgId: 'o1',
      projectId: 'p1',
      kind: 'FLAG_UPDATE',
      diff: {
        kind: 'FLAG_UPDATE',
        flagKey: 'new-checkout',
        envChanges: [
          {
            envKey: 'production',
            config: {
              fallthrough: {
                rollout: [
                  { variationId: 'v-on', weight: 25 },
                  { variationId: 'v-off', weight: 75 },
                ],
              },
              offVariationId: 'v-off',
              defaultVariationId: 'v-on',
              individualTargets: [],
              rules: [],
            },
          },
        ],
      },
      rationale: 'Ramps the new checkout to a quarter of traffic.',
      status: 'DRAFT',
      createdBy: 'alice@ex.com',
      createdAt: '2026-08-22T22:00:00Z',
    });
    const { client } = await renderScreen();

    await fireEvent.changeText(screen.getByTestId('ai-create-prompt'), 'ramp new-checkout to 25%');
    await fireEvent.press(screen.getByTestId('ai-create-submit'));

    await waitFor(() => expect(screen.getByTestId('diff-preview')).toBeTruthy());
    expect(screen.getByTestId('diff-preview-headline').props.children).toBe(
      'Update new-checkout in production',
    );
    // Prose with a before → after side, sourced from the live flag — not JSON.
    await waitFor(() => expect(screen.getByText('25% True / 75% False')).toBeTruthy());
    expect(screen.getByText('100% False')).toBeTruthy();
    expect(screen.queryByText(/variationId/)).toBeNull();
    expect(screen.getByTestId('ai-create-apply')).toBeTruthy();

    client.clear();
    client.unmount();
  });
});
