// @archon-test-isolated
import {
  telemetryInvocations,
  detectDefaultBranch,
  makeDeps,
  makePlatform,
  makeFakeResolver,
} from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm, cp } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { hydrateResumableRun } from './run-resume';
import { discoverWorkflows } from './workflow-discovery';
import type { WorkflowDeps } from './deps';
import { readRunDispatchMetadata } from './schemas/workflow-run';
import type { ResolvedWorkflow } from './schemas/workflow';
import type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from './child-isolation';

/** A `workflow:` child runs in its own worktree when its node asks for isolation. */
describe('workflow: sub-run isolation (#2121 slice 2)', () => {
  let cwd: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    await writeFile(join(cwd, '.archon', 'workflows', `${name}.yaml`), yaml);
  }

  async function discover(name: string): Promise<ResolvedWorkflow> {
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const wf = result.workflows.find(w => w.workflow.name === name);
    if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
    return wf.workflow;
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `subrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  // --- slice 2, PR-A: per-child worktree isolation ------------------------------

  it("isolation: 'worktree' runs the child in the resolver's cwd (distinct from the parent)", async () => {
    await writeWorkflow(
      'child-iso',
      `
name: child-iso
description: child that runs in its own worktree
nodes:
  - id: work
    prompt: "do the work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-iso',
      `
name: parent-iso
description: parent that isolates its child
nodes:
  - id: sub
    workflow: child-iso
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const loadConfig = deps.loadConfig;
    deps.loadConfig = async path => ({
      ...(await loadConfig(path)),
      envVars: { SETUP_VALUE: 'managed-child-value' },
    });
    const parent = await discover('parent-iso');
    const childCwd = join(cwd, 'child-worktree-0');
    const { resolver, calls } = makeFakeResolver(childCwd);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    // The resolver was invoked once, for the `sub` node, carrying the parent run.
    expect(calls).toHaveLength(1);
    if (!calls[0]) throw new Error('Expected resolver call');
    expect(calls[0].nodeId).toBe('sub');
    expect(calls[0].setupEnvironment.envVars).toMatchObject({ SETUP_VALUE: 'managed-child-value' });
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-iso');
    if (!parentRun) throw new Error('Expected parent run');
    expect(calls[0].parentRun.id).toBe(parentRun.id);
    // The child ran in the resolver's worktree cwd — NOT the parent's checkout.
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-iso');
    expect(child?.status).toBe('completed');
    expect(child?.working_path).toBe(childCwd);
    expect(child?.working_path).not.toBe(cwd);
  });

  it("isolation: 'worktree' with NO resolver injected fails the node fast (no shared-checkout fallback)", async () => {
    await writeWorkflow(
      'child-iso',
      `
name: child-iso
description: child that wants its own worktree
nodes:
  - id: work
    prompt: "do work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-iso-noresolver',
      `
name: parent-iso-noresolver
description: parent requesting worktree isolation with no resolver wired
nodes:
  - id: sub
    workflow: child-iso
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-iso-noresolver');

    // No resolveChildIsolation in opts — the node must fail fast, never silently
    // fall back to the parent's shared checkout.
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'parent-iso-noresolver'
    );
    expect(parentRun?.status).toBe('failed');
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'sub'
    );
    expect(String(nodeFailed?.data?.error)).toContain('requires an injected');
    // Fail-fast happens BEFORE the child row is created — no orphan child.
    expect([...store.runs.values()].filter(r => r.parent_run_id !== null)).toHaveLength(0);
  });

  for (const isolation of ['inherit', undefined]) {
    for (const base of ['fallback', 'override', 'empty']) {
      it(`shared child inherits ${base} base with isolation ${String(isolation)}`, async () => {
        await writeWorkflow(
          'child-share',
          `
name: child-share
description: reports shared checkout base
nodes:
  - id: work
    bash: |
      ${base === 'empty' ? 'printf done' : `printf '%s' "$BASE_BRANCH"`}
`
        );
        await writeWorkflow(
          'parent-inherit',
          `
name: parent-inherit
description: shares checkout
nodes:
  - id: sub
    workflow: child-share
${isolation ? '    isolation: inherit' : ''}
`
        );
        const store = new InMemoryStore();
        const deps = makeDeps(store);
        const loadConfig = deps.loadConfig;
        let loads = 0;
        deps.loadConfig = async path => ({
          ...(await loadConfig(path)),
          ...(loads++ > 0 ? { baseBranch: 'child-config' } : {}),
        });
        if (base === 'empty') {
          deps.store.getCodebase = async () => ({
            id: 'folder',
            name: 'folder',
            repository_url: null,
            default_cwd: cwd,
            kind: 'folder',
          });
        }
        const { resolver, calls } = makeFakeResolver(join(cwd, 'unused'));
        detectDefaultBranch.mockClear();
        const expected =
          base === 'empty' ? '' : base === 'override' ? 'parent-override' : 'parent-default';
        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-plat',
          cwd,
          await discover('parent-inherit'),
          'goal',
          { conversationId: 'conv-db' },
          {
            resolveChildIsolation: resolver,
            ...(base === 'empty' ? { codebaseId: 'folder' } : { baseBranch: 'parent-default' }),
            ...(base === 'override' ? { baseOverride: expected } : {}),
            ownedWorktree: {
              envId: 'env-parent',
              creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
            },
          }
        );
        expect(result.success).toBe(true);
        expect(calls).toHaveLength(0);
        expect(detectDefaultBranch).not.toHaveBeenCalled();
        const child = [...store.runs.values()].find(r => r.workflow_name === 'child-share');
        expect(child?.working_path).toBe(cwd);
        expect(child?.metadata.owned_worktree).toBeUndefined();
        expect(readRunDispatchMetadata(child?.metadata)?.base_branch).toBe(expected);
        expect(child?.metadata.summary).toBe(base === 'empty' ? 'done' : expected);
      });
    }
  }

  for (const configured of [undefined, 'child-config']) {
    for (const referencesBase of [false, true]) {
      it(`adopted checkout leaves its unknown base unresolved despite config: ${String(configured)}, references base: ${referencesBase}`, async () => {
        await writeWorkflow(
          'child-adopt',
          `
name: child-adopt
description: reports base on adoption
nodes:
  - id: work
    bash: '${referencesBase ? 'printf "%s" "$BASE_BRANCH"' : 'printf done'}'
`
        );
        await writeWorkflow(
          'parent-adopt',
          `
name: parent-adopt
description: adopts checkout
nodes:
  - id: sub
    workflow: child-adopt
    isolation: worktree
`
        );
        const store = new InMemoryStore();
        const deps = makeDeps(store);
        const loadConfig = deps.loadConfig;
        deps.loadConfig = async path => ({ ...(await loadConfig(path)), baseBranch: configured });
        const fake = makeFakeResolver(join(cwd, 'adopted-child'));
        const resolver: ChildIsolationResolver = {
          resolve: async req => ({
            ...(await fake.resolver.resolve(req)),
            baseBranch: undefined,
          }),
        };
        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-plat',
          cwd,
          await discover('parent-adopt'),
          'goal',
          { conversationId: 'conv-db' },
          { baseOverride: 'parent-only', resolveChildIsolation: resolver }
        );
        expect(result.success).toBe(!referencesBase);
        const child = [...store.runs.values()].find(r => r.workflow_name === 'child-adopt');
        expect(readRunDispatchMetadata(child?.metadata)?.base_branch).toBe('');
        if (referencesBase) {
          const failed = store.events.find(
            e =>
              e.workflow_run_id === child?.id &&
              e.event_type === 'node_failed' &&
              e.step_name === 'work'
          );
          expect(failed?.data?.error).toContain('No base branch could be resolved for this run');
          expect(failed?.data?.error).toContain('start a new parent run');
        }
        if (!referencesBase) expect(child?.metadata.summary).toBe('done');
      });
    }
  }

  for (const completedWork of [false, true]) {
    it(`failed isolated child retains its recorded base with completed work: ${completedWork}`, async () => {
      await writeWorkflow(
        'child-retry',
        `
name: child-retry
description: fails once
nodes:
${completedWork ? '  - id: before\n    bash: "printf before"' : ''}
  - id: work
${completedWork ? '    depends_on: [before]' : ''}
    bash: |
      test -f marker || { touch marker; exit 3; }
      printf '%s' "$BASE_BRANCH"
`
      );
      await writeWorkflow(
        'parent-retry',
        `
name: parent-retry
description: retries child
nodes:
  - id: sub
    workflow: child-retry
    isolation: worktree
`
      );
      const store = new InMemoryStore();
      const deps = makeDeps(store);
      const parent = await discover('parent-retry');
      const { resolver, calls } = makeFakeResolver(join(cwd, 'child-retry'));
      const first = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-plat',
        cwd,
        parent,
        'goal',
        { conversationId: 'conv-db' },
        { resolveChildIsolation: resolver }
      );
      expect(first.success).toBe(false);
      const child = [...store.runs.values()].find(r => r.workflow_name === 'child-retry')!;
      expect(readRunDispatchMetadata(child.metadata)?.base_branch).toBe('child-release');
      const loadConfig = deps.loadConfig;
      deps.loadConfig = async path => ({
        ...(await loadConfig(path)),
        baseBranch: 'changed-config',
      });
      const parentRun = (await store.getWorkflowRun(first.workflowRunId!))!;
      const hydrated = await hydrateResumableRun(deps, parentRun);
      const resumed = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-plat',
        cwd,
        parent,
        'goal',
        { conversationId: 'conv-db' },
        {
          ...(hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }),
          baseOverride: 'changed-parent',
          resolveChildIsolation: resolver,
        }
      );
      expect(resumed.success).toBe(true);
      expect(calls).toHaveLength(1);
      const completed = await store.getWorkflowRun(child.id);
      expect(readRunDispatchMetadata(completed?.metadata)?.base_branch).toBe('child-release');
      expect(completed?.metadata.summary).toBe('child-release');
    });
  }

  it('threads the resolver into a nested child so a grandchild also isolates (I1)', async () => {
    // parent → child-mid → grandchild-iso, all `isolation: worktree`. Without the
    // resolver being threaded into the child's own executeWorkflow opts, the
    // grandchild spawn would fail-fast "requires an injected resolver".
    await writeWorkflow(
      'grandchild-iso',
      `
name: grandchild-iso
description: bottom of a nested isolation chain
nodes:
  - id: work
    prompt: "grandchild does $ARGUMENTS"
`
    );
    await writeWorkflow(
      'child-mid',
      `
name: child-mid
description: middle link that isolates its own child
nodes:
  - id: sub
    workflow: grandchild-iso
    input: "y"
    isolation: worktree
`
    );
    await writeWorkflow(
      'parent-nested',
      `
name: parent-nested
description: top of a nested isolation chain
nodes:
  - id: sub
    workflow: child-mid
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-nested');

    // Resolver returns a distinct worktree per parent run and copies the repo's
    // `.archon` (workflows) into it — a real worktree is a checkout of the same repo,
    // so the nested grandchild target stays discoverable from the child's worktree.
    const calls: ChildIsolationRequest[] = [];
    const resolver: ChildIsolationResolver = {
      async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
        calls.push(req);
        const dir = join(cwd, 'wt', `${req.parentRun.id}-child-${String(req.childIndex ?? 0)}`);
        await mkdir(dir, { recursive: true });
        await cp(join(cwd, '.archon'), join(dir, '.archon'), { recursive: true });
        return {
          cwd: dir,
          envId: `env-${String(calls.length)}`,
          ownedWorktree: {
            envId: `env-${String(calls.length)}`,
            creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
          },
          baseBranch: 'child-release',
          branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-0`,
        };
      },
    };

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    // Both levels invoked the resolver (proving it propagated to the grandchild).
    expect(calls).toHaveLength(2);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-mid');
    const grandchild = [...store.runs.values()].find(r => r.workflow_name === 'grandchild-iso');
    expect(child?.status).toBe('completed');
    expect(grandchild?.status).toBe('completed');
    expect(child?.metadata.owned_worktree).toEqual({
      envId: 'env-1',
      creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
    });
    expect(grandchild?.metadata.owned_worktree).toEqual({
      envId: 'env-2',
      creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
    });
    // Three distinct checkouts: parent (shared), child worktree, grandchild worktree.
    expect(child?.working_path).not.toBe(cwd);
    expect(grandchild?.working_path).not.toBe(cwd);
    expect(grandchild?.working_path).not.toBe(child?.working_path);
    // The child records its own worktree env + branch in metadata (S3).
    expect((child?.metadata as Record<string, unknown>).isolation_env_id).toBeDefined();
    expect(String((child?.metadata as Record<string, unknown>).branch_name)).toContain(
      'archon/task-'
    );
  });

  it('a resolver that throws fails the node cleanly with no orphan child (I5)', async () => {
    await writeWorkflow(
      'child-iso',
      `
name: child-iso
description: child wanting its own worktree
nodes:
  - id: work
    prompt: "do work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-iso-throw',
      `
name: parent-iso-throw
description: parent whose resolver blows up
nodes:
  - id: sub
    workflow: child-iso
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-iso-throw');
    const resolver: ChildIsolationResolver = {
      resolve: () => Promise.reject(new Error('no space left on device')),
    };

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-iso-throw');
    expect(parentRun?.status).toBe('failed');
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'sub'
    );
    // Sub-run context prefix + the propagated resolver error (classification is the
    // real resolver's job; the fake surfaces the raw message unchanged).
    expect(String(nodeFailed?.data?.error)).toContain('Failed to create isolated worktree');
    expect(String(nodeFailed?.data?.error)).toContain('no space left on device');
    // No orphan child row — the fail happens before createWorkflowRun.
    expect([...store.runs.values()].filter(r => r.parent_run_id !== null)).toHaveLength(0);
  });

  it('resume with a pruned child worktree fails cleanly, not a deep ENOENT (I2)', async () => {
    // Child fails on its first pass so the parent has a resumable failed child; then
    // its worktree is deleted (as `isolation cleanup` would) before the parent resume.
    await writeWorkflow(
      'child-iso-fail',
      `
name: child-iso-fail
description: isolated child that fails first
nodes:
  - id: boom
    bash: "exit 3"
`
    );
    await writeWorkflow(
      'parent-iso-resume',
      `
name: parent-iso-resume
description: parent whose isolated child worktree gets pruned
nodes:
  - id: sub
    workflow: child-iso-fail
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-iso-resume');
    const childCwd = join(cwd, 'wt', 'pruned-child');
    const { resolver } = makeFakeResolver(childCwd);

    // First drive: resolver creates the worktree, child `exit 3` fails, parent fails.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );
    expect(r1.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-iso-resume');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-iso-fail');
    expect(child?.status).toBe('failed');
    expect(child?.working_path).toBe(childCwd);

    // Prune the child's worktree, then resume the parent.
    await rm(childCwd, { recursive: true, force: true });
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun!.id))!);
    const resumeOpts = hydrated ?? {
      preCreatedRun: await store.resumeWorkflowRun(parentRun!.id),
    };
    const r2 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { ...resumeOpts, resolveChildIsolation: resolver }
    );

    expect(r2.success).toBe(false);
    // Clean, actionable message — not a raw ENOENT from executing in a vanished dir.
    const nodeFailed = [...store.events]
      .reverse()
      .find(e => e.event_type === 'node_failed' && e.step_name === 'sub');
    expect(String(nodeFailed?.data?.error)).toContain('working path no longer exists');
    expect(String(nodeFailed?.data?.error)).toContain('cleaned up');
    expect(String(nodeFailed?.data?.error)).not.toContain('ENOENT');
  });

  it('resume of a child row with a NULL working path fails instead of falling back to the parent checkout', async () => {
    // `working_path` is nullable in the schema. Falling back to the parent's cwd here
    // would be the one silent shared-checkout fallback left in runChildWorkflow — and
    // for a child the author isolated on purpose, that is exactly the concurrent-write
    // collision the isolation was requested to prevent. Not reachable through normal
    // creation (every child row gets a real path), so this pins the guard directly.
    await writeWorkflow(
      'child-null-path',
      `
name: child-null-path
description: isolated child whose row loses its working path
nodes:
  - id: boom
    bash: "exit 3"
`
    );
    await writeWorkflow(
      'parent-null-path',
      `
name: parent-null-path
description: parent resuming a child with no recorded checkout
nodes:
  - id: sub
    workflow: child-null-path
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-null-path');
    const { resolver } = makeFakeResolver(join(cwd, 'wt', 'null-path-child'));

    // First drive: the child fails, leaving the parent a resumable failed child.
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      {
        resolveChildIsolation: resolver,
      }
    );
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-null-path');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-null-path');
    expect(child?.status).toBe('failed');

    // Erase the recorded checkout, then resume the parent.
    store.runs.get(child!.id)!.working_path = null;
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun!.id))!);
    const resumeOpts = hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun!.id) };
    const r2 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { ...resumeOpts, resolveChildIsolation: resolver }
    );

    expect(r2.success).toBe(false);
    const nodeFailed = [...store.events]
      .reverse()
      .find(e => e.event_type === 'node_failed' && e.step_name === 'sub');
    expect(String(nodeFailed?.data?.error)).toContain('no recorded working path');
    // The child must NOT have been re-run in the parent's checkout.
    expect((await store.getWorkflowRun(child!.id))?.working_path).not.toBe(cwd);
  });

  it('a parent auto-resumed after a gated isolated child can still isolate its NEXT child', async () => {
    // The flagship shape: isolated `implement` → the child's approval gate → approve →
    // the parent auto-resumes → isolated `review`. The second spawn is the regression:
    // maybeResumeParentRun re-enters executeWorkflow, and until the resolver was
    // threaded into it that re-entry ran resolver-less, so `review` failed with
    // "requires an injected child-isolation resolver" — on a git repo, via the CLI,
    // with the resolver correctly wired at the top. The observable is the parent
    // completing with BOTH children isolated, not merely "nothing threw".
    await writeWorkflow(
      'child-gated-iso',
      `
name: child-gated-iso
description: isolated child that pauses at a gate
nodes:
  - id: implement
    prompt: "implement $ARGUMENTS"
  - id: gate
    approval:
      message: "review the sub-run"
    depends_on: [implement]
  - id: wrap-up
    prompt: "summarize"
    depends_on: [gate]
`
    );
    await writeWorkflow(
      'child-review-iso',
      `
name: child-review-iso
description: isolated child that reviews what the first one built
nodes:
  - id: review
    prompt: "review $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-gated-iso',
      `
name: parent-gated-iso
description: isolated implement, gate, isolated review
nodes:
  - id: implement
    workflow: child-gated-iso
    input: "build it"
    isolation: worktree
  - id: review
    workflow: child-review-iso
    input: "$implement.output"
    isolation: worktree
    depends_on: [implement]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-gated-iso');

    // One worktree per (parent run, node) — the shape buildChildIdentifier produces.
    const calls: ChildIsolationRequest[] = [];
    const resolver: ChildIsolationResolver = {
      async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
        calls.push(req);
        const dir = join(cwd, 'wt', `${req.parentRun.id}-${req.nodeId}`);
        await mkdir(dir, { recursive: true });
        return {
          cwd: dir,
          envId: `env-${req.nodeId}`,
          baseBranch: 'child-release',
          branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-${req.nodeId}-child-0`,
        };
      },
    };

    // First drive: `implement` spawns an isolated child, which pauses at its gate;
    // the parent pauses blocked on it. `review` has not been reached.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );
    expect(r1.success && 'paused' in r1 && r1.paused).toBe(true);
    expect(calls.map(c => c.nodeId)).toEqual(['implement']);

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-gated-iso');
    const gatedChild = [...store.runs.values()].find(r => r.workflow_name === 'child-gated-iso');
    expect(parentRun?.status).toBe('paused');
    expect(gatedChild?.status).toBe('paused');
    expect(gatedChild?.working_path).not.toBe(cwd);

    // Approve the child and resume it in its OWN worktree, the way the CLI does —
    // with a resolver injected, since the surface builds one per dispatch. The
    // child's completion fires the parent auto-resume hook in-process.
    store.approveGate(gatedChild!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(gatedChild!.id))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      gatedChild!.working_path!,
      await discover('child-gated-iso'),
      gatedChild!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated!, resolveChildIsolation: resolver }
    );

    // The parent resumed and reached `review`, which got its OWN worktree.
    expect(calls.map(c => c.nodeId)).toEqual(['implement', 'review']);
    const reviewFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'review'
    );
    expect(reviewFailed).toBeUndefined();

    const finalParent = await store.getWorkflowRun(parentRun!.id);
    expect(finalParent?.status).toBe('completed');
    expect((await store.getWorkflowRun(gatedChild!.id))?.status).toBe('completed');

    // Distinct things, distinct checkouts: two isolated nodes → two worktrees, and
    // neither is the parent's.
    const reviewChild = [...store.runs.values()].find(r => r.workflow_name === 'child-review-iso');
    expect(reviewChild?.status).toBe('completed');
    expect(reviewChild?.working_path).not.toBe(cwd);
    expect(reviewChild?.working_path).not.toBe(gatedChild?.working_path);
  });

  it('a parent auto-resumed after a child gate keeps its base branch, user and source (#2454)', async () => {
    // The run's identity must not change at a gate. The parent's post-gate nodes have to
    // resolve the same `$BASE_BRANCH`, the same execution user, and report the same
    // workflow source as its pre-gate nodes — and the failure here is success-shaped, so
    // asserting completion proves nothing. `getDefaultBranch` is mocked to 'main' in this
    // file, which is exactly the git auto-detection an unrestored re-entry falls back to.
    await writeWorkflow(
      'identity-child',
      `
name: identity-child
description: child that pauses at its own gate
nodes:
  - id: work
    bash: |
      printf '%s' "$BASE_BRANCH"
  - id: gate
    approval:
      message: "approve the sub-run"
    depends_on: [work]
`
    );
    await writeWorkflow(
      'identity-parent',
      `
name: identity-parent
description: reads $BASE_BRANCH on both sides of a child gate
nodes:
  - id: before
    bash: |
      printf '%s' "$BASE_BRANCH"
  - id: sub
    workflow: identity-child
    input: "build it"
    depends_on: [before]
  - id: after
    bash: |
      printf '%s' "$BASE_BRANCH"
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const prefsUserIds: string[] = [];
    const credentialUserIds: string[] = [];
    const deps: WorkflowDeps = {
      ...makeDeps(store),
      isPerUserGitHubEnabled: () => true,
      getUserGithubToken: async userId => {
        credentialUserIds.push(userId);
        return undefined;
      },
      getUserAiPrefs: (userId: string) => {
        prefsUserIds.push(userId);
        return Promise.resolve({});
      },
    };
    const parent = await discover('identity-parent');
    telemetryInvocations.length = 0;

    // Dispatch as the CLI does: the codebase's default branch as the `$BASE_BRANCH`
    // fallback, the starting user, and the workflow's discovery source.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db', userId: 'user-alpha' },
      {
        baseBranch: 'release-2026',

        source: 'bundled',
      }
    );
    expect(r1.success && 'paused' in r1 && r1.paused).toBe(true);

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'identity-parent');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'identity-child');
    expect(parentRun?.status).toBe('paused');
    expect(child?.status).toBe('paused');
    expect(readRunDispatchMetadata(child?.metadata)?.base_branch).toBe('release-2026');
    expect(
      store.events.find(
        e =>
          e.workflow_run_id === child?.id &&
          e.step_name === 'work' &&
          e.event_type === 'node_completed'
      )?.data?.node_output
    ).toBe('release-2026');

    const preGateBase = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'before'
    )?.data?.node_output;
    expect(preGateBase).toBe('release-2026');
    const preGatePrefsCalls = prefsUserIds.length;
    const preGateCredentialCalls = credentialUserIds.length;
    const preGateTelemetry = telemetryInvocations.filter(t => t.workflowName === 'identity-parent');
    expect(preGateTelemetry).toEqual([
      { workflowName: 'identity-parent', workflowSource: 'bundled' },
    ]);

    // Approve the child and resume it the way the approving surface does. The child's
    // completion fires the in-process parent auto-resume, which re-enters executeWorkflow
    // with nothing but what the run itself recorded.
    store.approveGate(child!.id);
    store.runs.get(child!.id)!.user_id = 'user-child';
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(child!.id))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      child!.working_path!,
      await discover('identity-child'),
      child!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('completed');
    expect(
      readRunDispatchMetadata((await store.getWorkflowRun(child!.id))?.metadata)?.base_branch
    ).toBe('release-2026');
    const postGateBase = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'after'
    )?.data?.node_output;
    expect(postGateBase).toBe(preGateBase);

    expect(prefsUserIds.slice(0, preGatePrefsCalls)).toEqual(
      Array(preGatePrefsCalls).fill('user-alpha')
    );
    expect(prefsUserIds.slice(preGatePrefsCalls)).toEqual([]);
    expect(credentialUserIds.slice(preGateCredentialCalls)).toEqual(['user-child', 'user-alpha']);

    // The resumed half of the run reports the same workflow source, so a bundled
    // workflow is not recategorized as custom halfway through. Terminal telemetry reads
    // the source the run recorded at dispatch, so that record must still say bundled.
    expect(telemetryInvocations.filter(t => t.workflowName === 'identity-parent')).toEqual([
      { workflowName: 'identity-parent', workflowSource: 'bundled' },
      { workflowName: 'identity-parent', workflowSource: 'bundled' },
    ]);
    const completedParent = await store.getWorkflowRun(parentRun!.id);
    expect(readRunDispatchMetadata(completedParent?.metadata)?.source).toBe('bundled');
  });
});
