import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class StudioErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[StudioErrorBoundary]', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      // Phase 8 expands this with workflow-JSON copy-out and an issue link.
      return (
        <div role="alert" style={{ padding: 24, color: 'var(--studio-error)' }}>
          <h2>Studio crashed</h2>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
