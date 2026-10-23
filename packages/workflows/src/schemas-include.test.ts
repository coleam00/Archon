// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import {
  isIncludeDirective,
  INCLUDE_NODE_IGNORED_FIELDS,
  BASH_NODE_AI_FIELDS,
  dagNodeSchema,
  inputEnvKey,
} from './schemas';
import type { IncludeDirective, ComposeFanOutNode } from './schemas';
import { validationError } from './schema-test-utils';

describe('dagNodeSchema — include', () => {
  test('parses a valid include node (only structural fields survive)', () => {
    const result = dagNodeSchema.parse({
      id: 'review',
      include: 'acme-review-block',
      depends_on: ['finalize-pr'],
      when: 'always',
      trigger_rule: 'all_success',
    });
    expect(isIncludeDirective(result)).toBe(true);
    const node = result as IncludeDirective;
    expect(node.kind).toBe('include');
    expect(node.include).toBe('acme-review-block');
    expect(node.depends_on).toEqual(['finalize-pr']);
    expect(node.when).toBe('always');
    expect(node.trigger_rule).toBe('all_success');
  });

  test('trims surrounding whitespace on the target name', () => {
    const result = dagNodeSchema.parse({ id: 'r', include: '  acme-review-block  ' });
    expect((result as IncludeDirective).include).toBe('acme-review-block');
  });

  test('include + command are mutually exclusive', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'r',
        command: 'build',
        include: 'acme-review-block',
      })
    );
    expect(error.issues[0].message).toContain('mutually exclusive');
    expect(error.issues[0].message).toContain('include');
  });

  test('empty include is rejected', () => {
    const result = dagNodeSchema.safeParse({ id: 'r', include: '' });
    expect(result.success).toBe(false);
  });

  test("include accepts and retains a string-valued 'with:' mapping", () => {
    const result = dagNodeSchema.parse({
      id: 'r',
      include: 'acme-review-block',
      with: { pr: '$create.output', base_branch: 'main', empty: '' },
    });
    expect((result as IncludeDirective).with).toEqual({
      pr: '$create.output',
      base_branch: 'main',
      empty: '',
    });
  });

  test.each([
    ['null', null],
    ['an array', ['main']],
    ['a non-JSON value', { branch: new Date() }],
    ['an invalid key', { 'bad.key': 'main' }],
  ])("include rejects 'with:' when it is %s", (_description, withValue) => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'r',
        include: 'acme-review-block',
        with: withValue,
      })
    );
    expect(error.issues.some(issue => issue.path[0] === 'with')).toBe(true);
  });

  test("include accepts and retains typed JSON 'with:' values", () => {
    const result = dagNodeSchema.parse({
      id: 'r',
      include: 'acme-review-block',
      with: { flag: true, count: 3, tags: ['a', 'b'], meta: { k: 'v' }, nothing: null },
    });
    expect((result as IncludeDirective).with).toEqual({
      flag: true,
      count: 3,
      tags: ['a', 'b'],
      meta: { k: 'v' },
      nothing: null,
    });
  });

  test("rejects the reserved node id 'INPUTS'", () => {
    const error = validationError(dagNodeSchema.safeParse({ id: 'INPUTS', prompt: 'work' }));
    const idIssue = error.issues.find(issue => issue.path[0] === 'id');
    expect(idIssue?.message).toContain('$INPUTS.<name>');
  });

  test('include node drops AI/exec fields (they are ignored)', () => {
    const result = dagNodeSchema.parse({
      id: 'r',
      include: 'acme-review-block',
      model: 'opus',
      always_run: true,
      output_type: 'code',
      denied_tools: ['Bash(rm:*)'],
    });
    const node = result as Record<string, unknown>;
    expect(node.model).toBeUndefined();
    expect(node.always_run).toBeUndefined();
    expect(node.output_type).toBeUndefined();
    expect(node.denied_tools).toBeUndefined();
  });
});

describe('dagNodeSchema — launch-only options on an include node (#1764)', () => {
  test.each([
    ['isolation', { isolation: 'worktree' }],
    ['input', { input: 'do the thing' }],
  ])('rejects %s, naming the option and pointing at workflow:', (field, extra) => {
    const error = validationError(
      dagNodeSchema.safeParse({ id: 'review', include: 'blk', ...extra })
    );
    expect(error.issues).toHaveLength(1);
    const message = error.issues.map(i => i.message).join(' | ');
    expect(error.issues[0]?.path).toEqual([field]);
    expect(message).toContain('is not supported on an include node');
    expect(message).toContain("'workflow:' node");
  });

  test.each([undefined, { items: '$list.output', as: 'item', max_parallel: 3 }])(
    'normalizes an include target with or without fan-out (%j)',
    fan_out => {
      const node = dagNodeSchema.parse({ id: 'review', include: '  block  ', fan_out });
      expect(node.kind).toBe(fan_out ? 'compose_fan_out' : 'include');
      expect('include' in node && node.include).toBe('block');
    }
  );

  test.each([
    ['blank target', { include: '   ' }, '', 'must have either'],
    [
      'join',
      { fan_out: { items: '$list.output', as: 'item', join: 'first_success' } },
      'fan_out.join',
      'first_success',
    ],
    [
      'binding name',
      { fan_out: { items: '$list.output', as: '1bad' } },
      'fan_out.as',
      'invalid fan-out input name',
    ],
    [
      'binding collision',
      { fan_out: { items: '$list.output', as: 'item' }, with: { item: 'static' } },
      'fan_out.as',
      'collides',
    ],
    ['ID', { id: 'INPUTS' }, 'id', 'reserved'],
    ['with shape', { with: [] }, 'with', 'must be an object'],
    ['competing mode', { prompt: 'work' }, '', 'mutually exclusive'],
    ['misplaced input', { input: 'work' }, 'input', 'not supported'],
    [
      'workflow-only parallelism',
      { fan_out: { items: '$list.output', as: 'item', max_parallel: 'all' } },
      '',
      '',
    ],
  ])(
    'returns validation issues for a padded include with invalid %s',
    (_name, extra, path, message) => {
      const result = dagNodeSchema.safeParse({ id: 'review', include: '  block  ', ...extra });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            issue => issue.path.join('.') === path && issue.message.includes(message)
          )
        ).toBe(true);
      }
    }
  );

  test.each(['all', 0, 1.5])('compose fan-out rejects max_parallel: %s', max_parallel => {
    expect(
      dagNodeSchema.safeParse({
        id: 'review',
        include: 'blk',
        fan_out: { items: '$list.output', as: 'item', max_parallel },
      }).success
    ).toBe(false);
  });

  test('include + fan_out parses to a deferred compose_fan_out node', () => {
    const result = dagNodeSchema.parse({
      id: 'review',
      include: 'acme-review-block',
      depends_on: ['gather'],
      fan_out: { items: '$list.output', as: 'item', max_parallel: 3 },
    });
    const node = result as ComposeFanOutNode;
    expect(node.kind).toBe('compose_fan_out');
    expect(node.include).toBe('acme-review-block');
    expect(node.fan_out.max_parallel).toBe(3);
    expect(node.fan_out.join).toBe('all_done');
    expect(isIncludeDirective(result)).toBe(false);
  });

  test('compose fan-out requires an explicit item binding', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'review',
        include: 'blk',
        fan_out: { items: '$list.output' },
      })
    );
    expect(error.issues.map(issue => issue.message).join(' | ')).toContain('fan_out.as');
  });

  test('compose fan-out rejects join: first_success', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'review',
        include: 'blk',
        fan_out: { items: '$list.output', join: 'first_success' },
      })
    );
    const message = error.issues.map(i => i.message).join(' | ');
    expect(message).toContain('first_success');
  });

  test('compose fan-out rejects fan_out.as colliding with a with: key', () => {
    const error = validationError(
      dagNodeSchema.safeParse({
        id: 'review',
        include: 'blk',
        with: { item: 'static' },
        fan_out: { items: '$list.output', as: 'item' },
      })
    );
    const message = error.issues.map(i => i.message).join(' | ');
    expect(message).toContain('collides with');
  });

  test('a merely-meaningless AI field on an include node still only warns', () => {
    // The distinction the rejection above rests on: `model:` says nothing composition
    // has to refuse, it is simply unread. INCLUDE_NODE_IGNORED_FIELDS keeps warning.
    const result = dagNodeSchema.safeParse({ id: 'review', include: 'blk', model: 'opus' });
    expect(result.success).toBe(true);
  });
});

describe('INCLUDE_NODE_IGNORED_FIELDS', () => {
  test('is a superset of BASH_NODE_AI_FIELDS plus exec-only fields', () => {
    for (const f of BASH_NODE_AI_FIELDS) {
      expect(INCLUDE_NODE_IGNORED_FIELDS).toContain(f);
    }
    for (const f of ['retry', 'output_type', 'always_run', 'idle_timeout']) {
      expect(INCLUDE_NODE_IGNORED_FIELDS).toContain(f);
    }
    // Structural fields the include node legitimately carries are NOT ignored.
    for (const f of ['id', 'depends_on', 'when', 'trigger_rule', 'include', 'description']) {
      expect(INCLUDE_NODE_IGNORED_FIELDS).not.toContain(f);
    }
  });
});

describe('inputEnvKey (#2470)', () => {
  test('mangles an input name to INPUTS_<UPPER_SNAKE>', () => {
    expect(inputEnvKey('plan')).toBe('INPUTS_PLAN');
    expect(inputEnvKey('base-branch')).toBe('INPUTS_BASE_BRANCH');
    expect(inputEnvKey('foo_bar')).toBe('INPUTS_FOO_BAR');
    // hyphen and underscore fold to the same key — the loader rejects such a pair.
    expect(inputEnvKey('foo-bar')).toBe(inputEnvKey('foo_bar'));
  });
});
