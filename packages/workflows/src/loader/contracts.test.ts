// @archon-test-isolated
import { clearRegistry, providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { describe, it, expect } from 'bun:test';
import { isAgentNode, isExecNode, workflowDefinitionSchema, type DagNode } from '../schemas';
import { parseWorkflow as parseWorkflowWithProviders, type ParseResult } from '../loader';
import { resolveWorkflow } from '../graph-plan';
import { findPreparedStrictSchemaIssues } from '@archon/provider-contract';
import { itemAsksJsonSchema, parseItemAsks, storedItemAskSchema } from '../schemas/item-ask';
import { itemWaitsJsonSchema } from '../schemas/item-wait';
import { validateWorkflowResultContract } from './contracts';
import { validateStructuredOutput } from '../structured-output';

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
// The result contract: returns: { node, outcome } (#2618, #5660)
// ---------------------------------------------------------------------------

describe('workflow result contract: returns.outcome', () => {
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
    const { workflow, error } = parseOutcomeWorkflow(
      'returns: { node: result, outcome: "  green  " }'
    );

    expect(error).toBeNull();
    expect(workflow?.returns).toBe('result');
    expect(workflow?.result).toEqual({ outcome: 'green' });
  });

  it('loads the shorthand and the object form without an outcome the same', () => {
    const shorthand = parseOutcomeWorkflow('returns: result');
    const object = parseOutcomeWorkflow('returns: { node: result }');

    expect(shorthand.error).toBeNull();
    expect(object.workflow).toEqual(shorthand.workflow);
    expect(object.workflow?.result).toBeUndefined();
  });

  it('accepts a required string property with an enum', () => {
    const { workflow, error } = parseOutcomeWorkflow(
      'returns: { node: result, outcome: stage }',
      `
    output_format:
      type: object
      properties:
        stage: { type: string, enum: [built, stop] }
      required: [stage]`
    );

    expect(error).toBeNull();
    expect(workflow?.result).toEqual({ outcome: 'stage' });
  });

  it('keeps the declaration through the published workflow schema', () => {
    const parsed = workflowDefinitionSchema.parse({
      name: 'authored-outcome',
      description: 'independently reports the authored verdict',
      nodes: [{ id: 'result', bash: 'true' }],
      returns: 'result',
      result: { outcome: 'green' },
    });

    expect(parsed.result).toEqual({ outcome: 'green' });
  });

  it('does not take the declaration from an authored result: key', () => {
    const { workflow, warnings } = parseOutcomeWorkflow(
      'returns: result\nresult: { outcome: green }'
    );

    expect(workflow?.result).toBeUndefined();
    expect(warnings?.join('\n')).toContain("'result'");
  });

  it.each([
    ['a string with no enum', '{ type: string }'],
    ['an enum of non-strings', '{ type: string, enum: [1, 2] }'],
  ])('refuses an outcome declared as %s', (_label, property) => {
    const { workflow, error } = parseOutcomeWorkflow(
      'returns: { node: result, outcome: stage }',
      `
    output_format:
      type: object
      properties:
        stage: ${property}
      required: [stage]`
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain('type: string with a non-empty enum of strings');
  });

  it('refuses an outcome enum with an empty-string member, naming workflow and node', () => {
    const { workflow, error } = parseOutcomeWorkflow(
      'returns: { node: result, outcome: stage }',
      `
    output_format:
      type: object
      properties:
        stage: { type: string, enum: ['', built] }
      required: [stage]`
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain("'authored-outcome'");
    expect(error?.error).toContain("node 'result'");
    expect(error?.error).toContain('empty string');
  });

  it('refuses the removed outcome_field, naming the declaration that replaces it', () => {
    const { workflow, error } = parseOutcomeWorkflow('returns: result\noutcome_field: green');

    expect(workflow).toBeNull();
    expect(error?.error).toContain("'outcome_field:' has been removed");
    expect(error?.error).toContain('returns: { node: <id>, outcome: <field> }');
  });

  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    for (const selector of ['loop', 'outcome']) {
      const parseSelected = (output_format: Record<string, unknown>, field = 'done') =>
        parseWorkflow(
          Bun.YAML.stringify({
            name: 'composed-selector',
            description: 'Composed boolean selector contract',
            ...(selector === 'outcome' ? { returns: { node: 'result', outcome: field } } : {}),
            nodes: [
              {
                id: 'result',
                ...(selector === 'loop'
                  ? { loop: { prompt: 'work', until_field: field, max_iterations: 2 } }
                  : { prompt: 'work' }),
                output_format,
              },
            ],
          }),
          'composed-selector.yaml'
        );
      const branch = {
        type: 'object',
        properties: { done: { type: 'boolean' } },
        required: ['done'],
      };
      it(`accepts required ${keyword} booleans for ${selector} selectors`, () => {
        for (const schema of [
          { [keyword]: [branch] },
          { type: 'object', properties: branch.properties, [keyword]: [{ required: ['done'] }] },
          {
            [keyword]: [
              { ...branch, properties: { done: { type: 'boolean', const: true } } },
              { ...branch, properties: { done: { type: 'boolean', const: false } } },
            ],
          },
          { allOf: [{ type: 'object', required: ['done'] }, { properties: branch.properties }] },
          { type: 'object', required: ['done'], [keyword]: [{ properties: branch.properties }] },
          {
            allOf: [
              { type: 'object' },
              { [keyword]: [{ properties: branch.properties, required: ['done'] }] },
            ],
          },
          {
            type: 'object',
            properties: { done: { [keyword]: [{ type: 'boolean' }] } },
            required: ['done'],
          },
        ]) {
          expect(parseSelected(schema).error).toBeNull();
        }
      });
      it(`handles boolean-schema branches in ${keyword} ${selector} selectors`, () => {
        const neutral = keyword === 'allOf';
        for (const schema of [
          { [keyword]: [branch, neutral] },
          {
            type: 'object',
            properties: branch.properties,
            [keyword]: [{ required: ['done'] }, neutral],
          },
          {
            type: 'object',
            required: ['done'],
            properties: { done: { [keyword]: [{ type: 'boolean' }, neutral] } },
          },
        ]) {
          expect(parseSelected(schema).error).toBeNull();
        }
      });
      if (keyword !== 'allOf') {
        it(`rejects unconstrained and union-typed ${keyword} ${selector} alternatives`, () => {
          for (const property of [{}, { type: ['boolean', 'string'] }]) {
            for (const schema of [
              { [keyword]: [branch, { ...branch, properties: { done: property } }] },
              { ...branch, properties: { done: { [keyword]: [{ type: 'boolean' }, property] } } },
              { allOf: [{ [keyword]: [branch, { ...branch, properties: { done: property } }] }] },
            ]) {
              const result = parseSelected(schema);
              expect(result.workflow).toBeNull();
              expect(result.error?.error).toContain('boolean');
            }
          }
          expect(parseSelected({ [keyword]: [branch, true] }).workflow).toBeNull();
          expect(parseSelected({ allOf: [branch, { [keyword]: [true, false] }] }).error).toBeNull();
        });
      }
      it(`rejects ${keyword} ${selector} selectors with type arrays excluding boolean`, () => {
        for (const type of [['string'], ['string', 'null']]) {
          for (const schema of [
            { ...branch, properties: { done: { type } }, [keyword]: [{}] },
            { [keyword]: [{ ...branch, properties: { done: { type } } }] },
            { ...branch, properties: { done: { [keyword]: [{ type }] } } },
          ]) {
            const result = parseSelected(schema);
            expect(result.workflow).toBeNull();
            expect(result.error?.error).toContain('boolean');
          }
        }
      });
      if (selector === 'loop' && keyword === 'allOf') {
        it('preserves plain type arrays and allOf type arrays that permit booleans', () => {
          for (const type of [['string'], ['boolean'], ['boolean', 'string']]) {
            expect(parseSelected({ ...branch, properties: { done: { type } } }).error).toBeNull();
          }
          for (const type of [['boolean'], ['boolean', 'string']]) {
            for (const schema of [
              { ...branch, properties: { done: { type } }, allOf: [{}] },
              { allOf: [{ ...branch, properties: { done: { type } } }] },
              { ...branch, properties: { done: { allOf: [{ type }] } } },
            ]) {
              expect(parseSelected(schema).error).toBeNull();
            }
          }
        });
      }
      it(`rejects optional, undeclared and non-boolean ${keyword} ${selector} selectors`, () => {
        const rejected: [Record<string, unknown>, string, string][] = [
          [{ [keyword]: [{ ...branch, required: [] }] }, 'done', 'required'],
          [{ [keyword]: [branch] }, 'missing', 'not declared'],
          [
            { [keyword]: [{ ...branch, properties: { done: { type: 'string' } } }] },
            'done',
            'boolean',
          ],
        ];
        if (keyword !== 'allOf') {
          rejected.push(
            [
              { [keyword]: [branch, { type: 'string' }] },
              'done',
              selector === 'outcome' ? 'object' : 'required',
            ],
            [{ [keyword]: [branch, { ...branch, required: [] }] }, 'done', 'required'],
            [
              { [keyword]: [branch, { ...branch, properties: { done: { type: 'string' } } }] },
              'done',
              'boolean',
            ]
          );
        }
        for (const [schema, field, message] of rejected) {
          const result = parseSelected(schema, field);
          expect(result.workflow).toBeNull();
          expect(result.error?.error).toContain(message);
        }
      });
    }
  }

  it.each([
    ['a blank outcome', 'returns: { node: result, outcome: "   " }'],
    ['a non-string outcome', 'returns: { node: result, outcome: { field: green } }'],
    ['no node', 'returns: { outcome: green }'],
    ['an unknown key', 'returns: { node: result, noticed: noticed }'],
  ])('refuses returns with %s instead of silently dropping it', (_label, declaration) => {
    const { workflow, error } = parseOutcomeWorkflow(declaration);

    expect(workflow).toBeNull();
    expect(error?.error).toContain("Invalid 'returns'");
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
      'returns: { node: result, outcome: green }',
      outputFormat
    );

    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain('returns.outcome');
  });

  it('rejects a fan-out workflow node because its runtime output is an aggregate array', () => {
    const { workflow, error } = parseWorkflow(
      `
name: fan-out-outcome
description: invalid direct outcome over child aggregates
returns: { node: work, outcome: green }
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
returns: { node: fan, outcome: green }
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
returns: { node: group, outcome: green }
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

describe('workflow result contract: returns.asks', () => {
  const parseAsks = (
    declaration: string,
    node = `
  - id: decide
    prompt: decide
    output_format:
      type: object
      properties:
        summary: { type: string }`
  ): ParseResult =>
    parseWorkflow(
      `
name: leaves-asks
description: leaves decisions for an operator
${declaration}
nodes:${node}
`,
      'leaves-asks.yaml'
    );

  it('loads a declared asks property, which the engine adds to the returns node when resolved', () => {
    const { workflow, error } = parseAsks('returns: { node: decide, asks: asks }');
    expect(error).toBeNull();
    expect(workflow?.result).toEqual({ asks: 'asks' });
    if (workflow === null) throw new Error('Expected the workflow to load');
    const resolved = resolveWorkflow(workflow);
    const node = resolved.nodes.find(candidate => candidate.id === 'decide');
    expect(node?.output_format?.properties).toEqual({
      summary: { type: 'string' },
      asks: itemAsksJsonSchema(),
    });
    // The resolved workflow passes the contract again, as dispatch checks it.
    expect(validateWorkflowResultContract(resolved)).toBeNull();
    // The loaded definition is left as authored.
    const authored = workflow.nodes[0];
    const authoredFormat = authored && 'output_format' in authored ? authored.output_format : {};
    expect(Object.keys(authoredFormat?.properties ?? {})).toEqual(['summary']);
  });

  it('takes an ask with a null recommendation, and its schema stays strict-mode ready', () => {
    const ask = {
      question: 'Which way?',
      context: 'Nothing settles it.',
      options: [
        { id: 'drop', does: 'Drops it.', cost: 'The work is lost.' },
        { id: 'reshape', does: 'Plans it again.', cost: 'A round.' },
      ],
      recommendation: null,
      artifacts: [],
    };
    expect(parseItemAsks([ask])).toEqual({ asks: [ask] });
    expect(parseItemAsks([{ ...ask, recommendation: { option: 'keep', why: 'x' } }])).toEqual({
      problem: "[0].recommendation.option names 'keep', which is not one of the ask's options",
    });
    expect(findPreparedStrictSchemaIssues(itemAsksJsonSchema())).toEqual([]);
  });

  it('opens an ask that recommends no option with no recommendation and the reason beside it', () => {
    const ask = {
      question: 'Which way?',
      context: 'Nothing settles it.',
      options: [
        { id: 'drop', does: 'Drops it.', cost: 'The work is lost.' },
        { id: 'reshape', does: 'Plans it again.', cost: 'A round.' },
      ],
      recommendation: { option: null, why: 'Only you can weigh the deadline.' },
      artifacts: [],
    };
    // Stored with `recommendation: null`, so a binary that reads a recommendation as always
    // naming an option still reads the ask, and the reason in its own key.
    const opened = { ...ask, recommendation: null, no_recommendation: ask.recommendation.why };
    expect(parseItemAsks([ask])).toEqual({ asks: [opened] });
    expect(storedItemAskSchema.safeParse(opened).success).toBe(true);
  });

  it('refuses a property the author declared under the asks name', () => {
    const { workflow, error } = parseAsks(
      'returns: { node: decide, asks: asks }',
      `
  - id: decide
    prompt: decide
    output_format:
      type: object
      properties:
        asks: { type: array }`
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain("returns.asks: 'asks' on node 'decide'");
    expect(error?.error).toContain('the engine defines this property');
  });

  it('refuses a returns node with no output_format', () => {
    const { error } = parseAsks(
      'returns: { node: decide, asks: asks }',
      `
  - id: decide
    prompt: decide`
    );
    expect(error?.error).toContain("returns.asks: 'asks' selects node 'decide'");
    expect(error?.error).toContain('no output_format');
  });

  it('refuses asks naming the outcome property', () => {
    const { error } = parseAsks(
      'returns: { node: decide, outcome: green, asks: green }',
      `
  - id: decide
    prompt: decide
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]`
    );
    expect(error?.error).toContain(
      "returns.asks: 'green' names the same property as returns.outcome"
    );
  });

  it('refuses a loop_group returns node, as returns.outcome does', () => {
    const { error } = parseAsks(
      'returns: { node: group, asks: asks }',
      `
  - id: group
    output_format:
      type: object
      properties: {}
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: author
          prompt: author a result`
    );
    expect(error?.error).toContain("returns.asks: 'asks' cannot select loop_group node 'group'");
  });
});

describe('workflow result contract: returns.options', () => {
  const OPTIONS = `[
      { id: send-back, does: The builder continues., cost: A round. },
      { id: take-as-is, does: The change goes on as it is., cost: Nothing more is built. }
    ]`;
  const parse = (returns: string): ParseResult =>
    parseWorkflow(
      `
name: declares-options
description: every ask offers the same options
returns: ${returns}
nodes:
  - id: decide
    prompt: decide
    output_format:
      type: object
      properties:
        summary: { type: string }
`,
      'declares-options.yaml'
    );
  const ask = {
    question: 'Which way?',
    context: 'Nothing settles it.',
    recommendation: { option: 'take-as-is', why: 'It is done.' },
    artifacts: [],
  };

  it('gives the agent a schema with no options and a recommendation limited to the declared ids', () => {
    const { workflow, error } = parse(`{ node: decide, asks: asks, options: ${OPTIONS} }`);
    expect(error).toBeNull();
    if (workflow === null) throw new Error('Expected the workflow to load');
    const declared = workflow.result?.options ?? [];
    expect(declared.map(option => option.id)).toEqual(['send-back', 'take-as-is']);
    const resolved = resolveWorkflow(workflow);
    expect(validateWorkflowResultContract(resolved)).toBeNull();
    const schema = resolved.nodes.find(node => node.id === 'decide')?.output_format;
    if (schema === undefined) throw new Error('Expected an output_format');
    expect(findPreparedStrictSchemaIssues(itemAsksJsonSchema(declared))).toEqual([]);

    const check = (asks: unknown[]) => validateStructuredOutput({ summary: 's', asks }, schema);
    const errors = (asks: unknown[]) => {
      const result = check(asks);
      return result.valid ? [] : result.errors;
    };
    expect(check([ask])).toEqual({ valid: true });
    expect(check([{ ...ask, recommendation: null }])).toEqual({ valid: true });
    // Both refusals name the declared ids, so a retry can correct the output. Options the
    // writer added are refused whether the recommendation is valid or null.
    const namesDeclaredIds = expect.stringMatching(/^\/asks\/0.*send-back.*take-as-is/);
    expect(errors([{ ...ask, recommendation: { option: 'drop', why: 'x' } }])).toContainEqual(
      namesDeclaredIds
    );
    for (const recommendation of [ask.recommendation, null])
      expect(errors([{ ...ask, recommendation, options: declared }])).toEqual([namesDeclaredIds]);

    // At run end each ask gets the declared options, with does and cost from the YAML.
    expect(parseItemAsks([ask], declared)).toEqual({
      asks: [{ ...ask, options: declared }],
    });
  });

  it.each([
    ['without asks', `{ node: decide, options: ${OPTIONS} }`],
    ['with one option', '{ node: decide, asks: asks, options: [{ id: land, does: d, cost: c }] }'],
    [
      'with an id twice',
      '{ node: decide, asks: asks, options: [{ id: land, does: d, cost: c }, { id: land, does: d, cost: c }] }',
    ],
    [
      'with the reserved other',
      '{ node: decide, asks: asks, options: [{ id: land, does: d, cost: c }, { id: other, does: d, cost: c }] }',
    ],
    [
      'with an option missing its cost',
      '{ node: decide, asks: asks, options: [{ id: land, does: d }, { id: drop, does: d, cost: c }] }',
    ],
  ])('refuses options %s', (_case, returns) => {
    // The same workflow loads with a valid set (the test above), so the options are why.
    const { workflow, error } = parse(returns);
    expect(workflow).toBeNull();
    expect(error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Declared contract schemas compile at load time (#2453)
// ---------------------------------------------------------------------------

describe('workflow result contract: returns.waits', () => {
  const parse = (declaration: string, properties = 'summary: { type: string }'): ParseResult =>
    parseWorkflow(
      `
name: waits-outside
description: waits for checks on its change
${declaration}
nodes:
  - id: host
    prompt: read the change
    output_format:
      type: object
      properties:
        ${properties}
`,
      'waits-outside.yaml'
    );

  it('loads a declared waits property, which the engine adds beside the asks property', () => {
    const { workflow, error } = parse('returns: { node: host, asks: asks, waits: waits }');
    expect(error).toBeNull();
    expect(workflow?.result).toEqual({ asks: 'asks', waits: 'waits' });
    if (workflow === null) throw new Error('Expected the workflow to load');
    const resolved = resolveWorkflow(workflow);
    const node = resolved.nodes.find(candidate => candidate.id === 'host');
    expect(node?.output_format?.properties).toEqual({
      summary: { type: 'string' },
      asks: itemAsksJsonSchema(),
      waits: itemWaitsJsonSchema(),
    });
    expect(node?.output_format?.required).toEqual(['asks', 'waits']);
    expect(validateWorkflowResultContract(resolved)).toBeNull();
  });

  it('refuses an authored waits property and waits naming the asks property', () => {
    expect(
      parse('returns: { node: host, waits: waits }', 'waits: { type: array }').error?.error
    ).toContain("returns.waits: 'waits' on node 'host': the engine defines this property");
    expect(parse('returns: { node: host, asks: next, waits: next }').error?.error).toContain(
      "returns.waits: 'next' names the same property as returns.asks"
    );
  });
});

describe('workflow result contract: returns.ends, observes and returns.summary', () => {
  const parse = (
    declaration: string,
    properties = `stage: { type: string, enum: [approve, replan, landed] }
        why: { type: string }`,
    required = 'stage'
  ): ParseResult =>
    parseWorkflow(
      `
name: deliver
description: delivers a change
${declaration}
nodes:
  - id: result
    prompt: report
    output_format:
      type: object
      properties:
        ${properties}
      required: [${required}]
`,
      'deliver.yaml'
    );

  it('loads finishing outcomes of an enum and a declared string summary', () => {
    const { workflow, error } = parse(
      'returns: { node: result, outcome: stage, ends: [landed], summary: why }'
    );
    expect(error).toBeNull();
    expect(workflow?.result).toEqual({ outcome: 'stage', ends: ['landed'], summary: 'why' });
  });

  it('loads observes: true on a workflow', () => {
    const { workflow, error } = parse('observes: true\nreturns: { node: result, outcome: stage }');
    expect(error).toBeNull();
    expect(workflow?.observes).toBe(true);
  });

  it('refuses returns.final, naming both declarations that replace it', () => {
    const message = parse('returns: { node: result, outcome: stage, final: [landed] }').error
      ?.error;
    expect(message).toContain('returns.final was removed');
    expect(message).toContain('returns.ends');
    expect(message).toContain('observes: true');
  });

  it('refuses an observing workflow that ends its item', () => {
    expect(
      parse('observes: true\nreturns: { node: result, outcome: stage, ends: [landed] }').error
        ?.error
    ).toContain('both observes: true and returns.ends');
  });

  it('takes the boolean form by its outcome names', () => {
    const { error } = parse(
      'returns: { node: result, outcome: green, ends: [succeeded] }',
      'green: { type: boolean }',
      'green'
    );
    expect(error).toBeNull();
  });

  it.each([
    ['a value the outcome cannot take', 'outcome: stage, ends: [merged]', "names 'merged'"],
    ['a value named twice', 'outcome: stage, ends: [landed, landed]', "'landed' twice"],
    ['ends without an outcome', 'ends: [landed]', 'needs returns.outcome'],
    ['an undeclared summary', 'outcome: stage, summary: reason', "returns.summary: 'reason'"],
    [
      'a summary that is not a string',
      'outcome: stage, summary: stage',
      "returns.summary: 'stage'",
    ],
  ])('refuses %s', (_, declaration, message) => {
    expect(parse(`returns: { node: result, ${declaration} }`).error?.error).toContain(message);
  });
});

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
