import * as Sentry from "@sentry/react";

/**
 * Initialize Sentry error tracking for the frontend.
 *
 * This function configures Sentry to capture errors, performance traces,
 * and session replays from the React application. It will only initialize
 * if a VITE_SENTRY_DSN is provided in the environment.
 *
 * Environment Variables:
 *   VITE_SENTRY_DSN: Sentry Data Source Name (required for Sentry to be enabled)
 *   MODE: Deployment environment (from Vite, e.g., "development", "production")
 *
 * Features:
 *   - Browser tracing for performance monitoring
 *   - Session replay for debugging (with privacy controls)
 *   - Environment-based sampling rates
 *
 * Performance Sampling:
 *   - Production: 10% of transactions traced
 *   - Development: 100% of transactions traced
 *
 * Session Replay:
 *   - All text and media are masked for privacy
 *   - 10% of normal sessions recorded
 *   - 100% of error sessions recorded
 */
export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;

  if (!dsn) {
    console.warn("Sentry DSN not configured");
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [
      new Sentry.BrowserTracing({
        tracePropagationTargets: [
          "localhost",
          /^https:\/\/api\.archon\.dev/,
        ],
      }),
      new Sentry.Replay({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    tracesSampleRate: import.meta.env.MODE === "production" ? 0.1 : 1.0,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}
