import { callAPIWithETag } from "../../shared/api/apiClient";
import type { DemoteRequest, PlanContentResponse, PlansResponse, PromoteRequest, PromoteResult } from "../types";

export const planPromoterService = {
  async listPlans(): Promise<PlansResponse> {
    return callAPIWithETag<PlansResponse>("/api/plan-promoter/plans");
  },

  async promotePlan(request: PromoteRequest): Promise<PromoteResult> {
    return callAPIWithETag<PromoteResult>("/api/plan-promoter/promote", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },

  async getPlanContent(path: string): Promise<PlanContentResponse> {
    return callAPIWithETag<PlanContentResponse>(`/api/plan-promoter/content?path=${encodeURIComponent(path)}`);
  },

  async demotePlanToIdea(request: DemoteRequest): Promise<{ success: boolean; plan_name: string }> {
    return callAPIWithETag("/api/plan-promoter/demote", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
};
