import React, { useState } from 'react';
import { Pressable, Text, View, type GestureResponderEvent } from 'react-native';

import { haptic } from '@shared/haptics';
import { radius, spacing, useTheme } from '@shared/theme';

import { RAMP_DETENTS, clampPercent, snapToDetent } from '../lib/targeting';

export interface RampSliderProps {
  /** Server-side percentage; the slider re-syncs to it whenever it changes. */
  value: number;
  /** Fired once on release with the snapped detent — one write per gesture. */
  onCommit: (percent: number) => void;
  disabled?: boolean;
  testID?: string;
}

const THUMB = 22;
const TRACK_HEIGHT = 6;

/**
 * Detented rollout slider (0/5/10/25/50/75/100). Dragging snaps to the nearest
 * detent with a selection haptic on each crossing, and only the release
 * commits — a drag across the track must not fire six PUTs.
 *
 * Uses the View responder props rather than PanResponder or gesture-handler:
 * the handlers are read from the current render, so no refs are needed and no
 * GestureHandlerRootView ancestor is required.
 */
export function RampSlider({ value, onCommit, disabled = false, testID = 'ramp' }: RampSliderProps) {
  const { tokens, typography } = useTheme();
  const [width, setWidth] = useState(0);
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const [syncedValue, setSyncedValue] = useState(value);
  const [display, setDisplay] = useState(() => clampPercent(value));

  // Adjust state during render (not in an effect) when the server value moves
  // and no drag is in flight — React's sanctioned prop-sync pattern.
  if (value !== syncedValue && dragPercent === null) {
    setSyncedValue(value);
    setDisplay(clampPercent(value));
  }

  const usable = Math.max(1, width - THUMB);

  const percentAt = (e: GestureResponderEvent) =>
    snapToDetent(((e.nativeEvent.locationX - THUMB / 2) / usable) * 100);

  const track = (percent: number) => {
    if (percent === display) return;
    haptic('selection');
    setDisplay(percent);
    setDragPercent(percent);
  };

  const commit = (percent: number) => {
    setDragPercent(null);
    setSyncedValue(percent);
    setDisplay(percent);
    onCommit(percent);
  };

  return (
    <View testID={testID}>
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm }}
      >
        <Text style={[typography.label, { color: tokens.text.secondary }]}>Rollout</Text>
        <Text
          testID={`${testID}-value`}
          style={[typography.label, { color: tokens.accent.primaryDark }]}
        >
          {display}%
        </Text>
      </View>

      <View
        testID={`${testID}-track`}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 100, now: display }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={(e) => {
          const percent = percentAt(e);
          setDragPercent(percent);
          if (percent !== display) {
            haptic('selection');
            setDisplay(percent);
          }
        }}
        onResponderMove={(e) => track(percentAt(e))}
        onResponderRelease={(e) => commit(dragPercent ?? percentAt(e))}
        onResponderTerminate={() => setDragPercent(null)}
        style={{ height: THUMB + spacing.sm, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}
      >
        <View
          style={{
            height: TRACK_HEIGHT,
            marginHorizontal: THUMB / 2,
            borderRadius: radius.pill,
            backgroundColor: tokens.surface.subtle,
          }}
        >
          <View
            style={{
              width: `${display}%`,
              height: '100%',
              borderRadius: radius.pill,
              backgroundColor: tokens.accent.primary,
            }}
          />
        </View>
        {RAMP_DETENTS.map((detent) => (
          <View
            key={detent}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: THUMB / 2 + (detent / 100) * usable - 2,
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: detent <= display ? tokens.accent.muted : tokens.border.strong,
            }}
          />
        ))}
        <View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: (display / 100) * usable,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: tokens.accent.primary,
              borderWidth: 2,
              borderColor: tokens.surface.raised,
            },
            tokens.floatingShadow,
          ]}
        />
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs }}>
        {RAMP_DETENTS.map((detent) => (
          <Pressable
            key={detent}
            testID={`${testID}-detent-${detent}`}
            accessibilityRole="button"
            accessibilityLabel={`Set rollout to ${detent} percent`}
            accessibilityState={{ selected: detent === display, disabled }}
            disabled={disabled}
            hitSlop={6}
            onPress={() => {
              haptic('selection');
              commit(detent);
            }}
          >
            <Text
              style={[
                typography.caption,
                { color: detent === display ? tokens.accent.primaryDark : tokens.text.tertiary },
              ]}
            >
              {detent}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
