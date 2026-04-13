import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  scanPathForSensitiveKeys,
  EnvLeakError,
  formatLeakError,
  SENSITIVE_KEYS,
  AUTOLOADED_FILES,
} from './env-leak-scanner';

describe('scanPathForSensitiveKeys', () => {
  const tmpDir = '/tmp/archon-test-env-scan';

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty findings for clean directory', () => {
    const report = scanPathForSensitiveKeys(tmpDir);
    expect(report.findings).toHaveLength(0);
  });

  it('returns empty findings for non-existent directory', () => {
    const report = scanPathForSensitiveKeys('/tmp/archon-test-nonexistent-dir');
    expect(report.findings).toHaveLength(0);
  });

  // Each sensitive key × each auto-loaded filename
  for (const key of SENSITIVE_KEYS) {
    for (const filename of AUTOLOADED_FILES) {
      it(`detects ${key} in ${filename}`, () => {
        writeFileSync(join(tmpDir, filename), `${key}=sk-test-value\nOTHER=safe\n`);
        const report = scanPathForSensitiveKeys(tmpDir);
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].file).toBe(filename);
        expect(report.findings[0].keys).toContain(key);
        // Clean up for next iteration
        rmSync(join(tmpDir, filename));
      });
    }
  }

  it('ignores commented-out keys', () => {
    writeFileSync(join(tmpDir, '.env'), '# ANTHROPIC_API_KEY=value\n');
    const report = scanPathForSensitiveKeys(tmpDir);
    expect(report.findings).toHaveLength(0);
  });

  it('ignores lines without =', () => {
    writeFileSync(join(tmpDir, '.env'), 'ANTHROPIC_API_KEY\n');
    const report = scanPathForSensitiveKeys(tmpDir);
    expect(report.findings).toHaveLength(0);
  });

  it('reports multiple files with findings', () => {
    writeFileSync(join(tmpDir, '.env'), 'ANTHROPIC_API_KEY=sk-1\n');
    writeFileSync(join(tmpDir, '.env.local'), 'OPENAI_API_KEY=sk-2\n');
    const report = scanPathForSensitiveKeys(tmpDir);
    expect(report.findings).toHaveLength(2);
  });

  it('reports multiple keys in same file', () => {
    writeFileSync(join(tmpDir, '.env'), 'ANTHROPIC_API_KEY=sk-1\nOPENAI_API_KEY=sk-2\n');
    const report = scanPathForSensitiveKeys(tmpDir);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].keys).toHaveLength(2);
  });

  it('ignores non-autoloaded filenames', () => {
    writeFileSync(join(tmpDir, '.env.secrets'), 'ANTHROPIC_API_KEY=sk-1\n');
    const report = scanPathForSensitiveKeys(tmpDir);
    expect(report.findings).toHaveLength(0);
  });

  it('ignores safe keys', () => {
    writeFileSync(join(tmpDir, '.env'), 'DATABASE_URL=postgres://localhost\nNODE_ENV=dev\n');
    const report = scanPathForSensitiveKeys(tmpDir);
    expect(report.findings).toHaveLength(0);
  });
});

describe('EnvLeakError', () => {
  it('is instanceof EnvLeakError and Error', () => {
    const report = { path: '/tmp', findings: [{ file: '.env', keys: ['ANTHROPIC_API_KEY'] }] };
    const err = new EnvLeakError(report);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EnvLeakError);
    expect(err.name).toBe('EnvLeakError');
    expect(err.message).toContain('ANTHROPIC_API_KEY');
    expect(err.report).toBe(report);
  });

  it('defaults context to register-ui and stores it on the error', () => {
    const report = { path: '/x', findings: [{ file: '.env', keys: ['ANTHROPIC_API_KEY'] }] };
    const err = new EnvLeakError(report);
    expect(err.context).toBe('register-ui');
    expect(err.message).toContain('Add Project');
  });

  it('produces distinct remediation bodies per context', () => {
    const report = { path: '/x', findings: [{ file: '.env', keys: ['ANTHROPIC_API_KEY'] }] };
    const ui = formatLeakError(report, 'register-ui');
    const cli = formatLeakError(report, 'register-cli');
    const spawn = formatLeakError(report, 'spawn-existing');
    expect(ui).toContain('Add Project');
    expect(cli).toContain('--allow-env-keys');
    expect(cli).toContain('allow_target_repo_keys');
    expect(spawn).toContain('Settings');
    expect(spawn).toContain('already-registered');
    // headers differ between register and spawn
    expect(ui).toContain('Cannot add codebase');
    expect(spawn).toContain('Cannot run workflow');
  });

  it('formats remediation command with the offending single key', () => {
    const report = { path: '/x', findings: [{ file: '.env', keys: ['OPENAI_API_KEY'] }] };
    const message = formatLeakError(report, 'register-ui');

    expect(message).toContain("Remove the key from this repo's .env");
    expect(message).toContain("grep -vE '^(OPENAI_API_KEY)=' .env > .env.tmp && mv .env.tmp .env");
  });

  it('formats remediation command with all offending keys', () => {
    const report = {
      path: '/x',
      findings: [{ file: '.env', keys: ['GEMINI_API_KEY', 'OPENAI_API_KEY'] }],
    };
    const message = formatLeakError(report, 'register-ui');

    expect(message).toContain("Remove the keys from this repo's .env");
    expect(message).toContain(
      "grep -vE '^(GEMINI_API_KEY|OPENAI_API_KEY)=' .env > .env.tmp && mv .env.tmp .env"
    );
    expect(message).not.toContain("grep -v '^ANTHROPIC_API_KEY=' .env");
  });

  it('formats multiple findings', () => {
    const report = {
      path: '/test',
      findings: [
        { file: '.env', keys: ['ANTHROPIC_API_KEY'] },
        { file: '.env.local', keys: ['OPENAI_API_KEY', 'GEMINI_API_KEY'] },
      ],
    };
    const err = new EnvLeakError(report);
    expect(err.message).toContain('.env');
    expect(err.message).toContain('.env.local');
    expect(err.message).toContain('OPENAI_API_KEY');
    expect(err.message).toContain('GEMINI_API_KEY');
  });
});
