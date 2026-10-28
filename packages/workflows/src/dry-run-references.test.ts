import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { expandWorkflowIncludes } from './include-expander';
import { dryRunWorkflow, useDryRunFiles } from './dry-run-test-utils';

const { temporaryDirectory, commandFiles } = useDryRunFiles();

describe('dry-run text references', () => {
  test('hydrates object stubs and resolves workflow and strict output variables', async () => {
    const workflow = makeTestWorkflow({
      name: 'structured',
      nodes: [
        {
          id: 'classify',
          prompt: 'Classify $ARGUMENTS',
          output_format: { type: 'object', properties: { kind: { type: 'string' } } },
        },
        {
          id: 'use',
          prompt: 'Handle $classify.output.kind for $USER_MESSAGE',
          depends_on: ['classify'],
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: 'issue 2100',
      stubs: { classify: { kind: 'BUG' }, use: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[1]?.resolvedText).toBe('Handle BUG for issue 2100');
    expect(result.summary).toBe('done');
  });

  test('loads and resolves command-file prompt text', async () => {
    const cwd = commandFiles({
      inspect: 'Inspect $ARGUMENTS',
    });
    const workflow = makeTestWorkflow({
      name: 'command-text',
      nodes: [{ id: 'inspect', command: 'inspect' }],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: 'issue 2100',
      cwd,
      stubs: { inspect: 'done' },
    });

    expect(result.trace[0]?.resolvedText).toBe('Inspect issue 2100');
  });

  test('substitutes an empty typed-artifact listing in a dry-run preview', async () => {
    const cwd = commandFiles({ listing: 'Listing: [$TYPED_ARTIFACTS_FILE]' });
    const workflow = makeTestWorkflow({
      name: 'typed-artifact-preview',
      nodes: [{ id: 'listing', command: 'listing' }],
    });

    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { listing: 'done' },
    });

    expect(result.trace[0]?.resolvedText).toBe('Listing: []');
  });
  test('keeps whole-output references lenient and fails strict unknown fields', async () => {
    const workflow = makeTestWorkflow({
      name: 'strict-refs',
      nodes: [
        { id: 'producer', prompt: 'p', output_format: { type: 'object', properties: { ok: {} } } },
        { id: 'whole', prompt: 'whole=$unknown.output', depends_on: ['producer'] },
        { id: 'strict', prompt: 'strict=$producer.output.typo', depends_on: ['producer'] },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { producer: { ok: true }, whole: 'ok', strict: 'unused' },
    });

    expect(result.trace.find(entry => entry.nodeId === 'whole')?.resolvedText).toBe('whole=');
    expect(result.trace.find(entry => entry.nodeId === 'strict')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('not declared'),
    });
    expect(result.unusedStubs).toEqual(['strict']);
  });
});
describe('dryRunWorkflow — declared inputs (#2610)', () => {
  const defaulted = makeTestWorkflow({
    name: 'inputs-defaulted',
    inputs: { work: { default: 'W' } },
    nodes: [{ id: 'impl', prompt: 'Do $INPUTS.work' }],
  });

  test('applies declared defaults when nothing is supplied', async () => {
    const result = await dryRunWorkflow({
      workflow: defaulted,
      stubs: { impl: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Do W');
  });

  test('supplied values win over declared defaults', async () => {
    const result = await dryRunWorkflow({
      workflow: defaulted,
      stubs: { impl: 'done' },
      inputs: { work: 'X' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Do X');
  });

  test('merges a supplied input with a defaulted companion — the #2123 bundle shape', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-mixed',
      inputs: { diff: { required: true }, style: { default: 'strict' } },
      nodes: [{ id: 'review', prompt: 'Review $INPUTS.diff as $INPUTS.style' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { review: 'done' },
      inputs: { diff: 'D1' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Review D1 as strict');
  });

  test('keeps $INPUTS text literal in bash bodies — env vars are the only shell channel', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-shell-literal',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'code', bash: 'echo $INPUTS.work' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { code: 'stubbed' },
    });

    expect(result.trace[0]?.resolvedText).toBe('echo $INPUTS.work');
  });

  test('keeps passthrough semantics for a workflow that declares no inputs', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-passthrough',
      nodes: [{ id: 'use', prompt: 'Got $INPUTS.a' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { use: 'done' },
      inputs: { a: 'b' },
    });

    expect(result.trace[0]?.resolvedText).toBe('Got b');
  });

  test('resolves $INPUTS in a loop.command body during simulated iterations', async () => {
    const cwd = commandFiles({
      'loop-impl': 'Work on $INPUTS.work',
    });
    const workflow = makeTestWorkflow({
      name: 'inputs-loop-command',
      inputs: { work: { default: '' } },
      nodes: [{ id: 'impl', loop: { command: 'loop-impl', until: 'DONE', max_iterations: 2 } }],
    });

    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { impl: '<promise>DONE</promise>' },
      inputs: { work: 'ship it' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Work on ship it');
  });

  test('uses the input-bound compiled prompt for a nested included loop command', async () => {
    const cwd = temporaryDirectory();
    mkdirSync(join(cwd, '.archon', 'commands'), { recursive: true });
    // The raw source keeps the middle workflow's input name. Loading it at simulation time
    // reproduces #2629; the expanded node's compiled prompt has already rebound that name.
    writeFileSync(join(cwd, '.archon', 'commands', 'loop-impl.md'), 'Raw $INPUTS.work');

    const implement = makeTestWorkflow({
      name: 'implement',
      inputs: { work: { required: true } },
      nodes: [
        { id: 'implement', loop: { command: 'loop-impl', until: 'DONE', max_iterations: 1 } },
      ],
    });
    const deliver = makeTestWorkflow({
      name: 'deliver',
      inputs: { work: { required: true } },
      nodes: [{ id: 'impl', include: 'implement', with: { work: '$INPUTS.work' } }],
    });
    const fix = makeTestWorkflow({
      name: 'fix',
      inputs: { target: { required: true } },
      nodes: [{ id: 'deliver', include: 'deliver', with: { work: 'Fix $INPUTS.target' } }],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['implement', implement],
        ['deliver', deliver],
        ['fix', fix],
      ]),
      new Map([['loop-impl', 'Work on $INPUTS.work']])
    );
    expect(errors).toHaveLength(0);

    const result = await dryRunWorkflow({
      workflow: workflows.get('fix')!,
      cwd,
      stubs: { deliver__impl__implement: '<promise>DONE</promise>' },
      inputs: { target: 'issue 2629' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Work on Fix issue 2629');
  });

  test('when: conditions branch on the effective input map', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-when',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'gated', prompt: 'go', when: "$INPUTS.work == 'X'" }],
    });

    const supplied = await dryRunWorkflow({
      workflow,
      stubs: { gated: 'ran' },
      inputs: { work: 'X' },
    });
    expect(supplied.trace[0]?.state).toBe('stubbed');

    const defaultOnly = await dryRunWorkflow({
      workflow,
      stubs: { gated: 'unused' },
    });
    expect(defaultOnly.trace[0]).toMatchObject({
      state: 'skipped',
      reason: 'when_condition_false',
    });
  });

  test('fails an unknown reference with the same message a real run produces', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-typo',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'impl', prompt: 'Do $INPUTS.typo' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { impl: 'unused' },
    });

    // Read the value before matching: Bun's toMatchObject leaves an asymmetric
    // matcher behind in the received object, corrupting later reads of the same field.
    const reason = result.trace[0]?.state === 'failed' ? result.trace[0].reason : '';
    expect(reason).toContain("Unknown input '$INPUTS.typo'");
    expect(reason).toContain('$INPUTS.work');
  });

  test('keeps the no-declared-inputs failure unchanged', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-none',
      nodes: [{ id: 'impl', prompt: 'Do $INPUTS.x' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { impl: 'unused' },
    });

    expect(result.trace[0]).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('This run has no declared inputs.'),
    });
  });

  test('delivers INPUTS_<UPPER_SNAKE> env vars to exec-code nodes', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-exec',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'code', bash: 'printf "v=%s" "$INPUTS_WORK"' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      execCode: true,
    });

    expect(result.trace[0]).toMatchObject({ state: 'completed', output: 'v=W' });
  });

  test("delivers an included block's own inputs to its bash body under --exec-code", async () => {
    const block = makeTestWorkflow({
      name: 'blk',
      inputs: { work: { required: true } },
      nodes: [{ id: 'code', bash: 'set -u; printf "v=%s" $INPUTS.work' }],
    });
    const parent = makeTestWorkflow({
      name: 'parent',
      nodes: [{ id: 'inc', include: 'blk', with: { work: 'two words' } }],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['blk', block],
        ['parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);

    const result = await dryRunWorkflow({
      workflow: workflows.get('parent')!,
      execCode: true,
    });

    expect(result.trace[0]).toMatchObject({ state: 'completed', output: 'v=two words' });
  });
});

describe('dryRunWorkflow — node-local with: bindings (#2637)', () => {
  const producer = {
    id: 'plan',
    prompt: 'Make a plan',
    output_format: { type: 'object', properties: { green: { type: 'boolean' } } },
  };

  test('delivers a command binding into the $INPUTS bag of the resolved text', async () => {
    const cwd = commandFiles({
      deploy: 'Deploy green=$INPUTS.flag',
    });
    const workflow = makeTestWorkflow({
      name: 'binding-command',
      nodes: [
        producer,
        {
          id: 'deploy',
          command: 'deploy',
          depends_on: ['plan'],
          with: { flag: '$plan.output.green' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { plan: { green: true }, deploy: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[1]?.resolvedText).toBe('Deploy green=true');
  });

  test('a node-local binding wins over a run-level input of the same name', async () => {
    const cwd = commandFiles({
      report: 'Mode: $INPUTS.mode',
    });
    const workflow = makeTestWorkflow({
      name: 'binding-precedence',
      inputs: { mode: { default: 'run-level' } },
      nodes: [{ id: 'report', command: 'report', with: { mode: 'node-local' } }],
    });

    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { report: 'done' },
    });

    expect(result.trace[0]?.resolvedText).toBe('Mode: node-local');
  });

  test('delivers script bindings as INPUTS_* env under --exec-code', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-exec',
      nodes: [
        producer,
        {
          id: 'check',
          script: 'console.log(`green=${process.env.INPUTS_GREEN ?? "unset"}`)',
          runtime: 'bun' as const,
          depends_on: ['plan'],
          with: { green: '$plan.output.green' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { plan: { green: true } },
      execCode: true,
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[1]?.output).toBe('green=true');
  });

  test('resolves a stubbed producer checkoutStart for an exec consumer', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-checkout-start',
      nodes: [
        { id: 'producer', prompt: 'Prepare the checkout' },
        {
          id: 'consumer',
          script: 'console.log("unused")',
          runtime: 'bun',
          depends_on: ['producer'],
          with: { checkout: '$producer.execution.checkoutStart' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      cwd: temporaryDirectory(),
      stubs: { producer: 'prepared', consumer: 'previewed' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.find(t => t.nodeId === 'consumer')).toMatchObject({
      state: 'stubbed',
      output: 'previewed',
    });
  });

  test('fails the node with the executor error when a binding names an unknown producer', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-unknown',
      nodes: [
        producer,
        {
          id: 'check',
          script: 'console.log("never")',
          runtime: 'bun' as const,
          depends_on: ['plan'],
          with: { green: '$plann.output' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { plan: { green: true } },
      execCode: true,
    });

    expect(result.outcome).toBe('failed');
    const failed = result.trace.find(t => t.nodeId === 'check');
    expect(failed?.state).toBe('failed');
    expect(failed?.reason).toContain("references node 'plann'");
  });

  test('a directive on a skipped producer takes if_skipped, matching the real run', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-skipped',
      nodes: [
        producer,
        {
          id: 'maybe',
          prompt: 'Only sometimes',
          depends_on: ['plan'],
          when: "$plan.output.green == 'false'",
          output_format: { type: 'object', properties: { ready: { type: 'boolean' } } },
        },
        {
          id: 'gate',
          script: 'console.log(`ready=${process.env.INPUTS_READY ?? "unset"}`)',
          runtime: 'bun' as const,
          depends_on: ['plan', 'maybe'],
          trigger_rule: 'all_done' as const,
          with: { ready: { from: '$maybe.output.ready', if_skipped: false } },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { plan: { green: true } },
      execCode: true,
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.find(t => t.nodeId === 'gate')?.output).toBe('ready=false');
  });

  test('a directive on a failed producer fails the consumer, never taking if_skipped (#2696)', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-failed',
      nodes: [
        { id: 'corrections', bash: 'echo boom >&2; exit 1' },
        {
          id: 'gate-ready',
          script: 'console.log(`ready=${process.env.INPUTS_READY ?? "unset"}`)',
          runtime: 'bun' as const,
          depends_on: ['corrections'],
          trigger_rule: 'all_done' as const,
          with: { ready: { from: '$corrections.output', if_skipped: 'default' } },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      execCode: true,
    });

    expect(result.outcome).toBe('failed');
    const gate = result.trace.find(t => t.nodeId === 'gate-ready');
    expect(gate?.state).toBe('failed');
    expect(gate?.reason).toContain("'corrections' failed");
  });

  test('a composed command node resolves its own binding, not an empty caller input (#2964)', async () => {
    const cwd = commandFiles({
      'sync-pr-body': 'Update PR $INPUTS.number',
    });

    const deliver = makeTestWorkflow({
      name: 'deliver',
      nodes: [
        {
          id: 'pr',
          prompt: 'Open the PR',
          output_format: { type: 'object', properties: { number: { type: 'number' } } },
        },
        {
          id: 'sync',
          command: 'sync-pr-body',
          depends_on: ['pr'],
          with: { number: '$pr.output.number' },
        },
      ],
    });
    const ship = makeTestWorkflow({
      name: 'ship',
      nodes: [{ id: 'deliver', include: 'deliver' }],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['deliver', deliver],
        ['ship', ship],
      ]),
      new Map([['sync-pr-body', 'Update PR $INPUTS.number']])
    );
    expect(errors).toHaveLength(0);

    const result = await dryRunWorkflow({
      workflow: workflows.get('ship')!,
      cwd,
      stubs: { deliver__pr: { number: 2964 }, deliver__sync: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.find(t => t.nodeId === 'deliver__sync')?.resolvedText).toBe(
      'Update PR 2964'
    );
  });
});
describe('dryRunWorkflow — substituted values are previewed verbatim (#4046)', () => {
  const quoted =
    "Check $gate.output.decision, read $gate.output, use $INPUTS.plan, keep $& and it's done.";

  test('previews the run message exactly as written', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'verbatim-message',
        nodes: [{ id: 'summarize', prompt: 'Summarize this request: $ARGUMENTS' }],
      }),
      userMessage: quoted,
      defaultStubs: true,
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe(`Summarize this request: ${quoted}`);
  });

  test('previews a previous-iteration output exactly as written', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'verbatim-prior',
        nodes: [
          {
            id: 'grp',
            loop_group: {
              until: 'DONE',
              max_iterations: 2,
              nodes: [{ id: 'draft', prompt: 'Prior: [$LOOP_PREV.draft.output]' }],
            },
          },
        ],
      }),
      stubs: { draft: quoted },
    });

    const drafts = result.trace.filter(entry => entry.nodeId === 'draft');
    expect(drafts.map(entry => entry.resolvedText)).toEqual(['Prior: []', `Prior: [${quoted}]`]);
  });
});
