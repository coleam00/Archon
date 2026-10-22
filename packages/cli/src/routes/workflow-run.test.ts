import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { Codebase } from '@archon/core/schemas/codebase';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { RUN_PROJECT_CONFLICT_FLAGS } from '../dispatch-guards';
import * as commands from '../commands/workflow';
import { captureWorkflowCommand } from '../test-support/command';
import { runWorkflowRun } from './workflow-run';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
});

const repo: Codebase = {
  id: 'registered-id',
  name: 'acme/app',
  kind: 'repo',
  default_cwd: '/registered',
  repository_url: null,
  default_branch: null,
  ai_assistant_type: null,
  commands: {},
  created_at: new Date(),
  updated_at: new Date(),
};

type InvocationOptions = {
  missing?: boolean;
  lookupError?: boolean;
  getError?: boolean;
  detachedStatus?: 'pending' | 'running' | 'completed' | 'failed';
  json?: boolean;
  detachedOwner?: boolean;
  rowWorkflowName?: string;
  workflowNames?: readonly string[];
  wrongToken?: boolean;
  missingToken?: boolean;
  explicitSource?: boolean;
  sourceFile?: boolean;
  claimBeforeFailure?: boolean;
};

async function createDetachedRows(host: WorkflowHost, options: InvocationOptions) {
  const otherLaunch = options.wrongToken
    ? await host.deps.store.createWorkflowRun({
        workflow_name: 'probe',
        user_message: '',
        metadata: { cli_detached_launch_token: 'launch-token' },
      })
    : undefined;
  const handedOver = options.detachedStatus
    ? await host.deps.store.createWorkflowRun({
        workflow_name: options.rowWorkflowName ?? 'probe',
        user_message: '',
        metadata: {
          cli_detached_launch_token: options.wrongToken ? 'another-launch' : 'launch-token',
        },
      })
    : undefined;
  if (handedOver && options.detachedStatus !== 'pending') {
    await host.deps.store.claimPendingWorkflowRun(handedOver.id);
    if (options.detachedStatus === 'completed') {
      await host.deps.store.completeWorkflowRun(handedOver.id, { duration_ms: 1 });
    } else if (options.detachedStatus === 'failed') {
      await host.deps.store.failWorkflowRun(handedOver.id, 'original failure');
    }
  }
  return { otherLaunch, handedOver };
}

async function invoke(
  values: Record<string, unknown>,
  rows = [repo],
  options: InvocationOptions = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'archon-project-route-'));
  roots.push(home);
  if (options.sourceFile) writeFileSync(join(home, 'source'), 'not a directory');
  if (options.workflowNames) {
    const workflows = join(
      home,
      ...(options.explicitSource ? ['source'] : []),
      '.archon',
      'workflows'
    );
    mkdirSync(workflows, { recursive: true });
    for (const name of options.workflowNames) {
      writeFileSync(
        join(workflows, `${name}.yaml`),
        `name: ${name}\ndescription: Probe\nnodes:\n  - id: check\n    bash: echo ok\n`
      );
    }
  }
  const run = mock<typeof commands.workflowRunCommand>(async () => {});
  let exitCode: number | undefined;
  let stdout = '';
  let storedRun: WorkflowRun | null | undefined;
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk, callback) => {
    stdout += String(chunk);
    if (typeof callback === 'function') callback();
    return true;
  });
  const result = await captureWorkflowCommand(home, async host => {
    process.env.ARCHON_DETACHED_RUN_OWNER = options.detachedOwner === false ? '' : '1';
    process.env.ARCHON_DETACHED_LAUNCH_TOKEN = options.missingToken ? '' : 'launch-token';
    const { otherLaunch, handedOver } = await createDetachedRows(host, options);
    if (options.claimBeforeFailure) {
      const fail = host.deps.store.failWorkflowRun.bind(host.deps.store);
      spyOn(host.deps.store, 'failWorkflowRun').mockImplementation(async (id, error, options) => {
        await host.deps.store.claimPendingWorkflowRun(id);
        return fail(id, error, options);
      });
    }
    const list = spyOn(host.records.codebases, 'listCodebaseClaims').mockImplementation(
      async () => {
        if (options.lookupError) throw new Error('registry unavailable');
        return rows;
      }
    );
    const get = spyOn(host.records.codebases, 'getCodebase').mockImplementation(async id => {
      if (options.getError) throw new Error('project read unavailable');
      return options.missing ? null : (rows.find(row => row.id === id) ?? null);
    });
    try {
      exitCode = await runWorkflowRun({
        host,
        commands: { ...commands, workflowRunCommand: run },
        values: {
          ...values,
          ...(options.explicitSource ? { 'workflow-source': join(home, 'source') } : {}),
          ...(handedOver ? { 'internal-detached-run-id': handedOver.id } : {}),
        },
        positionals: ['workflow', 'run', 'probe', 'message'],
        command: 'workflow',
        subcommand: 'run',
        cwd: '/launch/subdir',
        effectiveCwd: options.workflowNames && !options.explicitSource ? home : '/launch',
        json: options.json,
        detachedRunConfig: undefined,
        inheritedEnv: {},
        forgeTrustedEnv: {},
      });
      if (handedOver) storedRun = await host.deps.store.getWorkflowRun(handedOver.id);
      if (otherLaunch) {
        expect((await host.deps.store.getWorkflowRun(otherLaunch.id))?.status).toBe('pending');
      }
    } finally {
      list.mockRestore();
      get.mockRestore();
    }
  });
  write.mockRestore();
  expect(result.status, result.output).toBe(0);
  return { run, exitCode, output: result.output, stderr: result.stderr, stdout, storedRun };
}

test.each([false, true])(
  'records an authorized detached source-directory refusal (file: %s)',
  async sourceFile => {
    const result = await invoke({}, [repo], {
      explicitSource: true,
      sourceFile,
      detachedStatus: 'pending',
      json: true,
    });
    const { error } = JSON.parse(result.stdout);
    expect(error).toContain('Error: --workflow-source is not a directory:');
    expect(error).toContain('Point it at the checkout holding .archon/workflows/.');
    expect(result.exitCode).toBe(1);
    expect(result.run).not.toHaveBeenCalled();
    expect(result.storedRun).toMatchObject({
      status: 'failed',
      metadata: {
        error: `Detached run failed to start: ${error}`,
        stop_reason: { reason: 'launch_failed' },
      },
    });
  }
);

test('passes an available explicit source to the detached run command', async () => {
  const result = await invoke({}, [repo], {
    explicitSource: true,
    workflowNames: ['probe'],
    detachedStatus: 'pending',
  });
  expect(result.exitCode).toBe(0);
  expect(result.run).toHaveBeenCalledTimes(1);
  expect(result.run.mock.calls[0]?.[4]?.discoveryCwd).toEndWith(`${sep}source`);
  expect(result.storedRun?.status).toBe('pending');
});

test.each([
  { name: 'unowned invocation', detachedOwner: false },
  { name: 'different launch', wrongToken: true },
  { name: 'missing token', missingToken: true },
  { name: 'ordinary invocation', detachedStatus: undefined },
  ...(['running', 'completed', 'failed'] as const).map(detachedStatus => ({
    name: detachedStatus,
    detachedStatus,
  })),
])('source refusal preserves runs outside startup ownership: $name', async options => {
  const result = await invoke({}, [repo], {
    detachedStatus: 'pending',
    ...options,
    explicitSource: true,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('--workflow-source is not a directory:');
  expect(result.run).not.toHaveBeenCalled();
  const expectedStatus = 'detachedStatus' in options ? options.detachedStatus : 'pending';
  expect(result.storedRun?.status).toBe(expectedStatus);
  expect(result.storedRun?.metadata?.error).toBe(
    options.name === 'failed' ? 'original failure' : undefined
  );
});

for (const flag of ['config', 'config-from-run']) {
  test.each([false, true])(`refuses --${flag} on run --resume (json: %s)`, async json => {
    const result = await invoke({ resume: true, [flag]: 'unused-config' }, [repo], { json });
    const message =
      `Error: --${flag} cannot be used when continuing an existing workflow run. ` +
      'The run keeps the config it started with.';
    expect(result.exitCode).toBe(1);
    expect(result.run).not.toHaveBeenCalled();
    if (json) {
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: message });
      expect(result.stderr).not.toContain(message);
    } else {
      expect(result.stdout).toBe('');
      expect(result.stderr.endsWith(`${message}\n`)).toBe(true);
    }
  });
}

test.each(['acme/app', 'registered-id'])(
  'selects registered repository %s without changing launch cwd',
  async project => {
    const result = await invoke({
      project,
      'no-worktree': true,
      adopt: 'prior',
    });
    expect(result.exitCode).toBe(0);
    expect(result.run).toHaveBeenCalledTimes(1);
    const call = result.run.mock.calls[0];
    expect(call?.slice(1, 4)).toEqual(['/launch', 'probe', 'message']);
    expect(call?.[4]).toMatchObject({
      codebaseId: repo.id,
      noWorktree: true,
      adoptRunId: 'prior',
    });
  }
);

test('id takes precedence over another registered name', async () => {
  const result = await invoke({ project: repo.id }, [
    repo,
    { ...repo, id: 'other', name: repo.id },
  ]);
  expect(result.run.mock.calls[0]?.[4]?.codebaseId).toBe(repo.id);
});

test('flag absent preserves cwd and options without selecting a project', async () => {
  const result = await invoke({ branch: 'feature', input: ['key=value'] });
  expect(result.exitCode).toBe(0);
  expect(result.run.mock.calls[0]?.[1]).toBe('/launch');
  expect(result.run.mock.calls[0]?.[4]).toMatchObject({
    codebaseId: undefined,
    branchName: 'feature',
    inputs: ['key=value'],
    discoveryCwd: undefined,
  });
});

test.each([...RUN_PROJECT_CONFLICT_FLAGS])('refuses --project with --%s', async flag => {
  const result = await invoke({
    project: repo.name,
    [flag]: flag === 'base-branch' ? 'main' : true,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`--${flag}`);
  expect(result.run).not.toHaveBeenCalled();
});

test.each(['', 'unknown/repo', '@cwd/unknown', '_folder/unknown', 'not a key'])(
  'refuses unregistered selector %j before launch',
  async project => {
    const result = await invoke({ project });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('archon project list');
    expect(result.run).not.toHaveBeenCalled();
  }
);

test('refuses ambiguous names', async () => {
  const result = await invoke({ project: repo.name }, [repo, { ...repo, id: 'duplicate' }]);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('matches 2 codebases');
  expect(result.run).not.toHaveBeenCalled();
});

test('refuses folder project selection', async () => {
  const result = await invoke({ project: repo.id }, [{ ...repo, kind: 'folder' }]);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('requires a registered repository');
  expect(result.run).not.toHaveBeenCalled();
});

test('refuses a disappeared project', async () => {
  const result = await invoke({ project: repo.id }, [repo], { missing: true });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('no longer exists');
  expect(result.run).not.toHaveBeenCalled();
});

test('registry failure preserves evidence in the JSON refusal', async () => {
  const result = await invoke({ project: repo.name }, [repo], { lookupError: true, json: true });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: expect.stringContaining('registry unavailable'),
  });
  expect(result.run).not.toHaveBeenCalled();
});

test('refuses --project with --resume before calling the run command', async () => {
  const result = await invoke({ project: repo.name, resume: true });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Error: --project cannot be combined with --resume.');
  expect(result.run).not.toHaveBeenCalled();
});

test.each([
  { name: 'missing claim', rows: [], options: {}, error: 'is not registered' },
  { name: 'missing row', rows: [repo], options: { missing: true }, error: 'no longer exists' },
  {
    name: 'list failure',
    rows: [repo],
    options: { lookupError: true },
    error: 'registry unavailable',
  },
  {
    name: 'get failure',
    rows: [repo],
    options: { getError: true },
    error: 'project read unavailable',
  },
  {
    name: 'changed kind',
    rows: [{ ...repo, kind: 'folder' as const }],
    options: {},
    error: 'requires a registered repository',
  },
  {
    name: 'ambiguous name',
    rows: [repo, { ...repo, id: 'duplicate' }],
    options: {},
    error: 'matches 2 codebases',
  },
])('records a detached project resolution refusal: $name', async ({ rows, options, error }) => {
  const result = await invoke({ project: repo.name }, [...rows], {
    ...options,
    detachedStatus: 'pending',
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(error);
  expect(result.run).not.toHaveBeenCalled();
  expect(result.storedRun).toMatchObject({
    status: 'failed',
    metadata: {
      error: expect.stringContaining(error),
      stop_reason: { reason: 'launch_failed' },
    },
  });
});

test.each(['running', 'completed', 'failed'] as const)(
  'project refusal leaves a %s detached run alone',
  async detachedStatus => {
    const result = await invoke({ project: 'missing' }, [], { detachedStatus });
    expect(result.exitCode).toBe(1);
    expect(result.storedRun?.status).toBe(detachedStatus);
    expect(result.storedRun?.metadata?.error).toBe(
      detachedStatus === 'failed' ? 'original failure' : undefined
    );
  }
);

test.each([...RUN_PROJECT_CONFLICT_FLAGS])(
  'records a detached --project conflict with --%s',
  async flag => {
    const result = await invoke(
      { project: repo.name, [flag]: flag === 'base-branch' ? 'main' : true },
      [repo],
      { detachedStatus: 'pending' }
    );
    expect(result.exitCode).toBe(1);
    expect(result.run).not.toHaveBeenCalled();
    expect(result.storedRun).toMatchObject({
      status: 'failed',
      metadata: { error: expect.stringContaining(`--${flag}`) },
    });
  }
);

test.each([
  { name: 'unowned invocation', detachedOwner: false },
  { name: 'same workflow, different launch', wrongToken: true },
  { name: 'missing launch identity', missingToken: true },
])('project refusal preserves another pending run: $name', async options => {
  const result = await invoke({ project: 'missing' }, [], {
    ...options,
    detachedStatus: 'pending',
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('is not registered');
  expect(result.run).not.toHaveBeenCalled();
  expect(result.storedRun?.status).toBe('pending');
  expect(result.storedRun?.metadata?.error).toBeUndefined();
});

test.each([false, true])(
  'records project refusal with explicit source: %s',
  async explicitSource => {
    const result = await invoke({ project: 'missing' }, [], {
      detachedStatus: 'pending',
      rowWorkflowName: 'archon-probe',
      workflowNames: ['archon-probe'],
      explicitSource,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('is not registered');
    expect(result.run).not.toHaveBeenCalled();
    expect(result.storedRun).toMatchObject({
      status: 'failed',
      metadata: { stop_reason: { reason: 'launch_failed' } },
    });
  }
);

test.each(['source', 'project'])(
  'startup %s refusal preserves a concurrent execution claim',
  async refusal => {
    const result = await invoke(refusal === 'project' ? { project: 'missing' } : {}, [], {
      explicitSource: refusal === 'source',
      detachedStatus: 'pending',
      claimBeforeFailure: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.run).not.toHaveBeenCalled();
    expect(result.storedRun?.status).toBe('running');
    expect(result.storedRun?.metadata.error).toBeUndefined();
    expect(result.storedRun?.metadata.stop_reason).toBeUndefined();
  }
);
