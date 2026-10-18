// @archon-test-isolated
import { clearRegistry, providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { describe, it, expect } from 'bun:test';
import { isAgentNode, isExecNode, type DagNode } from '../schemas';
import { parseWorkflow as parseWorkflowWithProviders, type ParseResult } from '../loader';

// Bootstrap provider registry (needed by isRegisteredProvider checks at load time)
clearRegistry();
registerBuiltinProviders();

function parseWorkflow(
  content: string,
  filename: string,
  configuredEnvNames?: ReadonlySet<string>
): ParseResult {
  return parseWorkflowWithProviders(content, filename, providerRegistry, configuredEnvNames);
}

// ---------------------------------------------------------------------------
// Authored workflow outcome (#2618)
// ---------------------------------------------------------------------------

describe('workflow authored outcome declaration (#2618)', () => {
  const parseOutcomeWorkflow = (
    declaration: string,
    outputFormat = `
    output_format:
      type: object
      properties:
        green:
          type: boolean
      required: [green]`
  ): ReturnType<typeof parseWorkflow> =>
    parseWorkflow(
      `
name: authored-outcome
description: independently reports the authored verdict
${declaration}
nodes:
  - id: result
    prompt: report the verdict${outputFormat}
`,
      'authored-outcome.yaml'
    );

  it('accepts a trimmed field naming a required boolean on the selected return node', () => {
    const { workflow, error } = parseOutcomeWorkflow('returns: result\noutcome_field: "  green  "');

    expect(error).toBeNull();
    expect(workflow?.returns).toBe('result');
    expect(workflow?.outcome_field).toBe('green');
  });

  it('rejects outcome_field without an explicit returns node', () => {
    const { workflow, error } = parseOutcomeWorkflow('outcome_field: green');

    expect(workflow).toBeNull();
    expect(error?.error).toContain('without returns:');
  });

  it.each([
    ['blank', 'returns: result\noutcome_field: "   "'],
    ['non-string', 'returns: result\noutcome_field: { field: green }'],
  ])('rejects a %s outcome_field instead of silently dropping it', (_label, declaration) => {
    const { workflow, error } = parseOutcomeWorkflow(declaration);

    expect(workflow).toBeNull();
    expect(error?.error).toContain("Invalid 'outcome_field'");
  });

  it.each([
    ['no output_format', ''],
    [
      'undeclared property',
      `
    output_format:
      type: object
      properties:
        ready: { type: boolean }
      required: [ready]`,
    ],
    [
      'optional property',
      `
    output_format:
      type: object
      properties:
        green: { type: boolean }`,
    ],
    [
      'non-boolean property',
      `
    output_format:
      type: object
      properties:
        green: { type: string }
      required: [green]`,
    ],
    [
      'non-object root schema',
      `
    output_format:
      type: string
      properties:
        green: { type: boolean }
      required: [green]`,
    ],
  ])('rejects an outcome field with %s', (_label, outputFormat) => {
    const { workflow, error } = parseOutcomeWorkflow(
      'returns: result\noutcome_field: green',
      outputFormat
    );

    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain('outcome_field');
  });

  it('rejects a fan-out workflow node because its runtime output is an aggregate array', () => {
    const { workflow, error } = parseWorkflow(
      `
name: fan-out-outcome
description: invalid direct outcome over child aggregates
returns: work
outcome_field: green
nodes:
  - id: plan
    prompt: emit tasks
    output_format:
      type: object
      properties:
        tasks:
          type: array
          items: { type: string }
      required: [tasks]
  - id: work
    workflow: child-workflow
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
`,
      'fan-out-outcome.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain('fan-out workflow node');
    expect(error?.error).toContain('collector node');
  });

  it('rejects a composed fan-out node because its runtime output is an aggregate array', () => {
    const { workflow, error } = parseWorkflow(
      `
name: compose-fan-out-outcome
description: invalid direct outcome over an in-parent instance aggregate
returns: fan
outcome_field: green
nodes:
  - id: fan
    include: some-block
    fan_out:
      items: "['a']"
      as: item
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]
`,
      'compose-fan-out-outcome.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain('composed fan-out node');
    expect(error?.error).toContain('collector node');
  });

  it('rejects a loop_group because its declared output format is ignored at runtime', () => {
    const { workflow, error } = parseWorkflow(
      `
name: loop-group-outcome
description: invalid outcome over a raw loop group result
returns: group
outcome_field: green
nodes:
  - id: group
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: author
          prompt: author a result
`,
      'loop-group-outcome.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain('loop_group');
    expect(error?.error).toContain('raw text');
    expect(error?.error).toContain('collector node');
  });
});

// ---------------------------------------------------------------------------
// Declared contract schemas compile at load time (#2453)
// ---------------------------------------------------------------------------

describe('output_format compiles at load time (#2453)', () => {
  it('rejects output_format on a workflow: node, naming the child returns: node as the owner', () => {
    const { workflow, error } = parseWorkflow(
      `
name: caller-schema
description: the caller repeats a contract the child already owns
nodes:
  - id: sub
    workflow: child-workflow
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]
`,
      'caller-schema.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toBe(
      "Node 'sub' declares output_format on a workflow: node; the result contract belongs to the child's returns: node — declare it there"
    );
  });

  it('rejects an output_format ajv cannot compile, naming the node', () => {
    const { workflow, error } = parseWorkflow(
      `
name: broken-contract
description: declares a contract that can never be enforced
nodes:
  - id: plan
    prompt: emit the plan result
    output_format:
      type: object
      properties:
        ready:
          $ref: "#/$defs/missing"
`,
      'broken-contract.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain("Node 'plan' declares an output_format that cannot be compiled");
    expect(error?.error).toContain('missing');
  });

  it('does not compile the inert output_format on a loop_group itself', () => {
    // The group's own schema governs nothing (warned and ignored), so a dangling $ref
    // there must not reject the file; only enforced schemas are compiled at load.
    const result = parseWorkflow(
      `
name: inert-group-schema
description: A loop_group whose own schema is inert
nodes:
  - id: group
    output_format:
      type: object
      properties: { done: { $ref: '#/$defs/missing' } }
    loop_group:
      until_bash: exit 0
      max_iterations: 1
      nodes:
        - id: work
          bash: echo done
`,
      'inert-group-schema.yaml'
    );
    expect(result.error).toBeNull();
    expect(result.workflow?.nodes).toHaveLength(1);
  });

  it('rejects an uncompilable output_format on a loop_group body node', () => {
    const { workflow, error } = parseWorkflow(
      `
name: broken-body-contract
description: a body node runs its own turn, so its schema must compile too
nodes:
  - id: refine
    loop_group:
      max_iterations: 2
      until: "$check.output.done == true"
      nodes:
        - id: check
          prompt: judge the work
          output_format:
            type: object
            properties:
              done:
                $ref: "#/$defs/nope"
`,
      'broken-body-contract.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain(
      "Node 'check' declares an output_format that cannot be compiled"
    );
  });

  it('still loads a schema carrying tolerated annotations and unknown formats', () => {
    const { workflow, error } = parseWorkflow(
      `
name: annotated-contract
description: ajv stays strict:false, so annotations are not errors
nodes:
  - id: plan
    prompt: emit the plan result
    output_format:
      type: object
      title: Plan result
      x-archon-note: an annotation ajv does not know
      properties:
        ready: { type: boolean }
        when: { type: string, format: not-a-known-format }
      required: [ready]
`,
      'annotated-contract.yaml'
    );

    expect(error).toBeNull();
    const annotated = (workflow?.nodes as DagNode[] | undefined)?.[0];
    expect(annotated !== undefined && isAgentNode(annotated)).toBe(true);
    if (annotated === undefined || !isAgentNode(annotated)) throw new Error('unreachable');
    expect(annotated.output_format).toBeDefined();
  });

  it('leaves a schemaless node untouched', () => {
    const { workflow, error } = parseWorkflow(
      `
name: schemaless
description: no declared contract, nothing to compile
nodes:
  - id: run
    bash: echo hi
`,
      'schemaless.yaml'
    );

    expect(error).toBeNull();
    const schemaless = (workflow?.nodes as DagNode[] | undefined)?.[0];
    expect(schemaless !== undefined && isExecNode(schemaless)).toBe(true);
    if (schemaless === undefined || !isExecNode(schemaless)) throw new Error('unreachable');
    expect(schemaless.output_format).toBeUndefined();
  });
});

describe('loop_group prose completion with structured terminal output (#2998)', () => {
  function parseGroup(outputFormat?: Record<string, unknown>, untilBash?: string): ParseResult {
    return parseWorkflow(
      Bun.YAML.stringify({
        name: 'structured-group',
        description: 'test',
        nodes: [
          {
            id: 'refine',
            loop_group: {
              until: 'DONE',
              ...(untilBash === undefined ? {} : { until_bash: untilBash }),
              max_iterations: 3,
              nodes: [
                { id: 'work', prompt: 'work' },
                {
                  id: 'review',
                  depends_on: ['work'],
                  prompt: 'review',
                  ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
                },
              ],
            },
          },
        ],
      }),
      'structured-group.yaml'
    );
  }

  it('rejects an object terminal schema when until is the sole completion channel', () => {
    const result = parseGroup({ type: 'object', properties: { done: { type: 'boolean' } } });
    expect(result.workflow).toBeNull();
    expect(result.error?.errorType).toBe('validation_error');
    expect(result.error?.error).toContain("'refine'");
    expect(result.error?.error).toContain("'review'");
    expect(result.error?.error).toContain('serialized structured output');
    expect(result.error?.error).toContain('until_bash');
    expect(result.error?.error).toContain('structured field');
  });

  it.each([
    { type: 'array' },
    { type: 'number' },
    { type: 'integer' },
    { type: 'boolean' },
    { type: 'null' },
    { type: ['object', 'null'] },
  ])('rejects a non-string terminal schema: %j', schema => {
    expect(parseGroup(schema).error?.errorType).toBe('validation_error');
  });

  it.each([{}, { type: ['string', 'object'] }])(
    'accepts a schema that permits string output: %j',
    schema => {
      expect(parseGroup(schema).error).toBeNull();
    }
  );

  it('judges the node a terminal gate reads past to (#4043)', () => {
    const result = parseWorkflow(
      Bun.YAML.stringify({
        name: 'structured-group-gate',
        description: 'test',
        nodes: [
          {
            id: 'refine',
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              nodes: [
                {
                  id: 'work',
                  prompt: 'work',
                  output_format: { type: 'object', properties: { done: { type: 'boolean' } } },
                },
                { id: 'ask', depends_on: ['work'], approval: { message: 'ok?' } },
              ],
            },
          },
        ],
      }),
      'structured-group-gate.yaml'
    );
    expect(result.error?.error).toContain("node 'work', which the group's output is read from");
  });

  it('judges every node a terminal gate reads past to (#4043)', () => {
    const result = parseWorkflow(
      Bun.YAML.stringify({
        name: 'structured-group-gate-fan-in',
        description: 'test',
        nodes: [
          {
            id: 'refine',
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              nodes: [
                { id: 'notes', prompt: 'notes' },
                {
                  id: 'work',
                  prompt: 'work',
                  output_format: { type: 'object', properties: { done: { type: 'boolean' } } },
                },
                { id: 'ask', depends_on: ['notes', 'work'], approval: { message: 'ok?' } },
              ],
            },
          },
        ],
      }),
      'structured-group-gate-fan-in.yaml'
    );
    expect(result.error?.error).toContain("node 'work', which the group's output is read from");
  });

  it('accepts a terminal node without output_format', () => {
    expect(parseGroup().error).toBeNull();
  });

  it('accepts a string terminal schema', () => {
    expect(parseGroup({ type: 'string' }).error).toBeNull();
  });

  it('accepts an object terminal schema with until_bash and retains the deprecation warning', () => {
    const result = parseGroup(
      { type: 'object', properties: { done: { type: 'boolean' } } },
      'exit 0'
    );
    expect(result.error).toBeNull();
    expect(
      result.warnings?.some(w => w.includes("'loop_group.until' completion signal is deprecated"))
    ).toBe(true);
  });
});
