/**
 * MetricsWriter — accumulates workflow event data and writes metrics.json
 * to the run's artifacts directory on workflow completion or failure.
 * Also appends a summary line to ~/.archon/metrics/runs-YYYY-MM.jsonl.
 *
 * Non-blocking by design: all I/O errors are caught and logged, never thrown.
 */
import { writeFile, mkdir, appendFile } from 'fs/promises';
import { join } from 'path';
import { createLogger, getArchonHome } from '@archon/paths';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from './event-emitter';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflows.metrics-writer');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface NodeRecord {
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  state: 'pending' | 'completed' | 'failed' | 'skipped';
  failureReason?: string;
  skipReason?: string;
}

interface CodebaseFingerprint {
  repo: string;
  commitSha: string;
  workingPath: string;
  claudeMdHash?: string;
}

interface SizeProxyRecord {
  inputWordCount?: number;
  gitAdditions?: number;
  gitDeletions?: number;
  gitChangedFiles?: number;
}

interface ClassificationRecord {
  issueType?: string;
  area?: string;
  scope?: string;
  confidence?: string;
  rawFields?: Record<string, unknown>;
}

interface MetricsAccumulator {
  runId: string;
  workflowName: string;
  nodesTotal: number;
  startedAt: number;
  completedAt?: number;
  outcome: 'pending' | 'success' | 'failed' | 'cancelled';
  failureMode?: string;
  nodes: Map<string, NodeRecord>;
  loopIterations: Map<string, number>;
  retries: Map<string, number>;
  approvals: { nodeId: string; decision: 'approved' | 'rejected'; waitMs: number }[];
  totalCostUsd: number;
  fingerprint?: CodebaseFingerprint;
  sizeProxy?: SizeProxyRecord;
  classification?: ClassificationRecord;
}

// ---------------------------------------------------------------------------
// Schema types (matches METRICS.md §4b structure)
// ---------------------------------------------------------------------------

interface NodeCostEntry {
  id: string;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  usd?: number;
}

export interface MetricsJson {
  schema_version: 1;
  run_id: string;
  workflow: string;
  started_at: string;
  completed_at: string;
  wall_clock_ms: number;
  outcome: string;
  failure_mode: string | null;
  execution: {
    nodes_defined: number;
    nodes_executed: number;
    nodes_skipped: number;
    loop_iterations: Record<string, number>;
    retries: Record<string, number>;
  };
  cost: {
    total_usd: number;
    by_node: NodeCostEntry[];
  };
  human: {
    approval_gates: number;
    approvals: { node_id: string; decision: string; wait_ms: number }[];
  };
  outcome_followup: {
    pr_number: null;
    pr_merged: null;
    pr_merged_at: null;
    ci_passed: null;
  };
  codebase_fingerprint: CodebaseFingerprint | null;
  input?: {
    word_count?: number;
    git_additions?: number;
    git_deletions?: number;
    git_changed_files?: number;
    classification?: {
      issue_type?: string;
      area?: string;
      scope?: string;
      confidence?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// MetricsWriter class
// ---------------------------------------------------------------------------

export class MetricsWriter {
  private acc: MetricsAccumulator;
  private artifactsDir: string;
  private unsubscribeFn: (() => void) | null = null;
  private written = false;

  constructor(runId: string, workflowName: string, artifactsDir: string) {
    this.artifactsDir = artifactsDir;
    this.acc = {
      runId,
      workflowName,
      nodesTotal: 0,
      startedAt: Date.now(),
      outcome: 'pending',
      nodes: new Map(),
      loopIterations: new Map(),
      retries: new Map(),
      approvals: [],
      totalCostUsd: 0,
    };

    this.unsubscribeFn = getWorkflowEventEmitter().subscribe(event => {
      this.handleEvent(event);
    });
  }

  private handleEvent(event: WorkflowEmitterEvent): void {
    if (event.runId !== this.acc.runId) return;

    switch (event.type) {
      case 'workflow_started':
        this.acc.nodesTotal = event.nodesTotal ?? 0;
        break;

      case 'workflow_fingerprint':
        this.acc.fingerprint = {
          repo: event.repo,
          commitSha: event.commitSha,
          workingPath: event.workingPath,
          ...(event.claudeMdHash !== undefined ? { claudeMdHash: event.claudeMdHash } : {}),
        };
        break;

      case 'node_started': {
        const existing = this.acc.nodes.get(event.nodeId);
        this.acc.nodes.set(event.nodeId, {
          ...(existing ?? {}),
          startedAt: Date.now(),
          state: 'pending',
        });
        break;
      }

      case 'node_completed': {
        const existing = this.acc.nodes.get(event.nodeId);
        this.acc.nodes.set(event.nodeId, {
          ...(existing ?? {}),
          completedAt: Date.now(),
          durationMs: event.duration,
          state: 'completed',
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          ...(event.tokensIn !== undefined ? { tokensIn: event.tokensIn } : {}),
          ...(event.tokensOut !== undefined ? { tokensOut: event.tokensOut } : {}),
          ...(event.cacheRead !== undefined ? { cacheRead: event.cacheRead } : {}),
          ...(event.cacheWrite !== undefined ? { cacheWrite: event.cacheWrite } : {}),
        });
        if (event.costUsd !== undefined) this.acc.totalCostUsd += event.costUsd;
        break;
      }

      case 'node_failed': {
        const existing = this.acc.nodes.get(event.nodeId);
        this.acc.nodes.set(event.nodeId, {
          ...(existing ?? {}),
          completedAt: Date.now(),
          state: 'failed',
          failureReason: event.error,
        });
        break;
      }

      case 'node_skipped': {
        this.acc.nodes.set(event.nodeId, {
          state: 'skipped',
          skipReason: event.reason,
        });
        break;
      }

      case 'loop_iteration_completed': {
        if (event.nodeId === undefined) break;
        const prev = this.acc.loopIterations.get(event.nodeId) ?? 0;
        this.acc.loopIterations.set(event.nodeId, Math.max(prev, event.iteration + 1));
        break;
      }

      case 'retry_attempted': {
        const prev = this.acc.retries.get(event.nodeId) ?? 0;
        this.acc.retries.set(event.nodeId, Math.max(prev, event.attempt));
        break;
      }

      case 'approval_resolved':
        this.acc.approvals.push({
          nodeId: event.nodeId,
          decision: event.decision,
          waitMs: event.waitMs,
        });
        break;

      case 'size_proxy_emitted':
        this.acc.sizeProxy = {
          ...(event.inputWordCount !== undefined ? { inputWordCount: event.inputWordCount } : {}),
          ...(event.gitAdditions !== undefined ? { gitAdditions: event.gitAdditions } : {}),
          ...(event.gitDeletions !== undefined ? { gitDeletions: event.gitDeletions } : {}),
          ...(event.gitChangedFiles !== undefined
            ? { gitChangedFiles: event.gitChangedFiles }
            : {}),
        };
        break;

      case 'classifier_emitted':
        // Last classifier node wins — keeps the richest classification seen
        this.acc.classification = {
          ...(event.issueType !== undefined ? { issueType: event.issueType } : {}),
          ...(event.area !== undefined ? { area: event.area } : {}),
          ...(event.scope !== undefined ? { scope: event.scope } : {}),
          ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
          rawFields: event.rawFields,
        };
        break;

      case 'workflow_completed':
        this.acc.outcome = 'success';
        this.acc.completedAt = Date.now();
        if (event.totalCostUsd !== undefined) this.acc.totalCostUsd = event.totalCostUsd;
        void this.flushAndCleanup();
        break;

      case 'workflow_failed':
        this.acc.outcome = 'failed';
        this.acc.completedAt = Date.now();
        if (event.failureMode !== undefined) this.acc.failureMode = event.failureMode;
        void this.flushAndCleanup();
        break;

      case 'workflow_cancelled':
        this.acc.outcome = 'cancelled';
        this.acc.completedAt = Date.now();
        void this.flushAndCleanup();
        break;

      default:
        break;
    }
  }

  buildMetricsJson(): MetricsJson {
    const { acc } = this;
    const completedAt = acc.completedAt ?? Date.now();
    const wallClockMs = completedAt - acc.startedAt;

    let nodesExecuted = 0;
    let nodesSkipped = 0;
    const byNode: NodeCostEntry[] = [];

    for (const [id, node] of acc.nodes) {
      if (node.state === 'skipped') {
        nodesSkipped++;
      } else {
        nodesExecuted++;
        if (
          node.tokensIn !== undefined ||
          node.tokensOut !== undefined ||
          node.costUsd !== undefined
        ) {
          byNode.push({
            id,
            ...(node.tokensIn !== undefined ? { tokens_in: node.tokensIn } : {}),
            ...(node.tokensOut !== undefined ? { tokens_out: node.tokensOut } : {}),
            ...(node.cacheRead !== undefined ? { cache_read: node.cacheRead } : {}),
            ...(node.cacheWrite !== undefined ? { cache_write: node.cacheWrite } : {}),
            ...(node.costUsd !== undefined ? { usd: node.costUsd } : {}),
          });
        }
      }
    }

    const sp = acc.sizeProxy;
    const cl = acc.classification;
    const hasInput = sp !== undefined || cl !== undefined;
    const input: MetricsJson['input'] = hasInput
      ? {
          ...(sp?.inputWordCount !== undefined ? { word_count: sp.inputWordCount } : {}),
          ...(sp?.gitAdditions !== undefined ? { git_additions: sp.gitAdditions } : {}),
          ...(sp?.gitDeletions !== undefined ? { git_deletions: sp.gitDeletions } : {}),
          ...(sp?.gitChangedFiles !== undefined ? { git_changed_files: sp.gitChangedFiles } : {}),
          ...(cl !== undefined
            ? {
                classification: {
                  ...(cl.issueType !== undefined ? { issue_type: cl.issueType } : {}),
                  ...(cl.area !== undefined ? { area: cl.area } : {}),
                  ...(cl.scope !== undefined ? { scope: cl.scope } : {}),
                  ...(cl.confidence !== undefined ? { confidence: cl.confidence } : {}),
                },
              }
            : {}),
        }
      : undefined;

    return {
      schema_version: 1,
      run_id: acc.runId,
      workflow: acc.workflowName,
      started_at: new Date(acc.startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      wall_clock_ms: wallClockMs,
      outcome: acc.outcome,
      failure_mode: acc.failureMode ?? null,
      execution: {
        nodes_defined: acc.nodesTotal,
        nodes_executed: nodesExecuted,
        nodes_skipped: nodesSkipped,
        loop_iterations: Object.fromEntries(acc.loopIterations),
        retries: Object.fromEntries(acc.retries),
      },
      cost: {
        total_usd: acc.totalCostUsd,
        by_node: byNode,
      },
      human: {
        approval_gates: acc.approvals.length,
        approvals: acc.approvals.map(a => ({
          node_id: a.nodeId,
          decision: a.decision,
          wait_ms: a.waitMs,
        })),
      },
      outcome_followup: {
        pr_number: null,
        pr_merged: null,
        pr_merged_at: null,
        ci_passed: null,
      },
      codebase_fingerprint: acc.fingerprint ?? null,
      ...(input !== undefined ? { input } : {}),
    };
  }

  private async flushAndCleanup(): Promise<void> {
    if (this.written) return;
    this.written = true;

    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }

    const metrics = this.buildMetricsJson();

    try {
      const metricsPath = join(this.artifactsDir, 'metrics.json');
      await writeFile(metricsPath, JSON.stringify(metrics, null, 2), 'utf-8');
      getLog().info({ runId: this.acc.runId, metricsPath }, 'metrics.write_completed');
    } catch (err) {
      getLog().warn({ err, runId: this.acc.runId }, 'metrics.write_failed');
    }

    try {
      const metricsDir = join(getArchonHome(), 'metrics');
      await mkdir(metricsDir, { recursive: true });
      const month = new Date(this.acc.startedAt).toISOString().slice(0, 7);
      const jsonlPath = join(metricsDir, `runs-${month}.jsonl`);
      const summary = {
        run_id: metrics.run_id,
        workflow: metrics.workflow,
        outcome: metrics.outcome,
        failure_mode: metrics.failure_mode,
        wall_clock_ms: metrics.wall_clock_ms,
        total_usd: metrics.cost.total_usd,
        nodes_executed: metrics.execution.nodes_executed,
        nodes_skipped: metrics.execution.nodes_skipped,
        repo: metrics.codebase_fingerprint?.repo ?? null,
        commit: metrics.codebase_fingerprint?.commitSha ?? null,
        started_at: metrics.started_at,
        // Regression-relevant input signals (Phase 3)
        input_word_count: metrics.input?.word_count ?? null,
        issue_type: metrics.input?.classification?.issue_type ?? null,
        area: metrics.input?.classification?.area ?? null,
        scope: metrics.input?.classification?.scope ?? null,
      };
      await appendFile(jsonlPath, JSON.stringify(summary) + '\n', 'utf-8');
      getLog().debug({ runId: this.acc.runId, jsonlPath }, 'metrics.jsonl_appended');
    } catch (err) {
      getLog().warn({ err, runId: this.acc.runId }, 'metrics.jsonl_append_failed');
    }
  }
}

/**
 * Create and attach a MetricsWriter for a workflow run.
 * Non-blocking — all I/O errors are swallowed and logged.
 * The writer self-detaches on the first terminal event.
 */
export function attachMetricsWriter(
  runId: string,
  workflowName: string,
  artifactsDir: string
): void {
  // Holds itself alive via the emitter subscription until the terminal event
  // triggers self-cleanup.
  new MetricsWriter(runId, workflowName, artifactsDir);
}
