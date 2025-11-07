/**
 * Repository Type Definitions
 *
 * This module defines TypeScript interfaces for configured repositories.
 * These types mirror the backend models from python/src/agent_work_orders/models.py ConfiguredRepository
 */

import type { SandboxType, WorkflowStep } from "./index";

/**
 * Configured repository with metadata and preferences
 *
 * Stores GitHub repository configuration for Agent Work Orders, including
 * verification status, metadata extracted from GitHub API, and per-repository
 * preferences for sandbox type and workflow commands.
 */
export interface ConfiguredRepository {
  /** Unique UUID identifier for the configured repository */
  id: string;

  /** GitHub repository URL (https://github.com/owner/repo format) */
  repository_url: string;

  /** Human-readable repository name (e.g., 'owner/repo-name') */
  display_name: string | null;

  /** Repository owner/organization name */
  owner: string | null;

  /** Default branch name (e.g., 'main' or 'master') */
  default_branch: string | null;

  /** Boolean flag indicating if repository access has been verified */
  is_verified: boolean;

  /** Timestamp of last successful repository verification */
  last_verified_at: string | null;

  /** Default sandbox type for work orders */
  default_sandbox_type: SandboxType;

  /** Default workflow commands for work orders */
  default_commands: WorkflowStep[];

  // Phase 2: Template linking fields
  /** UUID of workflow template from Context Hub */
  workflow_template_id: string | null;

  /** List of coding standard UUIDs from Context Hub */
  coding_standard_ids: string[];

  /** Repository-specific priming context (paths, architecture, conventions) */
  priming_context: Record<string, any>;

  /** Flag to enable template-based execution (Phase 3). Default: false (hardcoded .md files) */
  use_template_execution: boolean;

  /** Timestamp when repository configuration was created */
  created_at: string;

  /** Timestamp when repository configuration was last updated */
  updated_at: string;
}

/**
 * Request to create a new configured repository
 *
 * Creates a new repository configuration. If verify=True, the system will
 * call the GitHub API to validate repository access and extract metadata
 * (display_name, owner, default_branch) before storing.
 */
export interface CreateRepositoryRequest {
  /** GitHub repository URL to configure */
  repository_url: string;

  /** Whether to verify repository access via GitHub API and extract metadata */
  verify?: boolean;
}

/**
 * Request to update an existing configured repository
 *
 * All fields are optional for partial updates. Only provided fields will be
 * updated in the database.
 */
export interface UpdateRepositoryRequest {
  /** Update the display name for this repository */
  display_name?: string;

  /** Update the default sandbox type for this repository */
  default_sandbox_type?: SandboxType;

  /** Update the default workflow commands for this repository */
  default_commands?: WorkflowStep[];
}

/**
 * Agent tool/standard overrides for a specific repository
 *
 * Allows repository-specific customizations of agent templates without
 * modifying the template itself. NULL values mean "use template default".
 */
export interface RepositoryAgentOverride {
  /** Unique UUID for this override */
  id: string;

  /** FK to archon_configured_repositories */
  repository_id: string;

  /** FK to archon_agent_templates */
  agent_template_id: string;

  /** Override tools list (null = use template default) */
  override_tools: string[] | null;

  /** Override standards dict (null = use template default) */
  override_standards: Record<string, any> | null;

  /** Creation timestamp */
  created_at: string;

  /** Last update timestamp */
  updated_at: string;
}

/**
 * Request to apply workflow template to repository
 */
export interface ApplyWorkflowTemplateRequest {
  /** Workflow template UUID from Context Hub */
  workflow_template_id: string;
}

/**
 * Request to update repository priming context
 */
export interface UpdatePrimingContextRequest {
  /** Priming context dict (paths, architecture, etc.) */
  priming_context: Record<string, any>;
}

/**
 * Request to assign coding standards to repository
 */
export interface AssignCodingStandardsRequest {
  /** List of coding standard UUIDs from Context Hub */
  coding_standard_ids: string[];
}

/**
 * Request to create or update agent override
 */
export interface UpsertAgentOverrideRequest {
  /** Override tools list (null = use template default) */
  override_tools?: string[] | null;

  /** Override standards dict (null = use template default) */
  override_standards?: Record<string, any> | null;
}
