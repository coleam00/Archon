import { useEffect } from 'react';

/**
 * usePerformanceMetrics
 *
 * Tracks key browser performance metrics using the Performance API
 * and logs them to the console. Designed to be lightweight and safe in beta.
 *
 * Metrics captured:
 * - NavigationTiming entries (domInteractive, domComplete)
 * - Load/DOMContentLoaded handler durations
 * - Server-Timing entries (if provided by backend)
 */
export function usePerformanceMetrics() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
      return;
    }

    try {
      // Navigation timings once on mount
      const navEntries = performance.getEntriesByType('navigation');
      if (navEntries && navEntries.length > 0) {
        const nav = navEntries[0] as PerformanceNavigationTiming;
        // Basic high-signal timings
        const metrics = {
          type: 'navigation',
          name: nav.name,
          domInteractive: Math.round(nav.domInteractive),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart),
          loadEvent: Math.round(nav.loadEventEnd - nav.loadEventStart),
          domComplete: Math.round(nav.domComplete),
          transferSize: (nav as any).transferSize ?? undefined,
        };
        // eslint-disable-next-line no-console
        console.info('[perf] NavigationTiming', metrics);
      }

      // Observe server-timing and additional nav/resource entries
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          // Server-Timing if present
          // @ts-expect-error serverTiming may exist
          const serverTiming = (entry as any).serverTiming as Array<{ name: string; description?: string; duration?: number }>|undefined;
          if (serverTiming && serverTiming.length > 0) {
            serverTiming.forEach((st) => {
              // eslint-disable-next-line no-console
              console.info('[perf] ServerTiming', {
                entryType: entry.entryType,
                name: entry.name,
                metric: st.name,
                description: st.description,
                duration: st.duration,
              });
            });
          }
        });
      });

      observer.observe({ type: 'navigation', buffered: true });
      observer.observe({ type: 'resource', buffered: true });

      return () => observer.disconnect();
    } catch (_) {
      // noop: metrics are best-effort only in beta
    }
  }, []);
}

