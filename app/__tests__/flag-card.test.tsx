import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import { FlagCard } from '@features/flags/components/FlagCard';
import { MOCK_FLAGS } from '@features/flags/mockFlags';

const ramping = MOCK_FLAGS[0]; // checkout-redesign: ramping 40% on staging
const killed = MOCK_FLAGS[2]; // legacy-billing-path: kill switch on production

describe('FlagCard', () => {
  it('renders name, mono key, and per-env pills', async () => {
    await render(<FlagCard flag={ramping} activeEnvKey="staging" />);
    expect(screen.getByTestId('flag-card-checkout-redesign')).toBeTruthy();
    expect(screen.getByText('Checkout redesign')).toBeTruthy();
    expect(screen.getByText('checkout-redesign')).toBeTruthy();
    expect(screen.getByTestId('flag-card-checkout-redesign-env-dev')).toBeTruthy();
    expect(screen.getByTestId('flag-card-checkout-redesign-env-staging')).toBeTruthy();
    expect(screen.getByTestId('flag-card-checkout-redesign-env-production')).toBeTruthy();
  });

  it('shows the ramp bar and change caption when the active env is ramping', async () => {
    await render(<FlagCard flag={ramping} activeEnvKey="staging" />);
    expect(screen.getByTestId('flag-card-checkout-redesign-ramp')).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getByTestId('flag-card-checkout-redesign-changed').props.children).toMatch(
      /^changed .+ · alice$/,
    );
  });

  it('hides the ramp bar when the active env is not ramping', async () => {
    await render(<FlagCard flag={ramping} activeEnvKey="dev" />);
    expect(screen.queryByTestId('flag-card-checkout-redesign-ramp')).toBeNull();
  });

  it('long-press opens the kill-switch confirm; confirming calls onKillSwitch', async () => {
    const onKillSwitch = jest.fn();
    await render(<FlagCard flag={ramping} activeEnvKey="staging" onKillSwitch={onKillSwitch} />);
    await fireEvent(screen.getByTestId('flag-card-checkout-redesign'), 'longPress');
    expect(screen.getByText('Activate kill switch?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('flag-card-checkout-redesign-kill-confirm-confirm'));
    expect(onKillSwitch).toHaveBeenCalledTimes(1);
  });

  it('shows the kill-switch badge when active', async () => {
    await render(<FlagCard flag={killed} activeEnvKey="production" />);
    expect(screen.getByText('Kill switch active')).toBeTruthy();
  });
});
