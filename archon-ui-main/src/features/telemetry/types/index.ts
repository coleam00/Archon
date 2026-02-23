export type TelemetryAgentStatus = "active" | "inactive" | "busy";

export interface TelemetryAgent {
  id: string;
  name: string;
  role: string | null;
  status: TelemetryAgentStatus;
  capabilities: string[];
  metadata: Record<string, unknown>;
  last_seen: string | null;
  last_seen_seconds_ago: number;
}

export interface SprintInfo {
  id: string;
  name: string;
  goal: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

export interface SprintMetrics {
  sprint: SprintInfo;
  total_tasks: number;
  by_status: { todo: number; doing: number; review: number; done: number };
  queue_depth: number;
  velocity: Array<{ date: string; count: number }>;
}

export interface TelemetrySnapshot {
  agents: TelemetryAgent[];
  sprint: SprintMetrics | null;
  generated_at: string;
}
