import { afterEach, spyOn, test, expect } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { CONFORMANCE_CODEBASE_ID, describeWorkflowStoreConformance } from '../store-conformance';
import * as telemetry from '../run-terminal-telemetry';
import { createFileWorkflowStore } from './store';
import { commit } from './commit';
const roots = trackTempRoots();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
});
describeWorkflowStoreConformance('files', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'workflow-files-')));
  const reports: string[] = [];
  const spy = spyOn(telemetry, 'reportRunTerminalTelemetry').mockImplementation(run => {
    reports.push(run.id);
  });
  restore = () => spy.mockRestore();
  const store = await createFileWorkflowStore({
    root,
    // The host's codebase records, as every conformance target registers them.
    getCodebase: async id =>
      id === CONFORMANCE_CODEBASE_ID
        ? {
            id,
            name: 'conformance',
            repository_url: null,
            default_cwd: '/conformance',
            kind: 'repo',
          }
        : null,
  });
  return {
    store,
    backdate: (id, dates) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        Object.assign(run, dates);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    seedPersistedWait: (id, wait) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        run.metadata.wait = structuredClone(wait);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    terminalReports: () => [...reports],
    close: async () => {},
  };
});

test('live attention can publish, renew and clear alongside a paused gate', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'paused-attention-')));
  const store = await createFileWorkflowStore({ root });
  const run = await store.createWorkflowRun({ workflow_name: 'test', user_message: '' });
  await store.claimPendingWorkflowRun(run.id);
  const approval = {
    nodeId: 'gate',
    message: 'Review',
    requestedAt: '2026-10-18T06:55:59.000Z',
  };
  await store.pauseWorkflowRun(run.id, approval);
  const at = '2026-10-18T06:55:59.000Z';
  const call = {
    streamId: 'live-sibling',
    nodeId: 'ci',
    provider: 'codex',
    kind: 'provider_turn' as const,
    toolCallId: 'turn:live-sibling',
    name: 'provider turn',
    startedAt: at,
    lastProgressAt: at,
    raisedAt: at,
    thresholdMs: 100,
  };
  expect(await store.setToolCallAttention(run.id, call.streamId, [call])).toBe(true);
  expect((await store.getWorkflowRun(run.id))?.metadata.tool_call_attention).toEqual([call]);
  const renewed = { ...call, raisedAt: '2026-10-18T07:55:59.000Z' };
  expect(await store.setToolCallAttention(run.id, call.streamId, [renewed])).toBe(true);
  expect((await store.getWorkflowRun(run.id))?.metadata.tool_call_attention).toEqual([renewed]);
  expect(await store.setToolCallAttention(run.id, call.streamId, [])).toBe(true);
  const paused = await store.getWorkflowRun(run.id);
  expect(paused?.metadata.tool_call_attention).toBeUndefined();
  expect(paused?.status).toBe('paused');
  expect(paused?.metadata.approval).toEqual(approval);
});
