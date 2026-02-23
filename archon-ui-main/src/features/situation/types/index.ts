export interface RecommendedAction {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  type: "task" | "review" | "investigation" | "maintenance" | "feature";
  estimated_effort: "quick" | "moderate" | "significant";
  why: string;
}

export interface ActiveTaskSummary {
  title: string;
  status: "todo" | "doing";
  priority: "low" | "medium" | "high" | "critical";
}

export type SystemHealth = "healthy" | "degraded" | "warning";

export interface SituationBrief {
  summary: string;
  active_tasks: ActiveTaskSummary[];
  recent_activity: string;
  system_health: SystemHealth;
  system_health_notes: string;
  recommended_actions: RecommendedAction[];
}
