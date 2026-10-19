import type { WorkflowSource } from '../schemas';
import type { RawAliasesConfig, RawTiersConfig } from '../model-validation';

/** A single validation issue with actionable hint */
export interface ValidationIssue {
  level: 'error' | 'warning';
  code?: 'shell_output_ref';
  nodeId?: string;
  field: string;
  message: string;
  hint?: string;
  suggestions?: string[];
}

/** Result of validating a single workflow (Level 3) */
export interface WorkflowValidationResult {
  workflowName: string;
  filename?: string;
  valid: boolean;
  issues: ValidationIssue[];
}

/** Create a WorkflowValidationResult with `valid` derived from issues */
export function makeWorkflowResult(
  workflowName: string,
  issues: ValidationIssue[],
  filename?: string
): WorkflowValidationResult {
  return {
    workflowName,
    ...(filename !== undefined && { filename }),
    valid: issues.every(i => i.level !== 'error'),
    issues,
  };
}

/** Result of validating a single command */
export interface CommandValidationResult {
  commandName: string;
  valid: boolean;
  issues: ValidationIssue[];
}

/** Config subset for validation (avoids WorkflowDeps dependency) */
export interface ValidationConfig {
  loadDefaultCommands?: boolean;
  commandFolder?: string;
  workflowSource?: WorkflowSource;
  assistant?: string;
  aliases?: RawAliasesConfig;
  tiers?: RawTiersConfig;
  /** Install-level provider defaults, keyed by provider id. */
  assistants?: Record<string, Record<string, unknown>>;
  /** The run environment, for provider skill roots named by an environment variable. */
  env?: Record<string, string>;
}

/** Result of validating a single script */
export interface ScriptValidationResult {
  scriptName: string;
  valid: boolean;
  issues: ValidationIssue[];
}
