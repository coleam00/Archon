import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import { detectClaudeExecutablePath, writeHomePiModelConfig } from './setup-provider-auth';
import * as providerAuth from './setup-provider-auth';

describe('detectClaudeExecutablePath probe order', () => {
  // Use spies on the exported probe wrappers so each tier can be controlled
  // independently without touching the real filesystem or shell.
  let fileExistsSpy: ReturnType<typeof spyOn>;
  let npmRootSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fileExistsSpy = spyOn(providerAuth, 'probeFileExists').mockReturnValue(false);
    npmRootSpy = spyOn(providerAuth, 'probeNpmRoot').mockReturnValue(null);
    whichSpy = spyOn(providerAuth, 'probeWhichClaude').mockReturnValue(null);
  });

  afterEach(() => {
    fileExistsSpy.mockRestore();
    npmRootSpy.mockRestore();
    whichSpy.mockRestore();
  });

  it('returns the native installer path when present (tier 1 wins)', () => {
    // Native path exists; subsequent probes must not be called.
    fileExistsSpy.mockImplementation(
      (p: string) => p.includes('.local/bin/claude') || p.includes('.local\\bin\\claude')
    );
    const result = detectClaudeExecutablePath();
    expect(result).toBeTruthy();
    expect(result).toMatch(/\.local[\\/]bin[\\/]claude/);
    // Tier 2 / 3 must not have been consulted.
    expect(npmRootSpy).not.toHaveBeenCalled();
    expect(whichSpy).not.toHaveBeenCalled();
  });

  it('falls through to npm cli.js when native is missing (tier 2 wins)', () => {
    // Use path.join so the expected result matches whatever separator the
    // production code produces on the current platform (backslash on Windows,
    // forward slash elsewhere).
    const npmRoot = join('fake', 'npm', 'root');
    const expectedCliJs = join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    npmRootSpy.mockReturnValue(npmRoot);
    fileExistsSpy.mockImplementation((p: string) => p === expectedCliJs);
    const result = detectClaudeExecutablePath();
    expect(result).toBe(expectedCliJs);
    // Tier 3 must not have been consulted.
    expect(whichSpy).not.toHaveBeenCalled();
  });

  it('falls through to which/where when native and npm probes both miss (tier 3 wins)', () => {
    npmRootSpy.mockReturnValue('/fake/npm/root');
    // Native miss, npm cli.js miss, but `which claude` returns a path that exists.
    whichSpy.mockReturnValue('/opt/homebrew/bin/claude');
    fileExistsSpy.mockImplementation((p: string) => p === '/opt/homebrew/bin/claude');
    const result = detectClaudeExecutablePath();
    expect(result).toBe('/opt/homebrew/bin/claude');
  });

  it('returns null when every probe misses', () => {
    // All defaults already return false/null; nothing to override.
    expect(detectClaudeExecutablePath()).toBeNull();
  });

  it('does not return a which-resolved path that fails the existsSync check', () => {
    // `which` returns a path string but the file is not actually present
    // (stale PATH entry, dangling symlink, etc.) — must not be returned.
    npmRootSpy.mockReturnValue('/fake/npm/root');
    whichSpy.mockReturnValue('/stale/path/claude');
    fileExistsSpy.mockReturnValue(false);
    expect(detectClaudeExecutablePath()).toBeNull();
  });

  it('skips npm tier when probeNpmRoot returns null (e.g. npm not installed)', () => {
    // npm probe fails; tier 3 must still run.
    whichSpy.mockReturnValue('/usr/local/bin/claude');
    fileExistsSpy.mockImplementation((p: string) => p === '/usr/local/bin/claude');
    const result = detectClaudeExecutablePath();
    expect(result).toBe('/usr/local/bin/claude');
    expect(npmRootSpy).toHaveBeenCalled();
  });
});

describe('writeHomePiModelConfig', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archon-pi-config-'));
    originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpDir;
  });

  afterEach(async () => {
    await removeTempTree(tmpDir);
    if (originalHome !== undefined) {
      process.env.ARCHON_HOME = originalHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
  });

  it('writes fresh assistants.pi.model block when config is empty', () => {
    writeHomePiModelConfig('anthropic/claude-haiku-4-5');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('assistants:');
    expect(content).toContain('pi:');
    expect(content).toContain('model: "anthropic/claude-haiku-4-5"');
  });

  it('writes fresh block when config does not exist yet', () => {
    // No config.yaml pre-created — function must create it.
    writeHomePiModelConfig('openai/gpt-4o');
    expect(existsSync(join(tmpDir, 'config.yaml'))).toBe(true);
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('pi:');
    expect(content).toContain('model: "openai/gpt-4o"');
  });

  it('skips write when existing config already contains pi: (idempotent)', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), 'assistants:\n  pi:\n    model: "old"\n');
    writeHomePiModelConfig('anthropic/claude-haiku-4-5');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('model: "old"');
    expect(content).not.toContain('claude-haiku-4-5');
  });

  it('does not write pi: block when config has assistants: but no pi: (shows note instead)', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), 'assistants:\n  claude:\n    model: sonnet\n');
    writeHomePiModelConfig('openai/gpt-4o');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    // Should NOT have injected a pi: key — only a note() was shown.
    expect(content).not.toContain('pi:');
  });

  it('escapes double quotes in the model name', () => {
    writeHomePiModelConfig('vendor/"weird-model"');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('\\"weird-model\\"');
  });

  it('does not false-positive on api: substring (regex guard for includes bug)', () => {
    // A config with `api:` but no `pi:` should fall through to the append branch,
    // not the idempotent-skip branch.
    writeFileSync(join(tmpDir, 'config.yaml'), '# config\napi:\n  key: abc\n');
    writeHomePiModelConfig('openai/gpt-4o');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('pi:');
  });
});
