import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyTextsSource } from '../../workflows/sdlc/.shared/policy-sync';
import { writePolicyDefaults } from '../../workflows/sdlc/.shared/policy-defaults';

const shared = join(import.meta.dir, '../../workflows/sdlc/.shared');
let dir = '';
const saved = process.env.ARTIFACTS_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env.ARTIFACTS_DIR;
  else process.env.ARTIFACTS_DIR = saved;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('default policy documents', () => {
  it('the generated module carries every policy document as written (run policy-sync.ts when this fails)', () => {
    const generated = readFileSync(join(shared, 'policy-texts.generated.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(generated).toBe(policyTextsSource());
  });

  it('a policy node writes every default into the run, where triage reads it', () => {
    // A run's capture keeps no .md from .shared/; triage on 2026-10-26 found no default and stopped.
    dir = mkdtempSync(join(tmpdir(), 'policy-defaults-'));
    process.env.ARTIFACTS_DIR = dir;
    const out = writePolicyDefaults();
    const names = readdirSync(join(shared, 'policy')).filter(name => name.endsWith('.md')).sort();
    expect(names).toContain('triage.md');
    for (const name of names) {
      expect(existsSync(join(out, name))).toBe(true);
      expect(readFileSync(join(out, name), 'utf8')).toBe(
        readFileSync(join(shared, 'policy', name), 'utf8').replace(/\r\n/g, '\n')
      );
    }
  });
});
