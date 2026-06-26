import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '@/components/layout/Layout';
import { ProjectProvider } from '@/contexts/ProjectContext';
import { queryClient } from '@/lib/query-client';
import { BRTPage } from '@/routes/BRTPage';
import { IHHTPage } from '@/routes/IHHTPage';
// QEPPage merged into FountainPage 2026-06-11 — kept as file for ~14d, route now redirects.
// Re-enable import + route registration only if rollback needed.
// import { QEPPage } from '@/routes/QEPPage';
import { SocialContentPage } from '@/routes/SocialContentPage';
import { PMCPage } from '@/routes/PMCPage';
import { PMCProspectsPage } from '@/routes/PMCProspectsPage';
import { EWCPage } from '@/routes/EWCPage';
import { FountainPage } from '@/routes/FountainPage';
import { TTSPage } from '@/routes/TTSPage';
import { PlaygroundPage } from '@/routes/PlaygroundPage';
import { AccuFitPage } from '@/routes/AccuFitPage';
import { ARCPage } from '@/routes/ARCPage';
import { SADNPage } from '@/routes/SADNPage';
import { CategoryPage } from '@/routes/CategoryPage';
import { DrivePage } from '@/routes/DrivePage';
import { SolutionsPage } from '@/routes/SolutionsPage';
import { StrategicPartnerPage } from '@/routes/StrategicPartnerPage';
import { ContactsPage } from '@/routes/ContactsPage';
import { ResearchFirehosePage } from '@/routes/ResearchFirehosePage';
import { StartHerePage } from '@/routes/StartHerePage';
import { SessionTracesPage } from '@/routes/SessionTracesPage';

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
          <HashRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Navigate to="/welcome" replace />} />
                <Route path="/welcome" element={<StartHerePage />} />
                <Route path="/category/:slug" element={<CategoryPage />} />
                <Route path="/drive" element={<DrivePage />} />
                <Route path="/solutions" element={<SolutionsPage />} />
                <Route path="/solutions/:slug" element={<StrategicPartnerPage />} />
                <Route path="/contacts" element={<ContactsPage />} />
                <Route path="/research" element={<ResearchFirehosePage />} />
                <Route path="/pmc" element={<PMCPage />} />
                <Route path="/pmc-prospects" element={<PMCProspectsPage />} />
                <Route path="/brt" element={<BRTPage />} />
                <Route path="/ewc" element={<EWCPage />} />
                <Route path="/fountain" element={<FountainPage />} />
                <Route path="/ttts" element={<TTSPage />} />
                <Route path="/ihht" element={<IHHTPage />} />
                {/* QEP merged into Fountain WPB per 2026-06-11 decision
                    (intelligence/decisions/2026-06-11-qep-fountain-merge.md).
                    Route kept as redirect for ~14 days; QEPPage to be archived after. */}
                <Route path="/qep" element={<Navigate to="/fountain" replace />} />
                <Route path="/playground" element={<PlaygroundPage />} />
                <Route path="/accufit" element={<AccuFitPage />} />
                <Route path="/social-content" element={<SocialContentPage />} />
                <Route path="/external-reps/arc" element={<ARCPage />} />
                <Route path="/external-reps/sadn" element={<SADNPage />} />
                <Route path="/agents" element={<SessionTracesPage />} />
                {/* Backend-dependent routes intentionally omitted for static build:
                    /chat, /dashboard, /workflows*, /settings, /tts */}
                <Route path="*" element={<Navigate to="/welcome" replace />} />
              </Route>
            </Routes>
          </HashRouter>
        </ProjectProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
