import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { EmptyState } from './EmptyState';

export interface AsyncStateViewProps {
  loading: boolean;
  error?: Error | null;
  /** True when the load finished but there is nothing to show. */
  empty?: boolean;
  /** Rendered while loading (skeleton rows). */
  skeleton: React.ReactNode;
  /** Rendered when empty. Defaults to a generic EmptyState. */
  emptyState?: React.ReactNode;
  onRetry?: () => void;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** One switch for the loading / error / empty / content quartet. */
export function AsyncStateView({
  loading,
  error,
  empty = false,
  skeleton,
  emptyState,
  onRetry,
  children,
  style,
  testID,
}: AsyncStateViewProps) {
  let content: React.ReactNode;
  if (loading) {
    content = skeleton;
  } else if (error) {
    content = (
      <EmptyState
        testID={testID ? `${testID}-error` : undefined}
        icon="alert-circle"
        title="Something went wrong"
        message={error.message}
        actionLabel={onRetry ? 'Try again' : undefined}
        onAction={onRetry}
      />
    );
  } else if (empty) {
    content = emptyState ?? <EmptyState testID={testID ? `${testID}-empty` : undefined} title="Nothing here yet" />;
  } else {
    content = children;
  }
  return (
    <View testID={testID} style={[{ flex: 1 }, style]}>
      {content}
    </View>
  );
}
