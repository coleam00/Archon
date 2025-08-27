import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { SideNavigation } from './SideNavigation';
import { ArchonChatPanel } from './ArchonChatPanel';
import { X } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { credentialsService } from '../../services/credentialsService';
import { isLmConfigured } from '../../utils/onboarding';
import { BackendStartupError } from '../BackendStartupError';
/**
 * Props for the MainLayout component
 */
interface MainLayoutProps {
  children: React.ReactNode;
}
/**
 * MainLayout - The main layout component for the application
 *
 * This component provides the overall layout structure including:
 * - Side navigation
 * - Main content area
 * - Knowledge chat panel (slidable)
 */
export const MainLayout: React.FC<MainLayoutProps> = ({
  children
}) => {
  // State to track if chat panel is open
  const [isChatOpen, setIsChatOpen] = useState(false);
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [backendReady, setBackendReady] = useState(false);
  const [backendStartupFailed, setBackendStartupFailed] = useState(false);

  // Check backend readiness
  useEffect(() => {
    
    const checkBackendHealth = async (retryCount = 0) => {
      const maxRetries = 3; // 3 retries total
      const retryDelay = 1500; // 1.5 seconds between retries
      
      try {
        // Create AbortController for proper timeout handling
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        // Check if backend is responding with a simple health check
        const response = await fetch(`${credentialsService['baseUrl']}/api/health`, {
          method: 'GET',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const healthData = await response.json();
          console.log('📋 Backend health check:', healthData);
          
          // Check if backend is truly ready (not just started)
          if (healthData.ready === true) {
            console.log('✅ Backend is fully initialized');
            setBackendReady(true);
            setBackendStartupFailed(false);
          } else {
            // Backend is starting up but not ready yet
            console.log(`🔄 Backend initializing... (attempt ${retryCount + 1}/${maxRetries}):`, healthData.message || 'Loading credentials...');
            
            // Retry with shorter interval during initialization
            if (retryCount < maxRetries) {
              setTimeout(() => {
                checkBackendHealth(retryCount + 1);
              }, retryDelay); // Constant 1.5s retry during initialization
            } else {
              console.warn('Backend initialization taking too long - proceeding anyway');
              // Don't mark as failed yet, just not fully ready
              setBackendReady(false);
            }
          }
        } else {
          throw new Error(`Backend health check failed: ${response.status}`);
        }
      } catch (error) {
        // Handle AbortError separately for timeout
        const errorMessage = error instanceof Error 
          ? (error.name === 'AbortError' ? 'Request timeout (5s)' : error.message)
          : 'Unknown error';
        // Only log after first attempt to reduce noise during normal startup
        if (retryCount > 0) {
          console.log(`Backend not ready yet (attempt ${retryCount + 1}/${maxRetries}):`, errorMessage);
        }
        
        // Retry if we haven't exceeded max retries
        if (retryCount < maxRetries) {
          setTimeout(() => {
            checkBackendHealth(retryCount + 1);
          }, retryDelay * Math.pow(1.5, retryCount)); // Exponential backoff for connection errors
        } else {
          console.error('Backend startup failed after maximum retries - showing error message');
          setBackendReady(false);
          setBackendStartupFailed(true);
        }
      }
    };


    // Start the health check process
    setTimeout(() => {
      checkBackendHealth();
    }, 1000); // Wait 1 second for initial app startup
  }, []); // Empty deps - only run once on mount

  // Check for onboarding redirect after backend is ready
  useEffect(() => {
    const checkOnboarding = async () => {
      // Skip if backend failed to start
      if (backendStartupFailed) {
        return;
      }
      
      // Skip if not ready, already on onboarding, or already dismissed
      if (!backendReady || location.pathname === '/onboarding') {
        return;
      }

      // Check if onboarding was already dismissed
      if (localStorage.getItem('onboardingDismissed') === 'true') {
        return;
      }

      try {
        // Fetch credentials in parallel
        const [ragCreds, apiKeyCreds] = await Promise.all([
          credentialsService.getCredentialsByCategory('rag_strategy'),
          credentialsService.getCredentialsByCategory('api_keys')
        ]);

        // Check if LM is configured
        const configured = isLmConfigured(ragCreds, apiKeyCreds);
        
        if (!configured) {
          // Redirect to onboarding
          navigate('/onboarding', { replace: true });
        }
      } catch (error) {
        // Detailed error handling per alpha principles - fail loud but don't block
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorDetails = {
          context: 'Onboarding configuration check',
          pathname: location.pathname,
          error: errorMessage,
          timestamp: new Date().toISOString()
        };
        
        // Log with full context and stack trace
        console.error('ONBOARDING_CHECK_FAILED:', errorDetails, error);
        
        // Make error visible to user but don't block app functionality
        showToast(
          `Configuration check failed: ${errorMessage}. You can manually configure in Settings.`,
          'warning'
        );
        
        // Let user continue - onboarding is optional, they can configure manually
      }
    };

    checkOnboarding();
  }, [backendReady, backendStartupFailed, location.pathname, navigate, showToast]);

  return <div className="relative min-h-screen bg-white dark:bg-black overflow-hidden">
      {/* Show backend startup error if backend failed to start */}
      {backendStartupFailed && <BackendStartupError />}
      
      {/* Fixed full-page background grid that doesn't scroll */}
      <div className="fixed inset-0 neon-grid pointer-events-none z-0"></div>
      {/* Floating Navigation */}
      <div className="fixed left-6 top-1/2 -translate-y-1/2 z-50">
        <SideNavigation />
      </div>
      {/* Main Content Area - no left margin to allow grid to extend full width */}
      <div className="relative flex-1 pl-[100px] z-10">
        <div className="container mx-auto px-8 relative">
          <div className="min-h-screen pt-8 pb-16">{children}</div>
        </div>
      </div>
      {/* Floating Chat Button - Only visible when chat is closed */}
      {!isChatOpen && (
        <div className="fixed bottom-6 right-6 z-50 group">
          <button 
            disabled
            className="w-14 h-14 rounded-full flex items-center justify-center backdrop-blur-md bg-gradient-to-b from-gray-100/80 to-gray-50/60 dark:from-gray-700/30 dark:to-gray-800/30 shadow-[0_0_10px_rgba(156,163,175,0.3)] dark:shadow-[0_0_10px_rgba(156,163,175,0.3)] cursor-not-allowed opacity-60 overflow-hidden border border-gray-300 dark:border-gray-600" 
            aria-label="Knowledge Assistant - Coming Soon">
            <img src="/logo-neon.png" alt="Archon" className="w-7 h-7 grayscale opacity-50" />
          </button>
          {/* Tooltip */}
          <div className="absolute bottom-full right-0 mb-2 px-3 py-2 bg-gray-800 dark:bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap">
            <div className="font-medium">Coming Soon</div>
            <div className="text-xs text-gray-300">Knowledge Assistant is under development</div>
            <div className="absolute bottom-0 right-6 transform translate-y-1/2 rotate-45 w-2 h-2 bg-gray-800 dark:bg-gray-900"></div>
          </div>
        </div>
      )}
      {/* Chat Sidebar - Slides in/out from right */}
      <div className="fixed top-0 right-0 h-full z-40 transition-transform duration-300 ease-in-out transform" style={{
      transform: isChatOpen ? 'translateX(0)' : 'translateX(100%)'
    }}>
        {/* Close button - Only visible when chat is open */}
        {isChatOpen && <button onClick={() => setIsChatOpen(false)} className="absolute -left-14 bottom-6 z-50 w-12 h-12 rounded-full flex items-center justify-center backdrop-blur-md bg-gradient-to-b from-white/10 to-black/30 dark:from-white/10 dark:to-black/30 from-pink-100/80 to-pink-50/60 border border-pink-200 dark:border-pink-500/30 shadow-[0_0_15px_rgba(236,72,153,0.2)] dark:shadow-[0_0_15px_rgba(236,72,153,0.5)] hover:shadow-[0_0_20px_rgba(236,72,153,0.4)] dark:hover:shadow-[0_0_20px_rgba(236,72,153,0.7)] transition-all duration-300" aria-label="Close Knowledge Assistant">
            <X className="w-5 h-5 text-pink-500" />
          </button>}
        {/* Knowledge Chat Panel */}
        <ArchonChatPanel data-id="archon-chat" />
      </div>
    </div>;
};
