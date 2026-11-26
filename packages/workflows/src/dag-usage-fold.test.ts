import { describe, expect, it } from 'bun:test';
import { countedUsage, foldDagUsage } from './dag-usage-fold';
import { foldDagResumeSnapshot, type DagResumeEvent } from './dag-resume-snapshot';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeDeferredNodeUsage, serializeNodeStateRecord } from './node-record-serialization';

const started = (path: string, provider = 'claude') =>
  startNodeExecution({
    runId: 'run',
    path,
    node: { id: path, kind: 'agent', source: { kind: 'inline', prompt: 'private-prompt' } },
    invocation: newNodeInvocation([{ groupId: 'rounds', iteration: 2 }]),
    provider,
    sessionId: 'private-session',
  });

describe('shared usage selection', () => {
  it('observes an unmetered attempt without changing numeric admission', () => {
    const start = started('review', 'codex');
    const failed = finishNodeExecution(start, { status: 'failed', error: 'private-error' }, {});
    const fold = foldDagUsage([serializeNodeStateRecord(failed)], 'run');
    expect(fold.usageContributions).toHaveLength(1);
    expect(countedUsage(fold)).toEqual({
      costUsd: undefined,
      tokens: undefined,
      tokensUnknown: false,
      costPartial: true,
    });
    expect(fold.observations[0]).toMatchObject({
      path: 'review',
      nodeKind: 'agent',
      provider: 'codex',
      eventType: 'node_failed',
      invocationId: start.invocation.id,
      attemptId: start.attempt.id,
      loopPath: [{ groupId: 'rounds', iteration: 2 }],
      measurement: {
        tokens: { source: 'unavailable', reason: 'unknown' },
        costUsd: { source: 'unavailable', reason: 'unknown' },
      },
    });
  });

  it('keeps no-spend observations outside the consumed numeric ledger', () => {
    const start = started('not-called');
    const failed = finishNodeExecution(
      start,
      { status: 'failed', error: 'configuration' },
      { providerNotCalled: true }
    );
    const fold = foldDagUsage([serializeNodeStateRecord(failed)], 'run');
    expect(fold.usageContributions).toEqual([]);
    expect(fold.observations[0].measurement).toEqual({
      tokens: { source: 'unavailable', reason: 'not_applicable' },
      costUsd: { source: 'unavailable', reason: 'not_applicable' },
    });
  });

  it('preserves zero, retries and the existing duplicate-terminal charges', () => {
    const start = started('build');
    const failed = serializeNodeStateRecord(
      finishNodeExecution(
        start,
        { status: 'failed', error: 'private-error' },
        { costUsd: 0.25, tokens: { input: 4, output: 2 } }
      )
    );
    const next = started('build');
    const completed = serializeNodeStateRecord(
      finishNodeExecution(
        next,
        { status: 'completed' },
        { costUsd: 0, tokens: { input: 0, output: 0 } }
      )
    );
    const replay: DagResumeEvent = {
      step_name: 'build',
      event_type: 'node_skipped_prior_success',
      data: { type: 'agent', cost_usd: 900, tokens: { input: 900, output: 900 } },
    };
    const fold = foldDagUsage([failed, failed, completed, replay], 'run');
    expect(countedUsage(fold)).toEqual({
      costUsd: 0.5,
      tokens: { input: 8, output: 4 },
      tokensUnknown: false,
      costPartial: false,
    });
    expect(fold.usageContributions).toHaveLength(3);
    expect(fold.usageContributions[2].costUsd).toBe(0);
    expect(fold.usageContributions[0].evidence?.attemptId).toBe(start.attempt.id);
    expect(fold.usageContributions[2].evidence?.attemptId).toBe(next.attempt.id);
    expect(fold.usageContributions[0].evidence).toBe(fold.observations[0]);
    expect(fold.observations[3].eventType).toBe('node_skipped_prior_success');
  });

  it('retains authoritative segment evidence without adding it twice', () => {
    const leaf = (path: string, costUsd: number, input: number): DagResumeEvent => ({
      step_name: path,
      event_type: 'node_completed',
      data: { type: 'agent', provider: 'claude', cost_usd: costUsd, tokens: { input, output: 1 } },
    });
    const fold = foldDagUsage(
      [
        leaf('fan__item__nested__item__leaf', 0.25, 2),
        {
          step_name: 'fan__item__nested__item',
          event_type: 'node_completed',
          data: {
            type: 'compose_fan_out_instance',
            aggregate: true,
            cost_usd: 0.25,
            tokens: { input: 2, output: 1 },
          },
        },
        {
          step_name: 'fan__item',
          event_type: 'node_failed',
          data: {
            type: 'compose_fan_out_instance',
            aggregate: true,
            cost_usd: 0.25,
            tokens: { input: 2, output: 1 },
          },
        },
        leaf('fan__item__later', 0.5, 3),
        {
          step_name: 'group',
          event_type: 'node_completed',
          data: { type: 'loop_group', aggregate: true, cost_usd: 999 },
        },
      ],
      'run'
    );
    expect(countedUsage(fold).costUsd).toBe(0.75);
    expect(countedUsage(fold).tokens).toEqual({ input: 5, output: 2 });
    expect(fold.usageContributions.map(contribution => contribution.stepName)).toEqual([
      'fan__item',
      'fan__item__later',
    ]);
    const segment = fold.usageContributions[0].coveredContributions;
    expect(segment?.[0].stepName).toBe('fan__item__nested__item');
    expect(segment?.[0].coveredContributions?.[0].stepName).toBe('fan__item__nested__item__leaf');
    expect(fold.observations[0].nodeKind).toBe('agent');
    expect(fold.observations[0].measurement).toBeUndefined();
  });

  it('keeps charged and replaced child baselines with their parent paths', () => {
    const row = (path: string, childRunId: string, costUsd: number): DagResumeEvent => ({
      step_name: path,
      event_type: 'node_failed',
      data: { type: 'workflow', cost_usd: costUsd, child_usage: [{ childRunId, costUsd }] },
    });
    const fold = foldDagUsage(
      [
        row('sub', 'old-child', 0.25),
        row('sub', 'new-child', 0.5),
        row('other-sub', 'old-child', 0.25),
      ],
      'run'
    );
    expect(countedUsage(fold).costUsd).toBe(1);
    expect([...fold.reportedChildUsage.keys()]).toEqual(['old-child', 'new-child']);
    expect([...(fold.childUsagePaths.get('old-child') ?? [])]).toEqual(['sub', 'other-sub']);
    expect(fold.reportedChildUsage.get('old-child')?.costUsd).toBe(0.25);
  });

  it('replaces a carried loop baseline while retaining deferred measurement provenance', () => {
    const start = startNodeExecution({
      runId: 'run',
      path: 'loop',
      node: {
        id: 'loop',
        kind: 'loop',
        loop: { prompt: 'private-prompt', until: 'DONE', max_iterations: 2, fresh_context: false },
      },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
    const failed = finishNodeExecution(
      start,
      { status: 'failed', error: 'private-error', failureKind: 'config' },
      { costUsd: 0.25, tokens: { input: 2, output: 1 }, costPartial: true }
    );
    const deferred = serializeDeferredNodeUsage(
      finishNodeExecution(
        start,
        { status: 'suspended', point: 'interactive_loop' },
        { costUsd: 0.5, tokens: { input: 3, output: 2 } }
      )
    );
    const fold = foldDagUsage([serializeNodeStateRecord(failed), deferred], 'run');
    expect(countedUsage(fold)).toEqual({
      costUsd: 0.5,
      tokens: { input: 3, output: 2 },
      tokensUnknown: false,
      costPartial: false,
    });
    expect(fold.usageContributions).toHaveLength(1);
    expect(fold.usageContributions[0].loopBaseline).toBeUndefined();
    expect(fold.usageContributions[0].evidence).toMatchObject({
      nodeKind: 'loop',
      eventType: 'node_deferred_usage',
      invocationId: start.invocation.id,
      measurement: { costUsd: { source: 'provider', value: 0.5 } },
    });
    expect(fold.usageContributions[0].evidence?.provider).toBeUndefined();
    expect(fold.usageContributions[0].evidence?.attemptId).toBeUndefined();
  });

  it('projects only usage identities and gross measurement evidence', () => {
    const start = started('build');
    const record = finishNodeExecution(
      start,
      { status: 'completed' },
      {
        costUsd: 0.25,
        costPartial: true,
        tokens: {
          input: 2,
          output: 1,
          cachePartial: true,
          callsPartial: true,
          calls: [
            {
              model: 'private-model',
              responseId: 'private-response',
              input: 2,
              output: 1,
            },
          ],
        },
        output: { text: 'private-output', structured: { message: 'private-structured-output' } },
        sessionId: 'private-new-session',
      }
    );
    const fold = foldDagUsage([serializeNodeStateRecord(record)], 'run');
    const json = JSON.stringify(fold.observations);
    for (const marker of [
      'private-prompt',
      'private-output',
      'private-structured-output',
      'private-session',
      'private-new-session',
      'private-model',
      'private-response',
    ])
      expect(json).not.toContain(marker);
    expect(fold.observations[0].measurement).toEqual({
      tokens: {
        source: 'provider',
        value: { input: 2, output: 1, cachePartial: true, callsPartial: true },
      },
      costUsd: { source: 'provider', value: 0.25, partial: true },
    });
  });

  it('uses the pure selection without reading output spills', async () => {
    const rows: DagResumeEvent[] = [
      {
        step_name: 'build',
        event_type: 'node_completed',
        data: {
          type: 'agent',
          node_output: 'private-output',
          cost_usd: 0.25,
          tokens: { input: 2, output: 1 },
        },
      },
    ];
    const pure = countedUsage(foldDagUsage(rows, 'run'));
    expect(pure.costUsd).toBe(0.25);
    expect(pure.tokens).toEqual({ input: 2, output: 1 });
    const snapshot = await foldDagResumeSnapshot(rows, 'run');
    expect(snapshot.costUsd).toBe(pure.costUsd);
    expect(snapshot.tokens).toEqual(pure.tokens);
    expect(snapshot.tokensUnknown).toBe(pure.tokensUnknown);
    expect(snapshot.costPartial).toBe(pure.costPartial);
    expect(snapshot.completedNodeOutputs.get('build')?.output).toBe('private-output');
  });

  it('does not weaken strict malformed execution handling', async () => {
    const row: DagResumeEvent = {
      step_name: 'build',
      event_type: 'node_completed',
      data: { spend: {} },
    };
    expect(() => foldDagUsage([row], 'run')).toThrow();
    await expect(foldDagResumeSnapshot([row], 'run')).rejects.toThrow();
    expect(() =>
      foldDagUsage([{ ...row, event_type: 'node_deferred_usage', data: '{' }], 'run')
    ).toThrow();
    await expect(
      foldDagResumeSnapshot([{ ...row, event_type: 'node_deferred_usage', data: '{' }], 'run')
    ).rejects.toThrow();
  });
});
