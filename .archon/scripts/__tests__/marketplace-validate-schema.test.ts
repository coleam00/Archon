import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const VALIDATOR = resolve(import.meta.dir, '../marketplace-validate-schema.ts');

interface FileResult {
  name: string;
  valid: boolean;
  errors: string[];
}

interface ValidateOutput {
  valid: boolean;
  files: FileResult[];
  note?: string;
}

/**
 * Run the real marketplace-validate-schema.ts against a temp ARTIFACTS_DIR.
 * Pass `null` to omit the source/ directory entirely; otherwise pass a map of
 * relative path -> file content to populate source/.
 */
function runValidator(sourceFiles: Record<string, string> | null): ValidateOutput {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'validate-schema-'));
  if (sourceFiles) {
    const sourceDir = join(artifactsDir, 'source');
    mkdirSync(sourceDir, { recursive: true });
    for (const [rel, content] of Object.entries(sourceFiles)) {
      const full = join(sourceDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  const output = execFileSync('bun', [VALIDATOR], {
    env: { ...process.env, ARTIFACTS_DIR: artifactsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return JSON.parse(output) as ValidateOutput;
}

const VALID_WORKFLOW = `name: test-workflow
description: A minimal valid workflow for the empty-submission contract test.
nodes:
  - id: hello
    bash: echo hi
`;

// The empty-list contract these tests pin: `files: []` means "no workflow YAML
// found at the pinned SHA". validate-schema emits valid:true for it (nothing
// FAILED validation), but the decide node in marketplace-pr-review-and-merge
// must treat an empty list as request_changes, never as a merge signal (B3).
describe('marketplace-validate-schema: empty-submission contract', () => {
  it('returns files:[] when there is no source directory', () => {
    const result = runValidator(null);
    expect(result.files).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('returns files:[] when source has no YAML at all', () => {
    const result = runValidator({ 'README.md': '# just docs\n' });
    expect(result.files).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('returns files:[] when YAML exists but none is workflow-shaped (no top-level nodes:)', () => {
    const result = runValidator({ 'brand.yaml': 'name: brand\ncolor: blue\n' });
    expect(result.files).toHaveLength(0);
    expect(result.valid).toBe(true);
  });
});

describe('marketplace-validate-schema: non-empty contrast', () => {
  it('returns a non-empty files list for a real workflow', () => {
    const result = runValidator({ 'workflow.yaml': VALID_WORKFLOW });
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.every((f) => f.valid)).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('flags a workflow-shaped YAML that fails schema (files non-empty, valid:false)', () => {
    const result = runValidator({
      'bad.yaml': 'name: bad\nnodes:\n  - id: broken\n    provider: nonexistent-provider\n    prompt: hi\n',
    });
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });
});
