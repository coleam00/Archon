import { describe, expect, it } from 'bun:test';
import { trackTempRoots } from '@archon/paths/test-utils';
import { cpSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SCANNER = resolve(import.meta.dir, '../marketplace-security-scan.ts');
const FIXTURES = resolve(import.meta.dir, 'fixtures');

interface ScanFinding {
  file: string;
  line: number;
  category: string;
  pattern: string;
  context: string;
}

interface ScanOutput {
  severity: string;
  finding_count: number;
  findings: ScanFinding[];
}

const trackTempRoot = trackTempRoots();

function createTempRoot(prefix: string): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), prefix)));
}

function runScanner(sourceDir: string): ScanOutput {
  const artifactsDir = createTempRoot('scan-test-');
  const destSource = join(artifactsDir, 'source');
  cpSync(sourceDir, destSource, { recursive: true });
  const output = execFileSync('bun', [SCANNER], {
    env: { ...process.env, ARTIFACTS_DIR: artifactsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return JSON.parse(output) as ScanOutput;
}

describe('marketplace-security-scan', () => {
  it('reports every malicious category and the highest severity', () => {
    const result = runScanner(join(FIXTURES, 'malicious'));
    const categories = [...new Set(result.findings.map(finding => finding.category))].sort();

    expect(categories).toEqual([
      'cred_leak',
      'exfil',
      'obfuscation',
      'path_escape',
      'rce',
      'reverse_shell',
      'shell_exec',
      'suspicious_network',
      'unsafe_permissions',
    ]);
    expect(result.severity).toBe('critical');
    expect(result.finding_count).toBe(result.findings.length);
  });

  it('accepts benign source', () => {
    const result = runScanner(join(FIXTURES, 'benign'));
    expect(result.findings).toHaveLength(0);
    expect(result.severity).toBe('none');
    expect(result.finding_count).toBe(0);
  });

  it('accepts an empty source directory', () => {
    const result = runScanner(createTempRoot('scan-empty-'));
    expect(result.findings).toHaveLength(0);
    expect(result.severity).toBe('none');
    expect(result.finding_count).toBe(0);
  });
});
