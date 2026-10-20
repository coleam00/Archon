import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { Codebase } from '@archon/core/schemas/codebase';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as detachedControl from '../utils/detached-run-control';
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

async function invoke(
  values: Record<string, unknown>,
  rows = [repo],
  options: {
    missing?: boolean;
    lookupError?: boolean;
    getError?: boolean;
    detachedStatus?: 'pending' | 'running' | 'completed' | 'failed';
    json?: boolean;
    detachedOwner?: boolean;
    ownerClaimError?: boolean;
    rowWorkflowName?: string;
    workflowNames?: readonly string[];
  } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'archon-project-route-'));
  roots.push(home);
  if (options.workflowNames) {
    const workflows = join(home, '.archon', 'workflows');
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
    const claimOwner = spyOn(detachedControl, 'claimDetachedRunProcessOwner').mockImplementation(
      async () => {
        if (options.ownerClaimError) throw new Error('not a process owner');
      }
    );
    const handedOver = options.detachedStatus
      ? await host.deps.store.createWorkflowRun({
          workflow_name: options.rowWorkflowName ?? 'probe',
          user_message: '',
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
          ...(handedOver ? { 'internal-detached-run-id': handedOver.id } : {}),
        },
        positionals: ['workflow', 'run', 'probe', 'message'],
        command: 'workflow',
        subcommand: 'run',
        cwd: '/launch/subdir',
        effectiveCwd: options.workflowNames ? home : '/launch',
        json: options.json,
        detachedRunConfig: undefined,
        inheritedEnv: {},
        forgeTrustedEnv: {},
      });
      if (handedOver) storedRun = await host.deps.store.getWorkflowRun(handedOver.id);
    } finally {
      claimOwner.mockRestore();
      list.mockRestore();
      get.mockRestore();
    }
  });
  write.mockRestore();
  expect(result.status, result.output).toBe(0);
  return { run, exitCode, output: result.output, stdout, storedRun };
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
  { name: 'refused process claim', ownerClaimError: true },
  { name: 'different workflow', rowWorkflowName: 'unrelated' },
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

test.each([
  { names: ['archon-probe'], expected: 'failed' },
  { names: ['archon-probe', 'probe'], expected: 'pending' },
  { names: ['archon-probe', 'other-probe'], expected: 'pending' },
  { names: [], expected: 'pending' },
])('validates shorthand against all discovered workflows: $names', async ({ names, expected }) => {
  const result = await invoke({ project: 'missing' }, [], {
    detachedStatus: 'pending',
    rowWorkflowName: 'archon-probe',
    workflowNames: names,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('is not registered');
  expect(result.run).not.toHaveBeenCalled();
  expect(result.storedRun?.status).toBe(expected);
});
