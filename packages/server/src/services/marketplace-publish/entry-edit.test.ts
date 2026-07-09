import { describe, test, expect, beforeAll } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseEntries,
  decideAction,
  applyEdit,
  emitEntry,
  lintEntry,
  type MarketplaceEntryCandidate,
} from './entry-edit';

// Real-file fixture: the actual checked-in marketplace.ts source text, exactly
// as the plan specifies ("parse real-file fixture — copy of current
// marketplace.ts source text"). Read fresh each run so the fixture never
// drifts from the file it's protecting.
const MARKETPLACE_TS_PATH = join(import.meta.dir, '../../../../docs-web/src/data/marketplace.ts');

let realSource: string;
beforeAll(async () => {
  realSource = await readFile(MARKETPLACE_TS_PATH, 'utf-8');
});

describe('parseEntries (real-file fixture)', () => {
  test('extracts every entry with slug + author', () => {
    const { entries } = parseEntries(realSource);
    expect(entries.length).toBeGreaterThanOrEqual(9);
    expect(entries.map(e => e.slug)).toContain('archon-piv-loop');
    const pivLoop = entries.find(e => e.slug === 'archon-piv-loop');
    expect(pivLoop?.author).toBe('coleam00');
  });

  test('tolerates coleam00 entries using unquoted sha / template-literal sourceUrl', () => {
    const { entries } = parseEntries(realSource);
    const pivLoop = entries.find(e => e.slug === 'archon-piv-loop');
    expect(pivLoop).toBeDefined();
    // sha here is `SHA` (a const reference, unquoted) — parseEntries only
    // needs slug/author (always quoted), so this entry still parses cleanly.
    expect(pivLoop?.text).toContain('sha: SHA');
  });

  test('locates a plausible array span', () => {
    const parsed = parseEntries(realSource);
    expect(parsed.arrayOpenIndex).toBeGreaterThan(0);
    expect(parsed.arrayCloseIndex).toBeGreaterThan(parsed.arrayOpenIndex);
    expect(realSource[parsed.arrayOpenIndex]).toBe('[');
    expect(realSource[parsed.arrayCloseIndex]).toBe(']');
  });

  test('throws when the array declaration is missing', () => {
    expect(() => parseEntries('export const somethingElse = [];')).toThrow();
  });

  test('throws when the array is unterminated', () => {
    expect(() =>
      parseEntries("export const marketplaceEntries: MarketplaceEntry[] = [ { slug: 'x' }")
    ).toThrow('Unterminated marketplaceEntries array');
  });

  test('does not corrupt entry boundaries when a field value contains { } [ ] characters', () => {
    // A description mentioning JSON/template syntax embeds unbalanced-looking
    // structural characters inside a STRING VALUE — the brace/bracket scan
    // must treat these as opaque text, not real nesting.
    const fixture = `export const marketplaceEntries: MarketplaceEntry[] = [
  {
    slug: 'templating-flow',
    name: 'Templating Flow',
    author: 'seanrobertwright',
    description: 'Renders {{name}} and outputs an array like [a, b, c] plus a stray } and ] too.',
    sourceUrl: 'https://github.com/seanrobertwright/proj/blob/main/workflow.yaml',
    sha: '3333333333333333333333333333333333333333',
    tags: ['development'],
    archonVersionCompat: '>=0.3.0',
  },
  {
    slug: 'second-flow',
    name: 'Second Flow',
    author: 'seanrobertwright',
    description: 'A second, unrelated entry that must still parse correctly.',
    sourceUrl: 'https://github.com/seanrobertwright/proj/blob/main/second.yaml',
    sha: '4444444444444444444444444444444444444444',
    tags: ['automation'],
    archonVersionCompat: '>=0.3.0',
  },
];
`;
    const { entries } = parseEntries(fixture);
    expect(entries.map(e => e.slug)).toEqual(['templating-flow', 'second-flow']);
    expect(entries[0]?.text).toContain('{{name}}');
  });

  test('does not corrupt entry boundaries when a field value contains an escaped quote', () => {
    const fixture = `export const marketplaceEntries: MarketplaceEntry[] = [
  {
    slug: 'quote-flow',
    name: 'Quote Flow',
    author: 'seanrobertwright',
    description: 'Uses a workflow named \\'special\\' with braces {like this}.',
    sourceUrl: 'https://github.com/seanrobertwright/proj/blob/main/workflow.yaml',
    sha: '5555555555555555555555555555555555555555',
    tags: ['development'],
    archonVersionCompat: '>=0.3.0',
  },
];
`;
    const { entries } = parseEntries(fixture);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe('quote-flow');
  });
});

describe('decideAction', () => {
  const entries = [{ slug: 'existing-slug', author: 'alice', start: 0, end: 10, text: '{}' }];

  test('append when the slug is unseen', () => {
    expect(decideAction(entries, 'brand-new-slug', 'alice')).toEqual({ kind: 'append' });
  });

  test('update when the slug matches and the author matches (case-insensitive)', () => {
    const result = decideAction(entries, 'existing-slug', 'Alice');
    expect(result.kind).toBe('update');
  });

  test('collision when the slug matches but the author differs', () => {
    const result = decideAction(entries, 'existing-slug', 'bob');
    expect(result.kind).toBe('collision');
  });
});

const REALISTIC_CANDIDATE: MarketplaceEntryCandidate = {
  slug: 'spike-realistic',
  name: 'Spike Realistic',
  author: 'seanrobertwright',
  description:
    'A realistic entry whose sourceUrl embeds a forty-hex SHA and a marketplace bundle path, forcing the Prettier wrapped form for both fields.',
  sourceUrl:
    'https://github.com/seanrobertwright/some-project/tree/abc1234567890abc1234567890abc1234567890a/.archon/marketplace/spike-realistic',
  sha: 'abc1234567890abc1234567890abc1234567890a',
  tags: ['development'],
  archonVersionCompat: '>=0.5.0',
};

describe('emitEntry (S4 spike-verified snapshots)', () => {
  test('wraps description + sourceUrl, keeps short fields inline (the realistic shape)', () => {
    const expected = [
      '  {',
      "    slug: 'spike-realistic',",
      "    name: 'Spike Realistic',",
      "    author: 'seanrobertwright',",
      '    description:',
      "      'A realistic entry whose sourceUrl embeds a forty-hex SHA and a marketplace bundle path, forcing the Prettier wrapped form for both fields.',",
      '    sourceUrl:',
      "      'https://github.com/seanrobertwright/some-project/tree/abc1234567890abc1234567890abc1234567890a/.archon/marketplace/spike-realistic',",
      "    sha: 'abc1234567890abc1234567890abc1234567890a',",
      "    tags: ['development'],",
      "    archonVersionCompat: '>=0.5.0',",
      '  },',
    ].join('\n');
    expect(emitEntry(REALISTIC_CANDIDATE)).toBe(expected);
  });

  test('keeps a short description inline', () => {
    const candidate: MarketplaceEntryCandidate = {
      ...REALISTIC_CANDIDATE,
      description: 'Short description.',
      sourceUrl: 'https://github.com/o/r/blob/main/workflow.yaml',
    };
    const out = emitEntry(candidate);
    expect(out).toContain("    description: 'Short description.',");
    expect(out).not.toContain('    description:\n');
  });

  test('wraps whenever the inline form would exceed the 100-column printWidth', () => {
    // Prettier can't split a single string literal further — once wrapped, the
    // continuation line legitimately exceeds printWidth if the value itself does
    // (exactly what the spike-verified snapshot above shows for description/sourceUrl).
    // What must hold is: inline iff the single-line form fits.
    for (const [field, value] of Object.entries({
      slug: REALISTIC_CANDIDATE.slug,
      name: REALISTIC_CANDIDATE.name,
      author: REALISTIC_CANDIDATE.author,
      sha: REALISTIC_CANDIDATE.sha,
      archonVersionCompat: REALISTIC_CANDIDATE.archonVersionCompat,
    })) {
      const inlineForm = `    ${field}: '${value}',`;
      expect(inlineForm.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('applyEdit — append', () => {
  test('inserts the new entry immediately before the closing "];"', () => {
    const parsed = parseEntries(realSource);
    const updated = applyEdit(realSource, parsed, { kind: 'append' }, REALISTIC_CANDIDATE);
    expect(updated).toContain(emitEntry(REALISTIC_CANDIDATE));
    // Still parses cleanly after the edit, with the new entry present.
    const reparsed = parseEntries(updated);
    expect(reparsed.entries.map(e => e.slug)).toContain('spike-realistic');
    // The array must still close correctly.
    expect(updated.slice(0, 40)).toBe(realSource.slice(0, 40));
  });
});

describe('applyEdit — update', () => {
  test('replaces only the sha (in both the sha field and sourceUrl) and archonVersionCompat', () => {
    const fixture = `export const marketplaceEntries: MarketplaceEntry[] = [
  {
    slug: 'my-flow',
    name: 'My Flow',
    author: 'seanrobertwright',
    description: 'A flow.',
    sourceUrl: 'https://github.com/seanrobertwright/proj/tree/1111111111111111111111111111111111111111/.archon/marketplace/my-flow',
    sha: '1111111111111111111111111111111111111111',
    tags: ['development'],
    archonVersionCompat: '>=0.4.0',
  },
];
`;
    const parsed = parseEntries(fixture);
    const action = decideAction(parsed.entries, 'my-flow', 'seanrobertwright');
    expect(action.kind).toBe('update');

    const candidate: MarketplaceEntryCandidate = {
      slug: 'my-flow',
      name: 'My Flow',
      author: 'seanrobertwright',
      description: 'A flow.',
      sourceUrl:
        'https://github.com/seanrobertwright/proj/tree/2222222222222222222222222222222222222222/.archon/marketplace/my-flow',
      sha: '2222222222222222222222222222222222222222',
      tags: ['development'],
      archonVersionCompat: '>=0.5.0',
    };
    const updated = applyEdit(fixture, parsed, action, candidate);

    expect(updated).not.toContain('1111111111111111111111111111111111111111');
    expect(updated).toContain("sha: '2222222222222222222222222222222222222222'");
    expect(updated).toContain(
      '/tree/2222222222222222222222222222222222222222/.archon/marketplace/my-flow'
    );
    expect(updated).toContain("archonVersionCompat: '>=0.5.0'");
    // Only one entry total — update does not append a second entry.
    expect(parseEntries(updated).entries).toHaveLength(1);
    // Untouched fields survive verbatim.
    expect(updated).toContain("name: 'My Flow'");
  });
});

describe('applyEdit — update defensive error', () => {
  test('throws when the matched entry has no quoted 40-hex sha to replace', () => {
    const fixture = `export const marketplaceEntries: MarketplaceEntry[] = [
  {
    slug: 'templated',
    name: 'Templated',
    author: 'coleam00',
    description: 'Uses a const reference, not a quoted literal.',
    sourceUrl: \`\${BASE}/templated.yaml\`,
    sha: SHA,
    tags: ['development'],
    archonVersionCompat: '>=0.3.0',
  },
];
`;
    const parsed = parseEntries(fixture);
    const action = decideAction(parsed.entries, 'templated', 'coleam00');
    expect(action.kind).toBe('update');
    expect(() => applyEdit(fixture, parsed, action, REALISTIC_CANDIDATE)).toThrow(
      'no quoted 40-hex'
    );
  });
});

describe('applyEdit — collision', () => {
  test('throws rather than writing anything', () => {
    const parsed = { entries: [], arrayOpenIndex: 0, arrayCloseIndex: 1 };
    expect(() =>
      applyEdit(
        '',
        parsed,
        {
          kind: 'collision',
          existing: { slug: 'x', author: 'other', start: 0, end: 1, text: '{}' },
        },
        REALISTIC_CANDIDATE
      )
    ).toThrow();
  });
});

describe('lintEntry (S2 replicated field checks)', () => {
  const VALID = REALISTIC_CANDIDATE;

  test('passes for a fully valid candidate with no slug collision', () => {
    expect(lintEntry(VALID, [])).toEqual([]);
  });

  test('flags a duplicate slug', () => {
    expect(lintEntry(VALID, [VALID.slug])).toContainEqual(
      expect.stringContaining('Duplicate slug')
    );
  });

  test('flags an invalid slug', () => {
    const issues = lintEntry({ ...VALID, slug: 'Not Valid!' }, []);
    expect(issues.some(i => i.includes('slug must be lowercase'))).toBe(true);
  });

  test('flags blank name/author/description/archonVersionCompat', () => {
    const issues = lintEntry(
      { ...VALID, name: '  ', author: '', description: '\t', archonVersionCompat: '' },
      []
    );
    expect(issues.some(i => i.includes('name is required'))).toBe(true);
    expect(issues.some(i => i.includes('author is required'))).toBe(true);
    expect(issues.some(i => i.includes('description is required'))).toBe(true);
    expect(issues.some(i => i.includes('archonVersionCompat is required'))).toBe(true);
  });

  test('flags a malformed or uppercase sha', () => {
    expect(lintEntry({ ...VALID, sha: 'not-a-sha' }, []).length).toBeGreaterThan(0);
    expect(
      lintEntry({ ...VALID, sha: 'ABC1234567890ABC1234567890ABC1234567890A' }, []).length
    ).toBeGreaterThan(0);
  });

  test('flags an empty tags array', () => {
    expect(lintEntry({ ...VALID, tags: [] }, []).some(i => i.includes('at least one tag'))).toBe(
      true
    );
  });

  test('flags a sourceUrl not on an allowed host', () => {
    expect(
      lintEntry({ ...VALID, sourceUrl: 'https://gitlab.com/o/r' }, []).some(i =>
        i.includes('sourceUrl must start with')
      )
    ).toBe(true);
  });
});
