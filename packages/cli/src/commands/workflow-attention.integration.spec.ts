import { getLog } from './workflow-shared';
import * as chatScope from '../workflow-scope';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  getProjectStoragePaths,
  resolveProjectStorageKey,
  projectKeyForCodebase,
} from '@archon/paths/archon-paths';
import { providerRegistry } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import { attentionQueueSource } from '@archon/core/operations/attention-queue';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { workflowEventCursor } from '@archon/workflows/store';
import type { AttentionStreamLine } from '@archon/workflows/attention-watch';
import type { AttentionQueueItem } from '@archon/workflows/attention-queue';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  createInMemoryWorkflowHostStore,
  createInMemoryWorkflowStore,
} from '../test-support/workflow-store';
import { stateCommand } from './state';
import { workflowAttentionCommand, workflowAttentionLabelCommand } from './workflow-attention';
import { workflowNoticeCommand } from './workflow-notice';
import { emitWorkflowNotice, WORKFLOW_NOTICE_LIMITS } from '@archon/workflows/workflow-notice';
import * as workflowCommands from './workflow';
import { runWorkflowRespond } from '../routes/workflow';

const track = trackTempRoots();
const scopeSpy = spyOn(chatScope, 'readChatProjectScope');
const priorEnv = { ...process.env };
afterEach(() => {
  process.env = { ...priorEnv };
  scopeSpy.mockReturnValue(undefined);
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
    engine: new InProcessWorkflowEngine(deps, {
      branchOf: attentionQueueSource(store, records.isolation).branchOf,
    }),
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
  const scratchKey = await stateKey(scratchDir);
  expect(scratch[0]?.project).toEqual({
    key: scratchKey,
    codebaseId: null,
    name: scratchKey.slice(scratchKey.lastIndexOf('/') + 1),
  });
  expect(
    (await list(registeredDir, { project: await stateKey(scratchDir) })).map(item => item.runId)
  ).toEqual([unregistered]);

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

  // From events: the labels each wait opened with, so the later relabel does not show.
  const started = await captured(() =>
    workflowAttentionCommand(host, registeredDir, undefined, {
      json: true,
      all: true,
      labels: [],
      countBy: 'label:ci',
      since: '40m',
    })
  );
  expect(started.json).toMatchObject({
    counts: {
      counts: [
        { value: 'other', count: 2 },
        { value: 'pr', count: 1 },
      ],
    },
  });
  for (const opts of [{ since: '1h' }, { countBy: 'project', since: 'soon' }]) {
    const refused = await captured(() =>
      workflowAttentionCommand(host, registeredDir, undefined, { json: true, labels: [], ...opts })
    );
    expect(refused).toMatchObject({ code: 1, json: { ok: false } });
  }

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

  // A short run id resolves from a project subdirectory, as it does for `approve`.
  const subdir = join(registeredDir, 'src');
  mkdirSync(subdir);
  const prefix = current.slice(0, 8);
  const byPrefix = await captured(() =>
    workflowAttentionCommand(host, subdir, prefix, { json: true, labels: [] })
  );
  expect(byPrefix).toMatchObject({ code: 0, json: { ok: true, runId: current } });
  const labeledByPrefix = await captured(() =>
    workflowAttentionLabelCommand(host, prefix, `pause-${current}`, ['seen=yes'], [], true, subdir)
  );
  expect(labeledByPrefix).toMatchObject({ code: 0, json: { ok: true, runId: current } });
});

/** The JSON lines a long-running command writes until `stopWhen` holds, then SIGTERM. */
async function streamed(
  command: () => Promise<number>,
  stopWhen: (lines: Record<string, unknown>[]) => boolean
): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const write = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
    done?: (error?: Error | null) => void
  ) => {
    for (const text of String(chunk).split('\n')) {
      if (text === '') continue;
      const line = JSON.parse(text) as Record<string, unknown>;
      // The test logger shares stdout; stream lines are the ones with a type.
      if (typeof line.type === 'string') lines.push(line);
    }
    done?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    let finished = false;
    const running = command().then(code => {
      finished = true;
      return code;
    });
    for (let waited = 0; !stopWhen(lines); waited += 5) {
      if (waited > 5000) throw new Error(`stream never satisfied: ${JSON.stringify(lines)}`);
      await Bun.sleep(5);
    }
    expect(finished).toBe(false);
    process.emit('SIGTERM');
    return { code: await running, lines };
  } finally {
    write.mockRestore();
  }
}

test('watch writes only open items in the label filter and failed runs', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'attention-quiet-watch-cli-')));
  process.env.ARCHON_HOME = join(root, 'home');
  const host = createHost();
  const { store } = host.deps;
  mkdirSync(join(root, 'alpha'));
  const dir = realpathSync(join(root, 'alpha'));
  const running = async (): Promise<string> => {
    const run = await store.createWorkflowRun({ workflow_name: 'ci', user_message: '' });
    await store.claimPendingWorkflowRun(run.id);
    await store.updateWorkflowRun(run.id, {
      output_root: getProjectStoragePaths(resolveProjectStorageKey(null, dir)).root,
    });
    return run.id;
  };
  const recommendation = { option: 'merge', why: 'Review is ready.' };
  const paused = async (merge: string): Promise<string> => {
    const id = await running();
    await store.pauseWorkflowRunForWait(
      id,
      {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: new Date().toISOString(),
        message: 'Merge it?',
        pauseId: `pause-${id}`,
        form: 'select',
        options: [{ id: 'merge' }, { id: 'hold' }],
        recommendation,
        labels: { merge },
      },
      { kind: 'started', stepName: 'ask' }
    );
    return id;
  };
  const asked = await paused('pr');
  await paused('other');
  const completing = await running();
  const failing = await running();

  let acted = false;
  const { code, lines } = await streamed(
    () =>
      workflowAttentionCommand(host, dir, undefined, {
        json: true,
        labels: ['merge=pr'],
        watch: true,
      }),
    seen => {
      // The snapshot is out, so the stream follows the feed: end one run well, one badly.
      if (!acted && seen.length > 0) {
        acted = true;
        void store
          .completeWorkflowRun(completing, { duration_ms: 1 })
          .then(() => store.failWorkflowRun(failing, 'boom'));
      }
      return seen.some(line => line.type === 'terminal');
    }
  );
  expect(code).toBe(0);
  expect(lines).toMatchObject([
    { type: 'attention', item: { runId: asked, recommendation, labels: { merge: 'pr' } } },
    { type: 'terminal', runId: failing, status: 'failed' },
  ]);
  expect(lines).toHaveLength(2);

  // The protocol flags belong to the watch, and a replay cursor to the protocol.
  for (const opts of [{ protocol: true }, { watch: true, after: 'x' }]) {
    const refused = await captured(() =>
      workflowAttentionCommand(host, dir, undefined, { json: true, labels: [], ...opts })
    );
    expect(refused).toMatchObject({ code: 1, json: { ok: false } });
  }
});

test('--recommended answers as the declared answerer, and the notices watch says what each line needs', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'attention-recommended-cli-')));
  process.env.ARCHON_HOME = join(root, 'home');
  const host = createHost();
  const { store } = host.deps;
  mkdirSync(join(root, 'alpha'));
  const dir = realpathSync(join(root, 'alpha'));
  const running = async (): Promise<string> => {
    const run = await store.createWorkflowRun({ workflow_name: 'ci', user_message: '' });
    await store.claimPendingWorkflowRun(run.id);
    await store.updateWorkflowRun(run.id, {
      output_root: getProjectStoragePaths(resolveProjectStorageKey(null, dir)).root,
    });
    return run.id;
  };
  const paused = async (recommended: boolean): Promise<string> => {
    const id = await running();
    await store.pauseWorkflowRunForWait(
      id,
      {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: new Date().toISOString(),
        message: 'Merge it?',
        pauseId: `pause-${id}`,
        form: 'select',
        options: [{ id: 'merge' }, { id: 'hold' }],
        ...(recommended ? { recommendation: { option: 'merge', why: 'Review is ready.' } } : {}),
        labels: { merge: 'pr' },
      },
      { kind: 'started', stepName: 'ask' }
    );
    return id;
  };
  // `respond <id> [decision] --recommended --text Agreed. --as triage-agent --json`.
  const answer = (
    id: string,
    occurrence: string | null = `pause-${id}`,
    decision: string[] = []
  ): Promise<number> =>
    runWorkflowRespond({
      commands: workflowCommands,
      host,
      positionals: ['workflow', 'respond', id, ...decision],
      values: {
        recommended: true,
        ...(occurrence === null ? {} : { occurrence }),
        text: 'Agreed.',
        as: 'triage-agent',
        json: true,
      },
      command: 'workflow',
      subcommand: 'respond',
      cwd: dir,
      effectiveCwd: dir,
      json: true,
      detachedRunConfig: undefined,
      inheritedEnv: process.env,
      forgeTrustedEnv: process.env,
    });

  const unadvised = await paused(false);
  const refused = await captured(() => answer(unadvised));
  expect(refused).toMatchObject({
    code: 1,
    json: {
      ok: false,
      error: `Run ${unadvised}'s attention wait has no recommendation to accept. Choose one of its options.`,
    },
  });
  await store.cancelWorkflowRun(unadvised);

  // Accepting a recommendation names the occurrence it was read on, and takes no decision.
  const accepted = await paused(true);
  for (const refused of [
    () => answer(accepted, null),
    () => answer(accepted, 'an-earlier-pause'),
    () => answer(accepted, `pause-${accepted}`, ['hold']),
  ])
    expect(await captured(refused)).toMatchObject({ code: 1, json: { ok: false } });
  expect((await captured(() => answer(accepted, 'an-earlier-pause'))).json).toMatchObject({
    error: expect.stringContaining(`It is now awaiting occurrence 'pause-${accepted}'`),
  });
  expect(
    (await store.listWorkflowEvents(accepted)).some(event => event.event_type === 'wait_answered')
  ).toBe(false);
  expect(await captured(() => answer(accepted))).toMatchObject({
    code: 0,
    json: { ok: true, answer: { decision: 'merge', text: 'Agreed.' } },
  });
  expect(
    (await store.listWorkflowEvents(accepted)).find(event => event.event_type === 'wait_answered')
      ?.data
  ).toMatchObject({ by: { declared: 'triage-agent' } });

  // The stream shares stdout with the command, so the answer under watch skips the CLI.
  const asked = await paused(true);
  const completing = await running();
  let acted = false;
  const { code, lines } = await streamed(
    () =>
      workflowAttentionCommand(host, dir, undefined, {
        json: true,
        labels: [],
        watch: true,
        notices: true,
      }),
    seen => {
      if (!acted && seen.length > 0) {
        acted = true;
        void host.operations
          .answerWorkflow(
            asked,
            { choose: ['hold'] },
            { kind: 'operator', declared: 'triage-agent' },
            { via: 'cli' }
          )
          .then(() => store.completeWorkflowRun(completing, { duration_ms: 1 }));
      }
      return seen.some(line => line.type === 'terminal');
    }
  );
  expect(code).toBe(0);
  expect(lines).toMatchObject([
    { type: 'attention', needs: 'answer', item: { runId: asked } },
    {
      type: 'resolved',
      needs: 'nothing',
      runId: asked,
      reason: 'answered',
      answeredVia: 'cli',
      answeredBy: { declared: 'triage-agent' },
    },
    { type: 'terminal', needs: 'nothing', runId: completing, status: 'completed' },
  ]);
  expect(lines).toHaveLength(3);

  const counted = await captured(() =>
    workflowAttentionCommand(host, dir, undefined, {
      json: true,
      labels: [],
      countBy: 'label:merge',
      since: '40m',
    })
  );
  expect(counted.json).toMatchObject({
    counts: {
      counts: [{ value: 'pr', count: 3, recommendations: { asked: 2, answered: 2, followed: 1 } }],
    },
  });
});

test('watch streams the queue by project, refuses list-only flags, and exits 4 on a foreign cursor', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'attention-watch-cli-')));
  process.env.ARCHON_HOME = join(root, 'home');
  const host = createHost();
  const { store } = host.deps;
  const projectDir = (name: string): string => {
    mkdirSync(join(root, name));
    return realpathSync(join(root, name));
  };
  const pausedIn = async (dir: string): Promise<string> => {
    const run = await store.createWorkflowRun({ workflow_name: 'ci', user_message: '' });
    await store.claimPendingWorkflowRun(run.id);
    await store.updateWorkflowRun(run.id, {
      output_root: getProjectStoragePaths(resolveProjectStorageKey(null, dir)).root,
    });
    await store.pauseWorkflowRunForWait(
      run.id,
      {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: new Date().toISOString(),
        message: 'Retry?',
        pauseId: `pause-${run.id}`,
        form: 'approval',
      },
      { kind: 'started', stepName: 'ask' }
    );
    return run.id;
  };
  const alphaDir = projectDir('alpha');
  const alpha = await pausedIn(alphaDir);
  const betaDir = projectDir('beta');
  const beta = await pausedIn(betaDir);
  const watch = (opts: Partial<Parameters<typeof workflowAttentionCommand>[3]> = {}) =>
    streamed(
      () =>
        workflowAttentionCommand(host, alphaDir, undefined, {
          json: true,
          labels: [],
          watch: true,
          protocol: true,
          ...opts,
        }),
      lines => lines.some(line => line.type === 'ready')
    );
  const runsOf = (lines: Record<string, unknown>[]): unknown[] =>
    lines.flatMap(line =>
      line.type === 'attention' ? [[(line.item as AttentionQueueItem).runId, line.project]] : []
    );
  const alphaKey = projectKeyForCodebase(null, alphaDir);
  const alphaProject = {
    key: alphaKey,
    codebaseId: null,
    name: alphaKey.slice(alphaKey.lastIndexOf('/') + 1),
  };
  const betaKey = projectKeyForCodebase(null, betaDir);
  const betaProject = {
    key: betaKey,
    codebaseId: null,
    name: betaKey.slice(betaKey.lastIndexOf('/') + 1),
  };

  const own = await watch();
  expect(own.code).toBe(0);
  expect(runsOf(own.lines)).toEqual([[alpha, alphaProject]]);
  expect(
    (await watch({ project: betaKey })).lines.filter(line => line.type === 'attention')
  ).toMatchObject([{ project: betaProject, item: { runId: beta } }]);
  expect(runsOf((await watch({ all: true })).lines)).toEqual(
    expect.arrayContaining([
      [alpha, alphaProject],
      [beta, betaProject],
    ])
  );

  for (const opts of [{ watch: false, after: 'x' }, { sort: 'age' }, { countBy: 'project' }]) {
    const refused = await captured(() =>
      workflowAttentionCommand(host, alphaDir, undefined, {
        json: true,
        labels: [],
        watch: true,
        ...opts,
      })
    );
    expect(refused).toMatchObject({ code: 1, json: { ok: false } });
  }
  expect(
    await captured(() =>
      workflowAttentionCommand(host, alphaDir, alpha, { json: true, labels: [], watch: true })
    )
  ).toMatchObject({ code: 1, json: { ok: false } });

  expect(
    await captured(() =>
      workflowAttentionCommand(host, alphaDir, undefined, {
        json: true,
        labels: [],
        watch: true,
        protocol: true,
        after: 'sql:1',
      })
    )
  ).toEqual({ code: 4, json: { type: 'error', error: 'cursor_invalid', needs: 'look' } });
});

async function streamedText(
  command: () => Promise<number>,
  stopWhen: (text: string) => boolean
): Promise<{ code: number; text: string }> {
  let text = '';
  const write = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
    done?: (error?: Error | null) => void
  ) => {
    text += String(chunk);
    done?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    let finished = false;
    const running = command().then(code => {
      finished = true;
      return code;
    });
    for (let waited = 0; !stopWhen(text); waited += 5) {
      if (waited > 5000) throw new Error(`stream never satisfied: ${text}`);
      await Bun.sleep(5);
    }
    expect(finished).toBe(false);
    process.emit('SIGTERM');
    return { code: await running, text };
  } finally {
    write.mockRestore();
  }
}

test.each([true, false])(
  'watch forwards degradation and continues until a signal (json=%s)',
  async json => {
    const host = createHost();
    const lines: AttentionStreamLine[] = [
      { type: 'ready', cursor: workflowEventCursor('fixture:0') },
      { type: 'degraded', reason: 'run_unreadable', cursor: workflowEventCursor('fixture:0') },
      {
        type: 'resumed',
        runId: 'healthy',
        project: null,
        workflow: 'wf',
        parentRunId: null,
        status: 'running',
        cursor: workflowEventCursor('fixture:2'),
      },
    ];
    let closed = false;
    const watch = spyOn(host.engine, 'watchAttention').mockImplementation(async listener => {
      for (const line of lines) await listener(line);
      return {
        close: async () => {
          closed = true;
        },
      };
    });
    const command = () =>
      workflowAttentionCommand(host, process.cwd(), undefined, {
        json,
        all: true,
        labels: [],
        watch: true,
        protocol: true,
      });
    try {
      if (json) {
        const result = await streamed(command, output =>
          output.some(line => line.type === 'resumed')
        );
        expect(result).toEqual({
          code: 0,
          lines: [
            { ...lines[0], needs: 'nothing' },
            { ...lines[1], needs: 'look' },
            { ...lines[2], needs: 'nothing' },
          ],
        });
      } else {
        const result = await streamedText(command, text =>
          text.includes('Run healthy resumed (running).')
        );
        expect(result.code).toBe(0);
        expect(result.text).toContain(
          'Attention stream coverage may be incomplete because a run could not be read. Check the operator log; reconnect after repairing the read failure.'
        );
        expect(result.text.indexOf('coverage may be incomplete')).toBeLessThan(
          result.text.indexOf('Run healthy resumed')
        );
      }
      expect(closed).toBe(true);
    } finally {
      watch.mockRestore();
    }
  }
);

test("watch text names a child run's parent and a failure with no recorded error class", async () => {
  const host = createHost();
  const terminal = (runId: string, parentRunId: string | null): AttentionStreamLine => ({
    type: 'terminal',
    runId,
    project: null,
    workflow: 'w',
    parentRunId,
    status: 'failed',
    outcome: null,
    cause: { node: 'build', errorClass: null },
    cursor: workflowEventCursor('fixture:1'),
  });
  const attention: AttentionStreamLine = {
    type: 'attention',
    cursor: workflowEventCursor('fixture:0'),
    snapshot: true,
    project: null,
    workflow: 'w',
    parentRunId: 'p1',
    item: {
      kind: 'unreadable',
      runId: 'child',
      workflow: 'w',
      project: null,
      parentRunId: 'p1',
      fanOut: null,
      revision: 1,
      labels: {},
      pausedAt: null,
      context: { artifactsDir: null, transcript: null, workingPath: null, branch: null },
      reason: 'malformed_gate',
      detail: 'gate unreadable',
    },
  };
  const watch = spyOn(host.engine, 'watchAttention').mockImplementation(async listener => {
    await listener(attention);
    await listener(terminal('child', 'p1'));
    await listener(terminal('top', null));
    return { close: async () => {} };
  });
  try {
    const result = await streamedText(
      () =>
        workflowAttentionCommand(host, process.cwd(), undefined, {
          all: true,
          labels: [],
          watch: true,
          protocol: true,
        }),
      text => text.includes('Run top failed')
    );
    expect(result.code).toBe(0);
    expect(result.text).toContain(
      '  child  w  (no project)  pause time not recorded\n    child of run p1\n'
    );
    expect(result.text).toContain(
      'Run child failed: node build (error class not recorded). Workflow w, child of run p1. Show more with archon workflow get child.\n'
    );
    expect(result.text).toContain(
      'Run top failed: node build (error class not recorded). Workflow w. Show more with archon workflow get top.\n'
    );
  } finally {
    watch.mockRestore();
  }
});

test.each([
  { phase: 'startup', json: true, type: 'degraded' },
  { phase: 'tail', json: true, type: 'degraded' },
  { phase: 'startup', json: false, type: 'degraded' },
  { phase: 'tail', json: false, type: 'degraded' },
  { phase: 'startup', json: false, type: 'error' },
  { phase: 'tail', json: false, type: 'error' },
])('watch handles output failures (%s)', async ({ phase, json, type }) => {
  for (const code of ['ENOSPC', 'EPIPE', undefined]) {
    const host = createHost();
    const failure = Object.assign(new Error('write failed'), { code });
    let rejected: unknown;
    let closed = false;
    let delivery = Promise.resolve();
    const watch = spyOn(host.engine, 'watchAttention').mockImplementation(async listener => {
      const deliver = async (): Promise<void> => {
        try {
          await listener(
            type === 'error'
              ? { type: 'error', error: 'cursor_invalid' }
              : {
                  type: 'degraded',
                  reason: 'run_unreadable',
                  cursor: workflowEventCursor('fixture:0'),
                }
          );
        } catch (error) {
          rejected = error;
        }
      };
      if (phase === 'startup') await deliver();
      else delivery = Bun.sleep(5).then(deliver);
      return {
        close: async () => {
          await delivery;
          closed = true;
        },
      };
    });
    const write = spyOn(
      type === 'error' ? process.stderr : process.stdout,
      'write'
    ).mockImplementation(((chunk: string, done?: (error?: Error | null) => void) => {
      done?.(
        String(chunk).includes(
          type === 'error'
            ? 'The stream cursor'
            : json
              ? '"type":"degraded"'
              : 'coverage may be incomplete'
        )
          ? failure
          : undefined
      );
      return true;
    }) as typeof process.stdout.write);
    try {
      const result = await workflowAttentionCommand(host, process.cwd(), undefined, {
        json,
        all: true,
        labels: [],
        watch: true,
        protocol: true,
      });
      expect(result).toBe(code === 'EPIPE' ? (type === 'error' ? 4 : 0) : 1);
      expect(rejected).toBe(code === 'EPIPE' ? undefined : failure);
      expect(closed).toBe(true);
    } finally {
      write.mockRestore();
      watch.mockRestore();
    }
  }
});

test.each(['beta', 'scratch'])(
  'selected chat scope governs every run query from %s',
  async cwdName => {
    const { workflowStatusCommand, workflowRunsCommand } = await import('./workflow-query');
    const root = track(mkdtempSync(join(tmpdir(), 'chat-query-scope-')));
    process.env.ARCHON_HOME = join(root, 'home');
    const host = createHost();
    const projects = [];
    for (const name of ['alpha', 'beta']) {
      const dir = join(root, name);
      mkdirSync(dir);
      const project = await host.records.codebases.createCodebase({
        name,
        default_cwd: realpathSync(dir),
        kind: 'folder',
      });
      const run = await host.deps.store.createWorkflowRun({
        workflow_name: name,
        user_message: '',
        codebase_id: project.id,
      });
      await host.deps.store.claimPendingWorkflowRun(run.id);
      await host.deps.store.pauseWorkflowRunForWait(
        run.id,
        {
          owner: 'node',
          nodeId: 'ask',
          kind: 'attention',
          waitingSince: new Date().toISOString(),
          message: 'Continue?',
          pauseId: `pause-${name}`,
          form: 'approval',
        },
        { kind: 'started', stepName: 'ask' }
      );
      const failed = await host.deps.store.createWorkflowRun({
        workflow_name: name,
        user_message: '',
        codebase_id: project.id,
      });
      await host.deps.store.claimPendingWorkflowRun(failed.id);
      await host.deps.store.failWorkflowRun(failed.id, 'test failure');
      projects.push({ project, run, failed });
    }
    const [alpha, beta] = projects;
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    scopeSpy.mockReturnValue(alpha.project.id);
    const cwd = cwdName === 'beta' ? beta.project.default_cwd : realpathSync(scratch);
    const status = await captured(async () => {
      await workflowStatusCommand(host, cwd, { json: true });
      return 0;
    });
    expect(status.json).toMatchObject({ runs: [{ id: alpha.run.id }], scopeFallback: false });
    for (const open of [false, true]) {
      const result = await captured(() => workflowRunsCommand(host, cwd, { json: true, open }));
      expect(result.code).toBe(0);
      const runs = (result.json as { runs: { id: string }[] }).runs.map(run => run.id).sort();
      expect(runs).toEqual((open ? [alpha.failed.id] : [alpha.run.id, alpha.failed.id]).sort());
    }
    for (const project of [
      undefined,
      alpha.project.id,
      alpha.project.name,
      projectKeyForCodebase(alpha.project, alpha.project.default_cwd),
    ]) {
      const result = await captured(() =>
        workflowAttentionCommand(host, cwd, undefined, {
          json: true,
          labels: [],
          project,
        })
      );
      expect(result).toMatchObject({ code: 0, json: { items: [{ runId: alpha.run.id }] } });
    }
    const counts = await captured(() =>
      workflowAttentionCommand(host, cwd, undefined, {
        json: true,
        labels: [],
        countBy: 'project',
        project: projectKeyForCodebase(alpha.project, alpha.project.default_cwd),
      })
    );
    expect(counts).toMatchObject({
      code: 0,
      json: { counts: { counts: [{ count: 1, project: { codebaseId: alpha.project.id } }] } },
    });
    const watch = await streamed(
      () =>
        workflowAttentionCommand(host, cwd, undefined, {
          json: true,
          labels: [],
          watch: true,
          protocol: true,
          project: projectKeyForCodebase(alpha.project, alpha.project.default_cwd),
        }),
      lines => lines.some(line => line.type === 'ready')
    );
    expect(watch.lines.filter(line => line.type === 'attention')).toMatchObject([
      { item: { runId: alpha.run.id } },
    ]);
    await expect(workflowStatusCommand(host, cwd, { all: true })).rejects.toThrow('--all');
    for (const open of [false, true]) {
      const refused = await captured(() =>
        workflowRunsCommand(host, cwd, {
          json: true,
          all: true,
          open,
        })
      );
      expect(refused).toMatchObject({ code: 1, json: { ok: false } });
    }
    for (const mode of [{}, { countBy: 'project' }, { watch: true }]) {
      for (const selection of [
        { all: true },
        { project: beta.project.id },
        { project: beta.project.name },
        { project: projectKeyForCodebase(beta.project, beta.project.default_cwd) },
      ]) {
        const refused = await captured(() =>
          workflowAttentionCommand(host, cwd, undefined, {
            json: true,
            labels: [],
            ...mode,
            ...selection,
          })
        );
        expect(refused).toMatchObject({ code: 1, json: { ok: false } });
      }
    }
  }
);

test.each(['', 'missing-project'])(
  'invalid selected chat scope %j refuses every run query',
  async scope => {
    const { workflowStatusCommand, workflowRunsCommand } = await import('./workflow-query');
    const host = createHost();
    scopeSpy.mockReturnValue(scope);
    await expect(workflowStatusCommand(host, process.cwd())).rejects.toThrow('registered project');
    const queries = [
      () => workflowRunsCommand(host, process.cwd(), { json: true }),
      () => workflowRunsCommand(host, process.cwd(), { json: true, open: true }),
      ...[{}, { countBy: 'project' }, { watch: true }].map(
        mode => () =>
          workflowAttentionCommand(host, process.cwd(), undefined, {
            json: true,
            labels: [],
            ...mode,
          })
      ),
    ];
    for (const query of queries) {
      const result = await captured(query);
      expect(result).toMatchObject({ code: 1, json: { ok: false } });
      expect((result.json as { error: string }).error).toContain('registered project');
    }
  }
);

test.each([true, false].flatMap(all => [undefined, 'project'].map(countBy => ({ all, countBy }))))(
  'mixed attention batches retain reports (all: $all, countBy: $countBy)',
  async ({ all, countBy }) => {
    const root = track(mkdtempSync(join(tmpdir(), 'attention-degraded-')));
    process.env.ARCHON_HOME = join(root, 'home');
    const host = createHost();
    const project = await host.records.codebases.createCodebase({
      name: 'alpha',
      default_cwd: root,
    });
    const store = host.deps.store;
    const run = await store.createWorkflowRun({
      workflow_name: 'valid',
      user_message: '',
      codebase_id: project.id,
    });
    await store.claimPendingWorkflowRun(run.id);
    await store.pauseWorkflowRunForWait(
      run.id,
      {
        owner: 'node',
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: new Date().toISOString(),
        message: 'Readable question',
      },
      { kind: 'started', stepName: 'ask' }
    );
    const rows = await store.listAttentionQueueRows();
    const degraded = ['bad-a', 'bad-b'].map(runId => ({
      type: 'degraded' as const,
      reason: 'run_unreadable' as const,
      runId,
    }));
    store.listAttentionQueueRows = async () => [...degraded, ...rows];
    const warnings = all ? degraded : degraded.map(({ type, reason }) => ({ type, reason }));
    for (const labels of [[], ['missing=yes']]) {
      const result = await captured(() =>
        workflowAttentionCommand(host, root, undefined, {
          all,
          project: all ? undefined : project.id,
          labels,
          countBy,
          json: true,
        })
      );
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ ok: true, degraded: warnings });
      if (countBy === undefined)
        expect(result.json).toMatchObject({
          items: labels.length ? [] : [expect.objectContaining({ runId: run.id })],
        });
      else
        expect(result.json).toMatchObject({
          counts: { counts: labels.length ? [] : [expect.objectContaining({ count: 1 })] },
        });
    }
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      expect(
        await workflowAttentionCommand(host, root, undefined, {
          all,
          project: all ? undefined : project.id,
          labels: ['missing=yes'],
          countBy,
        })
      ).toBe(0);
      const text = lines.join('\n');
      expect(text.match(/Attention coverage incomplete/g)).toHaveLength(2);
      expect(text).not.toContain('No runs need attention');
      expect(text.includes('bad-a')).toBe(all);
      expect(text.includes('bad-b')).toBe(all);
    } finally {
      log.mockRestore();
    }
  }
);

test('a notice is recorded only from a node of a running run, reaches the notices watch and the window list, and is bounded', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'attention-notice-cli-')));
  process.env.ARCHON_HOME = join(root, 'home');
  const host = createHost();
  const { store } = host.deps;
  mkdirSync(join(root, 'alpha'));
  const dir = realpathSync(join(root, 'alpha'));
  const running = async (): Promise<string> => {
    const run = await store.createWorkflowRun({ workflow_name: 'merge-queue', user_message: '' });
    await store.claimPendingWorkflowRun(run.id);
    await store.updateWorkflowRun(run.id, {
      output_root: getProjectStoragePaths(resolveProjectStorageKey(null, dir)).root,
    });
    return run.id;
  };
  const node = (runId: string, as = runId): NodeJS.ProcessEnv => ({
    WORKFLOW_ID: runId,
    ARCHON_NODE_EXECUTION: JSON.stringify({ runId: as, path: 'merge' }),
  });
  const notice = (
    env: NodeJS.ProcessEnv,
    text = 'Merged pull request 7',
    labels = ['kind=merged']
  ): Promise<{ code: number; json: unknown }> =>
    captured(() => workflowNoticeCommand(host, text, labels, true, env));
  const watch = (level: { notices?: boolean }, emit: () => Promise<unknown>, done: string) => {
    let acted = false;
    return streamed(
      () =>
        workflowAttentionCommand(host, dir, undefined, {
          json: true,
          labels: ['kind=merged'],
          watch: true,
          ...level,
        }),
      seen => {
        // The open ask is the snapshot: once it is written the watch follows the feed.
        if (!acted && seen.length > 0) {
          acted = true;
          void emit();
        }
        return seen.some(line => line.type === done);
      }
    );
  };

  const run = await running();
  const other = await running();
  const asking = await running();
  await store.pauseWorkflowRunForWait(
    asking,
    {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: new Date().toISOString(),
      message: 'Merge it?',
      pauseId: `pause-${asking}`,
      form: 'approval',
      labels: { kind: 'merged' },
    },
    { kind: 'started', stepName: 'ask' }
  );
  // Outside a run, as another run's node, and for a run this store does not know.
  for (const env of [{}, node(run, other), node('00000000-0000-4000-8000-000000000001')])
    expect(await notice(env)).toMatchObject({ code: 1, json: { ok: false, action: 'notice' } });
  expect(await notice(node(run), 'two\nlines')).toMatchObject({
    code: 1,
    json: { reason: 'invalid', error: 'A notice is one line' },
  });
  expect(await store.listWorkflowNoticeRows()).toEqual([]);

  // The notices watch receives it as a line that asks nothing; a filtered-out label does not.
  // The stream shares stdout with the command, so the emits under watch skip the CLI.
  const say = (text: string, labels: Record<string, string>): Promise<unknown> =>
    emitWorkflowNotice(store, { runId: run, node: 'merge', text, labels });
  const failing = await running();
  const noticed = await watch(
    { notices: true },
    async () => {
      await say('Returned pull request 9', { kind: 'returned' });
      await say('Merged pull request 7', { kind: 'merged', pr: '7' });
      await store.failWorkflowRun(failing, 'boom');
    },
    'terminal'
  );
  expect(noticed.lines).toMatchObject([
    { type: 'attention', needs: 'answer' },
    {
      type: 'notice',
      needs: 'nothing',
      runId: run,
      workflow: 'merge-queue',
      node: 'merge',
      text: 'Merged pull request 7',
      labels: { kind: 'merged', pr: '7' },
    },
    { type: 'terminal', needs: 'look', runId: failing },
  ]);
  // The quiet watch does not: only the failure reaches it.
  const failingToo = await running();
  const quiet = await watch(
    {},
    async () => {
      await say('Merged pull request 8', { kind: 'merged' });
      await store.failWorkflowRun(failingToo, 'boom');
    },
    'terminal'
  );
  expect(quiet.lines.map(line => line.type)).toEqual(['attention', 'terminal']);

  // The window list and the count read the same rows, filtered and grouped by label.
  const window = (opts: object): Promise<{ code: number; json: unknown }> =>
    captured(() =>
      workflowAttentionCommand(host, dir, undefined, {
        json: true,
        labels: [],
        notices: true,
        since: '40m',
        ...opts,
      })
    );
  expect((await window({ labels: ['kind=merged'] })).json).toMatchObject({
    notices: [
      { text: 'Merged pull request 7', workflow: 'merge-queue', runId: run },
      { text: 'Merged pull request 8' },
    ],
  });
  expect((await window({ countBy: 'label:kind' })).json).toMatchObject({
    counts: {
      by: 'label',
      key: 'kind',
      counts: [
        { value: 'merged', count: 2 },
        { value: 'returned', count: 1 },
      ],
    },
  });

  // The list of live runs says what each is about: the latest notice it emitted, or none.
  const status = await captured(async () => {
    await workflowCommands.workflowStatusCommand(host, dir, { json: true, all: true });
    return 0;
  });
  const live = (status.json as { runs: { id: string; notice: unknown }[] }).runs;
  expect(live.find(entry => entry.id === run)?.notice).toMatchObject({
    text: 'Merged pull request 8',
    labels: { kind: 'merged' },
    node: 'merge',
  });
  expect(live.find(entry => entry.id === other)?.notice).toBeNull();

  // A run past its ceiling is refused, and so is one that is no longer running.
  for (let emitted = 3; emitted < WORKFLOW_NOTICE_LIMITS.perRun; emitted++)
    expect((await notice(node(run))).code).toBe(0);
  expect(await notice(node(run))).toMatchObject({ code: 1, json: { reason: 'run_limit' } });
  expect(await store.listWorkflowNoticeRows()).toHaveLength(WORKFLOW_NOTICE_LIMITS.perRun);
  await store.completeWorkflowRun(other, { duration_ms: 1 });
  expect(await notice(node(other))).toMatchObject({ code: 1, json: { reason: 'run_not_running' } });
});

for (const mode of [{ notices: true }, { countBy: 'project' }]) {
  test.each([false, true])(
    `invalid --since in ${JSON.stringify(mode)} is a quiet usage error (json=%s)`,
    async json => {
      const host = createHost();
      const log = spyOn(getLog(), 'error');
      const invoke = () =>
        workflowAttentionCommand(host, process.cwd(), undefined, {
          labels: [],
          all: true,
          since: '40x',
          json,
          ...mode,
        });
      try {
        if (json) {
          expect(await captured(invoke)).toMatchObject({
            code: 1,
            json: { ok: false, error: expect.stringContaining('since must be a duration') },
          });
        } else {
          await expect(invoke()).rejects.toThrow(
            'Failed to read the attention queue: since must be a duration'
          );
        }
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    }
  );
}
