import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
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

function runScanner(sourceDir: string): ScanOutput {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'scan-test-'));
  const destSource = join(artifactsDir, 'source');
  cpSync(sourceDir, destSource, { recursive: true });
  const output = execFileSync('bun', [SCANNER], {
    env: { ...process.env, ARTIFACTS_DIR: artifactsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  return JSON.parse(output) as ScanOutput;
}

function scanSingleFixture(fixturePath: string, destName: string): ScanOutput {
  const dir = mkdtempSync(join(tmpdir(), 'scan-single-'));
  writeFileSync(join(dir, destName), readFileSync(fixturePath));
  return runScanner(dir);
}

describe('marketplace-security-scan: malicious fixtures', () => {
  it('detects rce category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/rce.ts'), 'rce.ts');
    expect(result.findings.some((f) => f.category === 'rce')).toBe(true);
    expect(result.severity).toBe('critical');
  });

  it('detects exfil category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/exfil.sh'), 'exfil.sh');
    expect(result.findings.some((f) => f.category === 'exfil')).toBe(true);
    expect(result.severity).toBe('critical');
  });

  it('detects reverse_shell category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/reverse_shell.sh'), 'reverse_shell.sh');
    expect(result.findings.some((f) => f.category === 'reverse_shell')).toBe(true);
    expect(result.severity).toBe('critical');
  });

  it('detects cred_leak category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/cred_leak.ts'), 'cred_leak.ts');
    expect(result.findings.some((f) => f.category === 'cred_leak')).toBe(true);
    expect(['high', 'critical']).toContain(result.severity);
  });

  it('detects obfuscation category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/obfuscated.ts'), 'obfuscated.ts');
    expect(result.findings.some((f) => f.category === 'obfuscation')).toBe(true);
    expect(['high', 'critical']).toContain(result.severity);
  });

  it('detects unsafe_permissions category', () => {
    const result = scanSingleFixture(
      join(FIXTURES, 'malicious/unsafe_permissions.yaml'),
      'unsafe_permissions.yaml',
    );
    expect(result.findings.some((f) => f.category === 'unsafe_permissions')).toBe(true);
    expect(['high', 'critical']).toContain(result.severity);
  });

  it('detects path_escape category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/path_escape.ts'), 'path_escape.ts');
    expect(result.findings.some((f) => f.category === 'path_escape')).toBe(true);
    expect(['medium', 'high', 'critical']).toContain(result.severity);
  });

  it('detects shell_exec category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/shell_exec.ts'), 'shell_exec.ts');
    expect(result.findings.some((f) => f.category === 'shell_exec')).toBe(true);
    expect(['medium', 'high', 'critical']).toContain(result.severity);
  });

  it('detects suspicious_network category', () => {
    const result = scanSingleFixture(join(FIXTURES, 'malicious/suspicious_network.sh'), 'suspicious_network.sh');
    expect(result.findings.some((f) => f.category === 'suspicious_network')).toBe(true);
    expect(['medium', 'high', 'critical']).toContain(result.severity);
  });
});

describe('marketplace-security-scan: benign fixtures', () => {
  it('produces no findings for clean-workflow.yaml', () => {
    const result = scanSingleFixture(join(FIXTURES, 'benign/clean-workflow.yaml'), 'workflow.yaml');
    expect(result.findings).toHaveLength(0);
    expect(result.severity).toBe('none');
  });

  it('produces no findings for clean-script.ts', () => {
    const result = scanSingleFixture(join(FIXTURES, 'benign/clean-script.ts'), 'script.ts');
    expect(result.findings).toHaveLength(0);
    expect(result.severity).toBe('none');
  });

  it('produces no findings for clean-fetch.ts', () => {
    const result = scanSingleFixture(join(FIXTURES, 'benign/clean-fetch.ts'), 'fetch.ts');
    expect(result.findings).toHaveLength(0);
    expect(result.severity).toBe('none');
  });
});

describe('marketplace-security-scan: empty source', () => {
  it('returns severity none for empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    const result = runScanner(dir);
    expect(result.findings).toHaveLength(0);
    expect(result.severity).toBe('none');
  });
});
