export type AgentStatus = "active" | "inactive" | "busy";

export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  status: AgentStatus;
  last_seen: string;
  metadata: Record<string, unknown>;
  created_at: string;
  role?: string;
}

export interface RegisterAgentRequest {
  name: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  role?: string;
}

export interface AgentResponse {
  success: boolean;
  agent: Agent;
}

export interface AgentsListResponse {
  success: boolean;
  agents: Agent[];
  count: number;
}
