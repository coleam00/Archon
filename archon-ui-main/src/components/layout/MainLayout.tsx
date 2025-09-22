import { AlertCircle, WifiOff } from "lucide-react";
import type React from "react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useToast } from "../../features/shared/hooks/useToast";
import { cn } from "../../lib/utils";
import { credentialsService } from "../../services/credentialsService";
import { isLmConfigured } from "../../utils/onboarding";

// TEMPORARY: Import from old components until they're migrated to features
import { BackendStartupError } from "../BackendStartupError";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { Navigation } from "./Navigation";

interface MainLayoutProps {
  children: React.ReactNode;
  className?: string;
}

interface BackendStatusProps {
  isHealthLoading: boolean;
  isBackendError: boolean;
  healthData: { ready: boolean } | undefined;
}

/**
 * Backend health indicator component
 */
function BackendStatus({ isHealthLoading, isBackendError, healthData }: BackendStatusProps) {
  if (isHealthLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-yellow-50 dark:bg-yellow-950/30 text-yellow-700 dark:text-yellow-400 text-sm">
        <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
        <span>Connecting...</span>
      </div>
    );
  }

  if (isBackendError) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm">
        <WifiOff className="w-4 h-4" />
        <span>Backend Offline</span>
      </div>
    );
  }

  if (healthData?.ready === false) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-yellow-50 dark:bg-yellow-950/30 text-yellow-700 dark:text-yellow-400 text-sm">
        <AlertCircle className="w-4 h-4" />
        <span>Backend Starting...</span>
      </div>
    );
  }

  return null;
}

/**
 * Modern main layout using TanStack Query and Radix UI patterns
 * Uses CSS Grid for layout instead of fixed positioning
 */
export function MainLayout({ children, className }: MainLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();

  // Backend health monitoring with TanStack Query
  const {
    data: healthData,
    isError: isBackendError,
    error: backendError,
    isLoading: isHealthLoading,
    failureCount,
  } = useBackendHealth();

  // Track if backend has completely failed (for showing BackendStartupError)
  const backendStartupFailed = isBackendError && failureCount >= 5;

  // TEMPORARY: Handle onboarding redirect using old logic until migrated
  useEffect(() => {
    const checkOnboarding = async () => {
      // Skip if backend failed to start
      if (backendStartupFailed) {
        return;
      }

      // Skip if not ready, already on onboarding, or already dismissed
      if (!healthData?.ready || location.pathname === "/onboarding") {
        return;
      }

      // Check if onboarding was already dismissed
      if (localStorage.getItem("onboardingDismissed") === "true") {
        return;
      }

      try {
        // Fetch credentials in parallel (using old service temporarily)
        const [ragCreds, apiKeyCreds] = await Promise.all([
          credentialsService.getCredentialsByCategory("rag_strategy"),
          credentialsService.getCredentialsByCategory("api_keys"),
        ]);

        // Check if LM is configured (using old utility temporarily)
        const configured = isLmConfigured(ragCreds, apiKeyCreds);

        if (!configured) {
          // Redirect to onboarding
          navigate("/onboarding", { replace: true });
        }
      } catch (error) {
        // Log error but don't block app
        console.error("ONBOARDING_CHECK_FAILED:", error);
        showToast(`Configuration check failed. You can manually configure in Settings.`, "warning");
      }
    };

    checkOnboarding();
  }, [healthData?.ready, backendStartupFailed, location.pathname, navigate, showToast]);

  // Show backend error toast (once)
  useEffect(() => {
    if (isBackendError && backendError) {
      const errorMessage = backendError instanceof Error ? backendError.message : "Backend connection failed";
      showToast(`Backend unavailable: ${errorMessage}. Some features may not work.`, "error");
    }
  }, [isBackendError, backendError, showToast]);

  return (
    <div className={cn("relative min-h-screen bg-white dark:bg-black overflow-hidden", className)}>
      {/* TEMPORARY: Show backend startup error using old component */}
      {backendStartupFailed && <BackendStartupError />}

      {/* Fixed full-page background grid that doesn't scroll */}
      <div className="fixed inset-0 neon-grid pointer-events-none z-0" />

      {/* Floating Navigation */}
      <div className="fixed left-6 top-1/2 -translate-y-1/2 z-50 flex flex-col gap-4">
        <Navigation />
        <BackendStatus isHealthLoading={isHealthLoading} isBackendError={isBackendError} healthData={healthData} />
      </div>

      {/* Main Content Area - matches old layout exactly */}
      <div className="relative flex-1 pl-[100px] z-10">
        <div className="container mx-auto px-8 relative">
          <div className="min-h-screen pt-8 pb-16">{children}</div>
        </div>
      </div>

      {/* TEMPORARY: Floating Chat Button (disabled) - from old layout */}
      <div className="fixed bottom-6 right-6 z-50 group">
        <button
          type="button"
          disabled
          className="w-14 h-14 rounded-full flex items-center justify-center backdrop-blur-md bg-gradient-to-b from-gray-100/80 to-gray-50/60 dark:from-gray-700/30 dark:to-gray-800/30 shadow-[0_0_10px_rgba(156,163,175,0.3)] dark:shadow-[0_0_10px_rgba(156,163,175,0.3)] cursor-not-allowed opacity-60 overflow-hidden border border-gray-300 dark:border-gray-600"
          aria-label="Knowledge Assistant - Coming Soon"
        >
          <img src="/logo-neon.png" alt="Archon" className="w-7 h-7 grayscale opacity-50" />
        </button>
        {/* Tooltip */}
        <div className="absolute bottom-full right-0 mb-2 px-3 py-2 bg-gray-800 dark:bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap">
          <div className="font-medium">Coming Soon</div>
          <div className="text-xs text-gray-300">Knowledge Assistant is under development</div>
          <div className="absolute bottom-0 right-6 transform translate-y-1/2 rotate-45 w-2 h-2 bg-gray-800 dark:bg-gray-900"></div>
        </div>
      </div>
    </div>
  );
}

/**
 * Layout variant without navigation for special pages
 */
export function MinimalLayout({ children, className }: MainLayoutProps) {
  return (
    <div className={cn("min-h-screen bg-white dark:bg-black", "flex items-center justify-center", className)}>
      {/* Background Grid Effect */}
      <div
        className="absolute inset-0 pointer-events-none opacity-50"
        style={{
          backgroundImage: `linear-gradient(rgba(59, 130, 246, 0.03) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(59, 130, 246, 0.03) 1px, transparent 1px)`,
          backgroundSize: "50px 50px",
        }}
      />

      {/* Centered Content */}
      <div className="relative w-full max-w-4xl px-6">{children}</div>
    </div>
  );
}
