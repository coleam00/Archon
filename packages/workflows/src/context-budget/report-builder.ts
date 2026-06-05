/**
 * Pure report builder for the Context Budget Visualizer (observability).
 *
 * `buildContextBudgetReport` aggregates a single run's persisted workflow events
 * into the `ContextBudgetReport` data model (IMPACT-ANALYSIS §5). It is a pure
 * function — no DB, no model, no I/O — and is fully unit-testable from synthetic
 * events. Phase 1 only defines it; nothing in the execution path calls it yet.
 *
 * Decision 1 (dependency direction): `@archon/workflows` cannot import
 * `WorkflowEventRow` from `@archon/core` (core depends on workflows, not the
 * reverse). So we define our own minimal structural input type matching the
 * persisted row's relevant fields. The Phase-3 core op reads rows via core's own
 * DB layer and passes them in — structurally compatible, no import edge.
 */
import type {
  ContextBudgetConfig,
  ContextBudgetItem,
  ContextBudgetNodeReport,
  ContextBudgetReport,
  ContextBudgetTokenUsage,
  ContextBudgetWarning,
} from '../schemas/context-budget';
import { contextBudgetTokenUsageSchema } from '../schemas/context-budget';
import { classifyToolSource, isLowValuePath, type ToolSourceType } from '../utils/token-estimate';

/**
 * Minimal structural shape of a persisted workflow event row, carrying only the
 * fields the builder reads. Structurally compatible with core's `WorkflowEventRow`
 * (Decision 1) without creating an import edge back to `@archon/core`.
 */
export interface ContextBudgetEventInput {
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
}

// Event-type string literals the builder recognises (Decision 5 — Phase 1 is
// read-only, so these are plain strings, NOT the closed WORKFLOW_EVENT_TYPES union).
const EVENT_CONTEXT_BUDGET_COMPUTED = 'context_budget_computed';
const EVENT_NODE_COMPLETED = 'node_completed';
const EVENT_TOOL_CALLED = 'tool_called';

/** Default `over_budget` threshold (percent of budget) when none is configured. */
const DEFAULT_WARN_AT_PERCENT = 100;

// ---------------------------------------------------------------------------
// Small defensive readers
// ---------------------------------------------------------------------------

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Basename of a path, tolerating both `/` and `\` separators. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || normalized;
}

/** Best-effort test-file heuristic for the `no_test_context` warning (D4). */
function isTestPath(path: string): boolean {
  const p = path.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('_test.') ||
    p.includes('/__tests__/') ||
    p.includes('/test/') ||
    p.includes('/tests/')
  );
}

// ---------------------------------------------------------------------------
// Per-node aggregation scratch state
// ---------------------------------------------------------------------------

interface NodeAccumulator {
  nodeId: string;
  estimatedPromptTokens: number;
  budgetTokens: number | undefined;
  actualTokens: ContextBudgetTokenUsage | undefined;
  reads: ContextBudgetItem[];
}

function newAccumulator(nodeId: string): NodeAccumulator {
  return {
    nodeId,
    estimatedPromptTokens: 0,
    budgetTokens: undefined,
    actualTokens: undefined,
    reads: [],
  };
}

/**
 * Build the L3 read item for a `tool_called` event, or `null` for tools that are
 * not context reads. L3 measures files the agent read — `Read`/`Edit` (file-read),
 * `Grep` (grep), and `Bash` (bash). Other tools (WebFetch, Task, …) are not reads
 * and have no valid `sourceType` in the model, so they are skipped.
 */
function buildReadItem(nodeId: string, data: Record<string, unknown>): ContextBudgetItem | null {
  const toolName = readString(data.tool_name) ?? 'unknown';
  const source: ToolSourceType = classifyToolSource(toolName);
  if (source === 'other') return null;

  const toolInput = readRecord(data.tool_input);

  // Defensive extraction per the Risk table: file_path for Read/Edit, pattern for
  // Grep, command for Bash; missing fields fall back to the tool name only.
  const filePath = readString(toolInput.file_path);
  const pattern = readString(toolInput.pattern);
  const command = readString(toolInput.command);
  const detail = filePath ?? pattern ?? command;

  let label: string;
  if (source === 'file-read' && filePath) label = basename(filePath);
  else if (source === 'grep' && pattern) label = pattern;
  else if (source === 'bash' && command) label = command;
  else label = detail ?? toolName;

  const item: ContextBudgetItem = {
    nodeId,
    layer: 'dynamic-read',
    sourceType: source,
    label,
  };
  if (detail !== undefined) item.detail = detail;
  return item;
}

/** Representative token count used for the `over_budget` comparison. */
function measuredTokens(acc: NodeAccumulator): number {
  if (acc.actualTokens) {
    return acc.actualTokens.total ?? acc.actualTokens.input + acc.actualTokens.output;
  }
  return acc.estimatedPromptTokens;
}

/** Compute advisory warnings for one node. */
function computeWarnings(
  acc: NodeAccumulator,
  config: ContextBudgetConfig | undefined
): ContextBudgetWarning[] {
  const warnings: ContextBudgetWarning[] = [];

  // over_budget — measured usage at/above warnAtPercent of the resolved budget.
  const budget = acc.budgetTokens ?? config?.maxTokens;
  if (budget !== undefined && budget > 0) {
    const warnAtPercent = config?.warnAtPercent ?? DEFAULT_WARN_AT_PERCENT;
    const threshold = (budget * warnAtPercent) / 100;
    const measured = measuredTokens(acc);
    if (measured >= threshold) {
      warnings.push({
        nodeId: acc.nodeId,
        code: 'over_budget',
        message: `node '${acc.nodeId}' used ~${measured} tokens, at/above ${warnAtPercent}% of the ${budget}-token budget`,
      });
    }
  }

  // low_value_read — lockfiles / generated files read while the toggle is on.
  // Scoped to file-read items: a bash command or grep pattern whose detail string
  // coincidentally matches a lockfile name is not a file read of a low-value file.
  if (config?.warnOnLowValueReads) {
    const seen = new Set<string>();
    for (const read of acc.reads) {
      if (read.sourceType !== 'file-read') continue;
      const path = read.detail;
      if (path === undefined || !isLowValuePath(path) || seen.has(path)) continue;
      seen.add(path);
      warnings.push({
        nodeId: acc.nodeId,
        code: 'low_value_read',
        message: `low-value read: ${path}`,
      });
    }
  }

  // no_test_context — node read source files but none look like tests (D4, best-effort).
  const fileReadPaths = acc.reads
    .filter(r => r.sourceType === 'file-read')
    .map(r => r.detail)
    .filter((detail): detail is string => detail !== undefined);
  if (fileReadPaths.length > 0 && !fileReadPaths.some(isTestPath)) {
    warnings.push({
      nodeId: acc.nodeId,
      code: 'no_test_context',
      message: `node '${acc.nodeId}' read ${fileReadPaths.length} file(s) but no test files — expected context may be missing`,
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// buildContextBudgetReport
// ---------------------------------------------------------------------------

/**
 * Aggregate a run's workflow events into a `ContextBudgetReport`.
 *
 * Pure. Groups events by `step_name` (node id), reconstructs the three layers
 * (L1 from `context_budget_computed`, L2 from `node_completed.data.tokens`, L3
 * from `tool_called`), computes advisory warnings, and rolls up totals. Nodes
 * appear in first-seen event order for deterministic output.
 *
 * @param workflowRunId The run these events belong to (the report needs it; the
 *   minimal event input type intentionally omits the row's `workflow_run_id` per
 *   Decision 1, so it is passed explicitly — the Phase-3 core op already has it).
 */
export function buildContextBudgetReport(
  workflowRunId: string,
  events: readonly ContextBudgetEventInput[],
  config?: ContextBudgetConfig
): ContextBudgetReport {
  const accumulators = new Map<string, NodeAccumulator>();

  const accFor = (stepName: string): NodeAccumulator => {
    let acc = accumulators.get(stepName);
    if (!acc) {
      acc = newAccumulator(stepName);
      accumulators.set(stepName, acc);
    }
    return acc;
  };

  for (const event of events) {
    const stepName = event.step_name;
    if (stepName === null || stepName.length === 0) continue; // run-level events have no node
    const data = event.data ?? {};

    switch (event.event_type) {
      case EVENT_CONTEXT_BUDGET_COMPUTED: {
        const acc = accFor(stepName);
        const estimate = readNumber(data.estimatedPromptTokens);
        if (estimate !== undefined) acc.estimatedPromptTokens += estimate;
        const budget = readNumber(data.budgetTokens);
        if (budget !== undefined) acc.budgetTokens = budget;
        break;
      }
      case EVENT_NODE_COMPLETED: {
        const acc = accFor(stepName);
        const parsed = contextBudgetTokenUsageSchema.safeParse(data.tokens);
        if (parsed.success) acc.actualTokens = parsed.data;
        break;
      }
      case EVENT_TOOL_CALLED: {
        const acc = accFor(stepName);
        const item = buildReadItem(stepName, data);
        if (item !== null) acc.reads.push(item);
        break;
      }
      default:
        // Unrecognised event types are ignored (Phase 1 is read-only).
        break;
    }
  }

  const nodes: ContextBudgetNodeReport[] = [];
  let totalEstimated = 0;
  let totalActual = 0;
  let totalActualSeen = false;
  let totalCost = 0;
  let totalCostSeen = false;

  for (const acc of accumulators.values()) {
    const node: ContextBudgetNodeReport = {
      nodeId: acc.nodeId,
      estimatedPromptTokens: acc.estimatedPromptTokens,
      reads: acc.reads,
      warnings: computeWarnings(acc, config),
    };
    if (acc.budgetTokens !== undefined) node.budgetTokens = acc.budgetTokens;
    if (acc.actualTokens !== undefined) node.actualTokens = acc.actualTokens;
    nodes.push(node);

    totalEstimated += acc.estimatedPromptTokens;
    if (acc.actualTokens) {
      totalActualSeen = true;
      totalActual += acc.actualTokens.total ?? acc.actualTokens.input + acc.actualTokens.output;
      if (acc.actualTokens.cost !== undefined) {
        totalCostSeen = true;
        totalCost += acc.actualTokens.cost;
      }
    }
  }

  const totals: ContextBudgetReport['totals'] = { estimatedPromptTokens: totalEstimated };
  if (totalActualSeen) totals.actualTokens = totalActual;
  if (totalCostSeen) totals.costUsd = totalCost;

  return { workflowRunId, nodes, totals };
}
