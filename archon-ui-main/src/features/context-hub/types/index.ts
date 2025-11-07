/**
 * Context Engineering Hub Types
 *
 * Type definitions for template management system.
 * Mirrors backend models from src/server/models/template_models.py
 */

// Step type enum (matches backend StepTemplate.step_type)
export type StepType = "planning" | "implement" | "validate" | "prime" | "git";

// Sub-step configuration (used in StepTemplate.sub_steps)
export interface SubStep {
  order: number;
  name: string;
  agent_template_slug: string;
  prompt_template: string;
  required: boolean;
}

// Workflow step configuration (used in WorkflowTemplate.steps)
export interface WorkflowStep {
  step_type: StepType;
  order: number;
  step_template_slug: string;
}

/**
 * Agent Template
 *
 * Defines reusable agent configurations with prompts, tools, and standards.
 * Supports versioning via parent_template_id.
 */
export interface AgentTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model: string;
  temperature: number;
  tools: string[];
  standards: Record<string, unknown>;
  metadata: Record<string, unknown>;
  is_active: boolean;
  version: number;
  parent_template_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Step Template
 *
 * Defines workflow step with optional sub-workflow support.
 * Can be single-agent (agent_template_id set) or multi-agent (sub_steps populated).
 */
export interface StepTemplate {
  id: string;
  step_type: StepType;
  slug: string;
  name: string;
  description: string | null;
  prompt_template: string;
  agent_template_id: string | null;
  sub_steps: SubStep[];
  metadata: Record<string, unknown>;
  is_active: boolean;
  version: number;
  parent_template_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Workflow Template
 *
 * Defines execution sequence of steps (planning, implement, validate).
 * Must have at least one planning, implement, and validate step.
 */
export interface WorkflowTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  steps: WorkflowStep[];
  metadata: Record<string, unknown>;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Coding Standard
 *
 * Reusable coding standards with linter/formatter rules.
 */
export interface CodingStandard {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  language: string;
  standards: Record<string, unknown>;
  metadata: Record<string, unknown>;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Repository Agent Override
 *
 * Repository-specific agent customizations.
 */
export interface RepositoryAgentOverride {
  id: string;
  configured_repository_id: string;
  agent_template_id: string;
  override_tools: string[] | null;
  override_standards: Record<string, unknown> | null;
  override_prompt_additions: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// =====================================================
// REQUEST/RESPONSE TYPES
// =====================================================

/**
 * Create Agent Template Request
 */
export interface CreateAgentTemplateRequest {
  name: string;
  slug: string;
  description?: string | null;
  system_prompt: string;
  model?: string;
  temperature?: number;
  tools?: string[];
  standards?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Update Agent Template Request
 */
export interface UpdateAgentTemplateRequest {
  name?: string | null;
  description?: string | null;
  system_prompt?: string | null;
  model?: string | null;
  temperature?: number | null;
  tools?: string[] | null;
  standards?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Create Step Template Request
 */
export interface CreateStepTemplateRequest {
  step_type: StepType;
  name: string;
  slug: string;
  description?: string | null;
  prompt_template: string;
  agent_template_id?: string | null;
  sub_steps?: SubStep[];
  metadata?: Record<string, unknown>;
}

/**
 * Update Step Template Request
 */
export interface UpdateStepTemplateRequest {
  step_type?: StepType | null;
  name?: string | null;
  description?: string | null;
  prompt_template?: string | null;
  agent_template_id?: string | null;
  sub_steps?: SubStep[] | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Create Workflow Template Request
 */
export interface CreateWorkflowTemplateRequest {
  name: string;
  slug: string;
  description?: string | null;
  steps: WorkflowStep[];
  metadata?: Record<string, unknown>;
}

/**
 * Update Workflow Template Request
 */
export interface UpdateWorkflowTemplateRequest {
  name?: string | null;
  description?: string | null;
  steps?: WorkflowStep[] | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Create Coding Standard Request
 */
export interface CreateCodingStandardRequest {
  name: string;
  slug: string;
  description?: string | null;
  language: string;
  standards: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Update Coding Standard Request
 */
export interface UpdateCodingStandardRequest {
  name?: string | null;
  description?: string | null;
  language?: string | null;
  standards?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

// =====================================================
// UI-SPECIFIC TYPES
// =====================================================

/**
 * Tab identifiers for Context Hub page
 */
export type ContextHubTab = "agents" | "steps" | "workflows" | "standards";

/**
 * View mode for template libraries
 */
export type ViewMode = "grid" | "list";

/**
 * Available tool names for agent templates
 */
export const AVAILABLE_TOOLS = ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"] as const;

export type ToolName = (typeof AVAILABLE_TOOLS)[number];

/**
 * Step type display configuration
 */
export interface StepTypeConfig {
  label: string;
  color: string;
  description: string;
}

export const STEP_TYPE_CONFIGS: Record<StepType, StepTypeConfig> = {
  planning: {
    label: "Planning",
    color: "blue",
    description: "Research and planning phase",
  },
  implement: {
    label: "Implementation",
    color: "green",
    description: "Code implementation phase",
  },
  validate: {
    label: "Validation",
    color: "purple",
    description: "Testing and review phase",
  },
  prime: {
    label: "Priming",
    color: "cyan",
    description: "Context loading phase",
  },
  git: {
    label: "Git Operations",
    color: "gray",
    description: "Version control operations",
  },
};
