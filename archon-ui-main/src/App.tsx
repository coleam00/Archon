import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { KnowledgeBasePage } from './pages/KnowledgeBasePage';
import { SettingsPage } from './pages/SettingsPage';
import { MCPPage } from './pages/MCPPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { MainLayout } from './components/layouts/MainLayout';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { ProjectPage } from './pages/ProjectPage';
import { DisconnectScreenOverlay } from './components/DisconnectScreenOverlay';
import { ErrorBoundaryWithBugReport } from './components/bug-report/ErrorBoundaryWithBugReport';
import { MigrationBanner } from './components/ui/MigrationBanner';
import { serverHealthService } from './services/serverHealthService';
import { useMigrationStatus } from './hooks/useMigrationStatus';

const AppRoutes = () => {
  const { projectsEnabled } = useSettings();
  
  return (
    <Routes>
      <Route path="/" element={<KnowledgeBasePage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/mcp" element={<MCPPage />} />
      {projectsEnabled ? (
        <Route path="/projects" element={<ProjectPage />} />
      ) : (
        <Route path="/projects" element={<Navigate to="/" replace />} />
      )}
    </Routes>
  );
};

const AppContent = () => {
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
    setDisconnectScreenSettings(settings);

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
    <ThemeProvider>
      <ToastProvider>
        <SettingsProvider>
          <AppContent />
        </SettingsProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}