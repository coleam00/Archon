import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowDefinition } from './schemas';
import { COMPILED_LOOP_COMMAND, type LoopWithCompiledCommand } from './compiled-command';
import {
  wf,
  mapOf,
  nodeById,
  composedBindings,
  compiledLoopPrompt,
  loopGroupNodes,
  inlinePrompt,
} from './include-expander.fixtures';

describe('expandWorkflowIncludes — included command compilation', () => {
  function blockWithCommand(): [WorkflowDefinition, WorkflowDefinition] {
    const block = wf('cmdblk', [
      { id: 'sib', bash: 'echo hi' },
      { id: 'runner', command: 'my-cmd', depends_on: ['sib'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'cmdblk' }]);
    return [block, parent];
  }

  test('materializes a block command and namespaces its local sibling ref', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Process the results from $sib.output and summarize.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(inlinePrompt(runner) ?? '').toBe(
      'Process the results from $inc__sib.output and summarize.'
    );
    expect(runner && 'command' in runner).toBe(false);
  });

  test('materializes a command body and binds its declared include input', () => {
    const [block, parent] = blockWithCommand();
    block.inputs = { scope: { required: true } };
    const includeNode = parent.nodes[0];
    if (includeNode && 'include' in includeNode) includeNode.with = { scope: 'prod' };
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Review scope $INPUTS.scope.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(inlinePrompt(runner) ?? '').toBe('Review scope prod.');
  });

  test('binds a declared include input named output in an ordinary command', () => {
    const [block, parent] = blockWithCommand();
    block.inputs = { output: { required: true } };
    const includeNode = parent.nodes[0];
    if (includeNode && 'include' in includeNode) includeNode.with = { output: 'bound value' };
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['my-cmd', 'Review $INPUTS.output.']])
    );
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(inlinePrompt(runner) ?? '').toBe('Review bound value.');
  });

  test('keeps a caller ref passed through a command input parent-scoped on id collision', () => {
    const block = wf('collision-command-block', [
      { id: 'gather', prompt: 'local gather' },
      { id: 'runner', command: 'collision-command', depends_on: ['gather'] },
    ]);
    block.inputs = { context: { required: true } };
    const parent = wf('parent', [
      { id: 'gather', prompt: 'parent gather' },
      {
        id: 'inc',
        include: 'collision-command-block',
        depends_on: ['gather'],
        with: { context: '$gather.output' },
      },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['collision-command', 'Review $INPUTS.context.']])
    );
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(inlinePrompt(runner) ?? '').toBe('Review $gather.output.');
  });

  test('treats canonical refs inside Markdown code as live and namespaces them', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Work from $ARTIFACTS_DIR only. See `$sib.output` in fenced docs.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(inlinePrompt(runner) ?? '').toContain('`$inc__sib.output`');
  });

  test('binds a declared include input inside a fenced block', () => {
    const [block, parent] = blockWithCommand();
    block.inputs = { scope: { required: true } };
    const includeNode = parent.nodes[0];
    if (includeNode && 'include' in includeNode) includeNode.with = { scope: 'prod' };
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Run this:\n\n```bash\necho "$INPUTS.scope"\n```\n'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(errors).toHaveLength(0);
    const runner = nodeById(workflows.get('parent')!, 'inc__runner');
    expect(inlinePrompt(runner) ?? '').toContain('echo "prod"');
  });

  test('rejects a command ref outside the included workflow namespace', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([
      ['my-cmd', 'Use $caller.output directly.'],
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain("included workflow 'cmdblk'");
    expect(message).toContain("node 'runner'");
    expect(message).toContain("command 'my-cmd'");
    expect(message).toContain("'$caller.output'");
    expect(message).toContain('inputs:');
    expect(message).toContain('with:');
  });

  test('rejects the same external command ref when the parent has a colliding id', () => {
    const [block] = blockWithCommand();
    const parent = wf('parent', [
      { id: 'caller', bash: 'echo parent' },
      { id: 'inc', include: 'cmdblk', depends_on: ['caller'] },
    ]);
    const result = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['my-cmd', 'Use $caller.output directly.']])
    );
    expect(result.workflows.has('parent')).toBe(false);
    expect(result.errors.find(error => error.filename === 'parent')?.error).toContain(
      "'$caller.output'"
    );
  });

  test('fails closed when the command body cannot be resolved', () => {
    const [block, parent] = blockWithCommand();
    const commandContents = new Map<string, string | null>([['my-cmd', null]]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent), commandContents);
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain("command 'my-cmd'");
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      'could not be resolved during composition'
    );
  });

  test('rejects an empty command body during composition', () => {
    const [block, parent] = blockWithCommand();
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['my-cmd', '  \n\t']])
    );
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain("command 'my-cmd' is empty");
    expect(message).toContain('non-whitespace prompt body');
  });

  // #2964 — a command node's own `with:` map is a RUNTIME channel: the executor resolves
  // it against sibling outputs and merges it over the run inputs into the `$INPUTS` bag.
  // Composition used to drop it while materializing the body, then report every name it
  // supplied as a missing caller input — advice no caller could follow, because the value
  // does not exist until a sibling three steps earlier has run.
  test('keeps a command node own with: binding through composition', () => {
    const block = wf('archon-deliver', [
      { id: 'pr', bash: 'echo open-pr' },
      {
        id: 'sync',
        command: 'sync-pr-body',
        depends_on: ['pr'],
        with: { pr_number: '$pr.output.number' },
      },
    ]);
    const parent = wf('archon-ship', [{ id: 'deliver', include: 'archon-deliver' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['sync-pr-body', 'Update PR $INPUTS.pr_number.']])
    );
    expect(errors).toHaveLength(0);
    const sync = nodeById(workflows.get('archon-ship')!, 'deliver__sync');
    // The token stays standing for the executor's own `$INPUTS` pass — splicing anything
    // here would freeze a value that only exists mid-run.
    expect(inlinePrompt(sync)).toBe('Update PR $INPUTS.pr_number.');
    // …and the binding survives with its producer ref namespaced into the flat DAG.
    expect(composedBindings(sync)).toEqual({ pr_number: '$deliver__pr.output.number' });
  });

  test('a command node own binding wins over a caller-supplied input of the same name', () => {
    const block = wf('bindblk', [
      { id: 'pr', bash: 'echo open-pr' },
      {
        id: 'sync',
        command: 'sync-cmd',
        depends_on: ['pr'],
        with: { pr_number: '$pr.output.number' },
      },
    ]);
    block.inputs = { pr_number: { default: '' } };
    const parent = wf('parent', [
      { id: 'inc', include: 'bindblk', with: { pr_number: 'caller value' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['sync-cmd', 'Update PR $INPUTS.pr_number.']])
    );
    expect(errors).toHaveLength(0);
    // Nearest source wins, matching the executor's merge order. Splicing the caller value
    // (or the empty default a block declares to get past the old check) would silently
    // hand the agent a value the author never meant it to read.
    expect(inlinePrompt(nodeById(workflows.get('parent')!, 'inc__sync'))).toBe(
      'Update PR $INPUTS.pr_number.'
    );
  });

  test('still reports a command input no binding and no caller supplies', () => {
    const block = wf('partialblk', [
      { id: 'pr', bash: 'echo open-pr' },
      {
        id: 'sync',
        command: 'partial-cmd',
        depends_on: ['pr'],
        with: { pr_number: '$pr.output.number' },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'partialblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['partial-cmd', 'Update PR $INPUTS.pr_number for $INPUTS.repo.']])
    );
    // The shield is per-name, not a blanket exemption for a node that binds anything.
    expect(workflows.has('parent')).toBe(false);
    const message = errors.find(error => error.filename === 'parent')?.error;
    expect(message).toContain('$INPUTS.repo');
    expect(message).not.toContain('$INPUTS.pr_number');
  });

  test('carries a surviving binding through two include levels', () => {
    const inner = wf('inner', [
      { id: 'pr', bash: 'echo open-pr' },
      {
        id: 'sync',
        command: 'nested-sync',
        depends_on: ['pr'],
        with: { pr_number: '$pr.output.number' },
      },
    ]);
    const middle = wf('middle', [{ id: 'deliver', include: 'inner' }]);
    const outer = wf('outer', [{ id: 'ship', include: 'middle' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(inner, middle, outer),
      new Map([['nested-sync', 'Update PR $INPUTS.pr_number.']])
    );
    expect(errors).toHaveLength(0);
    // The payload rides a symbol, which structuredClone drops — a miss in either the
    // clone or the walker works at one level and silently vanishes at two.
    const sync = nodeById(workflows.get('outer')!, 'ship__deliver__sync');
    expect(composedBindings(sync)).toEqual({ pr_number: '$ship__deliver__pr.output.number' });
  });

  test('rejects a caller ref forwarded into a binding that skips depends_on', () => {
    const block = wf('refblk', [{ id: 'sync', command: 'ref-cmd', with: { v: '$INPUTS.src' } }]);
    block.inputs = { src: { required: true } };
    // `other` is a real parent node, but nothing makes it run before the block.
    const parent = wf('parent', [
      { id: 'other', bash: 'echo x' },
      { id: 'inc', include: 'refblk', with: { src: '$other.output' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['ref-cmd', 'Use $INPUTS.v.']])
    );
    // The block was proven hermetic before the caller's value was inserted, so the scan
    // over the FLATTENED graph is the only one that can see this ref. Without it the
    // binding reaches the executor and fails the node mid-run instead of at load.
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "add 'other' to 'inc__sync'.depends_on"
    );
  });

  test('accepts the same forwarded ref when the include declares the dependency', () => {
    const block = wf('refblk-ok', [{ id: 'sync', command: 'ref-ok', with: { v: '$INPUTS.src' } }]);
    block.inputs = { src: { required: true } };
    const parent = wf('parent', [
      { id: 'other', bash: 'echo x' },
      { id: 'inc', include: 'refblk-ok', depends_on: ['other'], with: { src: '$other.output' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['ref-ok', 'Use $INPUTS.v.']])
    );
    expect(errors).toHaveLength(0);
    expect(composedBindings(nodeById(workflows.get('parent')!, 'inc__sync'))).toEqual({
      v: '$other.output',
    });
  });

  test('materializes loop.command and binds its declared include input', () => {
    const block = wf('loopblk', [
      { id: 'repeat', loop: { command: 'loop-cmd', until: 'DONE', max_iterations: 1 } },
    ]);
    block.inputs = { scope: { required: true } };
    const parent = wf('parent', [{ id: 'inc', include: 'loopblk', with: { scope: 'prod' } }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['loop-cmd', 'Review $INPUTS.scope.']])
    );
    expect(errors).toHaveLength(0);
    const repeat = nodeById(workflows.get('parent')!, 'inc__repeat');
    expect(compiledLoopPrompt(repeat)).toBe('Review prod.');
    expect(repeat && 'loop' in repeat ? repeat.loop.command : undefined).toBe('loop-cmd');
  });

  test('binds a declared include input named output in a loop command', () => {
    const block = wf('loop-output-block', [
      { id: 'repeat', loop: { command: 'loop-output-cmd', until: 'DONE', max_iterations: 1 } },
    ]);
    block.inputs = { output: { required: true } };
    const parent = wf('parent', [
      { id: 'inc', include: 'loop-output-block', with: { output: 'bound value' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['loop-output-cmd', 'Review $INPUTS.output.']])
    );
    expect(errors).toHaveLength(0);
    expect(compiledLoopPrompt(nodeById(workflows.get('parent')!, 'inc__repeat'))).toBe(
      'Review bound value.'
    );
  });

  test('keeps a whitespace-only loop command as an actionable compiled error', () => {
    const block = wf('empty-loop-block', [
      { id: 'repeat', loop: { command: 'empty-loop-cmd', until: 'DONE', max_iterations: 1 } },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'empty-loop-block' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['empty-loop-cmd', '  \n\t']])
    );
    expect(errors).toHaveLength(0);
    const repeat = nodeById(workflows.get('parent')!, 'inc__repeat');
    const compiled =
      repeat && 'loop' in repeat
        ? (repeat.loop as typeof repeat.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]
        : undefined;
    expect(compiled?.error).toContain("command 'empty-loop-cmd' is empty");
  });

  test('materializes a nested loop command and namespaces an enclosing top-level ref', () => {
    const block = wf('nested-loopblk', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'repeat',
              loop: { command: 'nested-loop-cmd', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'nested-loopblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['nested-loop-cmd', 'Read $seed.output and continue.']])
    );
    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'inc__group');
    const repeat = loopGroupNodes(group)?.[0];
    expect(compiledLoopPrompt(repeat)).toBe('Read $inc__seed.output and continue.');
  });

  test('materializes a command inside a second-level nested loop group', () => {
    const block = wf('deep-command-block', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'outer',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'inner',
              loop_group: {
                until: 'DONE',
                max_iterations: 1,
                nodes: [{ id: 'review', command: 'deep-command' }],
              },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'deep-command-block' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['deep-command', 'Read $seed.output and continue.']])
    );

    expect(errors).toHaveLength(0);
    const outer = nodeById(workflows.get('parent')!, 'inc__outer');
    const inner = loopGroupNodes(outer)?.[0];
    const review = loopGroupNodes(inner)?.[0];
    expect(inlinePrompt(review) ?? '').toBe('Read $inc__seed.output and continue.');
  });

  test('binds an include input in a nested loop command', () => {
    const block = wf('nested-input-loopblk', [
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'repeat',
              loop: { command: 'nested-input-cmd', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [
      { id: 'inc', include: 'nested-input-loopblk', with: { scope: 'prod' } },
    ]);
    block.inputs = { scope: { required: true } };
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['nested-input-cmd', 'Review $INPUTS.scope.']])
    );
    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'inc__group');
    const repeat = loopGroupNodes(group)?.[0];
    expect(compiledLoopPrompt(repeat)).toBe('Review prod.');
  });

  test('passes when a nested loop command file references a local body node', () => {
    const block = wf('nested-local-loopblk', [
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            { id: 'seed', bash: 'echo seed' },
            {
              id: 'repeat',
              loop: { command: 'nested-local-cmd', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'nested-local-loopblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['nested-local-cmd', 'Read $seed.output and continue.']])
    );
    expect(errors).toHaveLength(0);
    expect(workflows.has('parent')).toBe(true);
  });

  test('fails closed when no commandContents map is supplied', () => {
    const [block, parent] = blockWithCommand();
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('expandWorkflowIncludes — command bodies read include aliases and own bindings', () => {
  const leaf = (): WorkflowDefinition =>
    wf('open-pr', [
      { id: 'prep', bash: 'echo prep' },
      { id: 'open', bash: 'echo 42', depends_on: ['prep'] },
    ]);

  test('names the include primary sink in top-level command and loop.command bodies', () => {
    const block = wf('deliver', [
      { id: 'pr', include: 'open-pr' },
      { id: 'check', command: 'check-ci', depends_on: ['pr'] },
      {
        id: 'retry',
        depends_on: ['pr'],
        loop: { command: 'retry-ci', until: 'DONE', max_iterations: 1 },
      },
    ]);
    const parent = wf('ship', [{ id: 'deliver', include: 'deliver' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(leaf(), block, parent),
      new Map([
        ['check-ci', 'Check CI for $pr.output and PR $pr.output.number.'],
        ['retry-ci', 'Retry CI for $pr.output.'],
      ])
    );
    expect(errors).toEqual([]);
    const ship = workflows.get('ship')!;
    expect(inlinePrompt(nodeById(ship, 'deliver__check'))).toBe(
      'Check CI for $deliver__pr__open.output and PR $deliver__pr__open.output.number.'
    );
    expect(compiledLoopPrompt(nodeById(ship, 'deliver__retry'))).toBe(
      'Retry CI for $deliver__pr__open.output.'
    );
  });

  test('names enclosing and body-scoped include sinks in a loop-body command body', () => {
    const block = wf('deliver', [
      { id: 'pr', include: 'open-pr' },
      {
        id: 'fix',
        depends_on: ['pr'],
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [
            { id: 'p', include: 'open-pr' },
            { id: 'ci', command: 'check-ci', depends_on: ['p'] },
          ],
        },
      },
    ]);
    const parent = wf('ship', [{ id: 'deliver', include: 'deliver' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(leaf(), block, parent),
      new Map([['check-ci', 'PR $pr.output, this pass $p.output, last $LOOP_PREV.p__open.output.']])
    );
    expect(errors).toEqual([]);
    const ci = loopGroupNodes(nodeById(workflows.get('ship')!, 'deliver__fix'))?.find(
      node => node.id === 'ci'
    );
    expect(inlinePrompt(ci)).toBe(
      'PR $deliver__pr__open.output, this pass $p__open.output, last $LOOP_PREV.p__open.output.'
    );
  });

  test('shields a loop-body command own with: name from the caller', () => {
    const block = wf('deliver', [
      {
        id: 'fix',
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [
            { id: 'p', bash: 'echo 42' },
            { id: 'ci', command: 'check-ci', depends_on: ['p'], with: { bound: '$p.output' } },
          ],
        },
      },
    ]);
    const parent = wf('ship', [{ id: 'deliver', include: 'deliver' }]);
    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(block, parent),
      new Map([['check-ci', 'Check PR $INPUTS.bound.']])
    );
    expect(errors).toEqual([]);
    const ci = loopGroupNodes(nodeById(workflows.get('ship')!, 'deliver__fix'))?.find(
      node => node.id === 'ci'
    );
    expect(inlinePrompt(ci)).toBe('Check PR $INPUTS.bound.');
    expect(composedBindings(ci)).toEqual({ bound: '$p.output' });
  });
});

describe('nested command metadata', () => {
  test('preserves a nested compiled loop command across three-level composition', () => {
    const leaf = wf('leaf-loop', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'group',
        depends_on: ['seed'],
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [
            {
              id: 'repeat',
              loop: { command: 'leaf-loop-command', until: 'DONE', max_iterations: 1 },
            },
          ],
        },
      },
    ]);
    leaf.inputs = { context: { required: true } };
    const middle = wf('middle-loop', [
      { id: 'inner', include: 'leaf-loop', with: { context: 'bound value' } },
    ]);
    const parent = wf('parent', [{ id: 'outer', include: 'middle-loop' }]);

    const { workflows, errors } = expandWorkflowIncludes(
      mapOf(leaf, middle, parent),
      new Map([['leaf-loop-command', 'Use $seed.output with $INPUTS.context and continue.']])
    );

    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'outer__inner__group');
    const repeat = loopGroupNodes(group)?.[0];
    expect(compiledLoopPrompt(repeat)).toBe(
      'Use $outer__inner__seed.output with bound value and continue.'
    );
  });
});
