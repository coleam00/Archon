// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import {
  isLoopGroupNode,
  loopGroupOutputNodes,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  BASH_NODE_AI_FIELDS,
  dagNodeSchema,
  loopNodeSchema,
} from './schemas';
import type { DagNode } from './schemas';
import { validationError } from './schema-test-utils';

describe('LOOP_NODE_AI_FIELDS', () => {
  test('excludes model and provider (loop nodes support them)', () => {
    expect(LOOP_NODE_AI_FIELDS).not.toContain('model');
    expect(LOOP_NODE_AI_FIELDS).not.toContain('provider');
  });

  test('contains all other AI-specific fields from BASH_NODE_AI_FIELDS', () => {
    // `output_format` is deliberately absent since #2563 — a loop: node makes its
    // own sendQuery, so the schema is honoured rather than warned-and-dropped.
    const expectedFields = [
      'context',
      'hooks',
      'mcp',
      'skills',
      'effort',
      'maxBudgetUsd',
      'systemPrompt',
      'fallbackModel',
      'betas',
      'sandbox',
    ];
    for (const field of expectedFields) {
      expect(LOOP_NODE_AI_FIELDS).toContain(field);
    }
  });
});

describe('loop iteration retry policy', () => {
  const loop = { prompt: 'Work', until: 'DONE', max_iterations: 2, fresh_context: false };
  test.each([
    { max_attempts: 1, delay_ms: 0 },
    { max_attempts: 5, delay_ms: 60000, on_error: 'transient' },
    { max_attempts: 2, delay_ms: 17 },
    { max_attempts: 3 },
  ] as const)('preserves valid retry %j in authored and typed loops', retry => {
    const authored = dagNodeSchema.parse({ id: 'work', loop, retry });
    const typed = loopNodeSchema.parse({ id: 'work', kind: 'loop', loop, retry });
    expect(authored.kind).toBe('loop');
    if (authored.kind !== 'loop') throw new Error('Expected a loop');
    expect(authored.retry).toEqual(retry);
    expect(typed.retry).toEqual(retry);
  });
  test.each([
    { delay_ms: 0 },
    { max_attempts: 0 },
    { max_attempts: 6 },
    { max_attempts: 1.5 },
    { max_attempts: 1, delay_ms: -1 },
    { max_attempts: 1, delay_ms: 60001 },
    { max_attempts: 1, on_error: 'all' },
    { max_attempts: 1, delay_ms: 0, on_error: 'all' },
  ])('rejects invalid retry %j in authored and typed loops', retry => {
    const authoredError = validationError(dagNodeSchema.safeParse({ id: 'work', loop, retry }));
    expect(authoredError.issues.some(issue => issue.path[0] === 'retry')).toBe(true);
    expect(loopNodeSchema.safeParse({ id: 'work', kind: 'loop', loop, retry }).success).toBe(false);
  });
  test.each([
    { prompt: 'Work' },
    { command: 'work' },
    { bash: 'true' },
    { script: 'work', runtime: 'bun' },
  ])('preserves ordinary retry constraints for %j', mode => {
    for (const delay_ms of [0, 17, 999]) {
      expect(
        dagNodeSchema.safeParse({ id: 'work', ...mode, retry: { max_attempts: 1, delay_ms } })
          .success
      ).toBe(false);
    }
    const retry = { max_attempts: 1, delay_ms: 1000, on_error: 'all' } as const;
    const node = dagNodeSchema.parse({ id: 'work', ...mode, retry });
    expect('retry' in node && node.retry).toEqual(retry);
  });
});

describe('dagNodeSchema — LoopNode AI-field survival', () => {
  /**
   * One valid authored value per AI field, so each can be parsed on its own and
   * checked against the list. Values only have to satisfy the schema — nothing
   * here asserts what a provider does with them.
   */
  const SAMPLE_AI_FIELD_VALUES: Record<string, unknown> = {
    provider: 'claude',
    model: 'sonnet',
    context: 'fresh',
    output_format: { type: 'object', properties: { done: { type: 'boolean' } } },
    allowed_tools: ['Read', 'Grep'],
    denied_tools: ['WebFetch', 'WebSearch'],
    hooks: { PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }] },
    mcp: '.mcp.json',
    skills: ['code-review'],
    plugins: ['formatter@tools'],
    agents: { reviewer: { description: 'reviews', prompt: 'review it' } },
    pi: { enableExtensions: false },
    effort: 'low',
    maxBudgetUsd: 5,
    systemPrompt: 'be brief',
    fallbackModel: 'haiku',
    settingSources: ['project'],
    betas: ['some-beta'],
    sandbox: { enabled: true },
    persist_session: true,
  };

  const parseLoopWith = (field: string, value: unknown): Record<string, unknown> => {
    const result = dagNodeSchema.safeParse({
      id: 'work',
      [field]: value,
      loop: { prompt: 'go', until_bash: 'true', max_iterations: 1 },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`expected a valid loop node declaring '${field}'`);
    return result.data as unknown as Record<string, unknown>;
  };

  test('preserves denied_tools so the restriction reaches each iteration (#3324)', () => {
    expect(parseLoopWith('denied_tools', ['WebFetch', 'WebSearch']).denied_tools).toEqual([
      'WebFetch',
      'WebSearch',
    ]);
  });

  test('preserves allowed_tools, including an empty allow-list', () => {
    expect(parseLoopWith('allowed_tools', ['Read']).allowed_tools).toEqual(['Read']);
    // `[]` means "no tools", not "no restriction" — dropping it would be the same
    // fail-open as dropping denied_tools, so it must survive as an empty array.
    expect(parseLoopWith('allowed_tools', []).allowed_tools).toEqual([]);
  });

  test('omits undeclared tool, model, and provider fields', () => {
    const node = parseLoopWith('description', 'no tool fields here');
    expect('allowed_tools' in node).toBe(false);
    expect('denied_tools' in node).toBe(false);
    expect('model' in node).toBe(false);
    expect('provider' in node).toBe(false);
  });

  test('a field survives the transform exactly when LOOP_NODE_AI_FIELDS omits it', () => {
    // The conformance check: every AI field the loader could warn about, parsed on
    // a loop node and compared against the list that describes it. A field claimed
    // as supported but dropped is a silent no-op; a field claimed as ignored but
    // carried is a warning the author did not need.
    for (const field of [...BASH_NODE_AI_FIELDS, 'output_format']) {
      const value = SAMPLE_AI_FIELD_VALUES[field];
      expect(value, `no sample value declared for '${field}'`).toBeDefined();
      const node = parseLoopWith(field, value);
      const shouldSurvive = !LOOP_NODE_AI_FIELDS.includes(field);
      expect(field in node, `'${field}' survival must match LOOP_NODE_AI_FIELDS`).toBe(
        shouldSurvive
      );
      if (shouldSurvive) expect(node[field]).toEqual(value);
    }
  });
});

describe('dagNodeSchema — loop_group', () => {
  test('parses a valid loop_group node with a recursive body', () => {
    const result = dagNodeSchema.parse({
      id: 'grp',
      loop_group: {
        until: 'DONE',
        max_iterations: 5,
        fresh_context: false,
        nodes: [
          { id: 'a', prompt: 'do a', depends_on: [] },
          { id: 'b', bash: 'echo hi', depends_on: ['a'] },
        ],
      },
    });
    expect(isLoopGroupNode(result as DagNode)).toBe(true);
    const grp = result as { loop_group?: { nodes: unknown[] } };
    expect(grp.loop_group?.nodes).toHaveLength(2);
  });

  test('loop_group + prompt are mutually exclusive', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'grp',
        prompt: 'inline',
        loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
      })
    );
    expect(error.issues[0].message).toContain('mutually exclusive');
    expect(error.issues[0].message).toContain('loop_group');
  });

  test('loop_group + loop are mutually exclusive', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'grp',
        loop: { prompt: 'p', until: 'DONE', max_iterations: 3 },
        loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
      })
    );
    expect(error.issues[0].message).toContain('mutually exclusive');
  });

  test('loop_group rejects retry (loop manages its own iteration)', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'grp',
        retry: { max_attempts: 2, delay_ms: 1000 },
        loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
      })
    );
    const retryIssue = error.issues.find(i => i.message.includes('retry'));
    expect(retryIssue).toBeDefined();
    expect(retryIssue?.message).toContain('loop_group');
  });

  test('loop_group requires at least one body node', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'grp',
        loop_group: { until: 'DONE', max_iterations: 3, nodes: [] },
      })
    );
    expect(error.issues.some(i => i.message.includes('at least one node'))).toBe(true);
  });

  test('loop_group rejects a body with no completion channel', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'grp',
        loop_group: { max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
      })
    );
    const issue = error.issues.find(i => i.message.includes('completion channel'));
    expect(issue?.message).toBe(
      "loop node requires a completion channel: set 'loop.until' (completion signal string) or 'loop.until_bash' (deterministic check, exit 0 = complete)"
    );
    expect(issue?.path).toEqual(['loop_group', 'until']);
  });

  test('loop_group accepts until_bash alone (no prose signal) — #2563', () => {
    const result = dagNodeSchema.parse({
      id: 'grp',
      loop_group: {
        max_iterations: 3,
        until_bash: 'test -f ./done',
        nodes: [{ id: 'x', bash: 'echo hi' }],
      },
    });
    const grp = result as { loop_group?: { until?: string; until_bash?: string } };
    expect(grp.loop_group?.until).toBeUndefined();
    expect(grp.loop_group?.until_bash).toBe('test -f ./done');
  });

  test('nested loop_group body parses (loop_group inside loop_group)', () => {
    const result = dagNodeSchema.parse({
      id: 'outer',
      loop_group: {
        until: 'OUTER_DONE',
        max_iterations: 3,
        nodes: [
          {
            id: 'inner',
            loop_group: {
              until: 'INNER_DONE',
              max_iterations: 2,
              nodes: [{ id: 'inner-work', prompt: 'work', depends_on: [] }],
            },
            depends_on: [],
          },
        ],
      },
    });
    if (result.kind !== 'loop_group') throw new Error('Expected outer loop group');
    const inner = result.loop_group.nodes[0];
    if (inner?.kind !== 'loop_group') throw new Error('Expected inner loop group');
    expect(isLoopGroupNode(inner)).toBe(true);
    expect(inner.loop_group.nodes).toHaveLength(1);
  });
});

describe('loopGroupOutputNodes', () => {
  const body = (sink: Record<string, unknown>): DagNode[] =>
    [
      { id: 'work', bash: 'echo work' },
      { ...sink, id: 'end', depends_on: ['work'] },
    ].map(n => dagNodeSchema.parse(n) as DagNode);
  const outputIds = (sink: Record<string, unknown>): string[] =>
    loopGroupOutputNodes(body(sink)).map(n => n.id);

  test('reads past a sink that asks a human to the work it depends on', () => {
    expect(outputIds({ approval: { message: 'ok?' } })).toEqual(['work']);
    expect(outputIds({ wait: { attention: 'Check it.' } })).toEqual(['work']);
  });

  test('keeps any other wait as the output, as before #4043', () => {
    expect(outputIds({ wait: { duration_ms: 1 } })).toEqual(['end']);
    expect(outputIds({ wait: { event: 'checks.complete', deadline_ms: 1 } })).toEqual(['end']);
  });
});

describe('dagNodeSchema — loop completion channel (#2563)', () => {
  test('a loop declaring only until_bash parses, with no prose signal', () => {
    const result = dagNodeSchema.parse({
      id: 'deterministic',
      loop: {
        prompt: 'fix the failing tests',
        max_iterations: 5,
        until_bash: 'bun run test',
      },
    });
    const node = result as { loop?: { until?: string; until_bash?: string } };
    expect(node.loop?.until).toBeUndefined();
    expect(node.loop?.until_bash).toBe('bun run test');
  });

  test('a loop declaring only until still parses (unchanged)', () => {
    const result = dagNodeSchema.parse({
      id: 'prose',
      loop: { prompt: 'iterate', until: 'COMPLETE', max_iterations: 5 },
    });
    const node = result as { loop?: { until?: string } };
    expect(node.loop?.until).toBe('COMPLETE');
  });

  test('a loop with no channel is rejected, naming every channel it could declare', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'no-channel',
        loop: { prompt: 'iterate', max_iterations: 5 },
      })
    );
    const issue = error.issues.find(i => i.message.includes('completion channel'));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe(
      "loop node requires a completion channel: set 'loop.until' (completion signal string) or 'loop.until_bash' (deterministic check, exit 0 = complete) or 'loop.until_field' (a declared boolean in output_format)"
    );
    expect(issue?.path).toEqual(['loop', 'until']);
  });

  test('an empty-string until is rejected rather than treated as absent', () => {
    const result = dagNodeSchema.safeParse({
      id: 'blank',
      loop: { prompt: 'iterate', until: '', max_iterations: 5 },
    });
    expect(result.success).toBe(false);
  });

  describe('channel verdict matrix (twin: builder structural.test.ts)', () => {
    const cases: Array<[string, Record<string, string>, boolean]> = [
      ['neither declared', {}, false],
      ['until only, real', { until: 'COMPLETE' }, true],
      ['until_bash only, real', { until_bash: 'bun run test' }, true],
      ['both real', { until: 'COMPLETE', until_bash: 'bun run test' }, true],
      ['until blank, no bash', { until: '  ' }, false],
      ['until blank + real bash', { until: ' ', until_bash: 'bun run test' }, false],
      ['real until + blank bash', { until: 'COMPLETE', until_bash: '   ' }, false],
      ['both blank', { until: ' ', until_bash: '\t' }, false],
      ['until empty string', { until: '' }, false],
      ['until_bash empty string', { until_bash: '' }, false],
      ['padded until (legit)', { until: ' COMPLETE ' }, true],
      ['multiline until_bash (legit)', { until_bash: '  set -e\n  test -f x\n' }, true],
      ['until_field only, real', { until_field: 'done' }, true],
      ['until_field blank', { until_field: '  ' }, false],
    ];

    // Supply a valid output contract so these cases isolate the channel rule.
    const untilFieldSchema = {
      type: 'object',
      properties: { done: { type: 'boolean' } },
      required: ['done'],
    };

    for (const [name, channels, shouldParse] of cases) {
      test(`${name} -> ${shouldParse ? 'accepted' : 'rejected'}`, () => {
        const needsSchema = 'until_field' in channels;
        const result = dagNodeSchema.safeParse({
          id: 'l',
          ...(needsSchema ? { output_format: untilFieldSchema } : {}),
          loop: { prompt: 'iterate', max_iterations: 5, ...channels },
        });
        expect(result.success).toBe(shouldParse);
      });
    }
  });

  test('a blank channel is rejected even when its sibling is valid', () => {
    const blankSignalError = validationError(
      dagNodeSchema.safeParse({
        id: 'a',
        loop: { prompt: 'p', until: ' ', until_bash: 'bun run test', max_iterations: 5 },
      })
    );
    expect(blankSignalError.issues.some(i => i.message.includes("'loop.until' must be"))).toBe(
      true
    );

    const blankCheckError = validationError(
      dagNodeSchema.safeParse({
        id: 'b',
        loop: { prompt: 'p', until: 'COMPLETE', until_bash: '   ', max_iterations: 5 },
      })
    );
    expect(blankCheckError.issues.some(i => i.message.includes("'loop.until_bash' must be"))).toBe(
      true
    );
  });

  test('a declared channel is validated but never rewritten', () => {
    // Trimming for validation is not trimming for storage: `until` is matched
    // verbatim by detectCompletionSignal and `until_bash` is executed verbatim, so
    // rewriting either here would silently change what an existing workflow does.
    const result = dagNodeSchema.parse({
      id: 'verbatim',
      loop: {
        prompt: 'p',
        until: ' COMPLETE ',
        until_bash: '  set -e\n  test -f x\n',
        max_iterations: 5,
      },
    });
    const node = result as { loop?: { until?: string; until_bash?: string } };
    expect(node.loop?.until).toBe(' COMPLETE ');
    expect(node.loop?.until_bash).toBe('  set -e\n  test -f x\n');
  });
});

describe('dagNodeSchema — loop.until_field (#2563)', () => {
  const schema = {
    type: 'object',
    properties: { done: { type: 'boolean' }, note: { type: 'string' } },
    required: ['done'],
  };
  const loopWith = (loop: Record<string, unknown>, output_format?: unknown) =>
    dagNodeSchema.safeParse({
      id: 'l',
      ...(output_format !== undefined ? { output_format } : {}),
      loop: { prompt: 'p', max_iterations: 5, ...loop },
    });

  test('a valid until_field parses and keeps output_format on the node', () => {
    const result = loopWith({ until_field: 'done' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { output_format?: unknown; loop?: { until_field?: string } };
      expect(node.output_format).toEqual(schema);
      expect(node.loop?.until_field).toBe('done');
    }
  });

  test('until_field alone satisfies the completion-channel rule', () => {
    expect(loopWith({ until_field: 'done' }, schema).success).toBe(true);
  });

  test('until_field without output_format is rejected', () => {
    const error = validationError(loopWith({ until_field: 'done' }));
    expect(error.issues.some(i => i.message.includes("declares no 'output_format'"))).toBe(true);
  });

  test('until_field naming an undeclared property is rejected, listing what is declared', () => {
    const error = validationError(loopWith({ until_field: 'finished' }, schema));
    const issue = error.issues.find(i => i.message.includes('not declared'));
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('done, note');
  });

  test('until_field must be listed in output_format.required', () => {
    // Otherwise a schema-valid payload may omit it, "absent" reads as "not
    // complete", and the loop burns max_iterations reporting the wrong cause.
    const optional = {
      type: 'object',
      properties: { done: { type: 'boolean' } },
    };
    const error = validationError(loopWith({ until_field: 'done' }, optional));
    expect(error.issues.some(i => i.message.includes('output_format.required'))).toBe(true);
  });

  test('until_field declared as a non-boolean type is rejected', () => {
    const stringy = {
      type: 'object',
      properties: { done: { type: 'string' } },
      required: ['done'],
    };
    const error = validationError(loopWith({ until_field: 'done' }, stringy));
    expect(error.issues.some(i => i.message.includes("must be 'boolean'"))).toBe(true);
  });

  test('a property with no declared type is accepted', () => {
    // JSON Schema does not require `type`; only a WRONG type is a violation.
    const untyped = { type: 'object', properties: { done: {} }, required: ['done'] };
    expect(loopWith({ until_field: 'done' }, untyped).success).toBe(true);
  });

  test('output_format without until_field is fine (structured output, prose termination)', () => {
    expect(loopWith({ until: 'DONE' }, schema).success).toBe(true);
  });

  test('until_field on a loop_group is an unknown key, leaving it channel-less', () => {
    // Declined by design: a loop_group body node can declare output_format and be
    // read by `until_bash: '[ "$decide.output.done" = "true" ]'`, so the existing
    // wiring already expresses it there. The key is stripped and the group is left
    // with no channel at all, which is the error the author sees.
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'g',
        loop_group: { max_iterations: 3, until_field: 'done', nodes: [{ id: 'x', bash: 'echo' }] },
      })
    );
    const issue = error.issues.find(i => i.message.includes('completion channel'));
    expect(issue).toBeDefined();
    expect(issue?.message).not.toContain('until_field');
  });
});

describe('LOOP_GROUP_NODE_AI_FIELDS', () => {
  test('excludes model/provider (forwarded to body AI nodes)', () => {
    expect(LOOP_GROUP_NODE_AI_FIELDS).not.toContain('model');
    expect(LOOP_GROUP_NODE_AI_FIELDS).not.toContain('provider');
  });

  test('differs from LOOP_NODE_AI_FIELDS on the fields a loop: node sendQuerys with', () => {
    // Only a single-prompt loop sends its own provider query.
    const loopSendQueryFields = ['pi', 'output_format', 'allowed_tools', 'denied_tools'];
    for (const field of loopSendQueryFields) {
      expect(LOOP_NODE_AI_FIELDS).not.toContain(field);
      expect(LOOP_GROUP_NODE_AI_FIELDS).toContain(field);
    }
    expect(LOOP_GROUP_NODE_AI_FIELDS.filter(f => !loopSendQueryFields.includes(f))).toEqual([
      ...LOOP_NODE_AI_FIELDS,
    ]);
  });
});

describe('dagNodeSchema — loop and loop_group select timeout', () => {
  // The mode transform drops every key the mode does not select, so a value that
  // never reaches the parsed node can never reach the until_bash subprocess.
  test('carries timeout through the loop transform', () => {
    const result = dagNodeSchema.parse({
      id: 'l',
      timeout: 600_000,
      loop: { prompt: 'p', until: 'DONE', max_iterations: 3 },
    });
    expect(result).toMatchObject({ kind: 'loop', timeout: 600_000 });
  });

  test('carries timeout through the loop_group transform', () => {
    const result = dagNodeSchema.parse({
      id: 'grp',
      timeout: 600_000,
      loop_group: { until: 'DONE', max_iterations: 3, nodes: [{ id: 'x', prompt: 'x' }] },
    });
    expect(result).toMatchObject({ kind: 'loop_group', timeout: 600_000 });
  });

  test.each([
    ['loop', 0],
    ['loop', -1],
    ['loop', Number.POSITIVE_INFINITY],
    ['loop_group', 0],
    ['loop_group', -1],
    ['loop_group', Number.POSITIVE_INFINITY],
  ] as const)('rejects an invalid %s timeout of %s', (kind, timeout) => {
    const mode =
      kind === 'loop'
        ? { loop: { prompt: 'p', until: 'DONE', max_iterations: 3 } }
        : {
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              nodes: [{ id: 'x', prompt: 'x' }],
            },
          };
    const error = validationError(dagNodeSchema.safeParse({ id: kind, timeout, ...mode }));
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        path: ['timeout'],
      })
    );
    if (Number.isFinite(timeout)) {
      expect(error.issues).toContainEqual(
        expect.objectContaining({ message: "'timeout' must be a positive number (ms)" })
      );
    }
  });
});
