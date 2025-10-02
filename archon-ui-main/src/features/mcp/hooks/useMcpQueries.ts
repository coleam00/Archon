import { useQuery } from "@tanstack/react-query";
import { useSmartPolling } from "@/features/shared/hooks";
import { STALE_TIMES } from "../../shared/config/queryPatterns";
import { mcpApi } from "../services";

// Query keys factory
export const mcpKeys = {
  all: ["mcp"] as const,
  status: () => [...mcpKeys.all, "status"] as const,
  config: () => [...mcpKeys.all, "config"] as const,
  sessions: () => [...mcpKeys.all, "sessions"] as const,
  clients: () => [...mcpKeys.all, "clients"] as const,
  health: () => [...mcpKeys.all, "health"] as const,
};

export function useMcpStatus() {
  const { refetchInterval } = useSmartPolling(5000); // 5 second polling

  return useQuery({
    queryKey: mcpKeys.status(),
    queryFn: () => mcpApi.getStatus(),
    refetchInterval,
    refetchOnWindowFocus: false,
    staleTime: STALE_TIMES.frequent,
    throwOnError: true,
  });
}

export function useMcpConfig() {
  return useQuery({
    queryKey: mcpKeys.config(),
    queryFn: () => mcpApi.getConfig(),
    staleTime: STALE_TIMES.static, // Config rarely changes
    throwOnError: true,
  });
}

export function useMcpClients() {
  const { refetchInterval } = useSmartPolling(10000); // 10 second polling

  return useQuery({
    queryKey: mcpKeys.clients(),
    queryFn: () => mcpApi.getClients(),
    refetchInterval,
    refetchOnWindowFocus: false,
    staleTime: STALE_TIMES.frequent,
    throwOnError: true,
  });
}

export function useMcpSessionInfo() {
  const { refetchInterval } = useSmartPolling(10000);

  return useQuery({
    queryKey: mcpKeys.sessions(),
    queryFn: () => mcpApi.getSessionInfo(),
    refetchInterval,
    refetchOnWindowFocus: false,
    staleTime: STALE_TIMES.frequent,
    throwOnError: true,
  });
}
