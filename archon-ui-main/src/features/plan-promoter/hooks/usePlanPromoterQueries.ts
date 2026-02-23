import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../shared/config/queryPatterns";
import { planPromoterService } from "../services/planPromoterService";
import type { DemoteRequest, PromoteRequest } from "../types";

export const planPromoterKeys = {
  all: ["plan-promoter"] as const,
  plans: () => [...planPromoterKeys.all, "plans"] as const,
  content: (path: string) => [...planPromoterKeys.all, "content", path] as const,
};

export function usePlans() {
  return useQuery({
    queryKey: planPromoterKeys.plans(),
    queryFn: () => planPromoterService.listPlans(),
    staleTime: STALE_TIMES.rare,
  });
}

export function usePlanContent(path: string | null) {
  return useQuery({
    queryKey: path ? planPromoterKeys.content(path) : DISABLED_QUERY_KEY,
    queryFn: () => planPromoterService.getPlanContent(path ?? ""),
    enabled: !!path,
    staleTime: STALE_TIMES.rare,
  });
}

export function usePromotePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: PromoteRequest) => planPromoterService.promotePlan(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: planPromoterKeys.plans() });
    },
  });
}

export function useDemotePlanToIdea() {
  return useMutation({
    mutationFn: (request: DemoteRequest) => planPromoterService.demotePlanToIdea(request),
  });
}
