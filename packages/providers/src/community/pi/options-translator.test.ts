import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolvePiSkills, resolvePiThinkingLevel, resolvePiTools } from './options-translator';

// ─── resolvePiThinkingLevel ─────────────────────────────────────────────

describe('resolvePiThinkingLevel', () => {
  test('returns undefined when no config provided', () => {
    expect(resolvePiThinkingLevel(undefined)).toEqual({ level: undefined });
  });

  test('returns undefined for empty config', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
  });

  // Pi's native `ThinkingLevel` matches Archon's ladder through `max`
  // (@earendil-works/pi-ai types.d.ts); Codex-only `ultra` clamps separately.
  // This previously asserted a downgrade to
  // `xhigh`, which was the bug: `effort: max` meant "as deep as this model goes"
  // everywhere except Pi, where a rung was quietly removed before Pi could apply
  // its own per-model handling.
  test("'max' reaches Pi natively rather than being downgraded", () => {
    expect(resolvePiThinkingLevel({ effort: 'max' })).toEqual({ level: 'max' });
  });

  test('every Pi-native rung passes through unclamped', () => {
    for (const rung of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolvePiThinkingLevel({ effort: rung })).toEqual({ level: rung });
    }
  });

  test("'ultra' clamps to Pi's strongest native rung", () => {
    expect(resolvePiThinkingLevel({ effort: 'ultra' })).toEqual({ level: 'max' });
    expect(resolvePiThinkingLevel({ effort: 'persistent' })).toEqual({ level: 'max' });
  });

  test('no warning when effort is absent', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
    expect(resolvePiThinkingLevel({ effort: undefined })).toEqual({
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

  test('allowed_tools: [] returns empty tools array (no built-in tools)', () => {
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

  test("a run's identity in the request env reaches the command Pi's bash tool spawns", async () => {
    const env = {
      WORKFLOW_ID: 'run-1',
      ARCHON_NODE_EXECUTION: '{"runId":"run-1","path":"notes"}',
      ARCHON_CLI_COMMAND: '["/opt/archon/bin/archon"]',
    };
    const bash = resolvePiTools(tmpdir(), undefined, env).tools?.find(t => t.name === 'bash');
    if (!bash) throw new Error('expected an env-aware bash tool');
    const result = await bash.execute('call-1', {
      command: 'printf "%s\\n" "$WORKFLOW_ID" "$ARCHON_NODE_EXECUTION" "$ARCHON_CLI_COMMAND"',
    });
    expect(result.content).toEqual([{ type: 'text', text: `${Object.values(env).join('\n')}\n` }]);
  });

  test('env passthrough does not affect unknown tool reporting', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'WebFetch'] }, { FOO: 'bar' });
    expect(result.tools).toHaveLength(1);
    expect(result.unknownTools).toEqual(['WebFetch']);
  });
});

// ─── resolvePiSkills ───────────────────────────────────────────────────────
//
// `resolvePiSkills` re-exports `resolveSkillDirectories`, whose own cases live in
// packages/paths/src/skills.test.ts. These cover what those do not: the
// ~/.claude/skills root and a mixed resolvable + missing list.

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

    const stage = [
      join(cwd, '.agents', 'skills', 'alpha'),
      join(cwd, '.claude', 'skills', 'bravo'),
      join(home, '.claude', 'skills', 'delta'),
    ];
    for (const dir of stage) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '# skill content\n');
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

  test('resolves user-global .claude/skills', () => {
    const result = resolvePiSkills(cwd, ['delta']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join('.claude', 'skills', 'delta'));
  });

  test('mixed resolvable + unresolvable returns both', () => {
    const result = resolvePiSkills(cwd, ['alpha', 'does-not-exist', 'bravo']);
    expect(result.paths).toHaveLength(2);
    expect(result.missing).toEqual(['does-not-exist']);
  });
});
