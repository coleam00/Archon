import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { getProjectStoragePaths, resolveProjectStorageKey } from '@archon/paths/archon-paths';
import { providerRegistry } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import type { AttentionQueueItem } from '@archon/workflows/attention-queue';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  createInMemoryWorkflowHostStore,
  createInMemoryWorkflowStore,
} from '../test-support/workflow-store';
import { stateCommand } from './state';
import { workflowAttentionCommand, workflowAttentionLabelCommand } from './workflow';

const track = trackTempRoots();
const priorEnv = { ...process.env };
afterEach(() => {
  process.env = { ...priorEnv };
});

function createHost(): WorkflowHost {
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  const deps = {
    store,
    providers: providerRegistry,
    loadConfig,
    getAgentProvider: (): never => {
      throw new Error('No provider');
    },
  };
  const unused = async (): Promise<never> => {
    throw new Error('Unused');
  };
  return {
    deps,
    records,
    engine: new InProcessWorkflowEngine(deps),
    operations: createWorkflowOperations({
      getUserRole: async () => undefined,
      store: { ...store, deleteWorkflowRun: unused },
      hostStore: records,
      requestDetachedRunStop: unused,
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: async () => false,
      reclaimRunWorktree: unused,
      reclaimContainerEnv: unused,
    }),
  };
}

/** The JSON document a command writes to stdout, and its exit code. */
async function captured(command: () => Promise<number>): Promise<{ code: number; json: unknown }> {
  const chunks: string[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
    done?: (error?: Error | null) => void
  ) => {
    chunks.push(chunk);
    done?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await command();
    // The test logger shares stdout; the command's own output is its last document.
    return { code, json: JSON.parse(chunks.at(-1) ?? '') };
  } finally {
    write.mockRestore();
  }
}

test('the queue scopes by project the way archon state names it, across a rename', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'attention-cli-')));
  process.env.ARCHON_HOME = join(root, 'home');
  const directory = (name: string): string => {
    mkdirSync(join(root, name));
    return realpathSync(join(root, name));
  };
  const registeredDir = directory('alpha');
  const scratchDir = directory('scratch');
  const host = createHost();
  const { store } = host.deps;
  // Registered under its new name; the run paused before the rename keeps the old key.
  const codebase = await host.records.codebases.createCodebase({
    name: 'beta',
    default_cwd: registeredDir,
    kind: 'folder',
  });
  const rootFor = (name: string | null, cwd: string): string =>
    getProjectStoragePaths(
      resolveProjectStorageKey(
        name === null ? null : { name, kind: 'folder', default_cwd: cwd },
        cwd
      )
    ).root;
  const pause = async (
    codebaseId: string | undefined,
    outputRoot: string,
    labels: Record<string, string>
  ): Promise<string> => {
    const run = await store.createWorkflowRun({
      workflow_name: 'ci',
      user_message: '',
      ...(codebaseId ? { codebase_id: codebaseId } : {}),
    });
    await store.claimPendingWorkflowRun(run.id);
    await store.updateWorkflowRun(run.id, { output_root: outputRoot });
    await store.pauseWorkflowRunForWait(
      run.id,
      {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: new Date().toISOString(),
        message: 'CI is red. Retry?',
        pauseId: `pause-${run.id}`,
        form: 'approval',
        labels,
      },
      { kind: 'started', stepName: 'ask' }
    );
    return run.id;
  };
  const current = await pause(codebase.id, rootFor('beta', registeredDir), { ci: 'other' });
  const renamed = await pause(codebase.id, rootFor('alpha', registeredDir), { ci: 'pr' });
  const unregistered = await pause(undefined, rootFor(null, scratchDir), { ci: 'other' });

  const list = async (
    cwd: string,
    opts: Partial<Parameters<typeof workflowAttentionCommand>[3]> = {}
  ): Promise<AttentionQueueItem[]> => {
    const { code, json } = await captured(() =>
      workflowAttentionCommand(host, cwd, undefined, { json: true, labels: [], ...opts })
    );
    expect(code).toBe(0);
    return (json as { items: AttentionQueueItem[] }).items;
  };
  const stateKey = async (cwd: string): Promise<string> => {
    const output: unknown[] = [];
    expect(
      await stateCommand(
        host,
        'get',
        ['probe/doc'],
        { cwd },
        { env: {}, write: async value => void output.push(value) }
      )
    ).toBe(0);
    return (output[0] as { scope: { key: string } }).scope.key;
  };

  const registered = await list(registeredDir);
  expect(registered.map(item => item.runId).sort()).toEqual([current, renamed].sort());
  expect(registered.find(item => item.runId === current)?.project).toEqual({
    key: await stateKey(registeredDir),
    codebaseId: codebase.id,
    name: 'beta',
  });
  expect(registered.find(item => item.runId === renamed)?.project).toEqual({
    key: '_folder/alpha',
    codebaseId: codebase.id,
    name: 'beta',
  });
  expect((await list(scratchDir, { project: 'beta' })).map(item => item.runId).sort()).toEqual(
    [current, renamed].sort()
  );

  const scratch = await list(scratchDir);
  expect(scratch.map(item => item.runId)).toEqual([unregistered]);
  expect(scratch[0]?.project).toEqual({
    key: await stateKey(scratchDir),
    codebaseId: null,
    name: 'scratch',
  });
  expect((await list(registeredDir, { project: '_cwd/scratch' })).map(item => item.runId)).toEqual([
    unregistered,
  ]);

  expect((await list(registeredDir, { all: true })).map(item => item.runId).sort()).toEqual(
    [current, renamed, unregistered].sort()
  );
  expect(
    (await list(registeredDir, { all: true, labels: ['ci=other'] })).map(item => item.runId).sort()
  ).toEqual([current, unregistered].sort());

  const labeled = await captured(() =>
    workflowAttentionLabelCommand(
      host,
      unregistered,
      `pause-${unregistered}`,
      ['class=ci-other'],
      ['ci'],
      true,
      scratchDir
    )
  );
  expect(labeled).toEqual({
    code: 0,
    json: {
      ok: true,
      action: 'attention_label',
      runId: unregistered,
      occurrence: `pause-${unregistered}`,
      revision: 2,
      labels: { class: 'ci-other' },
    },
  });
  const stale = await captured(() =>
    workflowAttentionLabelCommand(host, unregistered, 'pause-old', ['a=b'], [], true, scratchDir)
  );
  expect(stale.code).toBe(1);
  expect(stale.json).toMatchObject({
    ok: false,
    error: expect.stringContaining(`awaiting occurrence 'pause-${unregistered}'`),
  });

  const counts = await captured(() =>
    workflowAttentionCommand(host, registeredDir, undefined, {
      json: true,
      all: true,
      labels: [],
      countBy: 'label:ci',
    })
  );
  expect(counts.json).toMatchObject({
    counts: {
      by: 'label',
      key: 'ci',
      counts: [
        { value: null, count: 1 },
        { value: 'other', count: 1 },
        { value: 'pr', count: 1 },
      ],
    },
  });

  const one = await captured(() =>
    workflowAttentionCommand(host, scratchDir, unregistered, { json: true, labels: [] })
  );
  expect(one.json).toMatchObject({
    ok: true,
    runId: unregistered,
    item: { runId: unregistered, revision: 2, labels: { class: 'ci-other' } },
  });

  const conflicting = await captured(() =>
    workflowAttentionCommand(host, scratchDir, undefined, {
      json: true,
      project: 'beta',
      all: true,
      labels: [],
    })
  );
  expect(conflicting).toMatchObject({ code: 1, json: { ok: false } });
});
