import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { queryClient } from './features/shared/config/queryClient';
import { KnowledgeBasePage } from './pages/KnowledgeBasePage';
import GlobalTodoPage from './pages/GlobalTodoPage';
import { SettingsPage } from './pages/SettingsPage';
import { MCPPage } from './pages/MCPPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { MainLayout } from './components/layout/MainLayout';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './features/ui/components/ToastProvider';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { TooltipProvider } from './features/ui/primitives/tooltip';
import { ProjectPage } from './pages/ProjectPage';
import StyleGuidePage from './pages/StyleGuidePage';
import { AgentWorkOrdersPage } from './pages/AgentWorkOrdersPage';
import { AgentWorkOrderDetailPage } from './pages/AgentWorkOrderDetailPage';
import { SessionsPage } from './pages/SessionsPage';
import { AgentsPage } from './pages/AgentsPage';
import { SharedContextPage } from './pages/SharedContextPage';
import { HandoffsPage } from './pages/HandoffsPage';
import { TestRunnerPage } from './pages/TestRunnerPage';
import { PlanPromoterPage } from './pages/PlanPromoterPage';
import { AgentExecutionPage } from './pages/AgentExecutionPage';
import { TimelinePage } from './pages/TimelinePage';
import { SprintsPage } from './pages/SprintsPage';
import { TelemetryPage } from './pages/TelemetryPage';
import { SituationPage } from './pages/SituationPage';
import { DisconnectScreenOverlay } from './components/DisconnectScreenOverlay';
import { ErrorBoundaryWithBugReport } from './components/bug-report/ErrorBoundaryWithBugReport';
import { MigrationBanner } from './components/ui/MigrationBanner';
import { serverHealthService } from './services/serverHealthService';
import { useMigrationStatus } from './hooks/useMigrationStatus';
import { useSystemEvents } from './features/shared/hooks/useSystemEvents';


const AppRoutes = () => {
  const { projectsEnabled, styleGuideEnabled, agentWorkOrdersEnabled } = useSettings();

  return (
    <Routes>
      <Route path="/" element={<KnowledgeBasePage />} />
      <Route path="/todo" element={<GlobalTodoPage />} />
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/context" element={<SharedContextPage />} />
      <Route path="/handoffs" element={<HandoffsPage />} />
      <Route path="/timeline" element={<TimelinePage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/mcp" element={<MCPPage />} />
      <Route path="/test-runner" element={<TestRunnerPage />} />
      <Route path="/plan-promoter" element={<PlanPromoterPage />} />
      <Route path="/telemetry" element={<TelemetryPage />} />
      <Route path="/situation" element={<SituationPage />} />
      {styleGuideEnabled ? (
        <Route path="/style-guide" element={<StyleGuidePage />} />
      ) : (
        <Route path="/style-guide" element={<Navigate to="/" replace />} />
      )}
      {projectsEnabled ? (
        <>
          <Route path="/sprints" element={<SprintsPage />} />
          <Route path="/projects" element={<ProjectPage />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route path="/projects/:projectId/docs" element={<ProjectPage />} />
          <Route path="/projects/:projectId/docs/:docId" element={<ProjectPage />} />
        </>
      ) : (
        <>
          <Route path="/sprints" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<Navigate to="/" replace />} />
        </>
      )}
      {projectsEnabled && agentWorkOrdersEnabled ? (
        <Route path="/projects/:projectId/agent-run/:workOrderId" element={<AgentExecutionPage />} />
      ) : (
        <Route path="/projects/:projectId/agent-run/:workOrderId" element={<Navigate to="/projects" replace />} />
      )}
      {agentWorkOrdersEnabled ? (
        <>
          <Route path="/agent-work-orders" element={<AgentWorkOrdersPage />} />
          <Route path="/agent-work-orders/:id" element={<AgentWorkOrderDetailPage />} />
        </>
      ) : (
        <>
          <Route path="/agent-work-orders" element={<Navigate to="/" replace />} />
          <Route path="/agent-work-orders/:id" element={<Navigate to="/" replace />} />
        </>
      )}
    </Routes>
  );
};

const AppContent = () => {
  useSystemEvents();
  const [disconnectScreenActive, setDisconnectScreenActive] = useState(false);
  const [disconnectScreenDismissed, setDisconnectScreenDismissed] = useState(false);
  const [disconnectScreenSettings, setDisconnectScreenSettings] = useState({
    enabled: true,
    delay: 10000
  });
  const [migrationBannerDismissed, setMigrationBannerDismissed] = useState(false);
  const migrationStatus = useMigrationStatus();

  useEffect(() => {
    // Load initial settings
    const settings = serverHealthService.getSettings();
    setDisconnectScreenSettings((prev) => ({ ...prev, ...settings }));

    // Stop any existing monitoring before starting new one to prevent multiple intervals
    serverHealthService.stopMonitoring();

    // Start health monitoring
    serverHealthService.startMonitoring({
      onDisconnected: () => {
        if (!disconnectScreenDismissed) {
          setDisconnectScreenActive(true);
        }
      },
      onReconnected: () => {
        setDisconnectScreenActive(false);
        setDisconnectScreenDismissed(false);
        // Refresh the page to ensure all data is fresh
        window.location.reload();
      }
    });

    return () => {
      serverHealthService.stopMonitoring();
    };
  }, [disconnectScreenDismissed]);

  const handleDismissDisconnectScreen = () => {
    setDisconnectScreenActive(false);
    setDisconnectScreenDismissed(true);
  };

  return (
    <>
      <Router>
        <ErrorBoundaryWithBugReport>
          <MainLayout>
            {/* Migration Banner - shows when backend is up but DB schema needs work */}
            {migrationStatus.migrationRequired && !migrationBannerDismissed && (
              <MigrationBanner
                message={migrationStatus.message || "Database migration required"}
                onDismiss={() => setMigrationBannerDismissed(true)}
              />
            )}
            <AppRoutes />
          </MainLayout>
        </ErrorBoundaryWithBugReport>
      </Router>
      <DisconnectScreenOverlay
        isActive={disconnectScreenActive && disconnectScreenSettings.enabled}
        onDismiss={handleDismissDisconnectScreen}
      />
    </>
  );
};

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <TooltipProvider>
            <SettingsProvider>
              <AppContent />
            </SettingsProvider>
          </TooltipProvider>
        </ToastProvider>
      </ThemeProvider>
      {import.meta.env.VITE_SHOW_DEVTOOLS === 'true' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}