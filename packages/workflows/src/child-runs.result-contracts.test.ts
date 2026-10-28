// @archon-test-isolated
import { makeDeps, makePlatform, realArchonPaths } from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { hydrateResumableRun } from './run-resume';
import { discoverWorkflows } from './workflow-discovery';
import type { ResolvedWorkflow } from './schemas/workflow';

/** The child's result contract and artifact pointers reach the parent (#2453). */
// ---------------------------------------------------------------------------
// #2453 — the child's selected node owns the result contract. Its derived field
// projection travels to the parent as `summary_declared_fields`, which is what
// authorizes `$<node>.output.field` in the parent. A `workflow:` node cannot
// declare a schema of its own (that is a load error, see loader.test.ts).
// ---------------------------------------------------------------------------

describe('workflow: callee-owned result contracts (#2453)', () => {
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

  /** A child whose `returns:` node certifies its own two-field result (Phase 2 exec contract). */
  async function writeContractChild(): Promise<void> {
    await writeWorkflow(
      'child-contract',
      `
name: child-contract
description: a deterministic producer that certifies its own result
returns: emit
nodes:
  - id: emit
    bash: |
      printf '%s' '{"green":true,"note":"ok"}'
    output_format:
      type: object
      properties:
        green: { type: boolean }
        note: { type: string }
      required: [green, note]
`
    );
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `subcontract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it('keeps a child nested contract through two cold resumes and both result selections', async () => {
    const paths = [['proposal'], ['proposal', 'action']];
    for (const returns of ['returns: emit', '']) {
      await writeWorkflow(
        'nested-child',
        `
name: nested-child
description: nested producer
${returns}
nodes:
  - id: emit
    bash: printf '%s' '{"proposal":{"action":"add"}}'
    output_format:
      type: object
      properties:
        proposal:
          type: object
          properties:
            action: {type: string}
          required: [action]
      required: [proposal]
`
      );
      await writeWorkflow(
        'nested-parent',
        `
name: nested-parent
description: reads after two restarts
nodes:
  - id: sub
    workflow: nested-child
  - id: read
    depends_on: [sub]
    bash: |
      if [ ! -f "$STATE_DIR/once-${returns ? 'return' : 'sink'}" ]; then touch "$STATE_DIR/once-${returns ? 'return' : 'sink'}"; exit 1; fi
      if [ ! -f "$STATE_DIR/twice-${returns ? 'return' : 'sink'}" ]; then touch "$STATE_DIR/twice-${returns ? 'return' : 'sink'}"; exit 1; fi
      printf '%s' $sub.output.proposal.action
`
      );
      const store = new InMemoryStore();
      const deps = makeDeps(store);
      const run = (options?: Parameters<typeof executeWorkflow>[7]) =>
        executeWorkflow(
          deps,
          makePlatform(),
          'conv-plat',
          cwd,
          discoverResolved,
          'goal',
          { conversationId: 'conv-db' },
          options
        );
      const discoverResolved = await discover('nested-parent');
      expect((await run()).success).toBe(false);
      const parent = [...store.runs.values()].find(r => r.workflow_name === 'nested-parent');
      const child = [...store.runs.values()].find(r => r.workflow_name === 'nested-child');
      expect(child?.metadata?.summary_declared_output_paths).toEqual(paths);
      for (const success of [false, true]) {
        const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parent!.id))!);
        expect(hydrated?.priorCompletedNodes.get('sub')?.declaredOutputPaths).toEqual(paths);
        expect((await run({ ...hydrated! })).success).toBe(success);
      }
      expect(
        store.events
          .filter(e => e.step_name === 'sub' && e.event_type === 'node_skipped_prior_success')
          .map(e => e.data?.declared_output_paths)
      ).toEqual([paths, paths]);
      expect(
        store.events.find(
          e =>
            e.workflow_run_id === parent?.id &&
            e.step_name === 'read' &&
            e.event_type === 'node_completed'
        )?.data?.node_output
      ).toBe('add');
    }
  });

  it('a parent with NO caller output_format reads the child-declared field', async () => {
    await writeContractChild();
    await writeWorkflow(
      'parent-no-schema',
      `
name: parent-no-schema
description: reads a field the child declared, declaring nothing itself
nodes:
  - id: sub
    workflow: child-contract
  - id: read
    bash: |
      printf 'green=%s note=%s' $sub.output.green $sub.output.note
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-no-schema'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    // The child stamped its own projection beside the value it already stamped.
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-contract');
    expect(child?.metadata?.summary_value).toEqual({ green: true, note: 'ok' });
    expect(child?.metadata?.summary_declared_fields).toEqual(['green', 'note']);
    // The parent node completed under the CHILD's contract and persisted it.
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-no-schema');
    const subCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'sub'
    );
    expect(subCompleted?.data?.declared_fields).toEqual(['green', 'note']);
    const read = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'read'
    );
    expect(String(read?.data?.node_output)).toBe('green=true note=ok');
  });

  it('a typo in a child-declared field still fails loudly with no caller output_format', async () => {
    await writeContractChild();
    await writeWorkflow(
      'parent-typo',
      `
name: parent-typo
description: references a field the child never declared
nodes:
  - id: sub
    workflow: child-contract
  - id: read
    bash: |
      printf 'x=%s' $sub.output.greeen
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-typo'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(false);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-typo');
    const failed = store.events.find(
      e =>
        e.workflow_run_id === parent?.id && e.event_type === 'node_failed' && e.step_name === 'read'
    );
    expect(String(failed?.data?.error)).toContain(
      "references field 'greeen', which is not declared in node 'sub's output_format schema"
    );
  });

  it('a cold-resumed parent resolves child-declared fields exactly like a live one', async () => {
    await writeContractChild();
    await writeWorkflow(
      'parent-resume-contract',
      `
name: parent-resume-contract
description: the consumer fails once, then reads the same field after resume
nodes:
  - id: sub
    workflow: child-contract
  - id: read
    bash: |
      if [ -f "$STATE_DIR/read-marker" ]; then printf 'note=%s' $sub.output.note; else touch "$STATE_DIR/read-marker"; exit 1; fi
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const first = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-resume-contract'),
      'goal',
      { conversationId: 'conv-db' }
    );
    expect(first.success).toBe(false);

    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-resume-contract');
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parent!.id))!);
    expect(hydrated).not.toBeNull();
    // The snapshot carries the CHILD's contract; the parent's own definition never had it.
    expect(hydrated?.priorCompletedNodes.get('sub')?.declaredOutputPaths).toEqual([
      ['green'],
      ['note'],
    ]);

    const second = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-resume-contract'),
      'goal',
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );
    expect(second.success).toBe(true);
    const read = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'read'
    );
    expect(String(read?.data?.node_output)).toBe('note=ok');
    // The prior-success re-emit carries the contract forward for the NEXT resume.
    const replayed = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_skipped_prior_success' &&
        e.step_name === 'sub'
    );
    expect(replayed?.data?.declared_fields).toEqual(['green', 'note']);
  });

  it('a schemaless child carries no field contract, and the parent reads it leniently', async () => {
    await writeWorkflow(
      'child-schemaless',
      `
name: child-schemaless
description: emits JSON with no declared contract
returns: emit
nodes:
  - id: emit
    bash: |
      printf '%s' '{"green":true}'
`
    );
    await writeWorkflow(
      'parent-schemaless',
      `
name: parent-schemaless
description: reads a JSON field from a child that declared nothing
nodes:
  - id: sub
    workflow: child-schemaless
  - id: read
    bash: |
      printf 'green=%s' $sub.output.green
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-schemaless'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    // No contract anywhere: the child stamped no projection, the parent persisted none,
    // and the caller has no way to add one. Field access stays the schemaless parse.
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-schemaless');
    expect(child?.metadata?.summary_declared_fields).toBeUndefined();
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-schemaless');
    const subCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'sub'
    );
    expect(subCompleted?.data?.declared_fields).toBeUndefined();
    const read = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'read'
    );
    expect(String(read?.data?.node_output)).toBe('green=true');
  });
});

// ---------------------------------------------------------------------------
// #2453 — a child's small result may point at the large file it wrote. The pointer
// names the CHILD's run and a path relative to that run's artifacts directory; the
// child's producer proves it against its own run, and the parent relays the value
// without re-validating it.
// ---------------------------------------------------------------------------

describe('workflow: artifact pointers across the child boundary (#2453)', () => {
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

  /**
   * A child that writes a file under its own `$ARTIFACTS_DIR` and returns a pointer to
   * it. `$WORKFLOW_ID` is engine-substituted into shell bodies, so the script names its
   * own run without the engine inferring it — the pointer is an ordinary authored value.
   */
  async function writePointerChild(pointerPath: string, write = true): Promise<void> {
    await writeWorkflow(
      'child-pointer',
      `
name: child-pointer
description: writes a plan file and returns a pointer to it
mutates_checkout: false
returns: emit
nodes:
  - id: emit
    bash: |
      ${write ? 'printf \'# the full plan\' > "$ARTIFACTS_DIR/plan.md"' : 'true'}
      printf '{"ready":true,"plan":{"type":"archon_artifact","run_id":"%s","path":"${pointerPath}"}}' '$WORKFLOW_ID'
    output_format:
      type: object
      properties:
        ready: { type: boolean }
        plan:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [ready, plan]
`
    );
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `subpointer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it('a parent accepts a pointer at the child run that produced it', async () => {
    await writePointerChild('plan.md');
    await writeWorkflow(
      'parent-pointer',
      `
name: parent-pointer
description: threads a child result carrying an artifact pointer
nodes:
  - id: sub
    workflow: child-pointer
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-pointer'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-pointer');
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-pointer');
    const subCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'sub'
    );
    // The value crossing the boundary is still a run id plus a relative path — the
    // engine neither expanded it nor read the file.
    expect(subCompleted?.data?.structured_output).toEqual({
      ready: true,
      plan: { type: 'archon_artifact', run_id: child?.id, path: 'plan.md' },
    });
    expect(subCompleted?.data?.declared_fields).toEqual(['ready', 'plan']);
  });

  it('a pointer at a file the child never wrote fails the parent node', async () => {
    await writePointerChild('missing.md', false);
    await writeWorkflow(
      'parent-pointer-missing',
      `
name: parent-pointer-missing
description: the child names a file it did not write
nodes:
  - id: sub
    workflow: child-pointer
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-pointer-missing'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(false);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-pointer-missing');
    // The child's own producer already rejects it, before the child can complete —
    // the earliest boundary the value crosses.
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-pointer');
    const childFailed = store.events.find(
      e =>
        e.workflow_run_id === child?.id && e.event_type === 'node_failed' && e.step_name === 'emit'
    );
    expect(String(childFailed?.data?.error)).toContain('refers to a file that does not exist');
    expect(
      store.events.find(
        e =>
          e.workflow_run_id === parent?.id &&
          e.event_type === 'node_completed' &&
          e.step_name === 'sub'
      )
    ).toBeUndefined();
  });

  it('a fan-out aggregate relays one per-child pointer per item, each naming its own child run', async () => {
    // Each child is a SEPARATE run: it writes a per-item file under its own artifacts
    // directory and points at it with its own run id. The parent's aggregate must carry
    // that pointer unrewritten — the relay rule: the child proved it, the parent does
    // not re-validate.
    await writeWorkflow(
      'child-unit',
      `
name: child-unit
description: certifies a per-item result pointing at the file this child wrote
mutates_checkout: false
returns: check
nodes:
  - id: check
    runtime: bun
    script: |
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const item = process.env.ARGUMENTS;
      mkdirSync(join(process.env.ARTIFACTS_DIR, 'units'), { recursive: true });
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'units', item + '.md'), '# ' + item);
      console.log(JSON.stringify({
        id: item,
        ok: true,
        report: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'units/' + item + '.md' },
      }));
    output_format:
      type: object
      properties:
        id: { type: string }
        ok: { type: boolean }
        report:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [id, ok, report]
`
    );
    await writeWorkflow(
      'parent-pointer-fan',
      `
name: parent-pointer-fan
description: fans out over two items, each child pointing at its own per-item file
nodes:
  - id: items
    bash: |
      printf '%s' '["one","two"]'
  - id: work
    workflow: child-unit
    depends_on: [items]
    fan_out:
      items: "$items.output"
      max_parallel: 2
      join: all_success
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-pointer-fan'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-pointer-fan');
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'child-unit');
    expect(children).toHaveLength(2);
    const workCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'work'
    );
    const aggregate = workCompleted?.data?.structured_output as {
      id: string;
      ok: boolean;
      report: { type: string; run_id: string; path: string };
    }[];
    // Ordered by item, one pointer per element, unrewritten: each names the child run
    // that produced it (never the parent) and the relative path that child wrote.
    expect(aggregate.map(element => element.id)).toEqual(['one', 'two']);
    for (const element of aggregate) {
      const child = children.find(c => c.id === element.report.run_id);
      if (!child) throw new Error(`no child run produced element '${element.id}'`);
      expect(child.user_message).toBe(element.id);
      expect(element.report).toEqual({
        type: 'archon_artifact',
        run_id: child.id,
        path: `units/${element.id}.md`,
      });
      // The file lives under the CHILD's artifacts directory — the run the pointer
      // names — not the parent's.
      const childArtifacts = realArchonPaths.getRunArtifactsDirForRoot(
        child.output_root ?? '',
        child.id
      );
      expect(existsSync(join(childArtifacts, 'units', `${element.id}.md`))).toBe(true);
    }
    expect(new Set(aggregate.map(element => element.report.run_id))).toEqual(
      new Set(children.map(c => c.id))
    );
  });
});

// ---------------------------------------------------------------------------
// #2453 — the composed proof across a governed run boundary. The same contract the
// in-run composed test drives (a certified script result carrying a unit list and an
// artifact pointer) is produced by a CHILD run instead of an included block, and the
// parent declares no `output_format` of its own anywhere. What it reads — a declared
// field, a fan-out over that field, and an un-rewritten pointer — comes entirely from
// the child's contract.
// ---------------------------------------------------------------------------

describe('workflow: a child contract drives the parent composed path (#2453)', () => {
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

  const UNITS = [
    { id: 'unit-a', title: 'first unit of work' },
    { id: 'unit-b', title: 'second unit of work' },
  ];
  /** The instances run inside the PARENT run, so each per-item pointer names that run. */
  const aggregateFor = (runId: string) =>
    UNITS.map(unit => ({
      id: unit.id,
      ok: true,
      report: { type: 'archon_artifact', run_id: runId, path: `units/${unit.id}.md` },
    }));

  beforeEach(async () => {
    cwd = join(tmpdir(), `subcomposed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');

    // The governed child: a deterministic producer that certifies its own result,
    // writes the large artifact, and points at it.
    await writeWorkflow(
      'child-plan',
      `
name: child-plan
description: certifies a unit list plus a pointer at the plan it wrote
mutates_checkout: false
returns: build
nodes:
  - id: build
    runtime: bun
    script: |
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'plan.md'), '# the full plan');
      console.log(
        JSON.stringify({
          units: ${JSON.stringify(UNITS)},
          plan: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'plan.md' },
        })
      );
    output_format:
      type: object
      properties:
        units:
          type: array
          items:
            type: object
            properties:
              id: { type: string }
              title: { type: string }
            required: [id, title]
        plan:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [units, plan]
`
    );

    // The per-item body the parent fans out inside its own run. It owns its own
    // per-item contract, exactly as it would with any other producer upstream, and
    // points at a per-item file it wrote under the run it runs in.
    await writeWorkflow(
      'unit-block',
      `
name: unit-block
description: one instance per unit, certifying its own per-item result
mutates_checkout: false
inputs:
  unit:
    required: true
returns: check
nodes:
  - id: check
    runtime: bun
    script: |
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const unit = JSON.parse(process.env.INPUTS_UNIT);
      mkdirSync(join(process.env.ARTIFACTS_DIR, 'units'), { recursive: true });
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'units', unit.id + '.md'), '# ' + unit.title);
      console.log(JSON.stringify({
        id: unit.id,
        ok: typeof unit.title === 'string',
        report: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'units/' + unit.id + '.md' },
      }));
    output_format:
      type: object
      properties:
        id: { type: string }
        ok: { type: boolean }
        report:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [id, ok, report]
`
    );
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it('fans out over a child-declared field and threads the pointer, with no caller schema anywhere', async () => {
    await writeWorkflow(
      'composed-parent',
      `
name: composed-parent
description: declares no output_format of its own and reads the child's contract
mutates_checkout: false
nodes:
  - id: sub
    workflow: child-plan
  - id: work
    include: unit-block
    depends_on: [sub]
    fan_out:
      items: "$sub.output.units"
      as: unit
      max_parallel: 2
      join: all_success
  - id: verify
    depends_on: [work]
    bash: |
      printf 'aggregate=%s pointer=%s' $work.output $sub.output.plan
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('composed-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'composed-parent');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-plan');
    const parentEvent = (type: string, step: string) =>
      store.events.find(
        e => e.workflow_run_id === parent?.id && e.event_type === type && e.step_name === step
      );

    // The child stamped its own projection; the parent node completed under it without
    // repeating a single line of the child's schema.
    expect(child?.metadata?.summary_declared_fields).toEqual(['units', 'plan']);
    expect(parentEvent('node_completed', 'sub')?.data?.declared_fields).toEqual(['units', 'plan']);

    // `fan_out.items` read the child-declared `units` field as a real array, and the
    // aggregate relays each instance's per-item pointer unrewritten: one per item,
    // naming the PARENT run (the instances ran inside it) and a real file under it.
    const aggregate = aggregateFor(parent?.id ?? '');
    expect(parentEvent('node_completed', 'work')?.data?.structured_output).toEqual(aggregate);
    const parentArtifacts = realArchonPaths.getRunArtifactsDirForRoot(
      parent?.output_root ?? '',
      parent?.id ?? ''
    );
    for (const unit of UNITS) {
      expect(existsSync(join(parentArtifacts, 'units', `${unit.id}.md`))).toBe(true);
    }

    // The plan pointer names the CHILD's run and stayed a run id plus a relative path.
    expect(String(parentEvent('node_completed', 'verify')?.data?.node_output)).toBe(
      `aggregate=${JSON.stringify(aggregate)} pointer=${JSON.stringify({
        type: 'archon_artifact',
        run_id: child?.id,
        path: 'plan.md',
      })}`
    );
  });

  it('re-resolves the child-declared field for a fan-out that first runs after a cold resume', async () => {
    await writeWorkflow(
      'composed-parent-resume',
      `
name: composed-parent-resume
description: fails BEFORE the fan-out, so the resumed run re-resolves the child's field
mutates_checkout: false
nodes:
  - id: sub
    workflow: child-plan
  - id: gate
    depends_on: [sub]
    bash: |
      if [ -f "$STATE_DIR/gate-marker" ]; then echo open; else touch "$STATE_DIR/gate-marker"; exit 1; fi
  - id: work
    include: unit-block
    depends_on: [gate]
    fan_out:
      items: "$sub.output.units"
      as: unit
      max_parallel: 2
      join: all_success
  - id: verify
    depends_on: [work]
    bash: |
      printf 'aggregate=%s' $work.output
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const first = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('composed-parent-resume'),
      'goal',
      { conversationId: 'conv-db' }
    );
    expect(first.success).toBe(false);

    const parent = [...store.runs.values()].find(r => r.workflow_name === 'composed-parent-resume');
    expect(
      store.events.some(
        e =>
          e.workflow_run_id === parent?.id &&
          e.event_type === 'node_completed' &&
          e.step_name === 'work'
      )
    ).toBe(false);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parent!.id))!);
    // The parent's own definition never carried the contract; the snapshot does.
    expect(hydrated?.priorCompletedNodes.get('sub')?.declaredOutputPaths).toEqual([
      ['units'],
      ['plan'],
      ['plan', 'type'],
      ['plan', 'run_id'],
      ['plan', 'path'],
    ]);

    const second = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('composed-parent-resume'),
      'goal',
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    expect(second.success).toBe(true);
    const verify = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'verify'
    );
    // The fan-out ran for the FIRST time on the resumed run, so its item list came
    // from the rehydrated child contract rather than from a live child return.
    expect(String(verify?.data?.node_output)).toBe(
      `aggregate=${JSON.stringify(aggregateFor(parent?.id ?? ''))}`
    );
    // The child ran once: the resumed parent reused its persisted result and contract.
    expect([...store.runs.values()].filter(r => r.workflow_name === 'child-plan')).toHaveLength(1);
  });
});
