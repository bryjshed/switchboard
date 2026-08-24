/**
 * Import guard: every route and feature module resolves and evaluates. Catches
 * broken alias paths and barrel cycles that tsc cannot see — it type-checks
 * import paths but never runs the module graph.
 */
import ActivityScreen from '../app/(tabs)/activity/index';
import FlagsScreen from '../app/(tabs)/flags/index';
import SettingsScreen from '../app/(tabs)/settings/index';
import FlagDetailScreen from '../app/flag/[flagKey]/index';
import HistoryScreen from '../app/flag/[flagKey]/history';
import TargetingScreen from '../app/flag/[flagKey]/targeting';
import SdkKeysScreen from '../app/sdk-keys';
import MonitorScreen from '../app/(tabs)/monitor/index';
import RolloutMonitorScreen from '../app/flag/[flagKey]/monitor';
import AiCreateScreen from '../app/ai/create';
import ProposalDetailScreen from '../app/ai/proposal/[id]';
import ProposalsScreen from '../app/ai/proposals';
import { CreateFlagSheet } from '@features/flags/components/CreateFlagSheet';
import { EnvConfigCard } from '@features/flags/components/EnvConfigCard';
import { RampSlider } from '@features/flags/components/RampSlider';
import { RuleEditor } from '@features/flags/components/targeting/RuleEditor';
import { OrgProjectSwitcher } from '@features/orgs/components/OrgProjectSwitcher';
import { AiSettingsSection } from '@features/ai/components/AiSettingsSection';
import { AiUnavailableNotice } from '@features/ai/components/AiUnavailableNotice';
import { AnomalyBanner } from '@features/ai/components/AnomalyBanner';
import { AnomalyCard } from '@features/ai/components/AnomalyCard';
import { DiffPreview } from '@features/ai/components/DiffPreview';
import { ProposalRow } from '@features/ai/components/ProposalRow';
import { RolloutRow } from '@features/ai/components/RolloutRow';
import { Sparkline } from '@features/ai/components/Sparkline';
import { SplitBar } from '@features/ai/components/SplitBar';
import { VariantStatsCard } from '@features/ai/components/VariantStatsCard';

describe('module smoke', () => {
  it('every route exports a screen component', () => {
    for (const screen of [
      FlagsScreen,
      ActivityScreen,
      SettingsScreen,
      FlagDetailScreen,
      TargetingScreen,
      HistoryScreen,
      SdkKeysScreen,
      MonitorScreen,
      RolloutMonitorScreen,
      AiCreateScreen,
      ProposalDetailScreen,
      ProposalsScreen,
    ]) {
      expect(typeof screen).toBe('function');
    }
  });

  it('every A3 AI component module evaluates', () => {
    for (const component of [
      AiSettingsSection,
      AiUnavailableNotice,
      AnomalyBanner,
      AnomalyCard,
      DiffPreview,
      ProposalRow,
      RolloutRow,
      Sparkline,
      SplitBar,
      VariantStatsCard,
    ]) {
      expect(typeof component).toBe('function');
    }
  });

  it('every A2 component module evaluates', () => {
    for (const component of [
      OrgProjectSwitcher,
      CreateFlagSheet,
      EnvConfigCard,
      RampSlider,
      RuleEditor,
    ]) {
      expect(typeof component).toBe('function');
    }
  });
});
