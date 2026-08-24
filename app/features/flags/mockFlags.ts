import type { FlagSummaryResponse } from './types';

/**
 * FlagCard test fixture. The flags screen renders live data (A2); these rows
 * exist so component tests can cover ramping / killed / plain states without a
 * backend. Not imported by any screen.
 */
export const MOCK_FLAGS: FlagSummaryResponse[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    key: 'checkout-redesign',
    name: 'Checkout redesign',
    kind: 'BOOLEAN',
    tags: ['checkout', 'web'],
    environments: [
      { envKey: 'dev', enabled: true, killSwitchActive: false, version: 12 },
      {
        envKey: 'staging',
        enabled: true,
        killSwitchActive: false,
        version: 9,
        rolloutPercentage: 40,
        updatedAt: '2026-08-21T20:15:00Z',
        updatedBy: 'alice',
      },
      { envKey: 'production', enabled: false, killSwitchActive: false, version: 4 },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    key: 'ai-suggestions-v2',
    name: 'AI suggestions v2',
    kind: 'STRING',
    tags: ['ai'],
    environments: [
      { envKey: 'dev', enabled: true, killSwitchActive: false, version: 31 },
      { envKey: 'staging', enabled: true, killSwitchActive: false, version: 27 },
      {
        envKey: 'production',
        enabled: true,
        killSwitchActive: false,
        version: 22,
        rolloutPercentage: 10,
        updatedAt: '2026-08-21T09:00:00Z',
        updatedBy: 'marcus',
      },
    ],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    key: 'legacy-billing-path',
    name: 'Legacy billing path',
    kind: 'BOOLEAN',
    tags: ['billing'],
    environments: [
      { envKey: 'dev', enabled: false, killSwitchActive: false, version: 8 },
      { envKey: 'staging', enabled: false, killSwitchActive: false, version: 8 },
      {
        envKey: 'production',
        enabled: true,
        killSwitchActive: true,
        version: 15,
        updatedAt: '2026-08-20T23:40:00Z',
        updatedBy: 'oncall-bot',
      },
    ],
  },
];
