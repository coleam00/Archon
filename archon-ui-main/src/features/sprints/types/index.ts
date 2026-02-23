export type SprintStatus = "planning" | "ready_for_kickoff" | "active" | "completed" | "cancelled";

export interface Sprint {
  id: string;
  project_id: string;
  name: string;
  goal?: string | null;
  status: SprintStatus;
  start_date?: string | null;
  end_date?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSprintRequest {
  project_id: string;
  name: string;
  goal?: string;
  status?: SprintStatus;
  start_date?: string;
  end_date?: string;
}

export interface UpdateSprintRequest {
  name?: string;
  goal?: string;
  status?: SprintStatus;
  start_date?: string;
  end_date?: string;
  requested_by?: string;
}
