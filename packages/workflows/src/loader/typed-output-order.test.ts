import { describe, expect, test } from 'bun:test';
import { expandWorkflowIncludes } from '../include-expander';
import { mapOf, wf } from '../include-expander.fixtures';
import { dagNodeSchema } from '../schemas';
import { validateTypedOutputOrder } from './typed-output-order';

const VERDICT = { output_type: 'verdict', output_format: { type: 'object' } };
const READS = { verdicts: { outputs: 'verdict' } };

function reader(dependsOn: string[]): Record<string, unknown> {
  return { id: 'read', script: 'read', runtime: 'bun', depends_on: dependsOn, with: READS };
}

function loop(id: string, nodes: unknown[], dependsOn: string[] = []): Record<string, unknown> {
  return {
    id,
    depends_on: dependsOn,
    loop_group: { until_bash: 'true', max_iterations: 2, nodes },
  };
}

describe('typed-outputs binding order', () => {
  test('accepts producers the reader depends on, directly, transitively or through a loop', () => {
    const { nodes } = wf('ordered', [
      { id: 'first', bash: 'echo {}', ...VERDICT },
      { id: 'between', bash: 'echo', depends_on: ['first'] },
      loop('rounds', [{ id: 'judge', bash: 'echo {}', ...VERDICT }], ['between']),
      reader(['rounds']),
    ]);

    expect(validateTypedOutputOrder(nodes)).toBeNull();
  });

  test('refuses a producer the reader could race, naming the edge to add', () => {
    const { nodes } = wf('racing', [
      { id: 'first', bash: 'echo {}', ...VERDICT },
      { id: 'late', bash: 'echo {}', ...VERDICT },
      reader(['first']),
    ]);

    expect(validateTypedOutputOrder(nodes)).toBe(
      "Node 'read' binding 'with.verdicts' reads every 'verdict' output, but its producer 'late' is not an upstream dependency — add 'late' to 'read'.depends_on so the output is recorded first"
    );
  });

  test('names the loop to depend on when the unordered producer is inside one', () => {
    const { nodes } = wf('racing-loop', [
      loop('rounds', [{ id: 'judge', bash: 'echo {}', ...VERDICT }]),
      reader([]),
    ]);

    expect(validateTypedOutputOrder(nodes)).toContain(
      "its producer 'judge' (inside 'rounds') is not an upstream dependency — add 'rounds' to 'read'.depends_on"
    );
  });

  test('orders a reader in a loop body against producers in its own body and outside the loop', () => {
    const body = (dependsOn: string[]): unknown[] => [
      { id: 'judge', bash: 'echo {}', ...VERDICT },
      reader(dependsOn),
    ];
    const outside = { id: 'first', bash: 'echo {}', ...VERDICT };

    expect(
      validateTypedOutputOrder(
        wf('in-body', [outside, loop('rounds', body(['judge']), ['first'])]).nodes
      )
    ).toBeNull();
    expect(
      validateTypedOutputOrder(
        wf('body-race', [outside, loop('rounds', body([]), ['first'])]).nodes
      )
    ).toContain("add 'judge' to 'read'.depends_on");
    expect(
      validateTypedOutputOrder(wf('outer-race', [outside, loop('rounds', body(['judge']))]).nodes)
    ).toContain("add 'first' to 'rounds'.depends_on");
  });

  test('refuses a producer that is the loop enclosing the reader', () => {
    const { nodes } = wf('enclosing', [{ ...loop('rounds', [reader([])]), ...VERDICT }]);

    expect(validateTypedOutputOrder(nodes)).toContain(
      "'rounds' produces one and encloses that node"
    );
  });

  test('a producer inside an included block is checked once the block is flattened', () => {
    const block = wf('block', [{ id: 'judge', bash: 'echo {}', ...VERDICT }]);
    const racing = wf('racing', [{ id: 'review', include: 'block' }, reader([])]);
    const ordered = wf('ordered', [{ id: 'review', include: 'block' }, reader(['review'])]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, racing, ordered));

    expect(workflows.has('ordered')).toBe(true);
    expect(errors.map(error => error.error).join('\n')).toContain(
      "its producer 'review__judge' is not an upstream dependency — add 'review__judge' to 'read'.depends_on"
    );
  });
});

describe('typed-outputs binding shape', () => {
  /** The load errors of a node that binds `verdicts` to `binding`. */
  function load(binding: unknown, node: object = { script: 'read', runtime: 'bun' }): string {
    const parsed = dagNodeSchema.safeParse({ id: 'read', ...node, with: { verdicts: binding } });
    return parsed.success ? '' : parsed.error.issues.map(issue => issue.message).join('\n');
  }

  test('accepts exactly { outputs: <type> } on a script node', () => {
    expect(load({ outputs: 'verdict' })).toBe('');
    expect(load({ outputs: 'verdict', latest: true })).toContain(
      "a typed-outputs binding must be exactly { outputs: '<output_type>' }"
    );
    expect(load({ outputs: '' })).toContain("'outputs' must be a non-empty output_type");
  });

  test('refuses it on a command node, naming the channel an agent reads', () => {
    expect(load({ outputs: 'verdict' }, { command: 'review' })).toContain(
      'is only supported on script nodes; a command reads typed outputs through $TYPED_ARTIFACTS_FILE'
    );
  });
});
