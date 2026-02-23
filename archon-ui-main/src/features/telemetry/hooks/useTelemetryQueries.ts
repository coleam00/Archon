import { useQuery } from "@tanstack/react-query";
import { useSmartPolling } from "@/features/shared/hooks";
import { STALE_TIMES } from "../../shared/config/queryPatterns";
import { sessionService } from "../../sessions/services/sessionService";
import { handoffService } from "../../handoffs/services/handoffService";
import { telemetryService } from "../services/telemetryService";

export const telemetryKeys = {
  all: ["telemetry"] as const,
  snapshot: () => [...telemetryKeys.all, "snapshot"] as const,
  sessions: () => [...telemetryKeys.all, "sessions"] as const,
  handoffs: () => [...telemetryKeys.all, "handoffs"] as const,
};

export function useTelemetrySnapshot() {
  const { refetchInterval } = useSmartPolling(5000);

  return useQuery({
    queryKey: telemetryKeys.snapshot(),
    queryFn: () => telemetryService.getSnapshot(),
    refetchInterval,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIMES.frequent,
  });
}

export function useRecentSessions() {
  const { refetchInterval } = useSmartPolling(10000);

  return useQuery({
    queryKey: telemetryKeys.sessions(),
    queryFn: () => sessionService.listSessions(),
    refetchInterval,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIMES.frequent,
  });
}

export function useTelemetryHandoffs() {
  const { refetchInterval } = useSmartPolling(10000);

  return useQuery({
    queryKey: telemetryKeys.handoffs(),
    queryFn: () => handoffService.listHandoffs(),
    refetchInterval,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIMES.frequent,
  });
}
