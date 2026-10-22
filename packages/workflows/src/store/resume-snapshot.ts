import type { RunUsageFigures } from '../dag/usage';
import type { FanOutInstanceSnapshot } from '../fan-out-identity';
import type { DeclaredOutputPaths } from '../output-ref';
import type { RunBudgetUsage } from '../run-budget';
import type { NodeExecutionMetadata, NodeFailureKind } from '../schemas/node-execution';

/**
 * One completed node's persisted result, as rehydrated for resume (#2637).
 * `structuredOutput` is the logical value the node's `node_completed` event carried
 * under `structured_output`; absent for text-only nodes and rows persisted before
 * the key existed — those degrade to text re-parsing, the pre-#2637 behavior.
 * `declaredOutputPaths` is the field-path contract the node completed under. Resume
 * uses it only for a producer whose loaded definition states no contract, such as a
 * `workflow:` node whose contract is the child's; a local producer's own schema wins.
 * A row with only the legacy `declared_fields` reads as depth-1 paths.
 */
export interface PersistedNodeOutput {
  output: string;
  structuredOutput?: unknown;
  declaredOutputPaths?: DeclaredOutputPaths;
  /** Present only when resume recovered a preview rather than the full text.
   * Replay must retain this original provenance instead of certifying the preview. */
  outputTruncation?: { originalBytes: number | null; spillPath: string | null };
  /**
   * The execution facts of the completion this output came from, carried across prior-
   * success replays so a resumed consumer reads the same producer record a fresh run
   * would (`$node.execution.checkoutStart`). Absent on rows written before those facts.
   */
  execution?: NodeExecutionMetadata;
}

/** A node whose latest record in a prior pass is its failure. */
export interface PriorFailedNode {
  error: string;
  failureKind?: NodeFailureKind;
}

export interface DagResumeSnapshot extends RunUsageFigures {
  /** Cumulative usage already reported for each child run, keyed by child run id. */
  reportedChildUsage?: Map<string, RunUsageFigures>;
  /** Historical workflow spend with no unambiguous child attribution, keyed by path. */
  unattributedChildUsagePaths?: Set<string>;
  /** Latest unfinished invocation, keyed by canonical path and enclosing loop lineage. */
  unfinishedInvocations?: Map<string, NodeExecutionMetadata>;
  completedNodeOutputs: Map<string, PersistedNodeOutput>;
  /** Nodes whose latest record is `node_failed`; a run continued after a pause replays them. */
  failedNodes: Map<string, PriorFailedNode>;
  /** First durable ordered snapshot for each instance-qualified composed fan-out scope. */
  fanOutSnapshots: Map<string, readonly FanOutInstanceSnapshot[]>;
  /** Node/instance starts with no later terminal event, in lifecycle order. */
  unresolvedNodeStarts: Set<string>;
  /**
   * Run-budget consumption rebuilt from work-unit rows and `agent` attempt rows. Kept apart
   * from `costUsd`, which is telemetry and cannot tell unknown spend from none.
   */
  budget: RunBudgetUsage;
}
