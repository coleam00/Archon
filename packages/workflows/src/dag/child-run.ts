import { readSubrunMetadata, type WorkflowNode, type WorkflowRun } from '../schemas';
import { parseRunUsage } from '../schemas/run-usage';
import type { RunUsageFigures } from '../schemas/run-usage';
import type { DeclaredOutputPaths, JsonValue } from '../output-ref';

/** Terminal (or paused) outcome of a child sub-run, as consumed by a `workflow:` node. */
export interface ChildWorkflowOutcome extends RunUsageFigures {
  childRunId: string;
  status: 'completed' | 'paused' | 'failed' | 'cancelled';
  /** Child's terminal output (its first sink node's output), threaded as `$<id>.output`. */
  output?: string;
  /**
   * The terminal node's structured payload (#2637), read from `metadata.summary_value`
   * when the child stamped one. Threads the LOGICAL value back to the parent so
   * `$<id>.output.field` access and fan-out aggregation keep the type instead of
   * re-encoding the text. Absent for text-only children and pre-#2637 rows.
   */
  structuredOutput?: unknown;
  /**
   * Field paths the child's selected `returns:` node declared (#2453), read from the
   * run's subrun metadata. This is what authorizes a parent's `$<node>.output.a.b`: the
   * child owns the contract, and a `workflow:` node cannot declare one of its own.
   * Absent for schemaless children and pre-#2453 rows — those carry no contract at all.
   */
  declaredOutputPaths?: DeclaredOutputPaths;
  error?: string;
}

/** Arguments for starting (or resuming a failed) child sub-run. */
export interface RunChildWorkflowArgs {
  parentRun: WorkflowRun;
  nodeId: string;
  childWorkflowName: string;
  /** Data string forwarded as the child's user_message (substituted upstream). */
  input: string;
  cwd: string;
  /** Platform conversation id (shared with the parent). */
  conversationId: string;
  userId?: string;
  /** Codebase id inherited from the parent (env vars + attribution). */
  codebaseId?: string;
  /**
   * Per-child isolation mode (#2121 slice 2, PR-A). `'worktree'` runs the child in
   * its own git worktree via the injected child-isolation resolver; `'inherit'`
   * (or undefined) shares the parent's checkout. Threaded from `node.isolation`.
   */
  isolation?: WorkflowNode['isolation'];
  /**
   * Fan-out instance index (#2121 slice 2, PR-C). Set when this child is one of N
   * spawned by a `fan_out:` node; stamped into the child's `metadata.child_index` so
   * parent resume can re-key the ordered instance set by index. Undefined for a
   * single (non-fan-out) `workflow:` child. Also seeds the per-child worktree branch
   * identifier so N fan-out children get distinct worktrees.
   */
  childIndex?: number;
  /**
   * Content hash of a fan-out child's input (#2121 slice 2, PR-C). Stamped into
   * `metadata.fan_out_item_hash` at spawn so parent resume can WARN when a
   * non-deterministic items producer changed the item at a given index (never re-keys).
   */
  itemHash?: string;
  /** Present only when re-driving an existing child on parent resume. */
  resumeChild?:
    | { kind: 'failed'; run: WorkflowRun }
    | { kind: 'fan-out-cancelled'; run: WorkflowRun };
  /**
   * Named inputs (#2470) — the resolved `with:` map the parent supplied, plus (for a
   * fan-out child) the per-item `fan_out.as` entry. Logical JSON values (#2637).
   * Persisted to the child's `metadata.inputs` (canonical text) plus, when any value
   * is non-string, the `metadata.inputs_values` sibling, so `$INPUTS.<name>` resolves
   * at runtime and reconstitutes typed on cold resume. Undefined/empty when the node
   * declares no `with:`/`as`.
   */
  inputs?: Record<string, JsonValue>;
}

/**
 * Injected closure that starts a child workflow run in-process (#2121 Phase 2).
 * Defined in executor.ts — it captures `executeWorkflow` from the SAME module, so
 * there is no static import cycle — and threaded through executeDagWorkflow →
 * RunLayersContext so a `workflow:` node can spawn its child without dag-executor
 * importing executor.
 */
export type RunChildWorkflowFn = (args: RunChildWorkflowArgs) => Promise<ChildWorkflowOutcome>;

/**
 * Derive a child's node-facing outcome from its persisted run row. Cost and tokens are
 * written into the child's metadata at its run tail regardless of outcome (#2469) and
 * the terminal `summary` at completion, so both the synchronous path (runChildWorkflow
 * reads the row back) and the re-entry path (executeWorkflowNode finds an
 * already-terminal child) read the same source — and a child that burned tokens and
 * then failed or was cancelled still reports what it spent.
 */
export function childOutcomeFromRun(run: WorkflowRun): ChildWorkflowOutcome {
  if (run.status === 'running' || run.status === 'pending') {
    // Fail fast instead of a blind narrowing cast: every caller must hand this a
    // settled (terminal or paused) run. A non-settled status slipping through
    // would fall out of interpret()'s switch and corrupt the node result with
    // `undefined` — throwing turns that into a loud, attributable node failure.
    throw new Error(
      `Sub-run ${run.id} is still '${run.status}' — cannot derive a node outcome from an unsettled run.`
    );
  }
  const md: Record<string, unknown> = run.metadata ?? {};
  // Presence-keyed (#2637): `false`/`0`/`null` are legitimate structured values, so
  // reading through readSubrunMetadata's summaryValue keeps them distinguishable
  // from "not stamped".
  const { summaryValue, summaryDeclaredOutputPaths } = readSubrunMetadata(md);
  return {
    childRunId: run.id,
    status: run.status,
    output: typeof md.summary === 'string' ? md.summary : undefined,
    ...(summaryValue !== undefined ? { structuredOutput: summaryValue } : {}),
    // The child's own field contract (#2453) — read from the row so the synchronous
    // path and the parent re-entry/resume path stay one source, exactly like the
    // summary and usage above.
    ...(summaryDeclaredOutputPaths !== undefined
      ? { declaredOutputPaths: summaryDeclaredOutputPaths }
      : {}),
    ...childRunUsage(run),
    error: typeof md.error === 'string' ? md.error : undefined,
  };
}

/** Usage is available while a child is unresolved as well as after it settles. */
export function childRunUsage(
  run: WorkflowRun
): Pick<ChildWorkflowOutcome, 'costUsd' | 'tokens' | 'tokensUnknown'> {
  return parseRunUsage(run.metadata);
}
