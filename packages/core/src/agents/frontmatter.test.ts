import { describe, expect, test } from 'bun:test';
import {
  coerceModel,
  coerceStatus,
  coerceStringArray,
  parseAgentMd,
  serializeAgentMd,
  validateAgentName,
} from './frontmatter';
import { AgentFrontmatterError, AgentNameError } from './types';

describe('parseAgentMd', () => {
  test('parses standard frontmatter + body', () => {
    const src =
      '---\nname: alpha\ndescription: A test agent.\nmodel: sonnet\n---\n\nYou are alpha.\n';
    const parsed = parseAgentMd(src);
    expect(parsed.frontmatter.name).toBe('alpha');
    expect(parsed.frontmatter.description).toBe('A test agent.');
    expect(parsed.frontmatter.model).toBe('sonnet');
    expect(parsed.body.trim()).toBe('You are alpha.');
  });

  test('throws on missing opening delimiter', () => {
    expect(() => parseAgentMd('no front matter here\n')).toThrow(AgentFrontmatterError);
  });

  test('throws on missing closing delimiter', () => {
    expect(() => parseAgentMd('---\nname: x\ndescription: y\n')).toThrow(AgentFrontmatterError);
  });

  test('throws when frontmatter is a YAML array', () => {
    expect(() => parseAgentMd('---\n- one\n- two\n---\n\nbody\n')).toThrow(AgentFrontmatterError);
  });

  test('handles empty frontmatter block', () => {
    const parsed = parseAgentMd('---\n---\n\nbody only\n');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body.trim()).toBe('body only');
  });

  test('preserves unknown frontmatter keys', () => {
    const src = '---\nname: a\ndescription: d\nfoo: 42\nbar:\n  - 1\n  - 2\n---\n\nb\n';
    const parsed = parseAgentMd(src);
    expect(parsed.frontmatter.foo).toBe(42);
    expect(parsed.frontmatter.bar).toEqual([1, 2]);
  });
});

describe('serializeAgentMd', () => {
  test('writes preferred-key order then alphabetical', () => {
    const out = serializeAgentMd(
      {
        custom: 'last-of-extras',
        name: 'a',
        description: 'd',
        zzz: 'z',
        model: 'sonnet',
        tools: ['Read'],
      },
      'body\n'
    );
    expect(out.startsWith('---\n')).toBe(true);
    const yaml = out.split('\n---\n')[0]!;
    expect(yaml.indexOf('name:')).toBeLessThan(yaml.indexOf('description:'));
    expect(yaml.indexOf('description:')).toBeLessThan(yaml.indexOf('model:'));
    expect(yaml.indexOf('model:')).toBeLessThan(yaml.indexOf('tools:'));
    // 'custom' and 'zzz' come after preferred keys, sorted.
    expect(yaml.indexOf('custom:')).toBeLessThan(yaml.indexOf('zzz:'));
  });

  test('round-trips through parse', () => {
    const fm = { name: 'r', description: 'd', model: 'haiku', tools: ['Bash', 'Read'] };
    const serialized = serializeAgentMd(fm, 'hello world\n');
    const parsed = parseAgentMd(serialized);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body.trim()).toBe('hello world');
  });
});

describe('validateAgentName', () => {
  test('accepts kebab-case', () => {
    expect(() => validateAgentName('code-reviewer')).not.toThrow();
    expect(() => validateAgentName('agent42')).not.toThrow();
  });
  test('rejects uppercase, spaces, dots', () => {
    expect(() => validateAgentName('Bad Name')).toThrow(AgentNameError);
    expect(() => validateAgentName('with.dot')).toThrow(AgentNameError);
    expect(() => validateAgentName('UpperCase')).toThrow(AgentNameError);
  });
  test('rejects reserved names', () => {
    expect(() => validateAgentName('claude')).toThrow(AgentNameError);
    expect(() => validateAgentName('anthropic')).toThrow(AgentNameError);
  });
  test('rejects underscore-prefixed names', () => {
    expect(() => validateAgentName('_template')).toThrow(AgentNameError);
  });
  test('rejects empty / overly long names', () => {
    expect(() => validateAgentName('')).toThrow(AgentNameError);
    expect(() => validateAgentName('a'.repeat(65))).toThrow(AgentNameError);
  });
});

describe('coerce helpers', () => {
  test('coerceStatus defaults to active', () => {
    expect(coerceStatus(undefined)).toBe('active');
    expect(coerceStatus('garbage')).toBe('active');
    expect(coerceStatus('draft')).toBe('draft');
    expect(coerceStatus('archived')).toBe('archived');
  });
  test('coerceModel returns null on empty/invalid', () => {
    expect(coerceModel(undefined)).toBe(null);
    expect(coerceModel(42)).toBe(null);
    expect(coerceModel('  ')).toBe(null);
    expect(coerceModel('opus')).toBe('opus');
  });
  test('coerceStringArray ignores non-string entries', () => {
    expect(coerceStringArray(undefined)).toEqual([]);
    expect(coerceStringArray('one')).toEqual([]);
    expect(coerceStringArray(['a', 1, 'b', null])).toEqual(['a', 'b']);
  });
});
