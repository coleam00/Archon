import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mock fs/promises (writeFile / mkdir / appendFile) ---
// Capture calls so we can assert on what would have been written.
const mockWriteFile = mock(async (_path: string, _data: string, _enc: string) => undefined);
const mockMkdir = mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined);
const mockAppendFile = mock(async (_path: string, _data: string, _enc: string) => undefined);

mock.module('fs/promises', () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  appendFile: mockAppendFile,
}));

// --- Mock @archon/paths (createLogger + getArchonHome) ---
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

// --- Imports under test (after mocks) ---
import { MetricsWriter } from './metrics-writer';
import {
  getWorkflowEventEmitter,
  resetWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from './event-emitter';

const RUN_ID = 'run-test-1';
const WORKFLOW_NAME = 'test-workflow';
const ARTIFACTS_DIR = '/tmp/test-artifacts/run-test-1';

function emit(event: WorkflowEmitterEvent): void {
  getWorkflowEventEmitter().emit(event);
}

describe('MetricsWriter', () => {
  beforeEach(() => {
    resetWorkflowEventEmitter();
    mockWriteFile.mockClear();
    mockMkdir.mockClear();
    mockAppendFile.mockClear();
  });

  it('accumulates node_completed token fields into MetricsJson', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'workflow_started',
      runId: RUN_ID,
      workflowName: WORKFLOW_NAME,
      conversationId: 'conv-1',
      nodesTotal: 2,
    });
    emit({ type: 'node_started', runId: RUN_ID, nodeId: 'plan', nodeName: 'plan' });
    emit({
      type: 'node_completed',
      runId: RUN_ID,
      nodeId: 'plan',
      nodeName: 'plan',
      duration: 1000,
      costUsd: 0.05,
      tokensIn: 100,
      tokensOut: 50,
      cacheRead: 200,
      cacheWrite: 10,
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.cost.by_node).toHaveLength(1);
    expect(metrics.cost.by_node[0]).toMatchObject({
      id: 'plan',
      tokens_in: 100,
      tokens_out: 50,
      cache_read: 200,
      cache_write: 10,
      usd: 0.05,
    });
    expect(metrics.cost.total_usd).toBeCloseTo(0.05, 6);
    expect(metrics.execution.nodes_executed).toBe(1);
    expect(metrics.execution.nodes_skipped).toBe(0);
  });

  it('counts loop iterations as 1-based from 0-based events', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    // Iteration events arrive 0-based; the accumulator stores max iteration + 1.
    emit({
      type: 'loop_iteration_completed',
      runId: RUN_ID,
      nodeId: 'loop-node',
      iteration: 0,
      duration: 100,
      completionDetected: false,
    });
    emit({
      type: 'loop_iteration_completed',
      runId: RUN_ID,
      nodeId: 'loop-node',
      iteration: 1,
      duration: 100,
      completionDetected: false,
    });
    emit({
      type: 'loop_iteration_completed',
      runId: RUN_ID,
      nodeId: 'loop-node',
      iteration: 2,
      duration: 100,
      completionDetected: true,
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.execution.loop_iterations['loop-node']).toBe(3);
  });

  it('records approval waitMs and decision in human.approvals', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'approval_resolved',
      runId: RUN_ID,
      nodeId: 'gate',
      decision: 'approved',
      waitMs: 42_000,
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.human.approval_gates).toBe(1);
    expect(metrics.human.approvals).toEqual([
      { node_id: 'gate', decision: 'approved', wait_ms: 42_000 },
    ]);
  });

  it('flushes only once even if multiple terminal events fire for the same run', async () => {
    new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'workflow_completed',
      runId: RUN_ID,
      workflowName: WORKFLOW_NAME,
      duration: 1000,
    });
    emit({
      type: 'workflow_failed',
      runId: RUN_ID,
      workflowName: WORKFLOW_NAME,
      error: 'should be ignored after completion',
    });
    emit({
      type: 'workflow_cancelled',
      runId: RUN_ID,
      nodeId: 'gate',
      reason: 'user cancelled',
    });

    // Let the queued microtasks flush
    await new Promise(resolve => setTimeout(resolve, 0));

    // writeFile should be invoked exactly once with metrics.json
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writePath = mockWriteFile.mock.calls[0]?.[0] as string;
    expect(writePath.endsWith('/metrics.json')).toBe(true);

    // appendFile should also fire exactly once
    expect(mockAppendFile).toHaveBeenCalledTimes(1);
  });

  it('produces MetricsJson with schema_version: 1', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);
    const metrics = writer.buildMetricsJson();
    expect(metrics.schema_version).toBe(1);
    expect(metrics.run_id).toBe(RUN_ID);
    expect(metrics.workflow).toBe(WORKFLOW_NAME);
  });

  it('only handles events matching its own runId', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'node_completed',
      runId: 'unrelated-run',
      nodeId: 'foo',
      nodeName: 'foo',
      duration: 10,
      costUsd: 99,
      tokensIn: 999,
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.cost.by_node).toHaveLength(0);
    expect(metrics.cost.total_usd).toBe(0);
  });

  it('uses workflow_completed totalCostUsd when provided (overrides per-node sum)', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'node_completed',
      runId: RUN_ID,
      nodeId: 'a',
      nodeName: 'a',
      duration: 10,
      costUsd: 0.01,
    });
    emit({
      type: 'workflow_completed',
      runId: RUN_ID,
      workflowName: WORKFLOW_NAME,
      duration: 100,
      totalCostUsd: 0.99,
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.cost.total_usd).toBeCloseTo(0.99, 6);
    expect(metrics.outcome).toBe('success');
  });

  it('captures fingerprint from workflow_fingerprint event', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'workflow_fingerprint',
      runId: RUN_ID,
      repo: 'owner/repo',
      commitSha: 'abc1234',
      workingPath: '/work',
      claudeMdHash: 'deadbeef',
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.codebase_fingerprint).toEqual({
      repo: 'owner/repo',
      commitSha: 'abc1234',
      workingPath: '/work',
      claudeMdHash: 'deadbeef',
    });
  });

  it('counts skipped nodes separately from executed nodes', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({ type: 'node_completed', runId: RUN_ID, nodeId: 'a', nodeName: 'a', duration: 10 });
    emit({
      type: 'node_skipped',
      runId: RUN_ID,
      nodeId: 'b',
      nodeName: 'b',
      reason: 'when_condition',
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.execution.nodes_executed).toBe(1);
    expect(metrics.execution.nodes_skipped).toBe(1);
  });

  it('accumulates size_proxy_emitted into the input section', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'size_proxy_emitted',
      runId: RUN_ID,
      inputWordCount: 42,
      gitAdditions: 100,
      gitDeletions: 20,
      gitChangedFiles: 3,
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.input).toEqual({
      word_count: 42,
      git_additions: 100,
      git_deletions: 20,
      git_changed_files: 3,
    });
  });

  it('omits undefined fields from size_proxy_emitted output', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'size_proxy_emitted',
      runId: RUN_ID,
      inputWordCount: 7,
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.input).toEqual({ word_count: 7 });
  });

  it('accumulates classifier_emitted into input.classification', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'classifier_emitted',
      runId: RUN_ID,
      nodeId: 'classify',
      issueType: 'bug',
      area: 'api',
      scope: 'small',
      confidence: 'high',
      rawFields: { issue_type: 'bug', area: 'api', scope: 'small', confidence: 'high' },
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.input?.classification).toEqual({
      issue_type: 'bug',
      area: 'api',
      scope: 'small',
      confidence: 'high',
    });
  });

  it('uses last-write-wins semantics for classifier_emitted', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'classifier_emitted',
      runId: RUN_ID,
      nodeId: 'first',
      issueType: 'feature',
      area: 'web-ui',
      rawFields: { issue_type: 'feature', area: 'web-ui' },
    });
    emit({
      type: 'classifier_emitted',
      runId: RUN_ID,
      nodeId: 'second',
      issueType: 'bug',
      area: 'cli',
      scope: 'medium',
      rawFields: { issue_type: 'bug', area: 'cli', scope: 'medium' },
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.input?.classification).toEqual({
      issue_type: 'bug',
      area: 'cli',
      scope: 'medium',
    });
  });

  it('combines size_proxy_emitted and classifier_emitted into a single input section', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'size_proxy_emitted',
      runId: RUN_ID,
      inputWordCount: 12,
    });
    emit({
      type: 'classifier_emitted',
      runId: RUN_ID,
      nodeId: 'classify',
      issueType: 'chore',
      rawFields: { issue_type: 'chore' },
    });

    const metrics = writer.buildMetricsJson();
    expect(metrics.input).toEqual({
      word_count: 12,
      classification: { issue_type: 'chore' },
    });
  });

  it('omits input section when no size_proxy_emitted or classifier_emitted events fired', () => {
    const writer = new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);
    const metrics = writer.buildMetricsJson();
    expect(metrics.input).toBeUndefined();
  });

  it('includes input fields in the JSONL summary line', async () => {
    new MetricsWriter(RUN_ID, WORKFLOW_NAME, ARTIFACTS_DIR);

    emit({
      type: 'size_proxy_emitted',
      runId: RUN_ID,
      inputWordCount: 25,
    });
    emit({
      type: 'classifier_emitted',
      runId: RUN_ID,
      nodeId: 'classify',
      issueType: 'bug',
      area: 'db',
      scope: 'large',
      rawFields: { issue_type: 'bug', area: 'db', scope: 'large' },
    });
    emit({
      type: 'workflow_completed',
      runId: RUN_ID,
      workflowName: WORKFLOW_NAME,
      duration: 1000,
    });

    // Let queued microtasks flush
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const appendedRaw = mockAppendFile.mock.calls[0]?.[1] as string;
    const summary = JSON.parse(appendedRaw.trim()) as Record<string, unknown>;
    expect(summary.input_word_count).toBe(25);
    expect(summary.issue_type).toBe('bug');
    expect(summary.area).toBe('db');
    expect(summary.scope).toBe('large');
  });
});
