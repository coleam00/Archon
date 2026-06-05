/**
 * Zod schemas for the Context Budget Visualizer (observability).
 *
 * These describe the optional `contextBudget` config block (workflow + node level)
 * and the report data model (item / warning / per-node / totals). They are pure
 * data shapes — Phase 1 wires the config field into the node/workflow schemas and
 * exercises the report types from the pure builder; no execution path reads them yet.
 *
 * Import `z` from `@hono/zod-openapi` (project convention for all schema files).
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Config — optional `contextBudget` block (workflow-level + node-level)
// ---------------------------------------------------------------------------

/**
 * Optional context-budget config. Valid at the workflow level (defaults for all
 * nodes) and the node level (overrides). All fields optional; absence preserves
 * today's behavior exactly. Measurement defaults on; `enabled: false` opts out.
 */
export const contextBudgetConfigSchema = z.object({
  /** Master switch for measurement + report. Defaults on when the block is present. */
  enabled: z.boolean().optional(),
  /** Advisory token ceiling for warnings (not enforced — runs never block). */
  maxTokens: z.number().int().positive().optional(),
  /** Emit an `over_budget` warning at/above this percentage of `maxTokens`. */
  warnAtPercent: z.number().min(0).max(100).optional(),
  /** Warn when lockfiles / generated files are read (low-value reads). */
  warnOnLowValueReads: z.boolean().optional(),
});

export type ContextBudgetConfig = z.infer<typeof contextBudgetConfigSchema>;

// ---------------------------------------------------------------------------
// Token usage — local mirror of @archon/providers TokenUsage (types.ts:166-172)
// ---------------------------------------------------------------------------

/**
 * Actual token usage for a node (L2 — ground truth from the provider). Mirrors
 * `@archon/providers` `TokenUsage` field-for-field, re-declared as Zod here to keep
 * this schema self-contained (the SDK type is a plain TS interface, not a Zod schema).
 */
export const contextBudgetTokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  total: z.number().optional(),
  cost: z.number().optional(),
});

export type ContextBudgetTokenUsage = z.infer<typeof contextBudgetTokenUsageSchema>;

// ---------------------------------------------------------------------------
// Report data model (IMPACT-ANALYSIS §5)
// ---------------------------------------------------------------------------

/** The three measurement layers. */
export const contextBudgetLayerSchema = z.enum(['static-prompt', 'actual-usage', 'dynamic-read']);

export type ContextBudgetLayer = z.infer<typeof contextBudgetLayerSchema>;

/** Source type of a context item (L1 prompt parts, L2 usage, L3 tool reads). */
export const contextBudgetSourceTypeSchema = z.enum([
  'command-file',
  'variable',
  'node-output',
  'issue-context',
  'system-prompt',
  'file-read',
  'grep',
  'bash',
  'usage',
]);

export type ContextBudgetSourceType = z.infer<typeof contextBudgetSourceTypeSchema>;

/** A single measured context item (one row of the nutrition label). */
export const contextBudgetItemSchema = z.object({
  nodeId: z.string(),
  layer: contextBudgetLayerSchema,
  sourceType: contextBudgetSourceTypeSchema,
  /** Human label, e.g. 'src/auth/login.ts' or 'implement node prompt'. */
  label: z.string(),
  /** L1/L3 estimate (chars/4 heuristic). */
  estimatedTokens: z.number().optional(),
  /** L2 ground-truth count. */
  actualTokens: z.number().optional(),
  /** Path / pattern / command detail. */
  detail: z.string().optional(),
});

export type ContextBudgetItem = z.infer<typeof contextBudgetItemSchema>;

/** Advisory warning code. */
export const contextBudgetWarningCodeSchema = z.enum([
  'over_budget',
  'low_value_read',
  'no_test_context',
]);

export type ContextBudgetWarningCode = z.infer<typeof contextBudgetWarningCodeSchema>;

/** A single advisory (non-blocking) warning. */
export const contextBudgetWarningSchema = z.object({
  nodeId: z.string(),
  code: contextBudgetWarningCodeSchema,
  message: z.string(),
});

export type ContextBudgetWarning = z.infer<typeof contextBudgetWarningSchema>;

/** Per-node section of the report: L1 estimate, L2 actuals, L3 reads, warnings. */
export const contextBudgetNodeReportSchema = z.object({
  nodeId: z.string(),
  /** Resolved advisory ceiling for this node (node override ?? workflow default). */
  budgetTokens: z.number().optional(),
  /** L1 — estimated prompt tokens Archon assembled before calling the provider. */
  estimatedPromptTokens: z.number(),
  /** L2 — actual usage the provider reported back. */
  actualTokens: contextBudgetTokenUsageSchema.optional(),
  /** L3 — files/patterns/commands the agent read during the run. */
  reads: z.array(contextBudgetItemSchema),
  warnings: z.array(contextBudgetWarningSchema),
});

export type ContextBudgetNodeReport = z.infer<typeof contextBudgetNodeReportSchema>;

/** Roll-up totals across all nodes in the run. */
export const contextBudgetTotalsSchema = z.object({
  estimatedPromptTokens: z.number(),
  actualTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

export type ContextBudgetTotals = z.infer<typeof contextBudgetTotalsSchema>;

/** The full per-run context budget report. */
export const contextBudgetReportSchema = z.object({
  workflowRunId: z.string(),
  nodes: z.array(contextBudgetNodeReportSchema),
  totals: contextBudgetTotalsSchema,
});

export type ContextBudgetReport = z.infer<typeof contextBudgetReportSchema>;
