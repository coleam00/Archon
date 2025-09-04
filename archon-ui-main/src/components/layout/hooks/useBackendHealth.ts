import { useQuery } from "@tanstack/react-query";
import { getApiUrl } from "../../../config/api";

interface HealthResponse {
  ready: boolean;
  message?: string;
  server_status?: string;
  credentials_status?: string;
  database_status?: string;
  uptime?: number;
}

/**
 * Hook to monitor backend health status using TanStack Query
 * Replaces the direct fetch polling in old MainLayout
 */
export function useBackendHealth() {
  return useQuery<HealthResponse>({
    queryKey: ["backend", "health"],
    queryFn: async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${getApiUrl()}/api/health`, {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Health check failed: ${response.status}`);
        }

        return response.json();
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Health check timeout (5s)");
        }
        throw error;
      }
    },
    // Retry configuration for startup scenarios
    retry: (failureCount) => {
      // Keep retrying during startup, up to 5 times
      if (failureCount < 5) {
        return true;
      }
      return false;
    },
    retryDelay: (attemptIndex) => {
      // Exponential backoff: 1.5s, 2.25s, 3.375s, etc.
      return Math.min(1500 * 1.5 ** attemptIndex, 10000);
    },
    // Refetch every 30 seconds when healthy
    refetchInterval: 30000,
    // Keep trying to connect on window focus
    refetchOnWindowFocus: true,
    // Consider data fresh for 20 seconds
    staleTime: 20000,
  });
}
