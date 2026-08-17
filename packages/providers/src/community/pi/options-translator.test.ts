import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeConfig } from '../../types';
import { resolvePiSkills, resolvePiThinkingLevel, resolvePiTools } from './options-translator';

// ─── resolvePiThinkingLevel ─────────────────────────────────────────────

describe('resolvePiThinkingLevel', () => {
  test('returns undefined when no config provided', () => {
    expect(resolvePiThinkingLevel(undefined)).toEqual({ level: undefined });
  });

  test('returns undefined for empty config', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
  });

  test('maps valid thinking string directly', () => {
    expect(resolvePiThinkingLevel({ thinking: 'high' })).toEqual({ level: 'high' });
    expect(resolvePiThinkingLevel({ thinking: 'xhigh' })).toEqual({ level: 'xhigh' });
    expect(resolvePiThinkingLevel({ thinking: 'minimal' })).toEqual({ level: 'minimal' });
  });

  test('maps valid effort string directly', () => {
    expect(resolvePiThinkingLevel({ effort: 'medium' })).toEqual({ level: 'medium' });
    expect(resolvePiThinkingLevel({ effort: 'low' })).toEqual({ level: 'low' });
  });

  test('thinking takes precedence when both set', () => {
    expect(resolvePiThinkingLevel({ thinking: 'high', effort: 'low' })).toEqual({ level: 'high' });
  });

  test("'off' on either field returns undefined", () => {
    expect(resolvePiThinkingLevel({ thinking: 'off' })).toEqual({ level: undefined });
    expect(resolvePiThinkingLevel({ effort: 'off' })).toEqual({ level: undefined });
  });

  // Pi's `ThinkingLevel` is Archon's ladder exactly — `max` included
  // (@earendil-works/pi-ai types.d.ts). This previously asserted a downgrade to
  // `xhigh`, which was the bug: `effort: max` meant "as deep as this model goes"
  // everywhere except Pi, where a rung was quietly removed before Pi could apply
  // its own per-model handling.
  test("'max' reaches Pi natively rather than being downgraded", () => {
    expect(resolvePiThinkingLevel({ effort: 'max' })).toEqual({ level: 'max' });
    expect(resolvePiThinkingLevel({ thinking: 'max' })).toEqual({ level: 'max' });
  });

  test('every rung on the ladder passes through Pi unclamped', () => {
    for (const rung of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolvePiThinkingLevel({ effort: rung })).toEqual({ level: rung });
    }
  });

  test('warns on Claude-shape object thinking config', () => {
    const result = resolvePiThinkingLevel({
      thinking: { type: 'enabled', budget_tokens: 4000 },
    } as NodeConfig);
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain('object form is Claude-specific');
    // The REMEDY half, not just the diagnosis. This clause has drifted every
    // time the ladder changed — it is operator-facing advice, and advice that
    // lists the wrong rungs steers authors away from levels Pi supports.
    for (const rung of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(result.warning).toContain(rung);
    }
    // The rung list alone cannot catch the drift it exists for: those six names
    // are already in the vocabulary the message prints, so it stayed green while
    // the parenthetical beside it claimed `max → xhigh on Pi` — the opposite of
    // what this file's own array does.
    //
    // The fix for that was first written as a blacklist of downgrade spellings,
    // which was miscalibrated in BOTH directions: it rejected the true sentence
    // `nothing is clamped` (the exact wording ai-assistants.md uses for this
    // same fact) while passing four false ones, including `Pi downgrades max to
    // xhigh internally` — a plain-prose restatement of the original bug. A
    // blacklist can only ever enumerate the wrong claims someone happened to
    // write before.
    //
    // So assert the TRUE claim positively. Pi accepts the whole ladder; a
    // message that does not say so is either silent about it or contradicting
    // it, and both are the defect. The two narrow patterns stay as cheap
    // belt-and-braces against the historical spellings.
    expect(result.warning).toContain('accepts every rung natively');
    expect(result.warning).not.toMatch(/max\s*(→|->|becomes|maps? to)\s*xhigh/i);
    expect(result.warning).not.toMatch(/xhigh\s+on\s+Pi/i);
  });

  test('warns on unknown string thinking value', () => {
    const result = resolvePiThinkingLevel({ thinking: 'ultra' });
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain("unknown thinking level 'ultra'");
  });

  test('warns on unknown string effort value', () => {
    const result = resolvePiThinkingLevel({ effort: 'crushing' });
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain("unknown thinking level 'crushing'");
  });

  test('no warning when both fields are simply absent', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
    expect(resolvePiThinkingLevel({ thinking: undefined, effort: undefined })).toEqual({
      level: undefined,
    });
  });
});

// ─── resolvePiTools ─────────────────────────────────────────────────────

describe('resolvePiTools', () => {
  const cwd = '/tmp/test-cwd';

  test('returns undefined tools when neither allowed_tools nor denied_tools set', () => {
    expect(resolvePiTools(cwd, undefined)).toEqual({ tools: undefined, unknownTools: [] });
    expect(resolvePiTools(cwd, {})).toEqual({ tools: undefined, unknownTools: [] });
  });

  test('allowed_tools: [] returns empty tools array (no-tools idiom)', () => {
    const result = resolvePiTools(cwd, { allowed_tools: [] });
    expect(result.tools).toEqual([]);
    expect(result.unknownTools).toEqual([]);
  });

  test('allowed_tools: [read, bash] returns exactly those two', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'bash'] });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual([]);
  });

  test('case-insensitive tool names', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['Read', 'BASH', 'Edit'] });
    expect(result.tools).toHaveLength(3);
    expect(result.unknownTools).toEqual([]);
  });

  test('unknown tool names (Claude-specific) collected in unknownTools', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'WebFetch', 'bash'] });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual(['WebFetch']);
  });

  test('denied_tools subtracts from allowed_tools', () => {
    const result = resolvePiTools(cwd, {
      allowed_tools: ['read', 'bash', 'edit'],
      denied_tools: ['bash'],
    });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual([]);
  });

  test('denied_tools alone starts from full built-in set', () => {
    const result = resolvePiTools(cwd, { denied_tools: ['bash', 'write'] });
    // Pi has 7 built-in tools, 2 denied → 5 remain
    expect(result.tools).toHaveLength(5);
    expect(result.unknownTools).toEqual([]);
  });

  test('dedupes duplicate tool names', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'read', 'Read'] });
    expect(result.tools).toHaveLength(1);
  });

  test('allowed and denied both with unknowns flags each', () => {
    const result = resolvePiTools(cwd, {
      allowed_tools: ['read', 'UnknownA'],
      denied_tools: ['UnknownB'],
    });
    expect(result.tools).toHaveLength(1); // only 'read'
    expect(result.unknownTools).toEqual(['UnknownA', 'UnknownB']);
  });

  test('no allow/deny with non-empty env → returns Pi default 4-tool set with env-aware bash', () => {
    const result = resolvePiTools(cwd, undefined, { DATABASE_URL: 'postgres://x' });
    expect(result.tools).toHaveLength(4); // read/bash/edit/write
    expect(result.unknownTools).toEqual([]);
  });

  test('no allow/deny with empty env → still returns undefined (Pi defaults)', () => {
    expect(resolvePiTools(cwd, undefined, {})).toEqual({ tools: undefined, unknownTools: [] });
    expect(resolvePiTools(cwd, {}, {})).toEqual({ tools: undefined, unknownTools: [] });
  });

  test('env passthrough does not affect unknown tool reporting', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'WebFetch'] }, { FOO: 'bar' });
    expect(result.tools).toHaveLength(1);
    expect(result.unknownTools).toEqual(['WebFetch']);
  });
});

// ─── resolvePiSkills ───────────────────────────────────────────────────────
//
// Uses a temp directory to stage synthetic skill layouts — avoids relying on
// whatever the developer has in ~/.claude/skills/ or ~/.agents/skills/.

describe('resolvePiSkills', () => {
  let tmpRoot: string;
  let cwd: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'archon-pi-skills-'));
    cwd = join(tmpRoot, 'project');
    const home = join(tmpRoot, 'home');

    // Redirect os.homedir() by setting HOME before imports use it. Our
    // resolver calls homedir() at function-call time (not module load),
    // so setting HOME mid-test is safe.
    originalHome = process.env.HOME;
    process.env.HOME = home;

    // Staging:
    //   <cwd>/.agents/skills/alpha/SKILL.md
    //   <cwd>/.claude/skills/bravo/SKILL.md
    //   <home>/.agents/skills/charlie/SKILL.md
    //   <home>/.claude/skills/delta/SKILL.md
    //   <home>/.claude/skills/shared/SKILL.md  (also in <cwd>/.claude/skills/shared/)
    //   <cwd>/.claude/skills/shared/SKILL.md
    const stage = [
      [join(cwd, '.agents', 'skills', 'alpha'), 'SKILL.md'],
      [join(cwd, '.claude', 'skills', 'bravo'), 'SKILL.md'],
      [join(home, '.agents', 'skills', 'charlie'), 'SKILL.md'],
      [join(home, '.claude', 'skills', 'delta'), 'SKILL.md'],
      [join(cwd, '.claude', 'skills', 'shared'), 'SKILL.md'],
      [join(home, '.claude', 'skills', 'shared'), 'SKILL.md'],
      // A dir without SKILL.md — must not resolve
      [join(cwd, '.claude', 'skills', 'no-skill-md'), '.keep'],
    ];
    for (const [dir, file] of stage) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), '# skill content\n');
    }
  });

  afterAll(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('returns empty for undefined/empty input', () => {
    expect(resolvePiSkills(cwd, undefined)).toEqual({ paths: [], missing: [] });
    expect(resolvePiSkills(cwd, [])).toEqual({ paths: [], missing: [] });
  });

  test('resolves project-local .agents/skills', () => {
    const result = resolvePiSkills(cwd, ['alpha']);
    expect(result.missing).toEqual([]);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toContain(join('.agents', 'skills', 'alpha'));
  });

  test('resolves project-local .claude/skills', () => {
    const result = resolvePiSkills(cwd, ['bravo']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join('.claude', 'skills', 'bravo'));
  });

  test('resolves user-global .agents/skills', () => {
    const result = resolvePiSkills(cwd, ['charlie']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join('.agents', 'skills', 'charlie'));
  });

  test('resolves user-global .claude/skills', () => {
    const result = resolvePiSkills(cwd, ['delta']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join('.claude', 'skills', 'delta'));
  });

  test('project-local wins over user-global when both present', () => {
    const result = resolvePiSkills(cwd, ['shared']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join(cwd, '.claude', 'skills', 'shared'));
  });

  test('dir without SKILL.md does not resolve', () => {
    const result = resolvePiSkills(cwd, ['no-skill-md']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['no-skill-md']);
  });

  test('unknown skill name is reported in missing', () => {
    const result = resolvePiSkills(cwd, ['does-not-exist']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['does-not-exist']);
  });

  test('mixed resolvable + unresolvable returns both', () => {
    const result = resolvePiSkills(cwd, ['alpha', 'does-not-exist', 'bravo']);
    expect(result.paths).toHaveLength(2);
    expect(result.missing).toEqual(['does-not-exist']);
  });

  test('dedupes duplicate names', () => {
    const result = resolvePiSkills(cwd, ['alpha', 'alpha']);
    expect(result.paths).toHaveLength(1);
  });

  test('ignores empty-string and non-string names', () => {
    const result = resolvePiSkills(cwd, ['', 'alpha']);
    expect(result.paths).toHaveLength(1);
  });
});
