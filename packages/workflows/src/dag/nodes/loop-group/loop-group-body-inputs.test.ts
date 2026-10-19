// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  spyOnNodeExec,
  dagOptions,
  ready,
  readAllArtifacts,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import type { DagNode } from '../../../schemas';
import { workflowDefinitionSchema } from '../../../schemas';
import { expandWorkflowIncludes } from '../../../include-expander';
import type { IWorkflowStore } from '../../../store';

describe('loop_group body inputs: included blocks, command files and loop variables', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-loopgroup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('completes a loop_group when the until signal appears on iteration N', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'agent_message_chunk', text: 'iteration 1 work, not done yet' };
      } else {
        yield { type: 'agent_message_chunk', text: 'iteration 2 final result\nDONE' };
      }
      yield { type: 'result', sessionId: `lg-sess-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-loopgroup-done');

    const nodes: DagNode[] = [
      {
        id: 'fixer',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work, emit DONE when finished' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'dag-loopgroup-done', nodes },
        workflowRun,
      })
    );

    // Two iterations: iter 1 (no signal) → iter 2 (DONE signal) → complete.
    expect(callCount).toBe(2);
    expect(result).toContain('iteration 2 final result');
    const starts = (
      mockDeps.store.persistWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls
      .map(([event]) => event)
      .filter(event => event.event_type === 'node_started' && event.step_name === 'fixer.work');
    expect(starts).toHaveLength(2);
    expect(starts[0].data?.invocation).toMatchObject({
      loopPath: [{ groupId: 'fixer', iteration: 1 }],
    });
    expect(starts[1].data?.invocation).toMatchObject({
      loopPath: [{ groupId: 'fixer', iteration: 2 }],
    });
    expect(starts[0].data?.invocation).not.toEqual(starts[1].data?.invocation);
  });

  it('re-executes a load-time included body block on every loop_group iteration (#2623)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield {
        type: 'agent_message_chunk',
        text: callCount === 1 ? 'iteration 1 still working' : 'iteration 2\nDONE',
      };
      yield { type: 'result', sessionId: `included-body-${callCount}` };
    });

    const block = workflowDefinitionSchema.parse({
      name: 'review-block',
      description: 'Reusable loop body',
      returns: 'review',
      nodes: [{ id: 'review', prompt: 'review this iteration' }],
    });
    const parent = workflowDefinitionSchema.parse({
      name: 'included-loop-group',
      description: 'Repeats a composed block',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            nodes: [{ id: 'pass', include: 'review-block' }],
          },
        },
      ],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [block.name, block],
        [parent.name, parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const expanded = workflows.get(parent.name);
    expect(expanded).toBeDefined();
    if (!expanded) throw new Error('expected expanded workflow');

    const store = createMockStore();
    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: ready(expanded),
        workflowRun: makeWorkflowRun('dag-loopgroup-included'),
      })
    );

    expect(callCount).toBe(2);
    expect(result).toContain('iteration 2\nDONE');
    const bodyCompletions = store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .filter(
        event => event.event_type === 'node_completed' && event.step_name === 'group.pass__review'
      );
    expect(bodyCompletions.map(event => event.data?.iteration)).toEqual([1, 2]);
  });

  it('preserves typed loop body artifacts across three included iterations (#2480)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield {
        type: 'agent_message_chunk',
        text: callCount === 3 ? 'review iteration 3 DONE' : `review iteration ${String(callCount)}`,
      };
      yield { type: 'result', sessionId: `typed-body-${String(callCount)}` };
    });

    const block = workflowDefinitionSchema.parse({
      name: 'typed-review-block',
      description: 'Reusable typed loop body',
      returns: 'review',
      nodes: [{ id: 'review', prompt: 'review this iteration', output_type: 'findings' }],
    });
    const parent = workflowDefinitionSchema.parse({
      name: 'typed-included-loop-group',
      description: 'Repeats a typed composed block',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            nodes: [{ id: 'pass', include: 'typed-review-block' }],
          },
        },
      ],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [block.name, block],
        [parent.name, parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const expanded = workflows.get(parent.name);
    expect(expanded).toBeDefined();
    if (!expanded) throw new Error('expected expanded workflow');

    const artifactsDir = join(testDir, 'artifacts');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(createMockStore()),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: ready(expanded),
        workflowRun: makeWorkflowRun('dag-loopgroup-typed-included'),
        artifactsDir,
      })
    );

    expect(callCount).toBe(3);
    const artifacts = (await readAllArtifacts(artifactsDir)).sort(
      (left, right) =>
        (left.loopGroupPath?.[0]?.iteration ?? 0) - (right.loopGroupPath?.[0]?.iteration ?? 0)
    );
    expect(artifacts).toHaveLength(3);
    expect(new Set(artifacts.map(entry => entry.path)).size).toBe(3);
    expect(artifacts.map(entry => entry.nodeId)).toEqual([
      'pass__review',
      'pass__review',
      'pass__review',
    ]);
    expect(artifacts.map(entry => entry.loopGroupPath)).toEqual([
      [{ groupId: 'group', iteration: 1 }],
      [{ groupId: 'group', iteration: 2 }],
      [{ groupId: 'group', iteration: 3 }],
    ]);
    const contents = await Promise.all(
      artifacts.map(entry => readFile(join(artifactsDir, entry.path), 'utf8'))
    );
    expect(contents).toEqual([
      'review iteration 1',
      'review iteration 2',
      'review iteration 3 DONE',
    ]);
  });

  it('preserves complete nested loop_group lineage when inner iterations repeat (#2480)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield {
        type: 'agent_message_chunk',
        text:
          callCount === 1
            ? 'inner result 1\n<promise>INNER_DONE</promise>'
            : 'inner result 2\n<promise>INNER_DONE</promise>\nOUTER_DONE',
      };
      yield { type: 'result', sessionId: `nested-artifact-${String(callCount)}` };
    });

    const artifactsDir = join(testDir, 'artifacts');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(createMockStore()),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: {
          name: 'nested-typed-loop-group',
          nodes: [
            {
              id: 'outer',
              kind: 'loop_group',
              loop_group: {
                until: 'OUTER_DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  {
                    id: 'inner',
                    kind: 'loop_group',
                    loop_group: {
                      until: 'INNER_DONE',
                      max_iterations: 1,
                      fresh_context: false,
                      nodes: [
                        {
                          id: 'leaf',
                          kind: 'agent',
                          source: { kind: 'inline', prompt: 'produce nested result' },
                          output_type: 'findings',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('dag-nested-loopgroup-typed'),
        artifactsDir,
      })
    );

    expect(callCount).toBe(2);
    const artifacts = (await readAllArtifacts(artifactsDir)).sort(
      (left, right) =>
        (left.loopGroupPath?.[0]?.iteration ?? 0) - (right.loopGroupPath?.[0]?.iteration ?? 0)
    );
    expect(artifacts.map(entry => entry.loopGroupPath)).toEqual([
      [
        { groupId: 'outer', iteration: 1 },
        { groupId: 'inner', iteration: 1 },
      ],
      [
        { groupId: 'outer', iteration: 2 },
        { groupId: 'inner', iteration: 1 },
      ],
    ]);
    expect(new Set(artifacts.map(entry => entry.path)).size).toBe(2);
  });

  it('preserves a completed body artifact when an interactive loop_group resumes (#2480)', async () => {
    const artifactsDir = join(testDir, 'artifacts');
    const workflow = {
      name: 'resumed-typed-loop-group',
      nodes: [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            interactive: true,
            gate_message: 'Review the typed result.',
            nodes: [
              {
                id: 'work',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'produce a typed result' },
                output_type: 'findings',
              },
            ],
          },
        },
      ] as DagNode[],
    };

    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'iteration 1 draft' };
      yield { type: 'result', sessionId: 'typed-resume-1' };
    });
    const firstDeps = createMockDeps(createMockStore());
    await executeDagWorkflow(
      dagOptions({
        deps: firstDeps,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('dag-loopgroup-typed-resume'),
        artifactsDir,
      })
    );

    const beforeResume = await readAllArtifacts(artifactsDir);
    expect(beforeResume).toHaveLength(1);
    expect(beforeResume[0]?.loopGroupPath).toEqual([{ groupId: 'refine', iteration: 1 }]);
    const firstPath = beforeResume[0]?.path;
    if (firstPath === undefined) throw new Error('expected first-iteration artifact');
    expect(await readFile(join(artifactsDir, firstPath), 'utf8')).toBe('iteration 1 draft');

    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'iteration 2 final DONE' };
      yield { type: 'result', sessionId: 'typed-resume-2' };
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(createMockStore()),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('dag-loopgroup-typed-resume', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 1,
              sessionId: 'typed-resume-1',
              sessionProvider: 'claude',
              message: 'Review the typed result.',
            },
            loop_user_input: 'continue',
          },
        }),
        artifactsDir,
      })
    );

    const afterResume = (await readAllArtifacts(artifactsDir)).sort(
      (left, right) =>
        (left.loopGroupPath?.[0]?.iteration ?? 0) - (right.loopGroupPath?.[0]?.iteration ?? 0)
    );
    expect(afterResume.map(entry => entry.loopGroupPath)).toEqual([
      [{ groupId: 'refine', iteration: 1 }],
      [{ groupId: 'refine', iteration: 2 }],
    ]);
    expect(afterResume[0]?.path).toBe(firstPath);
    expect(await readFile(join(artifactsDir, firstPath), 'utf8')).toBe('iteration 1 draft');
    const secondPath = afterResume[1]?.path;
    if (secondPath === undefined) throw new Error('expected resumed iteration artifact');
    expect(await readFile(join(artifactsDir, secondPath), 'utf8')).toBe('iteration 2 final DONE');
  });

  it('resolves an included inner body previous output in nested loop_group until_bash (#2623)', async () => {
    // This runs the authored include through real load-time expansion before executing the
    // nested groups. The inner gate combines three scopes: its included body's previous
    // iteration, that body's current output, and the enclosing group's previous iteration.
    // Apostrophes in every carried value make unsafe shell interpolation fail visibly.
    //
    // Cost recomposition (flaky-fan-out): executing this 2x2 nesting end-to-end forks a
    // structurally-fixed TWELVE real `bash -c` processes (seed x2 + included body x4 +
    // inner gates x4 + outer gates x2), which consumed ~46% of the 5000ms budget Windows CI
    // then had, in a healthy run. What pins the #2623 regression is exactly
    // WHICH scoped values the executor compiles into each gate/body invocation, so this
    // half observes every fork through the established `git.execFileAsync` seam, pins each
    // compiled script byte-for-byte, and runs zero shells. Real-parse behaviour of the
    // apostrophed substitutions is proven separately by the shell-safety companion below.
    const outerCounter = join(testDir, 'nested-until-outer-counter');
    const outerCounterRef = `"${outerCounter.replace(/\\/g, '/')}"`;

    // Mirrors the executor's substitution quoting contract (shellQuote): apostrophes are
    // escaped as '\'' inside single quotes. EDGE H pins the same convention unit-side.
    const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const READY = q("inner's ready");
    const FIRST = q("outer's first");
    const SECOND = q("outer's second");
    const seedScript =
      `if [ -f ${outerCounterRef} ]; then echo "outer's second"; ` +
      `else touch ${outerCounterRef}; echo "outer's first"; fi`;
    /** Outer-group previous-seed scopes: iteration 1 saw none, iteration 2 saw "first". */
    const innerGateScript = (outerIteration: 1 | 2, seenPrevOutput: boolean) =>
      `${seenPrevOutput ? `test ${READY}` : "test ''"} = "inner's ready" && ` +
      `test ${READY} = "inner's ready" && ` +
      `{ { test ${outerIteration === 1 ? FIRST : SECOND} = "outer's first" && ` +
      `${outerIteration === 1 ? "test -z ''" : `test -z ${FIRST}`}; } || ` +
      `{ test ${outerIteration === 1 ? FIRST : SECOND} = "outer's second" && ` +
      `test ${outerIteration === 1 ? "''" : FIRST} = "outer's first"; }; }`;
    const outerGateScript = (outerIteration: 1 | 2) =>
      `test ${outerIteration === 1 ? FIRST : SECOND} = "outer's second" && ` +
      `test ${READY} = "inner's ready"`;

    const block = workflowDefinitionSchema.parse({
      name: 'nested-check-block',
      description: 'Reusable nested loop check',
      returns: 'check',
      nodes: [{ id: 'check', bash: `echo "inner's ready"` }],
    });
    const parent = workflowDefinitionSchema.parse({
      name: 'nested-included-loop-group',
      description: 'Repeats an included block inside nested groups',
      nodes: [
        {
          id: 'outer',
          loop_group: {
            max_iterations: 2,
            until_bash:
              `test $seed.output = "outer's second" && ` + `test $inner.output = "inner's ready"`,
            nodes: [
              {
                id: 'seed',
                bash: seedScript,
              },
              {
                id: 'inner',
                loop_group: {
                  max_iterations: 2,
                  until_bash:
                    `test $LOOP_PREV.pass__check.output = "inner's ready" && ` +
                    `test $pass.output = "inner's ready" && ` +
                    `{ { test $seed.output = "outer's first" && ` +
                    `test -z $LOOP_PREV.seed.output; } || ` +
                    `{ test $seed.output = "outer's second" && ` +
                    `test $LOOP_PREV.seed.output = "outer's first"; }; }`,
                  nodes: [{ id: 'pass', include: 'nested-check-block' }],
                },
                depends_on: ['seed'],
              },
            ],
          },
        },
      ],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [block.name, block],
        [parent.name, parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const expanded = workflows.get(parent.name);
    expect(expanded).toBeDefined();
    if (!expanded) throw new Error('expected expanded workflow');

    const observedScripts: string[] = [];
    let seedRuns = 0;
    let innerGatesRun = 0;
    let outerGatesRun = 0;
    const exitCodeErr = (code: number) =>
      Object.assign(new Error(`exit ${String(code)}`), { code });
    const execSpy = spyOnNodeExec().mockImplementation(async (_cmd, _args, options) => {
      const script = options?.input ?? '';
      observedScripts.push(script);
      if (script === `echo "inner's ready"`) return { stdout: "inner's ready\n", stderr: '' };
      if (script === seedScript) {
        seedRuns += 1;
        return { stdout: seedRuns === 1 ? "outer's first\n" : "outer's second\n", stderr: '' };
      }
      if (script.includes('-z ')) {
        innerGatesRun += 1;
        if (innerGatesRun % 2 === 0) return { stdout: '', stderr: '' }; // conditions met
        throw exitCodeErr(1); // previous-output snapshot still empty -> iterate again
      }
      if (script.includes(`= "outer's second"`)) {
        outerGatesRun += 1;
        if (outerGatesRun === 2) return { stdout: '', stderr: '' }; // second seed output
        throw exitCodeErr(1); // first seed output -> repeat the enclosing group
      }
      throw new Error(`unexpected bash subprocess while pinning #2623 substitutions: '${script}'`);
    });

    let store!: ReturnType<typeof createMockStore>;
    let result: Awaited<ReturnType<typeof executeDagWorkflow>>;
    try {
      store = createMockStore();
      result = await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-lg',
          cwd: testDir,
          workflow: ready(expanded),
          workflowRun: makeWorkflowRun('dag-nested-loopgroup-included-prev'),
        })
      );
    } finally {
      execSpy.mockRestore();
    }

    // Every fork the executor makes carries exactly the scoped values #2623 fixes: the
    // included body's previous/current output and the enclosing group's previous/current
    // seed stay distinct per nesting level and per outer iteration (empty snapshot on
    // first pass, prior value afterwards).
    expect(observedScripts).toEqual([
      seedScript,
      `echo "inner's ready"`,
      innerGateScript(1, false),
      `echo "inner's ready"`,
      innerGateScript(1, true),
      outerGateScript(1),
      seedScript,
      `echo "inner's ready"`,
      innerGateScript(2, false),
      `echo "inner's ready"`,
      innerGateScript(2, true),
      outerGateScript(2),
    ]);

    // Each outer iteration ran two inner iterations: inner iteration 1 sees an empty
    // previous snapshot, while iteration 2 sees the prior included-node output. The outer
    // repeats once, proving its own previous `seed` output remains outer-scoped.
    expect(result).toContain("inner's ready");
    const includedCompletions = store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .filter(
        event =>
          event.event_type === 'node_completed' && event.step_name === 'outer.inner.pass__check'
      );
    expect(includedCompletions.map(event => event.data?.iteration)).toEqual([1, 2, 1, 2]);
  });

  it('keeps included-block until_bash substitution parseable by real bash end-to-end (#2623)', async () => {
    // Shell-safety companion to the zero-subprocess #2623 test above: the substituted
    // gate below carries apostrophed literals through REAL Git-Bash so a quoting
    // regression (unbalanced quotes, lost escaping) surfaces as a parse failure instead
    // of passing silent. Four one-line scripts total — the house ceiling for spawned
    // subprocesses in until_bash tests. Iteration 1's gate fails on the empty
    // `$LOOP_PREV.pass__check.output` snapshot, forcing the second iteration whose gate
    // sees the prior included-node output — the exact causal chain of #2623.
    const block = workflowDefinitionSchema.parse({
      name: 'shellsafe-check-block',
      description: 'Reusable apostrophe-emitting check',
      returns: 'check',
      nodes: [{ id: 'check', bash: `echo "inner's ready"` }],
    });
    const parent = workflowDefinitionSchema.parse({
      name: 'included-shellsafe-loop-group',
      description: 'Repeats an included block gated by until_bash',
      nodes: [
        {
          id: 'group',
          loop_group: {
            max_iterations: 2,
            until_bash:
              `test $LOOP_PREV.pass__check.output = "inner's ready" && ` +
              `test $pass.output = "inner's ready"`,
            nodes: [{ id: 'pass', include: 'shellsafe-check-block' }],
          },
        },
      ],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [block.name, block],
        [parent.name, parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const expanded = workflows.get(parent.name);
    expect(expanded).toBeDefined();
    if (!expanded) throw new Error('expected expanded workflow');

    const store = createMockStore();
    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: ready(expanded),
        workflowRun: makeWorkflowRun('dag-included-untilbash-shellsafe'),
      })
    );

    // The gate's quoted comparisons parsed correctly: the loop completed via until_bash
    // on its second iteration only after reading BOTH the included body's previous
    // iteration and its current output through real bash.
    expect(result).toContain("inner's ready");
    const includedCompletions = store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .filter(
        event => event.event_type === 'node_completed' && event.step_name === 'group.pass__check'
      );
    expect(includedCompletions.map(event => event.data?.iteration)).toEqual([1, 2]);
  });

  it('runs a command-backed loop node inside a loop_group body with namespaced lifecycle events', async () => {
    // A `loop:` body node may use `loop.command` like any top-level loop. The
    // command body must reach the AI, and the loop's persisted lifecycle events
    // must carry the `<groupId>.<nodeId>` namespaced step_name (#2090).
    await writeFile(
      join(testDir, '.archon', 'commands', 'body-loop-cmd.md'),
      'Command-file body for the inner loop.'
    );
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: 'inner work done. <promise>INNER_DONE</promise>\nDONE',
      };
      yield { type: 'result', sessionId: 'lg-cmd-sess' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-loopgroup-cmd');

    const nodes: DagNode[] = [
      {
        id: 'grp',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'inner-loop',
              kind: 'loop',
              loop: {
                command: 'body-loop-cmd',
                until: 'INNER_DONE',
                max_iterations: 2,
                fresh_context: false,
              },
              depends_on: [],
            } as unknown as DagNode,
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'dag-loopgroup-cmd', nodes },
        workflowRun,
      })
    );

    // The command file's body (not a YAML inline prompt) reached the AI.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(mockSendQueryDag.mock.calls[0][0] as string).toContain(
      'Command-file body for the inner loop.'
    );
    // Inner-loop lifecycle events are namespaced under the group id.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const innerStarted = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_started' &&
        (call[0] as Record<string, unknown>).step_name === 'grp.inner-loop'
    );
    expect(innerStarted.length).toBeGreaterThanOrEqual(1);
  });

  it('delivers $LOOP_USER_INPUT to a resumed body script via env, never spliced into source (#2115)', async () => {
    // Resumed interactive group: the approval-gate free-text must reach the body script
    // as an env var, not as text interpolated into the executed TS source.
    const injection = '"); process.exit(1); //';
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'DONE\n', stderr: '' });
    try {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('lg-userinput-script', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'grp',
            iteration: 0,
            message: 'Review and provide feedback.',
          },
          loop_user_input: injection,
          loop_feedback_given: true,
        },
      });

      const nodes: DagNode[] = [
        {
          id: 'grp',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            fresh_context: true,
            interactive: true,
            gate_message: 'Review and provide feedback.',
            nodes: [
              {
                id: 'emit',
                kind: 'exec',
                script: 'console.log("$LOOP_USER_INPUT"); console.log("DONE")',
                runtime: 'bun',
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-lg-userinput',
          cwd: testDir,
          workflow: { name: 'lg-userinput-script', nodes },
          workflowRun,
        })
      );

      const scriptCall = execSpy.mock.calls.find(
        c => (c[0] as string) === 'bun' && (c[1] as string[]).includes('-e')
      ) as [string, string[], { env: NodeJS.ProcessEnv }] | undefined;
      expect(scriptCall).toBeDefined();
      // Source is byte-identical to the author's body — the payload is not interpolated.
      expect(scriptCall?.[1][2]).toBe('console.log("$LOOP_USER_INPUT"); console.log("DONE")');
      expect(scriptCall?.[1][2]).not.toContain('process.exit');
      // The per-iteration feedback reaches the script through the environment.
      expect(scriptCall?.[2].env.LOOP_USER_INPUT).toBe(injection);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('delivers $LOOP_USER_INPUT to a resumed body bash node via env (#2725)', async () => {
    // A body bash node's literal "$LOOP_USER_INPUT" token is already resolved by the
    // loop scope's shell-quoted splice into the script source, so a script using that
    // exact literal form is not a regression test for
    // this fix. This test targets a script that reads the variable WITHOUT that literal
    // token — `printenv`, matching how `${LOOP_USER_INPUT}` (braced form) or any other
    // indirect env read behaves — which the splice cannot touch and which previously read
    // as empty because executeBashNode's subprocess env hardcoded LOOP_USER_INPUT: ''.
    const feedback = 'looks good, ship it';
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'DONE\n', stderr: '' });
    try {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('lg-userinput-bash', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'grp',
            iteration: 0,
            message: 'Review and provide feedback.',
          },
          loop_user_input: feedback,
          loop_feedback_given: true,
        },
      });

      const nodes: DagNode[] = [
        {
          id: 'grp',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            fresh_context: true,
            interactive: true,
            gate_message: 'Review and provide feedback.',
            nodes: [
              {
                id: 'emit',
                kind: 'exec',
                script: 'printenv LOOP_USER_INPUT; echo "DONE"',
                runtime: 'sh',
                depends_on: [],
              },
            ],
          },
          depends_on: [],
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-lg-userinput-bash',
          cwd: testDir,
          workflow: { name: 'lg-userinput-bash', nodes },
          workflowRun,
        })
      );

      const bashCall = execSpy.mock.calls.find(
        c => (c[0] as string) === git.resolveBashPath() && (c[1] as string[])[0] === '-c'
      ) as [string, string[], { env: NodeJS.ProcessEnv }] | undefined;
      expect(bashCall).toBeDefined();
      // The per-iteration feedback reaches the bash node through the environment —
      // previously always '' regardless of what the reviewer typed at the gate.
      expect(bashCall?.[2].env.LOOP_USER_INPUT).toBe(feedback);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('substitutes $LOOP_USER_INPUT into a resumed body command file (#3954)', async () => {
    const feedback = 'tighten the error message';
    await writeFile(
      join(testDir, '.archon', 'commands', 'revise.md'),
      'Revise per reviewer: [$LOOP_USER_INPUT]'
    );
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DONE' };
      yield { type: 'result', sessionId: 'lg-cmd-input-sess' };
    });
    const workflowRun = makeWorkflowRun('lg-userinput-command', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'grp',
          iteration: 0,
          message: 'Review and provide feedback.',
        },
        loop_user_input: feedback,
        loop_feedback_given: true,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-lg-userinput-command',
        cwd: testDir,
        workflow: {
          name: 'lg-userinput-command',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
                interactive: true,
                gate_message: 'Review and provide feedback.',
                nodes: [
                  {
                    id: 'revise',
                    kind: 'agent',
                    source: { kind: 'command', name: 'revise' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(mockSendQueryDag.mock.calls[0][0] as string).toContain(
      `Revise per reviewer: [${feedback}]`
    );
  });

  it('resolves $LOOP_PREV in a body command file to the previous iteration (#3954)', async () => {
    await writeFile(
      join(testDir, '.archon', 'commands', 'draft.md'),
      'Prior draft: [$LOOP_PREV.draft.output]'
    );
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield { type: 'agent_message_chunk', text: callCount === 1 ? 'first draft' : 'DONE' };
      yield { type: 'result', sessionId: `lg-cmd-prev-sess-${callCount}` };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-lg-prev-command',
        cwd: testDir,
        workflow: {
          name: 'lg-prev-command',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
                nodes: [
                  {
                    id: 'draft',
                    kind: 'agent',
                    source: { kind: 'command', name: 'draft' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('lg-prev-command'),
      })
    );

    const prompts = mockSendQueryDag.mock.calls.map(call => call[0] as string);
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain('Prior draft: []');
    expect(prompts[1]).toContain('Prior draft: [first draft]');
  });

  it('runs a nested body command file through every enclosing loop scope (#3954)', async () => {
    await writeFile(
      join(testDir, '.archon', 'commands', 'polish.md'),
      'outer: [$LOOP_PREV.a.output] inner: [$LOOP_PREV.polish.output]'
    );
    let aCalls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      let text: string;
      if (prompt.includes('produce a')) text = `A${++aCalls}`;
      else if (prompt.includes('inner: []')) text = 'C1';
      else text = prompt.includes('outer: [A1]') ? 'INNER_DONE OUTER_DONE' : 'INNER_DONE';
      yield { type: 'agent_message_chunk', text };
      yield { type: 'result', sessionId: 'lg-nested-cmd-sess' };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-lg-nested-command',
        cwd: testDir,
        workflow: {
          name: 'lg-nested-command',
          nodes: [
            {
              id: 'outer',
              kind: 'loop_group',
              loop_group: {
                until: 'OUTER_DONE',
                max_iterations: 2,
                fresh_context: true,
                nodes: [
                  {
                    id: 'a',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'produce a' },
                    depends_on: [],
                  },
                  {
                    id: 'inner',
                    kind: 'loop_group',
                    loop_group: {
                      until: 'INNER_DONE',
                      max_iterations: 2,
                      fresh_context: true,
                      nodes: [
                        {
                          id: 'polish',
                          kind: 'agent',
                          source: { kind: 'command', name: 'polish' },
                          depends_on: [],
                        },
                      ],
                    },
                    depends_on: ['a'],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('lg-nested-command'),
      })
    );

    const polishPrompts = mockSendQueryDag.mock.calls
      .map(call => call[0] as string)
      .filter(prompt => prompt.includes('outer: ['));
    expect(polishPrompts.length).toBe(4);
    expect(polishPrompts[0]).toContain('outer: [] inner: []');
    expect(polishPrompts[1]).toContain('outer: [] inner: [C1]');
    expect(polishPrompts[2]).toContain('outer: [A1] inner: []');
    expect(polishPrompts[3]).toContain('outer: [A1] inner: [C1]');
  });

  // #3972 — a command body is loaded only when its node runs, after expansion replaced
  // the include node, so its `$<include>.output` must still name the include's sink.
  it('gives a standalone command body the output of an include it reads (#3972)', async () => {
    await writeFile(
      join(testDir, '.archon', 'commands', 'check-ci.md'),
      'Check CI for [$pr.output]'
    );
    await writeFile(join(testDir, '.archon', 'commands', 'fix-ci.md'), 'Fix CI for [$pr.output]');
    await writeFile(
      join(testDir, '.archon', 'commands', 'retry-ci.md'),
      'Retry CI for [$pr.output]'
    );
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      yield {
        type: 'agent_message_chunk',
        text: prompt.includes('open the pr') ? 'PR-42' : 'DONE',
      };
      yield { type: 'result', sessionId: 'include-alias-sess' };
    });
    const leaf = workflowDefinitionSchema.parse({
      name: 'open-pr',
      description: 'Opens a PR',
      nodes: [{ id: 'open', prompt: 'open the pr' }],
    });
    const deliver = workflowDefinitionSchema.parse({
      name: 'deliver',
      description: 'Reads an include from command bodies',
      nodes: [
        { id: 'pr', include: 'open-pr' },
        { id: 'check', command: 'check-ci', depends_on: ['pr'] },
        {
          id: 'fix',
          depends_on: ['pr'],
          loop_group: {
            until: 'DONE',
            max_iterations: 1,
            nodes: [{ id: 'ci', command: 'fix-ci' }],
          },
        },
        {
          id: 'retry',
          depends_on: ['pr'],
          loop: { command: 'retry-ci', until: 'DONE', max_iterations: 1 },
        },
      ],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [leaf.name, leaf],
        [deliver.name, deliver],
      ])
    );
    expect(errors).toHaveLength(0);

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-include-alias',
        cwd: testDir,
        workflow: workflows.get('deliver')!,
        workflowRun: makeWorkflowRun('include-alias'),
      })
    );

    const prompts = mockSendQueryDag.mock.calls.map(call => call[0] as string);
    expect(prompts.find(prompt => prompt.includes('Check CI for'))).toContain(
      'Check CI for [PR-42]'
    );
    expect(prompts.find(prompt => prompt.includes('Fix CI for'))).toContain('Fix CI for [PR-42]');
    expect(prompts.find(prompt => prompt.includes('Retry CI for'))).toContain(
      'Retry CI for [PR-42]'
    );
  });

  it('resolves an included loop-body command own with: binding at run time (#3972)', async () => {
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      yield { type: 'agent_message_chunk', text: prompt.includes('produce') ? 'PR-7' : 'DONE' };
      yield { type: 'result', sessionId: 'included-binding-sess' };
    });
    const block = workflowDefinitionSchema.parse({
      name: 'fix-loop',
      description: 'A loop-body command binds its sibling output',
      nodes: [
        {
          id: 'fix',
          loop_group: {
            until: 'DONE',
            max_iterations: 1,
            nodes: [
              { id: 'p', prompt: 'produce' },
              { id: 'ci', command: 'check-pr', depends_on: ['p'], with: { bound: '$p.output' } },
            ],
          },
        },
      ],
    });
    const parent = workflowDefinitionSchema.parse({
      name: 'ship',
      description: 'Includes the loop',
      nodes: [{ id: 'deliver', include: 'fix-loop' }],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [block.name, block],
        [parent.name, parent],
      ]),
      new Map([['check-pr', 'Check PR [$INPUTS.bound]']])
    );
    expect(errors).toHaveLength(0);

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-included-binding',
        cwd: testDir,
        workflow: workflows.get('ship')!,
        workflowRun: makeWorkflowRun('included-binding'),
      })
    );

    const prompts = mockSendQueryDag.mock.calls.map(call => call[0] as string);
    expect(prompts.find(prompt => prompt.includes('Check PR'))).toContain('Check PR [PR-7]');
  });
});
