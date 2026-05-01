import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '@/components/layout/Layout';
import { ProjectProvider } from '@/contexts/ProjectContext';
import { queryClient } from '@/lib/query-client';
import { ChatPage } from '@/routes/ChatPage';
import { WorkflowsPage } from '@/routes/WorkflowsPage';
import { WorkflowExecutionPage } from '@/routes/WorkflowExecutionPage';
import { WorkflowBuilderPage } from '@/routes/WorkflowBuilderPage';
import { SymphonyPage } from '@/routes/SymphonyPage';
import { MissionPage } from '@/routes/MissionPage';
import { CompassPage } from '@/routes/CompassPage';
import { SkillsPage } from '@/routes/SkillsPage';
import { AgentsPage } from '@/routes/AgentsPage';
import { SettingsPage } from '@/routes/SettingsPage';

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
        <ProjectProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Navigate to="/chat" replace />} />
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/chat/*" element={<ChatPage />} />
                <Route path="/dashboard" element={<Navigate to="/mission?tab=history" replace />} />
                <Route path="/workflows" element={<WorkflowsPage />} />
                <Route path="/workflows/builder" element={<WorkflowBuilderPage />} />
                <Route path="/workflows/runs/:runId" element={<WorkflowExecutionPage />} />
                <Route path="/workflows/runs" element={<Navigate to="/workflows" replace />} />
                <Route path="/symphony" element={<SymphonyPage />} />
                <Route path="/mission" element={<MissionPage />} />
                <Route path="/compass" element={<CompassPage />} />
                <Route path="/skills" element={<SkillsPage />} />
                <Route path="/skills/:name" element={<SkillsPage />} />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/agents/:name" element={<AgentsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ProjectProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
