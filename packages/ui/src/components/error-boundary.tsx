import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Send error to telemetry if crash reporting is enabled
    // Privacy filters are applied in the main process before transmission
    if (typeof window !== 'undefined' && 'costgoblin' in window) {
      const api = window.costgoblin as { captureError?: (error: Error, context?: Readonly<Record<string, unknown>>) => Promise<void> };
      if (typeof api.captureError === 'function') {
        void api.captureError(error, {
          componentStack: errorInfo.componentStack,
        });
      }
    }
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="min-h-screen bg-bg-primary flex items-center justify-center p-8">
          <div className="max-w-lg w-full rounded-xl border border-negative/50 bg-negative-muted p-6">
            <h2 className="text-lg font-semibold text-negative">Something went wrong</h2>
            <p className="mt-2 text-sm text-text-secondary leading-relaxed">
              {this.state.error.message}
            </p>
            {this.state.error.message.includes('aws sso login') && (
              <div className="mt-3 rounded-lg bg-bg-primary/50 border border-border px-3 py-2">
                <p className="text-xs text-text-muted">Run this in your terminal:</p>
                <code className="text-sm text-accent font-mono">
                  {this.state.error.message.split('Run: ')[1] ?? 'aws sso login'}
                </code>
              </div>
            )}
            <button
              type="button"
              onClick={() => { this.setState({ error: null }); }}
              className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
