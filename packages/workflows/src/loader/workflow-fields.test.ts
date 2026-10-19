// @archon-test-isolated
import { clearRegistry, providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { describe, it, expect, mock } from 'bun:test';

// Inline mock logger: the moved suites assert on the warnings the field parsers log
type MockLog = (data: unknown, message?: string, ...args: unknown[]) => undefined;
const mockLogger = {
  fatal: mock<MockLog>(() => undefined),
  error: mock<MockLog>(() => undefined),
  warn: mock<MockLog>(() => undefined),
  info: mock<MockLog>(() => undefined),
  debug: mock<MockLog>(() => undefined),
  trace: mock<MockLog>(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

// Mock @archon/paths: suppress logger + pass through real path utilities
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
}));

import { parseWorkflow as parseWorkflowWithProviders, type ParseResult } from '../loader';
import { KNOWN_WORKFLOW_KEYS } from '../schemas/workflow';
import type { WorkflowDefinition } from '../schemas/workflow';

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
