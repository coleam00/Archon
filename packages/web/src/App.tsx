import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { LegacyRedirect } from '@/routes/LegacyRedirect';
import { LoginPage } from '@/routes/LoginPage';
import { ConsoleApp } from '@/experiments/console/ConsoleApp';
import { SessionGate } from '@/components/auth/SessionGate';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught rendering error', {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-zinc-950 p-8">
          <div className="max-w-md text-center">
            <h1 className="mb-2 text-xl font-semibold text-zinc-100">Something went wrong</h1>
            <p className="mb-4 text-sm text-zinc-400">
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </p>
            <button
              onClick={(): void => {
                window.location.reload();
              }}
              className="rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App(): React.ReactElement {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<Navigate to="/console" replace />} />
            <Route
              path="/console/*"
              element={
                <SessionGate>
                  <ConsoleApp />
                </SessionGate>
              }
            />
            <Route path="/legacy/*" element={<LegacyRedirect />} />
            <Route path="/workflows/*" element={<LegacyRedirect />} />
            <Route path="/settings" element={<Navigate to="/console/settings" replace />} />
            <Route path="*" element={<Navigate to="/console" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
