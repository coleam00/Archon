export interface Plan {
  name: string;
  path: string;
  status: "ACTIVE" | "COMPLETE" | "DRAFT" | "REVIEW" | "RESOLVED" | string;
  notes: string;
  section: string;
  already_promoted: boolean;
  project_id: string | null;
}

export interface PromoteResult {
  project_id: string;
  project_title: string;
  task_count: number;
  tasks_created: number;
}

export interface PromoteRequest {
  plan_path: string;
  plan_name: string;
}

export interface PlansResponse {
  plans: Plan[];
  count: number;
  error?: string;
}

export interface PlanContentResponse {
  content: string;
  path: string;
}

export interface DemoteRequest {
  plan_path: string;
  plan_name: string;
  notes: string;
  section: string;
}
