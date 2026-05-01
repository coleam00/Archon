import { describe, test, expect } from 'bun:test';
import { parseSkillMd, serializeSkillMd, validateSkillName, derivePrefix } from './frontmatter';
import { SkillFrontmatterError, SkillNameError } from './types';

describe('parseSkillMd', () => {
  test('parses standard frontmatter + body', () => {
    const input = `---
name: my-skill
description: A test skill
---

# Heading

Body content.
`;
    const { frontmatter, body } = parseSkillMd(input);
    expect(frontmatter).toEqual({ name: 'my-skill', description: 'A test skill' });
    expect(body.startsWith('\n# Heading')).toBe(true);
  });

  test('preserves unknown frontmatter keys', () => {
    const input = `---
name: x
description: y
argument-hint: "[arg]"
allowed-tools:
  - Bash
  - WebFetch
---

body
`;
    const { frontmatter } = parseSkillMd(input);
    expect(frontmatter['argument-hint']).toBe('[arg]');
    expect(frontmatter['allowed-tools']).toEqual(['Bash', 'WebFetch']);
  });

  test('handles CRLF line endings', () => {
    const input = '---\r\nname: x\r\ndescription: y\r\n---\r\n\r\nBody\r\n';
    const { frontmatter, body } = parseSkillMd(input);
    expect(frontmatter.name).toBe('x');
    expect(body.includes('Body')).toBe(true);
  });

  test('throws when frontmatter is not closed', () => {
    const input = `---
name: x
description: y

# Body without closing delimiter
`;
    expect(() => parseSkillMd(input)).toThrow(SkillFrontmatterError);
  });

  test('throws when file does not start with ---', () => {
    expect(() => parseSkillMd('# Just markdown\n')).toThrow(SkillFrontmatterError);
  });

  test('throws on invalid YAML', () => {
    const input = `---
name: x
description: : :
---

body
`;
    expect(() => parseSkillMd(input)).toThrow(SkillFrontmatterError);
  });

  test('treats empty frontmatter as {}', () => {
    const input = `---
---

body
`;
    const { frontmatter, body } = parseSkillMd(input);
    expect(frontmatter).toEqual({});
    expect(body.includes('body')).toBe(true);
  });
});

describe('serializeSkillMd', () => {
  test('round-trips through parse without losing keys', () => {
    const original = `---
name: my-skill
description: |
  Multi
  line
argument-hint: "[arg]"
---

# Body

Some text.
`;
    const parsed = parseSkillMd(original);
    const serialized = serializeSkillMd(parsed.frontmatter, parsed.body);
    const reparsed = parseSkillMd(serialized);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
    expect(reparsed.body.trim()).toBe(parsed.body.trim());
  });

  test('puts name and description first regardless of input order', () => {
    const yaml = serializeSkillMd(
      { 'argument-hint': '[a]', description: 'd', extra: 'e', name: 'n' },
      'body'
    );
    const lines = yaml.split('\n');
    // line 0 is "---", line 1 should be name
    expect(lines[1]?.startsWith('name:')).toBe(true);
    expect(lines[2]?.startsWith('description:')).toBe(true);
  });

  test('ends with exactly one trailing newline', () => {
    const out = serializeSkillMd({ name: 'x', description: 'y' }, 'body\n\n\n');
    expect(out.endsWith('\nbody\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('validateSkillName', () => {
  test('accepts valid names', () => {
    expect(() => validateSkillName('archon')).not.toThrow();
    expect(() => validateSkillName('atw-review')).not.toThrow();
    expect(() => validateSkillName('a1b2-c3')).not.toThrow();
  });

  test('rejects uppercase', () => {
    expect(() => validateSkillName('MySkill')).toThrow(SkillNameError);
  });

  test('rejects underscores and spaces', () => {
    expect(() => validateSkillName('my_skill')).toThrow(SkillNameError);
    expect(() => validateSkillName('my skill')).toThrow(SkillNameError);
  });

  test('rejects path separators', () => {
    expect(() => validateSkillName('foo/bar')).toThrow(SkillNameError);
    expect(() => validateSkillName('../etc')).toThrow(SkillNameError);
  });

  test('rejects reserved words', () => {
    expect(() => validateSkillName('anthropic')).toThrow(SkillNameError);
    expect(() => validateSkillName('claude')).toThrow(SkillNameError);
  });

  test('rejects empty and over-length', () => {
    expect(() => validateSkillName('')).toThrow(SkillNameError);
    expect(() => validateSkillName('a'.repeat(65))).toThrow(SkillNameError);
  });
});

describe('derivePrefix', () => {
  test('returns prefix before first colon', () => {
    expect(derivePrefix('claude-api:pdf')).toBe('claude-api');
  });

  test('returns prefix before first hyphen when no colon', () => {
    expect(derivePrefix('atw-review')).toBe('atw');
    expect(derivePrefix('gws-gmail')).toBe('gws');
    expect(derivePrefix('recipe-find-free-time')).toBe('recipe');
  });

  test('returns null when no separator', () => {
    expect(derivePrefix('archon')).toBe(null);
    expect(derivePrefix('diagnose')).toBe(null);
  });

  test('returns null for trailing-only hyphen', () => {
    expect(derivePrefix('foo-')).toBe(null);
  });
});
