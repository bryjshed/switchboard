import React from 'react';

import { EmptyState } from './EmptyState';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render errors below it; offers a reset instead of a dead screen. */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[ErrorBoundary]', error);
  }

  private reset = () => this.setState({ error: null });

  render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <EmptyState
          icon="alert-triangle"
          title="Something broke"
          message={error.message}
          actionLabel="Try again"
          onAction={this.reset}
        />
      );
    }
    return this.props.children;
  }
}
