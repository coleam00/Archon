import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { validateStructuredOutput } from '@archon/providers';
import { parseWorkflow } from '../packages/workflows/src/loader';
import { resolveWorkflow } from '../packages/workflows/src/graph-plan';
import { qualifyWorkflowResources } from '../packages/workflows/src/packaged-workflow';
import { dryRunWorkflow } from '../packages/workflows/src/dry-run';
import { parseFixtureFile } from '../packages/workflows/src/fixture-runner';
import {
  decide,
  externalPath,
  github,
  governMerge,
  localIO,
  parseAcceptance,
  parsePolicy,
  parseTarget,
  runCommand,
  type Acceptance,
  type AcceptanceReceipt,
  type Candidate,
  type MergeIO,
  type MergeResult,
  type Policy,
  type PullRequest,
  type RunCommand,
} from '../.archon/workflows/sdlc/merge/scripts/merge';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const commit = 'c'.repeat(40);
const receipt: Acceptance = {
  schema_version: 1,
  repository: 'example/project',
  pr: 42,
  head_sha: head,
  base_sha: base,
  verdict: 'approve',
};
const wireReceipt: AcceptanceReceipt = {
  ...receipt,
  repository: { owner: 'example', name: 'project' },
};
const policy: Policy = {
  authorized: true,
  repository: receipt.repository,
  base_branch: 'release-test',
  required_checks: ['test'],
  hold_labels: ['hold'],
  accept_races: true,
};
const pull: PullRequest = {
  repository: receipt.repository,
  pr: 42,
  head_sha: head,
  base_branch: policy.base_branch,
  head_repository: receipt.repository,
  state: 'open',
  draft: false,
  merged: false,
  merge_commit: '',
  mergeable: true,
  labels: [],
  auto_merge: false,
};
const candidate: Candidate = {
  pull,
  base_sha: base,
  contains_base: true,
  checks: [{ name: 'test', passed: true }],
  merge_queue: false,
};

function mergeWorkflow() {
  const parsed = parseWorkflow(
    readFileSync(
      resolve(import.meta.dir, '../.archon/workflows/sdlc/merge/archon-merge.yaml'),
      'utf8'
    ),
    'archon-merge.yaml'
  );
  if (!parsed.workflow) throw new Error(parsed.error.error);
  return parsed.workflow;
}

const mergeNode = mergeWorkflow().nodes[0];
if (mergeNode.kind !== 'exec' || !mergeNode.output_format) {
  throw new Error('merge node must declare its result contract');
}
const outputSchema = mergeNode.output_format;

function harness() {
  const state = {
    policies: [structuredClone(policy), structuredClone(policy)],
    snapshots: [structuredClone(candidate), structuredClone(candidate)],
    stops: [false, false],
    pulls: [
      structuredClone(pull),
      structuredClone(pull),
      { ...pull, merged: true, state: 'closed', merge_commit: commit },
    ],
    writes: [] as MergeResult[],
    mutations: 0,
    policyReads: 0,
    inspections: 0,
    stopReads: 0,
    pullReads: 0,
    exit: 0,
    readbackFails: false,
    writeFails: false,
    mergeThrows: false,
    parentsFail: false,
    acceptance: structuredClone(wireReceipt),
    parents: [base, head],
    events: [] as string[],
  };
  const io: MergeIO = {
    async readPolicy() {
      state.events.push('policy');
      return state.policies[state.policyReads++];
    },
    async readAcceptance() {
      return parseAcceptance(state.acceptance);
    },
    async stopped() {
      state.events.push('stop');
      return state.stops[state.stopReads++];
    },
    async authenticate() {
      state.events.push('auth');
    },
    async readPull() {
      state.events.push('read');
      if (state.readbackFails && state.pullReads === 2) throw new Error('readback unavailable');
      return state.pulls[state.pullReads++];
    },
    async inspect(current) {
      state.events.push('inspect');
      return { ...state.snapshots[state.inspections++], pull: current };
    },
    async merge(actual) {
      expect(actual).toEqual(receipt);
      state.events.push('merge');
      state.mutations++;
      if (state.mergeThrows) throw new Error('transport broke');
      return state.exit;
    },
    async mergeParents() {
      if (state.parentsFail) throw new Error('read failed');
      return state.parents;
    },
    async write(value) {
      expect(validateStructuredOutput(value, outputSchema)).toMatchObject({ valid: true });
      if (state.writeFails) throw new Error('disk full');
      state.writes.push(value);
    },
  };
  return { state, io };
}

describe('governed merge decisions', () => {
  test('authorizes only the accepted base and head and rereads policy immediately before mutation', async () => {
    const { state, io } = harness();
    expect(decide(receipt, policy, candidate, false)).toBeNull();
    const outcome = await governMerge('42', io);
    expect(outcome.status).toBe('merged');
    expect(outcome.merge_commit).toBe(commit);
    expect(state.mutations).toBe(1);
    expect(
      state.events.slice(state.events.indexOf('merge') - 2, state.events.indexOf('merge') + 2)
    ).toEqual(['policy', 'stop', 'merge', 'read']);
    expect(state.writes).toEqual([outcome]);
  });

  const refusals: {
    name: string;
    mutate: (state: ReturnType<typeof harness>['state']) => void;
    status: MergeResult['status'];
  }[] = [
    {
      name: 'denied authorization',
      mutate: s => {
        s.policies[0].authorized = false;
      },
      status: 'held',
    },
    {
      name: 'unacknowledged races',
      mutate: s => {
        s.policies[0].accept_races = false;
      },
      status: 'held',
    },
    {
      name: 'hold label',
      mutate: s => {
        s.pulls[0].labels = ['hold', 'passed'];
      },
      status: 'held',
    },
    {
      name: 'stop present',
      mutate: s => {
        s.stops[0] = true;
      },
      status: 'held',
    },
    {
      name: 'stop appears at final read',
      mutate: s => {
        s.stops[1] = true;
      },
      status: 'held',
    },
    {
      name: 'policy revoked at final read',
      mutate: s => {
        s.policies[1].authorized = false;
      },
      status: 'held',
    },
    {
      name: 'policy repository changes',
      mutate: s => {
        s.policies[1].repository = 'elsewhere/project';
      },
      status: 'held',
    },
    {
      name: 'policy base changes',
      mutate: s => {
        s.policies[1].base_branch = 'other';
      },
      status: 'held',
    },
    {
      name: 'new required check',
      mutate: s => {
        s.policies[1].required_checks.push('new');
      },
      status: 'held',
    },
    {
      name: 'new hold label policy',
      mutate: s => {
        s.policies[1].hold_labels.push('passed');
        s.pulls[1].labels = ['passed'];
      },
      status: 'held',
    },
    {
      name: 'changed head',
      mutate: s => {
        s.pulls[0].head_sha = commit;
      },
      status: 'revalidation_required',
    },
    {
      name: 'head changes at final read',
      mutate: s => {
        s.pulls[1].head_sha = commit;
      },
      status: 'revalidation_required',
    },
    {
      name: 'moved base',
      mutate: s => {
        s.snapshots[0].base_sha = commit;
      },
      status: 'revalidation_required',
    },
    {
      name: 'base moves at final read',
      mutate: s => {
        s.snapshots[1].base_sha = commit;
      },
      status: 'revalidation_required',
    },
    {
      name: 'head lacks tested base',
      mutate: s => {
        s.snapshots[0].contains_base = false;
      },
      status: 'revalidation_required',
    },
    {
      name: 'missing required check despite passed label',
      mutate: s => {
        s.snapshots[0].checks = [];
        s.pulls[0].labels = ['passed'];
      },
      status: 'held',
    },
    {
      name: 'failed required check',
      mutate: s => {
        s.snapshots[0].checks[0].passed = false;
      },
      status: 'held',
    },
    {
      name: 'new pending check at final read',
      mutate: s => {
        s.snapshots[1].checks.push({ name: 'test', passed: false });
      },
      status: 'held',
    },
    {
      name: 'conflict',
      mutate: s => {
        s.pulls[0].mergeable = false;
      },
      status: 'held',
    },
    {
      name: 'unknown mergeability',
      mutate: s => {
        s.pulls[0].mergeable = null;
      },
      status: 'held',
    },
    {
      name: 'draft',
      mutate: s => {
        s.pulls[0].draft = true;
      },
      status: 'held',
    },
    {
      name: 'closed',
      mutate: s => {
        s.pulls[0].state = 'closed';
      },
      status: 'held',
    },
    {
      name: 'fork',
      mutate: s => {
        s.pulls[0].head_repository = 'fork/project';
      },
      status: 'held',
    },
    {
      name: 'retargeted base',
      mutate: s => {
        s.pulls[0].base_branch = 'other';
      },
      status: 'held',
    },
    {
      name: 'merge queue',
      mutate: s => {
        s.snapshots[0].merge_queue = true;
      },
      status: 'held',
    },
    {
      name: 'existing auto-merge',
      mutate: s => {
        s.pulls[0].auto_merge = true;
      },
      status: 'held',
    },
  ];
  for (const refusal of refusals) {
    test(`${refusal.name} never calls mutation`, async () => {
      const { state, io } = harness();
      refusal.mutate(state);
      expect((await governMerge('42', io)).status).toBe(refusal.status);
      expect(state.mutations).toBe(0);
    });
  }

  test('idempotency requires matching identity and merge parents, even after base advances', async () => {
    const { state, io } = harness();
    state.pulls[0] = state.pulls[2];
    state.snapshots[0].base_sha = commit;
    state.policies[0].authorized = false;
    expect((await governMerge('42', io)).status).toBe('merged');
    expect(state.mutations).toBe(0);
    expect(state.inspections).toBe(0);
  });
  test('concurrent matching merge between preflight reads is idempotent', async () => {
    const { state, io } = harness();
    state.pulls[1] = state.pulls[2];
    expect((await governMerge('42', io)).status).toBe('merged');
    expect(state.mutations).toBe(0);
  });
  for (const mismatch of ['head', 'parents', 'repository', 'base'] as const) {
    test(`already merged with different ${mismatch} is not idempotent success`, async () => {
      const { state, io } = harness();
      state.pulls[0] = state.pulls[2];
      if (mismatch === 'head') state.pulls[0].head_sha = commit;
      if (mismatch === 'parents') state.parents = [commit, head];
      if (mismatch === 'repository') state.pulls[0].repository = 'other/project';
      if (mismatch === 'base') state.pulls[0].base_branch = 'other';
      expect((await governMerge('42', io)).status).not.toBe('merged');
      expect(state.mutations).toBe(0);
    });
  }
  for (const throws of [false, true]) {
    test(`merge command ${throws ? 'throws' : 'exits nonzero'} but readback proves merged`, async () => {
      const { state, io } = harness();
      state.exit = 1;
      state.mergeThrows = throws;
      expect((await governMerge('42', io)).status).toBe('merged');
      expect(state.pullReads).toBe(3);
    });
  }
  test('nonzero merge with unmerged readback fails honestly', async () => {
    const { state, io } = harness();
    state.exit = 1;
    state.pulls[2] = pull;
    const outcome = await governMerge('42', io);
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('exit 1');
  });
  test('readback failure leaves outcome unknown without retry', async () => {
    const { state, io } = harness();
    state.readbackFails = true;
    const outcome = await governMerge('42', io);
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('unknown');
    expect(state.mutations).toBe(1);
  });
  test('parent read failure preserves evidence of the remote merge', async () => {
    const { state, io } = harness();
    state.parentsFail = true;
    const outcome = await governMerge('42', io);
    expect(outcome.status).toBe('failed');
    expect(outcome.merge_commit).toBe(commit);
    expect(outcome.summary).toContain('reports merged');
  });
  test('base race after preflight records the remote merge for manual reconciliation', async () => {
    const { state, io } = harness();
    state.parents = [commit, head];
    const outcome = await governMerge('42', io);
    expect(outcome.status).toBe('revalidation_required');
    expect(outcome.merge_commit).toBe(commit);
  });
  test('local write failure never relabels verified remote success as failed merge', async () => {
    const { state, io } = harness();
    state.writeFails = true;
    const outcome = await governMerge('42', io);
    expect(outcome.status).toBe('merged');
    expect(outcome.merge_commit).toBe(commit);
    expect(outcome.summary).toContain('Local merge.json write failed');
  });
  test('invalid acceptance and mismatched input refuse without mutation', async () => {
    for (const target of ['43', 'https://github.com/other/project/pull/42', '--admin']) {
      const { state, io } = harness();
      expect((await governMerge(target, io)).status).toBe('failed');
      expect(state.mutations).toBe(0);
    }
    const { state, io } = harness();
    state.acceptance.head_sha = 'short';
    expect((await governMerge('42', io)).status).toBe('failed');
    expect(state.mutations).toBe(0);
  });
});

describe('input contracts', () => {
  test('YAML result keys and status vocabulary conform to the TypeScript owner', () => {
    const fields = {
      status: 'string',
      repository: 'string',
      pr: 'integer',
      head_sha: 'string',
      base_sha: 'string',
      summary: 'string',
      merge_commit: 'string',
    } satisfies Record<keyof MergeResult, string>;
    const statuses = {
      merged: true,
      held: true,
      revalidation_required: true,
      failed: true,
    } satisfies Record<MergeResult['status'], true>;
    expect(outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: Object.keys(fields),
      properties: {
        ...Object.fromEntries(Object.entries(fields).map(([field, type]) => [field, { type }])),
        status: { type: 'string', enum: Object.keys(statuses) },
      },
    });
  });
  test('minimum receipt is accepted; unknown versions and malformed identities are refused', () => {
    expect(parseAcceptance(wireReceipt)).toEqual(receipt);
    for (const patch of [
      { schema_version: 2 },
      { verdict: 'reject' },
      { pr: 0 },
      { pr: '42' },
      { head_sha: 'abc' },
      { base_sha: null },
      { repository: 'url' },
    ]) {
      expect(() => parseAcceptance({ ...wireReceipt, ...patch })).toThrow();
    }
    expect(parseAcceptance({ ...wireReceipt, evidence: 'external extension' })).toEqual(receipt);
  });
  test('no default authorization, explicit booleans, unknown policy fields refused', () => {
    const { authorized: _authorized, accept_races: _races, ...denied } = policy;
    expect(parsePolicy(denied)).toMatchObject({ authorized: false, accept_races: false });
    for (const patch of [
      { authorized: 'true' },
      { accept_races: 'true' },
      { required_checks: 'test' },
      { hold_labels: [false] },
      { admin: true },
      { stop_file: 'relative' },
    ]) {
      expect(() => parsePolicy({ ...policy, ...patch })).toThrow();
    }
  });
  test('target uses explicit repository and positive safe PR number', () => {
    expect(parseTarget('https://github.com/Example/Project/pull/42', receipt.repository)).toBe(42);
    for (const value of [
      '0',
      '-1',
      '1.5',
      '9007199254740992',
      'https://github.example/project/pull/42',
      'https://token@github.com/example/project/pull/42',
    ]) {
      expect(() => parseTarget(value, receipt.repository)).toThrow();
    }
  });
});

function apiHarness() {
  const responses: Record<string, unknown> = {
    user: { login: 'operator', id: 1 },
    'repos/example/project/pulls/42': {
      number: 42,
      state: 'open',
      draft: false,
      merged: false,
      merge_commit_sha: null,
      mergeable: true,
      labels: [],
      auto_merge: null,
      head: { sha: head, repo: { full_name: receipt.repository } },
      base: { ref: policy.base_branch, repo: { full_name: receipt.repository } },
    },
    graphql: { data: { repository: { pullRequest: { isMergeQueueEnabled: false } } } },
    'repos/example/project/git/ref/heads/release-test': { object: { sha: base } },
    [`repos/example/project/compare/${base}...${head}`]: { merge_base_commit: { sha: base } },
    [`repos/example/project/commits/${head}/check-runs?filter=latest&per_page=100`]: [
      {
        total_count: 1,
        check_runs: [{ name: 'test', head_sha: head, status: 'completed', conclusion: 'success' }],
      },
    ],
    [`repos/example/project/commits/${head}/status?per_page=100`]: [
      { sha: head, total_count: 0, statuses: [] },
    ],
  };
  const calls: string[][] = [];
  const run: RunCommand = async args => {
    calls.push(args);
    if (args[1] === 'pr') return { exitCode: 1, stdout: 'human prose is not the result' };
    const key = args.find(arg => Object.hasOwn(responses, arg));
    if (!key) throw new Error(`Unexpected adapter call ${args.join(' ')}`);
    return { exitCode: 0, stdout: JSON.stringify(responses[key]) };
  };
  return { responses, calls, run, adapter: github(run) };
}

describe('GitHub structured API adapter', () => {
  test('reads REST fields and paginated check/status objects; pins mutation arguments', async () => {
    const { adapter, calls } = apiHarness();
    await adapter.authenticate();
    expect(await adapter.readPull(receipt.repository, 42)).toEqual(pull);
    expect(await adapter.inspect(pull)).toEqual(candidate);
    expect(await adapter.merge(receipt)).toBe(1);
    expect(calls.at(-1)).toEqual([
      'gh',
      'pr',
      'merge',
      '42',
      '--repo',
      'https://github.com/example/project',
      '--merge',
      '--match-head-commit',
      head,
    ]);
    expect(calls.filter(args => args.includes('--paginate'))).toHaveLength(2);
  });
  for (const [status, conclusion] of [
    ['queued', null],
    ['in_progress', null],
    ['completed', 'failure'],
    ['completed', 'neutral'],
    ['completed', 'skipped'],
    ['unknown', 'success'],
  ]) {
    test(`check run ${status}/${conclusion} prevents mutation through real decision`, async () => {
      const { responses, adapter } = apiHarness();
      responses[`repos/example/project/commits/${head}/check-runs?filter=latest&per_page=100`] = [
        { total_count: 1, check_runs: [{ name: 'test', head_sha: head, status, conclusion }] },
      ];
      expect(decide(receipt, policy, await adapter.inspect(pull), false)?.status).toBe('held');
    });
  }
  for (const state of ['pending', 'failure', 'error', 'unknown']) {
    test(`legacy commit status ${state} prevents merge`, async () => {
      const { responses, adapter } = apiHarness();
      responses[`repos/example/project/commits/${head}/status?per_page=100`] = [
        { sha: head, total_count: 1, statuses: [{ context: 'legacy', state }] },
      ];
      expect(decide(receipt, policy, await adapter.inspect(pull), false)?.status).toBe('held');
    });
  }
  test('checks on subsequent pages cannot disappear', async () => {
    const { responses, adapter } = apiHarness();
    responses[`repos/example/project/commits/${head}/status?per_page=100`] = [
      { sha: head, total_count: 2, statuses: [{ context: 'first', state: 'success' }] },
      { sha: head, total_count: 2, statuses: [{ context: 'second', state: 'pending' }] },
    ];
    expect(decide(receipt, policy, await adapter.inspect(pull), false)?.status).toBe('held');
  });
  test('API exit status and malformed JSON are failures, never classified by human stderr', async () => {
    for (const response of [
      { exitCode: 1, stdout: '{}' },
      { exitCode: 0, stdout: 'merged successfully' },
      { exitCode: 0, stdout: '{}' },
    ]) {
      await expect(github(async () => response).readPull(receipt.repository, 42)).rejects.toThrow();
    }
  });
  test('truncated pagination refuses instead of treating omitted checks as success', async () => {
    const { responses, adapter } = apiHarness();
    responses[`repos/example/project/commits/${head}/check-runs?filter=latest&per_page=100`] = [
      { total_count: 2, check_runs: [] },
    ];
    await expect(adapter.inspect(pull)).rejects.toThrow('pagination');
  });
});

const trackTempRoot = trackTempRoots();
function temp() {
  return trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-merge-test-')));
}

describe('external files and deterministic script execution', () => {
  test('real filesystem IO and GitHub adapter record a verified merge after a nonzero command', async () => {
    const root = temp();
    const cwd = join(root, 'candidate');
    mkdirSync(cwd);
    const policyPath = join(root, 'policy.json');
    const receiptPath = join(root, 'acceptance.json');
    writeFileSync(policyPath, JSON.stringify(policy));
    writeFileSync(receiptPath, JSON.stringify(wireReceipt));
    const { responses, calls, run } = apiHarness();
    responses[`repos/example/project/git/commits/${commit}`] = {
      parents: [{ sha: base }, { sha: head }],
    };
    const io = localIO(
      { INPUTS_POLICY: policyPath, INPUTS_RECEIPT: receiptPath, ARTIFACTS_DIR: root },
      cwd,
      async args => {
        const response = await run(args);
        if (args[1] === 'pr')
          responses['repos/example/project/pulls/42'] = {
            ...(responses['repos/example/project/pulls/42'] as object),
            merged: true,
            state: 'closed',
            merge_commit_sha: commit,
          };
        return response;
      }
    );
    const outcome = await governMerge('42', io);
    expect(outcome.status).toBe('merged');
    expect(calls.filter(args => args[1] === 'pr')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'merge.json'), 'utf8'))).toEqual(outcome);
  });
  test('pack dry-run fixture executes the actual named node in a safe scratch workspace', async () => {
    const repositoryRoot = resolve(import.meta.dir, '..');
    const mergeRoot = join(repositoryRoot, '.archon/workflows/sdlc/merge');
    const parsed = parseWorkflow(
      readFileSync(join(mergeRoot, 'archon-merge.yaml'), 'utf8'),
      'archon-merge.yaml'
    );
    if (!parsed.workflow) throw new Error(parsed.error.error);
    const workflow = resolveWorkflow(
      qualifyWorkflowResources(parsed.workflow, {
        source: 'project',
        pack: 'sdlc',
        workflow: 'merge',
      })
    );
    const fixture = parseFixtureFile(
      readFileSync(join(mergeRoot, 'fixtures/missing-policy.stubs.yaml'), 'utf8'),
      'missing-policy.stubs.yaml'
    );
    const simulation = await dryRunWorkflow({
      workflow,
      cwd: repositoryRoot,
      execWorkspace: temp(),
      userMessage: '',
      inputs: fixture.declaration.inputs,
      stubs: fixture.stubs,
      execCode: fixture.execCode,
    });
    expect(simulation.outcome).toBe('completed');
    const entry = simulation.trace.find(node => node.nodeId === 'merge');
    expect(entry).toMatchObject({
      reason: 'executed locally',
      output: expect.stringContaining('Operator paths must be absolute'),
    });
  });
  test('rejects checkout paths and paths in other worktrees', async () => {
    const root = temp();
    const cwd = join(root, 'candidate');
    mkdirSync(cwd);
    const inside = join(cwd, 'policy.json');
    writeFileSync(inside, '{}');
    await expect(externalPath(inside, cwd)).rejects.toThrow('candidate');
    const other = join(root, 'other');
    mkdirSync(other);
    writeFileSync(join(other, '.git'), 'gitdir: elsewhere');
    const otherPolicy = join(other, 'policy.json');
    writeFileSync(otherPolicy, '{}');
    await expect(externalPath(otherPolicy, cwd)).rejects.toThrow('Git worktrees');
    await expect(externalPath('relative.json', cwd)).rejects.toThrow('absolute');
  });
  test.each(['external', 'checkout'])(
    'rereads policy and observes a new %s stop entry',
    async location => {
      const root = temp();
      const cwd = join(root, 'candidate');
      mkdirSync(cwd);
      const policyPath = join(root, 'policy.json');
      const stopFile = join(location === 'checkout' ? cwd : root, 'stop');
      writeFileSync(policyPath, JSON.stringify({ ...policy, stop_file: stopFile }));
      const io = localIO({ INPUTS_POLICY: policyPath }, cwd);
      const first = await io.readPolicy();
      expect(await io.stopped(first)).toBe(false);
      writeFileSync(stopFile, '');
      expect(await io.stopped(first)).toBe(true);
      writeFileSync(policyPath, JSON.stringify({ ...policy, authorized: false }));
      expect((await io.readPolicy()).authorized).toBe(false);
    }
  );
  test('a missing stop parent refuses instead of treating the stop as clear', async () => {
    const root = temp();
    const io = localIO({}, root);
    await expect(
      io.stopped({ ...policy, stop_file: join(root, 'missing', 'STOP') })
    ).rejects.toThrow();
  });
  test('real Bun entrypoint refuses missing policy and writes its result without calling gh', async () => {
    const root = temp();
    const cwd = join(root, 'candidate');
    mkdirSync(cwd);
    const script = resolve(import.meta.dir, '../.archon/workflows/sdlc/merge/scripts/merge.ts');
    const child = Bun.spawn([process.execPath, '--no-env-file', script], {
      cwd,
      env: {
        ...process.env,
        INPUTS_TARGET: '42',
        INPUTS_POLICY: '',
        INPUTS_RECEIPT: '',
        ARTIFACTS_DIR: root,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe('');
    const outcome: unknown = JSON.parse(stdout);
    expect(outcome).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('absolute'),
    });
    expect(JSON.parse(readFileSync(join(root, 'merge.json'), 'utf8'))).toEqual(outcome);
  });
  test('subprocess adapter drains stderr without treating vendor prose as structured state', async () => {
    const response = await runCommand([
      process.execPath,
      '--no-env-file',
      '-e',
      'console.log(JSON.stringify({ok:true})); console.error("vendor prose"); process.exit(7)',
    ]);
    expect(response.exitCode).toBe(7);
    expect(JSON.parse(response.stdout)).toEqual({ ok: true });
  });
});
