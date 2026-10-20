import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { Codebase } from '@archon/core/schemas/codebase';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    json?: boolean;
  } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'archon-project-route-'));
  roots.push(home);
  const run = mock<typeof commands.workflowRunCommand>(async () => {});
  let exitCode: number | undefined;
  let stdout = '';
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk, callback) => {
    stdout += String(chunk);
    if (typeof callback === 'function') callback();
    return true;
  });
  const result = await captureWorkflowCommand(home, async host => {
    const list = spyOn(host.records.codebases, 'listCodebaseClaims').mockImplementation(
      async () => {
        if (options.lookupError) throw new Error('registry unavailable');
        return rows;
      }
    );
    const get = spyOn(host.records.codebases, 'getCodebase').mockImplementation(async id =>
      options.missing ? null : (rows.find(row => row.id === id) ?? null)
    );
    try {
      exitCode = await runWorkflowRun({
        host,
        commands: { ...commands, workflowRunCommand: run },
        values,
        positionals: ['workflow', 'run', 'probe', 'message'],
        command: 'workflow',
        subcommand: 'run',
        cwd: '/launch/subdir',
        effectiveCwd: '/launch',
        json: options.json,
        detachedRunConfig: undefined,
        inheritedEnv: {},
        forgeTrustedEnv: {},
      });
    } finally {
      list.mockRestore();
      get.mockRestore();
    }
  });
  write.mockRestore();
  expect(result.status, result.output).toBe(0);
  return { run, exitCode, output: result.output, stdout };
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
