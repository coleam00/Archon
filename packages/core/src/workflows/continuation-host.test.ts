// @archon-test-isolated
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
const mockWarn = mock((_fields: unknown, _message: string) => undefined);
const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({
    warn: mockWarn,
    error: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
  }),
}));
const trackTempRoot = trackTempRoots();
const { WorkflowSourceUnavailableError, loadWorkflowSource, DEFAULT_WORKFLOW_SOURCE_CONFIG } =
  await import('../../../workflows/src/workflow-source');
const mockListDueWorkflowContinuations = mock(
  async (_now: Date, _limit: number) => [] as WorkflowRun[]
);
const mockDeferWorkflowContinuation = mock(async () => undefined);
const store = {
  listDueWorkflowContinuations: mockListDueWorkflowContinuations,
  deferWorkflowContinuation: mockDeferWorkflowContinuation,
};
const { wakeDueWorkflowContinuations } = await import('@archon/core/workflows/continuation-resume');

async function scanDueWorkflowContinuations(
  now: Date,
  resume: (run: WorkflowRun, cursor: WorkflowResumeCursor) => Promise<boolean>
): Promise<number> {
  const outcomes = await wakeDueWorkflowContinuations(store, now, async (run, cursor) =>
    (await resume(run, cursor))
      ? {
          kind: 'accepted',
          run,
          settled: Promise.resolve({ success: true, workflowRunId: run.id }),
        }
      : { kind: 'unavailable', reason: 'test unavailable' }
  );
  return outcomes.filter(outcome => outcome.kind === 'accepted').length;
}

function run(
  id: string,
  status: 'paused' | 'failed',
  metadata: Record<string, unknown>
): WorkflowRun {
  return {
    origin: { conversationId: 'conv-1' },
    id,
    workflow_name: 'deliver',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status,
    outcome: null,
    user_message: 'deliver',
    metadata,
    started_at: new Date('2026-08-24T10:00:00.000Z'),
    completed_at: status === 'failed' ? new Date('2026-08-24T10:01:00.000Z') : null,
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
  };
}

describe('continuation host scanner', () => {
  beforeEach(() => {
    mockListDueWorkflowContinuations.mockReset();
    mockDeferWorkflowContinuation.mockReset();
    mockDeferWorkflowContinuation.mockResolvedValue(undefined);
  });
  test('resumes due waits and quota continuations through the shared resume CAS', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T11:00:00.000Z',
      deadlineAt: '2026-08-25T11:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          pauseId: 'time-occurrence',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
      run('quota-1', 'failed', { scheduled_resume: scheduled }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(2);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[0]).toEqual([
      expect.objectContaining({ id: 'wait-1' }),
      {
        kind: 'wait',
        nodeId: 'delay',
        resumeAt: '2026-08-24T11:00:00.000Z',
        pauseId: 'time-occurrence',
      },
    ]);
    expect(resume.mock.calls[1]).toEqual([
      expect.objectContaining({ id: 'quota-1' }),
      { kind: 'quota', attempt: 1, resumeAt: '2026-08-24T11:00:00.000Z' },
    ]);
  });
  test('resumes due event waits through the shared resume CAS', async () => {
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('event-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'await-review',
          kind: 'event',
          pauseId: 'event-occurrence',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
          event: 'review.completed',
        },
      }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(1);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-1' }), {
      kind: 'wait',
      pauseId: 'event-occurrence',
      nodeId: 'await-review',
      resumeAt: '2026-08-24T11:00:00.000Z',
    });
  });
  test('does not schedule an attention wait even if a malformed due query returns it', async () => {
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('attention-1', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-08-24T10:00:00.000Z',
          message: 'Re-run CI, then resume.',
        },
      }),
    ]);
    const resume = mock(async () => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(0);
    expect(resume).not.toHaveBeenCalled();
    expect(mockDeferWorkflowContinuation).not.toHaveBeenCalled();
  });
  test('resumes a paused wait even when the run retains historical quota metadata', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T10:30:00.000Z',
      deadlineAt: '2026-08-25T10:30:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
      triggeredAt: '2026-08-24T10:30:01.000Z',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-after-quota', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:31:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
        scheduled_resume: scheduled,
      }),
    ]);
    const resume = mock(async (_run: WorkflowRun, _cursor: WorkflowResumeCursor) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
  test('backs off a due row when execution prerequisites are unavailable', async () => {
    mockListDueWorkflowContinuations.mockResolvedValueOnce([
      run('wait-poison', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
    ]);
    const resume = mock(async () => false);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:00.000Z'), resume)
    ).resolves.toBe(0);

    expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith(
      'wait-poison',
      '2026-08-24T11:01:00.000Z',
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' }
    );
  });
  test('logs and backs off a row when destination resolution rejects', async () => {
    mockListDueWorkflowContinuations.mockResolvedValueOnce([
      run('wait-reject', 'paused', {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
    ]);
    const resume = mock(async () => {
      throw new Error('conversation lookup failed');
    });

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:00.000Z'), resume)
    ).resolves.toBe(0);

    expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith(
      'wait-reject',
      '2026-08-24T11:01:00.000Z',
      { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00.000Z' }
    );
  });
});

test('reports deferral failure while admitting other rows', async () => {
  const wait = {
    owner: 'node',
    kind: 'time',
    nodeId: 'delay',
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2026-08-24T11:00:00.000Z',
  };
  mockListDueWorkflowContinuations.mockResolvedValue([
    run('bad', 'paused', { wait }),
    run('good', 'paused', { wait }),
  ]);
  mockDeferWorkflowContinuation.mockRejectedValueOnce(new Error('defer unavailable'));
  const outcomes = await wakeDueWorkflowContinuations(
    store,
    new Date('2026-08-24T11:00:01.000Z'),
    async candidate => {
      if (candidate.id === 'bad') throw new Error('resume unavailable');
      return {
        kind: 'accepted',
        run: candidate,
        settled: Promise.resolve({ success: true, workflowRunId: candidate.id }),
      };
    }
  );
  expect(outcomes[0]).toEqual({
    runId: 'bad',
    kind: 'failed',
    error: expect.any(Error),
    deferError: expect.any(Error),
  });
  expect(outcomes[1]?.kind).toBe('accepted');
});

test('a row waiting for capacity is deferred and keeps its outcome', async () => {
  const wait = {
    owner: 'node',
    kind: 'time',
    nodeId: 'delay',
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2026-08-24T11:00:00.000Z',
  };
  mockListDueWorkflowContinuations.mockResolvedValue([run('full', 'paused', { wait })]);
  mockDeferWorkflowContinuation.mockReset();
  mockDeferWorkflowContinuation.mockResolvedValue(undefined);
  const blocker = { kind: 'run' as const, id: 'holder' };
  const outcomes = await wakeDueWorkflowContinuations(
    store,
    new Date('2026-08-24T11:00:00.000Z'),
    async () => ({ kind: 'waiting_for_capacity', blocker, message: 'busy' })
  );
  expect(outcomes).toEqual([
    { runId: 'full', kind: 'waiting_for_capacity', blocker, message: 'busy' },
  ]);
  expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith('full', '2026-08-24T11:01:00.000Z', {
    kind: 'wait',
    nodeId: 'delay',
    resumeAt: '2026-08-24T11:00:00.000Z',
  });
});

test('bounds structural source failures locally and warns once', async () => {
  const candidate = run('structural-source', 'paused', {
    wait: {
      owner: 'node',
      kind: 'time',
      nodeId: 'delay',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2026-08-24T11:00:00.000Z',
    },
  });
  mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
  mockDeferWorkflowContinuation.mockClear();
  mockWarn.mockClear();
  const resume = mock(async () => {
    throw new WorkflowSourceUnavailableError(
      '/owning-host/source/manifest.json',
      new Error('ENOENT')
    );
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    await wakeDueWorkflowContinuations(
      store,
      new Date(Date.parse('2026-08-24T11:00:00Z') + attempt * 60_000),
      resume
    );
  }
  expect(resume).toHaveBeenCalledTimes(3);
  expect(mockDeferWorkflowContinuation).toHaveBeenCalledTimes(2);
  expect(mockWarn).toHaveBeenCalledTimes(1);
  expect(mockWarn).toHaveBeenCalledWith(
    {
      err: expect.any(WorkflowSourceUnavailableError),
      runId: candidate.id,
      path: '/owning-host/source/manifest.json',
      attempts: 3,
    },
    expect.stringContaining(`archon workflow resume ${candidate.id}`)
  );
  expect(mockWarn.mock.calls[0]).toEqual([
    expect.any(Object),
    expect.stringContaining(`archon workflow abandon ${candidate.id}`),
  ]);
  expect(candidate.status).toBe('paused');
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
    import { wakeDueWorkflowContinuations } from ${JSON.stringify(new URL('./continuation-resume.ts', import.meta.url).href)};
    const run = ${JSON.stringify(candidate)};
    let resumed = false;
    const outcomes = await wakeDueWorkflowContinuations({
      listDueWorkflowContinuations: async () => [run],
      deferWorkflowContinuation: async () => { throw new Error('healthy host deferred'); },
    }, new Date('2026-08-24T12:00:00Z'), async () => {
      resumed = true;
      return { kind: 'accepted', run, settled: Promise.resolve({ success: true, workflowRunId: run.id }) };
    });
    if (!resumed || outcomes[0]?.kind !== 'accepted') process.exit(1);
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, DATABASE_URL: '' } }
  );
  expect(await new Response(child.stderr).text()).toBe('');
  expect(await child.exited).toBe(0);
});

async function sourceFixture(): Promise<string> {
  const root = trackTempRoot(await fs.mkdtemp(join(tmpdir(), 'continuation-source-')));
  const content = 'frozen';
  await fs.writeFile(join(root, 'source.txt'), content);
  const hash = createHash('sha256').update(content).digest('hex');
  await fs.writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: 1,
      engine_version: 'test',
      origin: root,
      captured_at: new Date().toISOString(),
      digest: createHash('sha256').update(`source.txt\0${hash}\n`).digest('hex'),
      file_count: 1,
      byte_count: content.length,
      scopes: [],
      source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    })
  );
  return root;
}

for (const read of ['manifest', 'directory', 'file'] as const) {
  test(`temporary ${read} read failures keep retrying and recover`, async () => {
    const root = await sourceFixture();
    const manifest = await fs.readFile(join(root, 'manifest.json'), 'utf8');
    const candidate = run(`transient-${read}`, 'paused', {
      wait: {
        owner: 'node',
        kind: 'time',
        nodeId: 'delay',
        waitingSince: '2026-08-24T10:00:00Z',
        resumeAt: '2026-08-24T11:00:00Z',
      },
    });
    mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
    mockDeferWorkflowContinuation.mockClear();
    const resume = mock(async () => {
      await loadWorkflowSource(root);
      return {
        kind: 'accepted' as const,
        run: candidate,
        settled: Promise.resolve({ success: true as const, workflowRunId: candidate.id }),
      };
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const cause = Object.assign(new Error('temporary descriptor shortage'), { code: 'EMFILE' });
      const reader =
        read === 'directory'
          ? spyOn(fs, 'readdir').mockRejectedValue(cause)
          : (() => {
              const fileReader = spyOn(fs, 'readFile').mockRejectedValue(cause);
              if (read === 'file') fileReader.mockResolvedValueOnce(manifest);
              return fileReader;
            })();
      const now = new Date(Date.parse('2026-08-24T11:00:00Z') + attempt * 60_000);
      try {
        await wakeDueWorkflowContinuations(store, now, resume);
        expect(mockDeferWorkflowContinuation).toHaveBeenLastCalledWith(
          candidate.id,
          new Date(now.getTime() + 60_000).toISOString(),
          { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00Z' }
        );
      } finally {
        reader.mockRestore();
      }
    }
    const outcomes = await wakeDueWorkflowContinuations(
      store,
      new Date('2026-08-24T12:00:00Z'),
      resume
    );
    expect(resume).toHaveBeenCalledTimes(6);
    expect(outcomes[0]?.kind).toBe('accepted');
    expect(mockDeferWorkflowContinuation).toHaveBeenCalledTimes(5);
  });
}

test('temporary discovery reads keep retrying through resolution and recover', async () => {
  const root = await sourceFixture();
  const manifest = { ...(await loadWorkflowSource(root)).manifest };
  await fs.unlink(join(root, 'source.txt'));
  const relativePath = 'project/.archon/workflows/deliver.yaml';
  const workflowPath = join(root, relativePath);
  const content =
    'name: deliver\ndescription: Test workflow\nnodes:\n  - id: done\n    bash: echo done\n';
  await fs.mkdir(join(root, 'project/.archon/workflows'), { recursive: true });
  await fs.writeFile(workflowPath, content);
  const manifestPath = join(root, 'manifest.json');
  const hash = createHash('sha256').update(content).digest('hex');
  manifest.digest = createHash('sha256').update(`${relativePath}\0${hash}\n`).digest('hex');
  manifest.byte_count = content.length;
  manifest.scopes = ['project'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const capture = await loadWorkflowSource(root);
  const candidate = run('transient-discovery', 'paused', {
    wait: {
      owner: 'node',
      kind: 'time',
      nodeId: 'delay',
      waitingSince: '2026-08-24T10:00:00Z',
      resumeAt: '2026-08-24T11:00:00Z',
    },
    workflow_source: { ...capture.manifest, root },
  });
  const { resolveRunWorkflow } = await import('./resolve-run-workflow');
  const { createWorkflowDeps } = await import('./store-adapter');
  const deps = createWorkflowDeps();
  mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
  mockDeferWorkflowContinuation.mockClear();
  mockWarn.mockClear();
  const resume = mock(async () => {
    const result = await resolveRunWorkflow(deps, candidate, root, {});
    return result.ok
      ? {
          kind: 'accepted' as const,
          run: candidate,
          settled: Promise.resolve({ success: true as const, workflowRunId: candidate.id }),
        }
      : { kind: 'unavailable' as const, reason: result.message, sourceError: result.sourceError };
  });
  const cause = Object.assign(new Error('temporary descriptor shortage'), { code: 'EMFILE' });
  const readFile = fs.readFile;
  for (let attempt = 0; attempt < 5; attempt++) {
    const reader = spyOn(fs, 'readFile')
      .mockImplementation(readFile)
      .mockImplementationOnce(readFile)
      .mockImplementationOnce(readFile)
      .mockImplementationOnce(readFile)
      .mockImplementationOnce(readFile)
      .mockRejectedValueOnce(cause);
    try {
      const now = new Date(Date.parse('2026-08-24T11:00:00Z') + attempt * 60_000);
      const outcomes = await wakeDueWorkflowContinuations(store, now, resume);
      expect(outcomes[0]?.kind).toBe('unavailable');
      expect(reader.mock.calls[4]).toEqual([workflowPath, 'utf-8']);
      expect(mockDeferWorkflowContinuation).toHaveBeenLastCalledWith(
        candidate.id,
        new Date(now.getTime() + 60_000).toISOString(),
        { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00Z' }
      );
    } finally {
      reader.mockRestore();
    }
  }
  const outcomes = await wakeDueWorkflowContinuations(
    store,
    new Date('2026-08-24T12:00:00Z'),
    resume
  );
  expect(resume).toHaveBeenCalledTimes(6);
  expect(outcomes[0]?.kind).toBe('accepted');
  expect(mockDeferWorkflowContinuation).toHaveBeenCalledTimes(5);
  expect(
    mockWarn.mock.calls.filter(([, message]) => message.includes('This host stopped'))
  ).toHaveLength(0);
  expect(candidate.status).toBe('paused');
});

for (const failure of [
  'json',
  'shape',
  'identity',
  'config',
  'record',
  'record-path',
  'workflow',
] as const) {
  test(`structural ${failure} refusal survives resolution and stops retrying`, async () => {
    const root = await sourceFixture();
    const manifestPath = join(root, 'manifest.json');
    const manifest = (await loadWorkflowSource(root)).manifest;
    const candidate = run(`structural-${failure}`, 'paused', {
      wait: {
        owner: 'node',
        kind: 'time',
        nodeId: 'delay',
        waitingSince: '2026-08-24T10:00:00Z',
        resumeAt: '2026-08-24T11:00:00Z',
      },
      workflow_source: {
        ...manifest,
        root,
        ...(failure === 'identity' ? { digest: 'different-run-digest' } : {}),
        ...(failure === 'config'
          ? { source_config: { ...DEFAULT_WORKFLOW_SOURCE_CONFIG, command_folder: 'different' } }
          : {}),
      },
    });
    if (failure === 'json') await fs.writeFile(manifestPath, '{');
    if (failure === 'shape') await fs.writeFile(manifestPath, JSON.stringify({ version: 99 }));
    if (failure === 'record') candidate.metadata.workflow_source = { version: 99 };
    if (failure === 'record-path') candidate.metadata.workflow_source = { version: 99, root };
    const reasons = {
      json: 'not valid JSON',
      shape: 'not a shape this build understands',
      identity: 'not the one this run recorded',
      config: 'different resolution settings',
      record: 'source record cannot be read',
      'record-path': 'source record cannot be read',
      workflow: 'no longer contains that workflow',
    };
    const { resolveRunWorkflow } = await import('./resolve-run-workflow');
    const { createWorkflowDeps } = await import('./store-adapter');
    const deps = createWorkflowDeps();
    mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
    mockDeferWorkflowContinuation.mockClear();
    mockWarn.mockClear();
    const resume = mock(async () => {
      const result = await resolveRunWorkflow(deps, candidate, root, {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('invalid source admitted');
      expect(result.message).toContain(reasons[failure]);
      return {
        kind: 'unavailable' as const,
        reason: result.message,
        sourceError: result.sourceError,
      };
    });
    for (let i = 0; i < 8; i++)
      await wakeDueWorkflowContinuations(store, new Date('2026-08-24T12:00:00Z'), resume);
    expect(resume).toHaveBeenCalledTimes(3);
    expect(mockDeferWorkflowContinuation).toHaveBeenCalledTimes(2);
    const warnings = mockWarn.mock.calls.filter(([, message]) =>
      message.includes('This host stopped')
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatchObject({
      runId: candidate.id,
      path:
        failure === 'record'
          ? undefined
          : failure === 'json' || failure === 'shape'
            ? manifestPath
            : root,
    });
    expect(warnings[0]?.[1]).toContain(`archon workflow resume ${candidate.id}`);
    expect(warnings[0]?.[1]).toContain(`archon workflow abandon ${candidate.id}`);
    if (failure === 'record') expect(warnings[0]?.[1]).toContain('path unavailable');
    expect(candidate.status).toBe('paused');
  });
}

for (const replacement of [false, true]) {
  test(`a missing captured file${replacement ? ' with an equal-count replacement' : ''} reaches the bound and warns once`, async () => {
    const root = await sourceFixture();
    await fs.unlink(join(root, 'source.txt'));
    if (replacement) await fs.writeFile(join(root, 'other.txt'), 'frozen');
    const candidate = run(`missing-entry-${replacement}`, 'paused', {
      wait: {
        owner: 'node',
        kind: 'time',
        nodeId: 'delay',
        waitingSince: '2026-08-24T10:00:00Z',
        resumeAt: '2026-08-24T11:00:00Z',
      },
    });
    mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
    mockDeferWorkflowContinuation.mockClear();
    mockWarn.mockClear();
    const resume = mock(async () => {
      await loadWorkflowSource(root);
      return { kind: 'not-accepted' as const };
    });
    for (let i = 0; i < 8; i++)
      await wakeDueWorkflowContinuations(store, new Date('2026-08-24T12:00:00Z'), resume);
    expect(resume).toHaveBeenCalledTimes(3);
    expect(mockDeferWorkflowContinuation).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0]?.[0]).toMatchObject({ path: root, runId: candidate.id });
    expect(candidate.status).toBe('paused');
  });
}

test('blocked rows do not starve later continuations in the same database', async () => {
  const candidates = Array.from({ length: 26 }, (_, i) =>
    run(`queue-${i}`, 'paused', {
      wait: {
        owner: 'node',
        kind: 'time',
        nodeId: 'delay',
        waitingSince: '2026-08-24T10:00:00Z',
        resumeAt: '2026-08-24T11:00:00Z',
      },
    })
  );
  mockListDueWorkflowContinuations.mockImplementation(async (_now: Date, limit: number) =>
    candidates.slice(0, limit)
  );
  const resume = mock(async (candidate: WorkflowRun) =>
    candidate.id === 'queue-25'
      ? {
          kind: 'accepted' as const,
          run: candidate,
          settled: Promise.resolve({ success: true as const, workflowRunId: candidate.id }),
        }
      : {
          kind: 'unavailable' as const,
          reason: 'source unreadable',
          sourceError: new WorkflowSourceUnavailableError('/foreign/source', new Error('ENOENT')),
        }
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    await wakeDueWorkflowContinuations(store, new Date('2026-08-24T11:00:00Z'), resume);
  }
  resume.mockClear();
  const outcomes = await wakeDueWorkflowContinuations(
    store,
    new Date('2026-08-24T12:00:00Z'),
    resume
  );
  expect(resume).toHaveBeenCalledTimes(1);
  expect(outcomes).toEqual([expect.objectContaining({ runId: 'queue-25', kind: 'accepted' })]);
});

test('a manually recovered run can wake at its next occurrence and warns only once per process', async () => {
  const { createFileWorkflowStore } = await import('@archon/workflows/file-store');
  const root = trackTempRoot(await fs.mkdtemp(join(tmpdir(), 'continuation-recovery-')));
  const persisted = await createFileWorkflowStore({ root });
  const candidate = await persisted.createWorkflowRun({
    workflow_name: 'deliver',
    user_message: '',
  });
  await persisted.claimPendingWorkflowRun(candidate.id);
  const wait = {
    owner: 'node' as const,
    kind: 'time' as const,
    nodeId: 'delay',
    waitingSince: '2026-08-24T10:00:00Z',
    resumeAt: '2026-08-24T11:00:00Z',
  };
  await persisted.pauseWorkflowRunForWait(candidate.id, wait, {
    kind: 'started',
    stepName: 'delay',
  });
  mockWarn.mockClear();
  const refuse = mock(async () => ({
    kind: 'unavailable' as const,
    reason: 'source unavailable',
    sourceError: new WorkflowSourceUnavailableError('/foreign/source', new Error('missing')),
  }));
  for (let i = 0; i < 4; i++)
    await wakeDueWorkflowContinuations(
      persisted,
      new Date(Date.parse('2026-08-24T12:00:00Z') + i * 60_000),
      refuse
    );
  expect(refuse).toHaveBeenCalledTimes(3);
  await persisted.resumeWorkflowRun(candidate.id);
  await persisted.pauseWorkflowRunForWait(
    candidate.id,
    { ...wait, waitingSince: '2026-08-24T12:00:00Z', resumeAt: '2026-08-24T13:00:00Z' },
    { kind: 'started', stepName: 'delay' }
  );
  const accept = mock(async (_run: WorkflowRun, cursor: WorkflowResumeCursor) => {
    expect(cursor).toEqual({ kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T13:00:00Z' });
    const resumed = await persisted.resumeWorkflowRun(candidate.id, cursor);
    return {
      kind: 'accepted' as const,
      run: resumed,
      settled: Promise.resolve({ success: true as const, workflowRunId: candidate.id }),
    };
  });
  expect(
    (await wakeDueWorkflowContinuations(persisted, new Date('2026-08-24T14:00:00Z'), accept))[0]
      ?.kind
  ).toBe('accepted');
  expect(accept).toHaveBeenCalledTimes(1);
  await persisted.pauseWorkflowRunForWait(
    candidate.id,
    {
      ...wait,
      nodeId: 'later',
      waitingSince: '2026-08-24T14:00:00Z',
      resumeAt: '2026-08-24T15:00:00Z',
    },
    { kind: 'started', stepName: 'later' }
  );
  for (let i = 0; i < 4; i++)
    await wakeDueWorkflowContinuations(
      persisted,
      new Date(Date.parse('2026-08-24T16:00:00Z') + i * 60_000),
      refuse
    );
  expect(refuse).toHaveBeenCalledTimes(6);
  expect(
    mockWarn.mock.calls.filter(([, message]) => message.includes('This host stopped'))
  ).toHaveLength(1);
  expect((await persisted.getWorkflowRun(candidate.id))?.status).toBe('paused');
});

async function discoveryRecoveryFixture(
  id: string,
  files: Record<string, string>,
  config = DEFAULT_WORKFLOW_SOURCE_CONFIG,
  workflowName = 'deliver'
) {
  const root = await sourceFixture();
  const manifest = { ...(await loadWorkflowSource(root)).manifest };
  await fs.unlink(join(root, 'source.txt'));
  const digest = createHash('sha256');
  for (const [relative, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    await fs.mkdir(join(root, relative, '..'), { recursive: true });
    await fs.writeFile(join(root, relative), content);
    digest.update(`${relative}\0${createHash('sha256').update(content).digest('hex')}\n`);
  }
  manifest.digest = digest.digest('hex');
  manifest.file_count = Object.keys(files).length;
  manifest.byte_count = Object.values(files).reduce(
    (total, content) => total + Buffer.byteLength(content),
    0
  );
  manifest.source_config = config;
  await fs.writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  const capture = await loadWorkflowSource(root);
  const candidate = run(id, 'paused', {
    workflow_source: { ...capture.manifest, root },
    wait: {
      owner: 'node',
      kind: 'time',
      nodeId: 'delay',
      waitingSince: '2026-08-24T10:00:00Z',
      resumeAt: '2026-08-24T11:00:00Z',
    },
  });
  candidate.workflow_name = workflowName;
  const { resolveRunWorkflow } = await import('./resolve-run-workflow');
  const { createWorkflowDeps } = await import('./store-adapter');
  const deps = createWorkflowDeps();
  expect(await resolveRunWorkflow(deps, candidate, root, {})).toMatchObject({ ok: true });
  const resume = mock(async () => {
    const result = await resolveRunWorkflow(deps, candidate, root, {});
    return result.ok
      ? {
          kind: 'accepted' as const,
          run: candidate,
          settled: Promise.resolve({ success: true as const, workflowRunId: candidate.id }),
        }
      : { kind: 'unavailable' as const, reason: result.message, sourceError: result.sourceError };
  });
  mockListDueWorkflowContinuations.mockResolvedValue([candidate]);
  mockDeferWorkflowContinuation.mockClear();
  mockWarn.mockClear();
  return { root, candidate, resume };
}

async function expectDiscoveryRecovery(
  { candidate, resume }: Awaited<ReturnType<typeof discoveryRecoveryFixture>>,
  restore: () => void
) {
  try {
    for (let i = 0; i < 5; i++) {
      const now = new Date(Date.parse('2026-08-24T12:00:00Z') + i * 60_000);
      expect((await wakeDueWorkflowContinuations(store, now, resume))[0]?.kind).toBe('unavailable');
      expect(mockDeferWorkflowContinuation).toHaveBeenLastCalledWith(
        candidate.id,
        new Date(now.getTime() + 60_000).toISOString(),
        { kind: 'wait', nodeId: 'delay', resumeAt: '2026-08-24T11:00:00Z' }
      );
    }
  } finally {
    restore();
  }
  expect(
    (await wakeDueWorkflowContinuations(store, new Date('2026-08-24T13:00:00Z'), resume))[0]?.kind
  ).toBe('accepted');
  expect(resume).toHaveBeenCalledTimes(6);
  expect(mockDeferWorkflowContinuation).toHaveBeenCalledTimes(5);
  expect(
    mockWarn.mock.calls.filter(([, message]) => message.includes('This host stopped'))
  ).toHaveLength(0);
}

for (const scope of ['packaged', 'project', 'configured', 'global', 'legacy'] as const) {
  const operations = scope === 'packaged' ? (['read'] as const) : (['read', 'inspect'] as const);
  for (const operation of operations) {
    test(`temporary ${scope} command ${operation} keeps retrying and recovers`, async () => {
      const dir =
        scope === 'packaged'
          ? 'project/.archon/workflows/pack/block/commands'
          : scope === 'project'
            ? 'project/.archon/commands'
            : scope === 'configured'
              ? 'project/custom-commands'
              : scope === 'global'
                ? 'global/commands'
                : 'bundled/commands/defaults';
      const commandName =
        scope === 'packaged' ? '__archon_pack__project:pack:block::review' : 'review';
      const fixture = await discoveryRecoveryFixture(
        `command-recovery-${scope}-${operation}`,
        {
          'project/.archon/workflows/deliver.yaml':
            'name: deliver\ndescription: Test\nnodes:\n  - id: inc\n    include: nested\n',
          'project/.archon/workflows/nested.yaml':
            'name: nested\ndescription: Test\nnodes:\n  - id: inc\n    include: block\n',
          'project/.archon/workflows/block.yaml': JSON.stringify({
            name: 'block',
            description: 'Test',
            nodes:
              scope === 'project' && operation === 'inspect'
                ? [
                    {
                      id: 'group',
                      loop_group: {
                        until: 'DONE',
                        max_iterations: 1,
                        nodes: [{ id: 'act', command: commandName }],
                      },
                    },
                  ]
                : [{ id: 'act', command: commandName }],
          }),
          [`${dir}/review.md`]: 'Review the changes.',
        },
        {
          ...DEFAULT_WORKFLOW_SOURCE_CONFIG,
          ...(scope === 'configured' ? { command_folder: 'custom-commands' } : {}),
        }
      );
      const cause = Object.assign(new Error('temporary I/O failure'), { code: 'EMFILE' });
      const readFile = fs.readFile;
      const findCommandFiles = paths.findCommandFiles;
      const fault =
        operation === 'read'
          ? spyOn(fs, 'readFile').mockImplementation(
              new Proxy(readFile, {
                apply(target, receiver, args) {
                  if (args[0] === join(fixture.root, dir, 'review.md') && args[1] === 'utf-8')
                    return Promise.reject(cause);
                  return Reflect.apply(target, receiver, args);
                },
              })
            )
          : spyOn(paths, 'findCommandFiles').mockImplementation(async directory => {
              if (directory === join(fixture.root, dir)) throw cause;
              return findCommandFiles(directory);
            });
      await expectDiscoveryRecovery(fixture, () => fault.mockRestore());
    });
  }
}

for (const scope of [
  'project',
  'global',
  'bundled',
  'installed',
  'project-shared',
  'global-shared',
] as const) {
  test(`${scope} script inspection failure isolates healthy workflows and retries its owner`, async () => {
    const shared = scope.endsWith('-shared');
    const base =
      scope === 'project' || shared
        ? 'project/.archon/workflows/pack'
        : scope === 'installed'
          ? 'installed/acme.pack'
          : `${scope}/workflows/pack`;
    const fixture = await discoveryRecoveryFixture(
      `script-recovery-${scope}`,
      {
        [`${base}/deliver/workflow.yaml`]:
          'name: deliver\ndescription: Test\nnodes:\n  - id: act\n    script: task\n    runtime: bun\n',
        [`${base}/deliver/scripts/task.ts`]: 'console.log("done");',
        [`${base}/healthy/healthy.yaml`]:
          'name: healthy\ndescription: Test\nnodes:\n  - id: act\n    script: task\n    runtime: bun\n',
        [`${base}/healthy/scripts/task.ts`]: 'console.log("healthy");',
        ...(shared
          ? {
              'project/.archon/workflows/shared.yaml':
                'name: shared\ndescription: Test\nnodes:\n  - id: act\n    script: unrelated\n    runtime: bun\n',
              'project/.archon/workflows/healthy-shared.yaml':
                'name: healthy-shared\ndescription: Test\nnodes:\n  - id: act\n    script: good\n    runtime: bun\n',
              [`${scope === 'project-shared' ? 'project/.archon' : 'global'}/scripts/good.ts`]:
                'console.log("healthy");',
              [`${scope === 'project-shared' ? 'project/.archon' : 'global'}/scripts/unrelated.ts`]:
                'console.log("unrelated");',
            }
          : {}),
        ...(scope === 'installed'
          ? {
              [`${base}/archon-plugin.json`]: JSON.stringify({
                schemaVersion: 1,
                kind: 'workflow-pack',
                name: 'pack',
                description: 'Test',
                entrypoints: { deliver: 'deliver/workflow.yaml', healthy: 'healthy/healthy.yaml' },
              }),
            }
          : {}),
      },
      DEFAULT_WORKFLOW_SOURCE_CONFIG,
      scope === 'installed' ? 'acme/pack:deliver' : shared ? 'shared' : 'deliver'
    );
    const cause = Object.assign(new Error('temporary I/O failure'), { code: 'EIO' });
    const stat = fs.stat;
    const inspect = spyOn(fs, 'stat').mockImplementation(
      new Proxy(stat, {
        apply(target, receiver, args) {
          if (
            args[0] ===
            join(
              fixture.root,
              shared
                ? `${scope === 'project-shared' ? 'project/.archon' : 'global'}/scripts/unrelated.ts`
                : `${base}/deliver/scripts/task.ts`
            )
          )
            return Promise.reject(cause);
          return Reflect.apply(target, receiver, args);
        },
      })
    );
    try {
      const { resolveRunWorkflow } = await import('./resolve-run-workflow');
      const { createWorkflowDeps } = await import('./store-adapter');
      const healthy = {
        ...fixture.candidate,
        workflow_name: scope === 'installed' ? 'acme/pack:healthy' : 'healthy',
      };
      expect(
        await resolveRunWorkflow(createWorkflowDeps(), healthy, fixture.root, {})
      ).toMatchObject({ ok: true });
      if (shared) {
        expect(
          await resolveRunWorkflow(
            createWorkflowDeps(),
            { ...fixture.candidate, workflow_name: 'healthy-shared' },
            fixture.root,
            {}
          )
        ).toMatchObject({ ok: true });
      }
      await expectDiscoveryRecovery(fixture, () => inspect.mockRestore());
    } finally {
      inspect.mockRestore();
    }
  });
}
