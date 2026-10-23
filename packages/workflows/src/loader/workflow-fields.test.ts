// @archon-test-isolated
import { mockLogger, parseWorkflow, parseWorkflowYaml } from './test-utils';
import { describe, it, expect } from 'bun:test';
import { KNOWN_WORKFLOW_KEYS, workflowContainerPolicySchema } from '../schemas/workflow';
import type { WorkflowDefinition } from '../schemas/workflow';
import { parseContainerPolicy } from './workflow-fields';

// ---------------------------------------------------------------------------
// Workflow signature: inputs / returns (#2470)
// ---------------------------------------------------------------------------

describe('workflow signature: inputs / returns (#2470)', () => {
  it('parses declared inputs and returns', () => {
    const { workflow, error } = parseWorkflow(
      `
name: sig
description: signature block
returns: build
inputs:
  diff:
    required: true
    description: the diff to review
  style:
    default: strict
nodes:
  - id: build
    prompt: "do it with $INPUTS.diff and $INPUTS.style"
`,
      'sig.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.returns).toBe('build');
    expect(workflow?.inputs?.diff?.required).toBe(true);
    expect(workflow?.inputs?.style?.default).toBe('strict');
  });

  it('rejects returns naming a non-existent top-level node', () => {
    const { workflow, error } = parseWorkflow(
      `
name: bad-returns
description: returns names nothing
returns: nope
nodes:
  - id: build
    prompt: "hi"
`,
      'bad-returns.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain("returns: 'nope'");
  });

  it('rejects an empty returns value instead of falling back to a positional sink', () => {
    const { workflow, error } = parseWorkflow(
      `
name: empty-returns
description: invalid empty selector
returns: "   "
nodes:
  - id: build
    prompt: "hi"
`,
      'empty-returns.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain("Invalid 'returns'");
  });

  it('rejects a non-string returns value instead of falling back to a positional sink', () => {
    const { workflow, error } = parseWorkflow(
      `
name: object-returns
description: invalid object selector
returns: { node: build }
nodes:
  - id: build
    prompt: "hi"
`,
      'object-returns.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain("Invalid 'returns'");
  });

  it('drops a contradictory required+default input (warn-and-drop)', () => {
    const { workflow, error } = parseWorkflow(
      `
name: contradiction
description: required and default together
inputs:
  x:
    required: true
    default: v
nodes:
  - id: build
    prompt: "hi"
`,
      'contradiction.yaml'
    );
    expect(error).toBeNull();
    // The single contradictory key is dropped, leaving no inputs.
    expect(workflow?.inputs).toBeUndefined();
  });

  it('drops an invalid input name with a warning while preserving the workflow', () => {
    mockLogger.warn.mockClear();
    const { workflow, error } = parseWorkflow(
      `
name: invalid-input-name
description: invalid input name
inputs:
  bad.name:
    default: value
nodes:
  - id: build
    prompt: "hi"
`,
      'invalid-input-name.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.inputs).toBeUndefined();
    expect(mockLogger.warn.mock.calls.map(call => call[1])).toContain(
      'invalid_workflow_input_name_ignored'
    );
  });

  it('ignores a non-object inputs block with a warning while preserving the workflow', () => {
    mockLogger.warn.mockClear();
    const { workflow, error } = parseWorkflow(
      `
name: invalid-inputs-block
description: invalid inputs block
inputs: [wrong]
nodes:
  - id: build
    prompt: "hi"
`,
      'invalid-inputs-block.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.inputs).toBeUndefined();
    expect(mockLogger.warn.mock.calls.map(call => call[1])).toContain(
      'invalid_workflow_inputs_block_ignored'
    );
  });

  it('rejects two input names that mangle to the same env key', () => {
    const { workflow, error } = parseWorkflow(
      `
name: collide
description: env-key collision
inputs:
  foo-bar:
    description: hyphen form
  foo_bar:
    description: underscore form
nodes:
  - id: build
    prompt: "hi"
`,
      'collide.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain('INPUTS_FOO_BAR');
  });

  it('flags a dangling $node.output ref inside a workflow: with value', () => {
    const { workflow, error } = parseWorkflow(
      `
name: with-ref
description: with value references an unknown node
nodes:
  - id: sub
    workflow: child-wf
    with:
      plan: "$nosuch.output"
`,
      'with-ref.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain('nosuch');
  });
});

// ---------------------------------------------------------------------------
// Workflow-level field parity (#2457)
// ---------------------------------------------------------------------------

/**
 * `parseWorkflow` does not derive its result from `workflowDefinitionSchema` — it
 * hand-assembles a WorkflowDefinition field by field into an object literal. A field
 * added to the schema but not added to that literal is SILENTLY DISCARDED: the YAML
 * parses, the workflow loads, and the feature is simply inert.
 *
 * That is not hypothetical. `requires:` was added to `workflowBaseSchema` in ab81248d
 * (2026-06-01) without touching the loader, and was not added to that literal until
 * 2d7bf587 (2026-07-16) — six weeks in which the GitHub capability gate could never
 * fire for any discovered workflow, fixed incidentally inside an unrelated PR.
 *
 * This is the guard. The field list is derived from `KNOWN_WORKFLOW_KEYS`, which
 * itself derives from the workflow object schema,
 * so a new schema field fails the test until it is given a fixture here — the same
 * "the derived check fails until the new thing is registered" ratchet used by
 * `check:capability-matrix` and the schema-parity test in `sqlite.test.ts`.
 *
 * Deliberately NOT solved by deriving the assembly itself (`schema.parse(raw)`): most
 * fields warn-and-drop, logging a present-but-invalid value and continuing rather than
 * aborting the whole discovery pass, and `.parse()` would reject the workflow instead.
 * That is not universal — a few fields deliberately hard-reject and a few coerce
 * silently — but one warn-and-drop field is enough to make a blanket `.parse()` wrong.
 * `loader/workflow-fields.ts` and the `WorkflowDefinition` literal in `parseWorkflow` are the
 * authority on which field does what; do not restate it here.
 * See #2457.
 */
describe('workflow-level field parity (#2457)', () => {
  /**
   * One fixture per workflow-level schema key: a YAML fragment setting the field, and a
   * predicate proving it survived `parseWorkflow`. `present` is deliberately a survival
   * check rather than deep equality — several fields are normalised on the way through
   * (tags deduped, betas trimmed), and this guard is about the
   * field reaching the result at all, not about how it is parsed.
   */
  const FIELD_FIXTURES: Record<
    string,
    { yaml: string; present: (w: WorkflowDefinition) => boolean }
  > = {
    name: { yaml: '', present: w => w.name === 'parity' },
    description: { yaml: '', present: w => w.description === 'parity fixture' },
    nodes: { yaml: '', present: w => w.nodes?.length === 1 },
    provider: { yaml: 'provider: claude', present: w => w.provider === 'claude' },
    model: { yaml: 'model: sonnet', present: w => w.model === 'sonnet' },
    // The one field that survives as a DIFFERENT key. #2556 deprecated it and
    // the loader translates it into `effort:`, so asserting `w.modelReasoningEffort`
    // would now fail for the right reason. The guard's invariant is "a schema
    // field must not be silently inert", and translation satisfies it — so the
    // fixture proves the value arrived, and that the deprecated key did not.
    modelReasoningEffort: {
      yaml: 'modelReasoningEffort: high',
      present: w => w.effort === 'high' && w.modelReasoningEffort === undefined,
    },
    webSearchMode: { yaml: 'webSearchMode: live', present: w => w.webSearchMode === 'live' },
    effort: { yaml: 'effort: high', present: w => w.effort === 'high' },
    fallbackModel: {
      yaml: 'fallbackModel: haiku',
      present: w => w.fallbackModel === 'haiku',
    },
    betas: { yaml: 'betas:\n  - some-beta', present: w => w.betas?.includes('some-beta') === true },
    sandbox: { yaml: 'sandbox:\n  enabled: true', present: w => w.sandbox?.enabled === true },
    worktree: { yaml: 'worktree:\n  enabled: false', present: w => w.worktree?.enabled === false },
    container: {
      yaml: 'container:\n  enabled: true',
      present: w => w.container?.enabled === true,
    },
    evidence_policy: {
      yaml: 'evidence_policy:\n  required: true',
      present: w => w.evidence_policy?.required === true,
    },
    budget: {
      yaml: 'budget:\n  max_work_units: 3',
      present: w => w.budget?.max_work_units === 3,
    },
    mutates_checkout: {
      yaml: 'mutates_checkout: false',
      present: w => w.mutates_checkout === false,
    },
    persist_sessions: {
      yaml: 'persist_sessions: true',
      present: w => w.persist_sessions === true,
    },
    tags: { yaml: 'tags:\n  - alpha', present: w => w.tags?.includes('alpha') === true },
    requires: {
      yaml: 'requires:\n  - github',
      present: w => w.requires?.includes('github') === true,
    },
    inputs: {
      yaml: 'inputs:\n  diff:\n    required: true',
      present: w => w.inputs?.diff?.required === true,
    },
    // `returns` must name a real top-level node id — the fixture's single node is `only`.
    returns: { yaml: 'returns: only', present: w => w.returns === 'only' },
    outcome_field: {
      yaml: 'returns: only\noutcome_field: green',
      present: w => w.outcome_field === 'green',
    },
    deprecated: {
      yaml: 'deprecated:\n  message: Switch instead.',
      present: w => w.deprecated?.message === 'Switch instead.',
    },
  };

  const schemaKeys = [...KNOWN_WORKFLOW_KEYS];

  it('has a fixture for every workflow-level schema key (the ratchet)', () => {
    const missing = schemaKeys.filter(k => !(k in FIELD_FIXTURES));
    expect(
      missing,
      `Workflow-level schema keys with no parity fixture: ${missing.join(', ')}. ` +
        'Add a fixture in FIELD_FIXTURES AND make sure parseWorkflow actually carries the ' +
        'field into its returned object literal — a schema field missing from that literal ' +
        'is silently discarded at parse (see #2457).'
    ).toEqual([]);
  });

  it('has no fixture for a key that is not in the schema', () => {
    const stale = Object.keys(FIELD_FIXTURES).filter(k => !schemaKeys.includes(k));
    expect(stale, `Parity fixtures for keys no longer in the schema: ${stale.join(', ')}`).toEqual(
      []
    );
  });

  for (const key of Object.keys(FIELD_FIXTURES)) {
    it(`round-trips '${key}' through parseWorkflow`, () => {
      const fixture = FIELD_FIXTURES[key];
      const yaml = [
        'name: parity',
        'description: parity fixture',
        fixture.yaml,
        'nodes:',
        '  - id: only',
        '    prompt: hello',
        '    output_format:',
        '      type: object',
        '      properties:',
        '        green: { type: boolean }',
        '      required: [green]',
      ]
        .filter(line => line !== '')
        .join('\n');

      // An INVALID fixture value is dropped by design, which looks identical to the bug
      // this test hunts. Clearing the logger first lets the failure message rank the two
      // causes: a warning is strong evidence the fixture is at fault. Silence is NOT
      // proof of the opposite — a few fields coerce an invalid value away with no log at
      // all — so the silent branch names both causes rather than rendering a verdict.
      mockLogger.warn.mockClear();

      const result = parseWorkflow(yaml, `parity-${key}.yaml`);
      expect(
        result.error,
        `parseWorkflow rejected the '${key}' fixture: ${result.error?.error}`
      ).toBeNull();

      const warned = mockLogger.warn.mock.calls.length > 0;
      const message = warned
        ? `Field '${key}' did not survive parseWorkflow, and a warning fired — the FIXTURE ` +
          'value above is almost certainly invalid for this field, which warn-and-drop ' +
          'discards by design. Fix the fixture, not the loader.'
        : `Field '${key}' is declared on workflowDefinitionSchema and did NOT survive ` +
          'parseWorkflow, with no warning logged. Two possible causes, likeliest first: ' +
          "(1) the field is missing from the object literal parseWorkflow returns — that's " +
          'the #2457 bug, add it there; or (2) the fixture value is invalid for a field ' +
          'that coerces silently without logging, in which case fix the fixture. Check the ' +
          'fixture value against the schema first — it is the cheaper of the two to rule out.';
      expect(fixture.present(result.workflow as WorkflowDefinition), message).toBe(true);
    });
  }
});

describe('workflow-level model preference list', () => {
  it('keeps a list, so it can travel to the nodes', () => {
    const { workflow, error } = parseWorkflow(
      `
name: listed
description: preference list
model: ['@reviewer', medium]
nodes:
  - id: only
    prompt: "hi"
`,
      'listed.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.model).toEqual(['@reviewer', 'medium']);
  });

  it('rejects a list that could fail to resolve instead of dropping it', () => {
    const { workflow, error } = parseWorkflow(
      `
name: unresolvable
description: preference list without a final tier
model: ['@reviewer', '@implementer']
nodes:
  - id: only
    prompt: "hi"
`,
      'unresolvable.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain("must be a tier or a model id, not the alias '@implementer'");
  });

  it('treats a bare model key as no model, as it always has', () => {
    const { workflow, error } = parseWorkflow(
      `
name: bare
description: bare model key
model:
nodes:
  - id: only
    prompt: "hi"
`,
      'bare.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.model).toBeUndefined();
  });

  it('rejects a model that is neither a ref nor a list, naming both shapes', () => {
    const { workflow, error } = parseWorkflow(
      `
name: numeric
description: numeric model
model: 5
nodes:
  - id: only
    prompt: "hi"
`,
      'numeric.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain('a model ref string or a preference list');
  });
});

describe('container policy', () => {
  it('preserves every schema field through the container parser', () => {
    const policy = {
      enabled: false,
      write_back: workflowContainerPolicySchema.shape.write_back.unwrap().options[0],
    } satisfies Required<NonNullable<ReturnType<typeof parseContainerPolicy>>>;

    expect(Object.keys(policy).sort()).toEqual(
      Object.keys(workflowContainerPolicySchema.shape).sort()
    );
    expect(parseContainerPolicy(policy, 'policy.yaml')).toEqual(policy);
  });

  it.each(workflowContainerPolicySchema.shape.write_back.unwrap().options)(
    'accepts schema write_back mode %s without adding absent fields',
    writeBack => {
      expect(parseContainerPolicy({ write_back: writeBack }, 'policy.yaml')).toEqual({
        write_back: writeBack,
      });
    }
  );

  it.each<[unknown, ReturnType<typeof parseContainerPolicy>, [unknown, string][]]>([
    [undefined, undefined, []],
    [{}, undefined, []],
    [{ enabled: undefined, write_back: undefined }, undefined, []],
    [{ enabled: false }, { enabled: false }, []],
    [null, undefined, [[null, 'invalid_container_block_ignored']]],
    [[], undefined, [[[], 'invalid_container_block_ignored']]],
    ['auto', undefined, [['auto', 'invalid_container_block_ignored']]],
    [
      { enabled: false, write_back: 'bogus' },
      { enabled: false },
      [['bogus', 'invalid_container_write_back_value_ignored']],
    ],
    [
      { enabled: 'yes', write_back: 'approve' },
      { write_back: 'approve' },
      [['yes', 'invalid_container_enabled_value_ignored']],
    ],
    [
      { enabled: null, write_back: null },
      undefined,
      [
        [null, 'invalid_container_enabled_value_ignored'],
        [null, 'invalid_container_write_back_value_ignored'],
      ],
    ],
  ])('parses %j with field-level warnings', (raw, expected, warnings) => {
    mockLogger.warn.mockClear();
    expect(parseContainerPolicy(raw, 'policy.yaml')).toEqual(expected);
    expect(mockLogger.warn.mock.calls).toEqual(
      warnings.map(([value, event]) => [{ filename: 'policy.yaml', value }, event])
    );
  });
});

describe('workflow-level policy fields', () => {
  const withField = (field: string): string =>
    `name: policy\ndescription: d\n${field}\nnodes:\n  - id: n\n    prompt: p\n`;

  it.each<[string, string, keyof WorkflowDefinition, unknown]>([
    ['worktree.enabled: false', 'worktree:\n  enabled: false', 'worktree', { enabled: false }],
    ['worktree.enabled: true', 'worktree:\n  enabled: true', 'worktree', { enabled: true }],
    // Policy is caller-decides when the block is absent.
    ['no worktree block', '', 'worktree', undefined],
    [
      'container enabled + write_back',
      'container:\n  enabled: true\n  write_back: auto',
      'container',
      { enabled: true, write_back: 'auto' },
    ],
    [
      'an invalid container.write_back, keeping the block',
      'container:\n  enabled: true\n  write_back: bogus',
      'container',
      { enabled: true },
    ],
    ['no container block', '', 'container', undefined],
    [
      'evidence_policy.required: true (#2230)',
      'evidence_policy:\n  required: true',
      'evidence_policy',
      { required: true },
    ],
    [
      'evidence_policy.required: false',
      'evidence_policy:\n  required: false',
      'evidence_policy',
      { required: false },
    ],
    ['no evidence_policy', '', 'evidence_policy', undefined],
    ['an explicit tags array', 'tags: [GitLab, Review]', 'tags', ['GitLab', 'Review']],
    ['no tags', '', 'tags', undefined],
    // An explicit empty list suppresses tag inference, so it is kept rather than omitted.
    ['an explicit empty tags array', 'tags: []', 'tags', []],
    [
      'tags trimmed and deduped',
      'tags: ["GitLab", "GitLab ", "  GitLab  ", "Review"]',
      'tags',
      ['GitLab', 'Review'],
    ],
    // YAML coerces unquoted scalars: 123 → number, null → null.
    [
      'non-string tag entries filtered',
      'tags:\n  - GitLab\n  - 123\n  - null\n  - Review',
      'tags',
      ['GitLab', 'Review'],
    ],
    ['all-blank tags reduced to an empty array', 'tags: ["", "  "]', 'tags', []],
    // A scalar instead of a list is discarded; the workflow still loads.
    ['scalar tags ignored', 'tags: GitLab', 'tags', undefined],
    ['mutates_checkout: false', 'mutates_checkout: false', 'mutates_checkout', false],
    ['mutates_checkout: true', 'mutates_checkout: true', 'mutates_checkout', true],
    ['no mutates_checkout', '', 'mutates_checkout', undefined],
    // The string "yes" is not a boolean, so the field is dropped.
    [
      'an invalid mutates_checkout dropped',
      'mutates_checkout: "yes"',
      'mutates_checkout',
      undefined,
    ],
  ])('parses %s', (_, field, key, expected) => {
    expect(parseWorkflowYaml(withField(field)).workflow[key] as unknown).toEqual(expected);
  });

  // Silently dropping a declared terminal-success gate would let runs complete
  // ungated, so a malformed block fails validation instead of warn-and-ignore.
  it.each([
    ['a malformed evidence_policy block', 'evidence_policy:\n  required: "yes"', 'evidence_policy'],
    [
      'an empty evidence_policy block (required is mandatory)',
      'evidence_policy: {}',
      'required: boolean',
    ],
  ])('rejects %s', (_, field, message) => {
    const result = parseWorkflow(withField(field), 'evidence.yaml');
    expect(result.workflow).toBeNull();
    expect(result.error?.errorType).toBe('validation_error');
    expect(result.error?.error).toContain(message);
  });
});

describe('run budget (#2814)', () => {
  const budgeted = (nodes: string, budget = 'budget:\n  max_spend_usd: 2.5\n'): string =>
    `name: budgeted\ndescription: d\n${budget}nodes:\n${nodes}`;

  it('parses a budget declaring either ceiling or both', () => {
    for (const [yaml, expected] of [
      ['budget:\n  max_work_units: 3\n', { max_work_units: 3 }],
      ['budget:\n  max_spend_usd: 2.5\n', { max_spend_usd: 2.5 }],
      [
        'budget:\n  max_work_units: 3\n  max_spend_usd: 2.5\n',
        { max_work_units: 3, max_spend_usd: 2.5 },
      ],
    ] as const) {
      const result = parseWorkflow(budgeted('  - id: n\n    prompt: p\n', yaml), 'b.yaml');
      expect(result.error).toBeNull();
      expect(result.workflow?.budget).toEqual(expected);
    }
  });

  it('rejects a malformed budget instead of running without a ceiling', () => {
    for (const yaml of [
      'budget: {}\n',
      'budget:\n  max_spend_usd: 0\n',
      'budget:\n  max_work_units: 1.5\n',
      'budget:\n  max_spend: 5\n',
      'budget:\n  max_work_units: 3\n  max_spend: 5\n',
      'budget: lots\n',
    ]) {
      const result = parseWorkflow(budgeted('  - id: n\n    prompt: p\n', yaml), 'b.yaml');
      expect(result.error?.errorType).toBe('validation_error');
      expect(result.error?.error).toContain('Invalid budget');
    }
  });

  it('rejects loops, workflow: children and fan-out under a budget', () => {
    for (const [nodeYaml, kind] of [
      ['    loop:\n      until: done\n      max_iterations: 1\n      prompt: p', 'loop'],
      [
        '    loop_group:\n      nodes:\n        - id: b\n          bash: echo hi\n      until: done\n      max_iterations: 1',
        'loop_group',
      ],
      ['    workflow: child', 'workflow'],
      ['    workflow: child\n    fan_out:\n      items: \'["a"]\'\n      as: item', 'workflow'],
      [
        '    include: block\n    fan_out:\n      items: \'["a"]\'\n      as: item',
        'include with fan_out',
      ],
    ] as const) {
      const result = parseWorkflow(budgeted(`  - id: x\n${nodeYaml}\n`), `${kind}.yaml`);
      expect(result.error?.errorType).toBe('validation_error');
      expect(result.error?.error).toContain(`node 'x' is a ${kind} node`);
      // The same shape without a budget is not refused for this reason.
      const unbudgeted = parseWorkflow(budgeted(`  - id: x\n${nodeYaml}\n`, ''), 'u.yaml');
      expect(unbudgeted.error?.error ?? '').not.toContain('budget');
    }
  });

  it('loads a budgeted workflow of ordinary nodes, gates, waits and halts', () => {
    const { workflow } = parseWorkflowYaml(
      budgeted(
        [
          '  - id: plan',
          '    prompt: p',
          '  - id: check',
          '    bash: echo ok',
          '    depends_on: [plan]',
          '  - id: tool',
          '    script: console.log(1)',
          '    runtime: bun',
          '    depends_on: [plan]',
          '  - id: review',
          '    approval:',
          '      message: ok?',
          '      on_reject:',
          '        prompt: fix it',
          '    depends_on: [check, tool]',
          '  - id: pause',
          '    wait:',
          '      duration_ms: 1000',
          '    depends_on: [review]',
          '  - id: stop',
          '    cancel: done',
          '    depends_on: [pause]',
          '',
        ].join('\n')
      )
    );
    expect(workflow.budget).toEqual({ max_spend_usd: 2.5 });
  });
});

describe('workflow-level model and effort', () => {
  it('should accept any model string with a known provider (SDK validates at run time)', () => {
    // Whatever the user wrote in `model:` passes through to the SDK; the
    // SDK is the source of truth for what model strings exist. Errors
    // surface at run time, not load time.
    const { workflow } = parseWorkflowYaml(`name: any-model
description: Any model string with a known provider
provider: claude
model: claude-opus-4-7[1m]
nodes:
  - id: test
    command: test
`);

    expect(workflow.provider).toBe('claude');
    expect(workflow.model).toBe('claude-opus-4-7[1m]');
  });

  it('should parse codex options fields (and ignore the removed additionalDirectories field)', () => {
    // additionalDirectories was a dead workflow-level field (parsed but never
    // consumed by the DAG executor) — it has been removed. A YAML that still
    // declares it must load fine, with the field simply ignored.
    const { workflow } = parseWorkflowYaml(`name: codex-options
description: Codex options are parsed
provider: codex
model: gpt-5.6-sol
modelReasoningEffort: medium
webSearchMode: live
additionalDirectories:
  - /repo/a
  - 123
nodes:
  - id: test
    command: test
`);

    // #2556: translated into `effort:` at load, never carried forward.
    expect(workflow.effort).toBe('medium');
    expect(workflow.modelReasoningEffort).toBeUndefined();
    expect(workflow.webSearchMode).toBe('live');
    // The removed field is not carried onto the workflow object.
    expect((workflow as Record<string, unknown>).additionalDirectories).toBeUndefined();
  });

  it('should translate modelReasoningEffort into effort and say so', () => {
    // #2556: warn-and-TRANSLATE. The value must survive to the executor — an
    // author who reads the warning and does nothing must see no change in the
    // depth their nodes run at — but it survives as `effort:`, the field that
    // has a node-level counterpart. That is what makes the deprecation
    // terminal, and what lets a later pass collapse workflow-level config onto
    // nodes (#1764) without a hole for this field.
    const { workflow, warnings } = parseWorkflowYaml(`name: deprecated-effort-spelling
description: Uses the old Codex-only spelling
provider: codex
modelReasoningEffort: xhigh
nodes:
  - id: test
    command: test
`);

    // The value arrives under the canonical spelling; the deprecated key is gone.
    expect(workflow.effort).toBe('xhigh');
    expect(workflow.modelReasoningEffort).toBeUndefined();

    const deprecation = warnings.find(w => w.includes('modelReasoningEffort'));
    expect(deprecation).toBeDefined();
    expect(deprecation).toContain('deprecated');
    // The message must name what actually happened, not just what to write —
    // an author who reads "deprecated" and nothing else cannot tell whether
    // their value still applies.
    expect(deprecation).toContain("has been applied as 'effort: xhigh'");
    // The scope change must be disclosed, not just the rename. The old field
    // was Codex-only; `effort:` is not, so a workflow that declares only the
    // deprecated field now reasons deeper on its Claude/Pi/Copilot nodes too,
    // where before it affected none of them. Silent is exactly what this
    // issue exists to remove.
    expect(deprecation).toContain('EVERY node');
    expect(deprecation).toContain('non-Codex');
  });

  it('translates for a NON-Codex workflow too — the widening, pinned', () => {
    // R22's cost, as behavior rather than a sentence. The deprecated field was
    // Codex-gated in the executor: on a Claude workflow it applied to nothing
    // and warned. Translation is provider-blind (the loader cannot know which
    // nodes resolve to Codex), so it now applies. That is deliberate and
    // disclosed — and a plausible "fix" would be to re-add a Codex gate here,
    // which would silently restore the two-field hole #1764 Task 1 needs gone.
    // This test is what makes that regression fail.
    const { workflow } = parseWorkflowYaml(`name: deprecated-on-claude
description: Codex-only spelling on a Claude workflow
provider: claude
modelReasoningEffort: high
nodes:
  - id: test
    command: test
`);

    expect(workflow.provider).toBe('claude');
    // Applied, not dropped, and under the canonical spelling.
    expect(workflow.effort).toBe('high');
    expect(workflow.modelReasoningEffort).toBeUndefined();
  });

  it('should ignore modelReasoningEffort when effort is also declared, and say which won', () => {
    // The loader cannot know which nodes resolve to Codex, so the deprecated
    // field's Codex-only precedence is not expressible at load time. `effort:`
    // wins, and the warning has to say so plainly — silently picking one of
    // two declared depths is the failure this issue exists to remove.
    const { workflow, warnings } = parseWorkflowYaml(`name: both-spellings
description: Declares both reasoning-depth fields
provider: codex
effort: minimal
modelReasoningEffort: xhigh
nodes:
  - id: test
    command: test
`);

    expect(workflow.effort).toBe('minimal');
    expect(workflow.modelReasoningEffort).toBeUndefined();

    const deprecation = warnings.find(w => w.includes('modelReasoningEffort'));
    expect(deprecation).toBeDefined();
    expect(deprecation).toContain('IGNORED');
    expect(deprecation).toContain('effort: minimal');
  });

  it('should not warn about deprecation when modelReasoningEffort is absent', () => {
    const { workflow, warnings } = parseWorkflowYaml(`name: current-effort-spelling
description: Uses the one spelling
provider: codex
effort: xhigh
nodes:
  - id: test
    command: test
`);

    expect(workflow.effort).toBe('xhigh');
    expect(warnings).toEqual([]);
  });

  it('should warn-and-drop invalid workflow-level fallback fields without rejecting the workflow', () => {
    // Same warn-and-ignore policy as `interactive` / `modelReasoningEffort`:
    // a typo in one workflow-level field must not nuke the whole discovery pass.
    mockLogger.warn.mockClear();
    parseWorkflowYaml(`name: bad
description: invalid fallback fields are dropped
provider: claude
effort: nuclear
fallbackModel: ''
betas: []
sandbox: 'yes'
nodes:
  - id: only
    prompt: p
`);

    // The structured warn events are the operator-facing surface — assert each fired.
    const events = mockLogger.warn.mock.calls.map(call => call[1]);
    expect(events).toContain('invalid_workflow_effort_value_ignored');
    expect(events).toContain('invalid_workflow_fallback_model_value_ignored');
    expect(events).toContain('invalid_workflow_betas_value_ignored');
    expect(events).toContain('invalid_workflow_sandbox_value_ignored');
  });

  it('should trim surrounding whitespace from workflow-level fallbackModel', () => {
    // The inline trim (rather than safeParse) exists specifically so a stray
    // surrounding space is normalised rather than rejected.
    const wf = parseWorkflowYaml(`name: fm-trim
description: fallbackModel with whitespace
fallbackModel: '  claude-haiku-4-5  '
nodes:
  - id: only
    prompt: p
`).workflow;
    expect(wf.fallbackModel).toBe('claude-haiku-4-5');
  });

  it('should trim and filter empty strings out of workflow-level betas', () => {
    const wf = parseWorkflowYaml(`name: beta-trim
description: betas with whitespace
betas:
  - '  alpha  '
  - ''
  - 'beta'
nodes:
  - id: only
    prompt: p
`).workflow;
    expect(wf.betas).toEqual(['alpha', 'beta']);
  });
});

describe('deprecated marker (#2781)', () => {
  const withDeprecated = (block: string): string =>
    `name: test\ndescription: test\n${block}\nnodes:\n  - id: n\n    prompt: p\n`;

  it('parses a declared deprecation cleanly and keeps the field', () => {
    const { workflow, warnings } = parseWorkflowYaml(
      withDeprecated('deprecated:\n  message: Switch to the sdlc pack instead.')
    );
    expect(warnings).toEqual([]);
    expect(workflow.deprecated?.message).toBe('Switch to the sdlc pack instead.');
  });

  it('rejects a malformed deprecated block instead of dropping it silently', () => {
    // An empty block would mean a bundled default with no removal warning at
    // all — the exact failure the notice exists to prevent.
    const result = parseWorkflow(withDeprecated('deprecated: {}'), 'test.yaml');
    expect(result.workflow).toBeNull();
    expect(result.error?.errorType).toBe('validation_error');
    expect(result.error?.error).toContain('Invalid deprecated');
  });
});
