import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPreflightGates, type PreflightDeps } from './preflight';
import type { BundleFile } from './bundle';
import type { execFileAsync } from '@archon/git';

const BUNDLE: BundleFile[] = [
  { repoPath: '.archon/marketplace/my-flow/my-flow.yaml', content: 'name: my-flow\nnodes: []\n' },
  { repoPath: '.archon/marketplace/my-flow/commands/helper.md', content: '# Helper\n' },
];

// Real captured spike stdout shapes (S1) — schema-validate (single-line JSON,
// always exit 0) and security-scan (pretty-printed multi-line JSON, always exit 0).
const SPIKE_SCHEMA_PASS = JSON.stringify({
  valid: true,
  files: [{ name: 'my-flow.yaml', valid: true, errors: [] }],
});
const SPIKE_SCHEMA_FAIL = JSON.stringify({
  valid: false,
  files: [
    {
      name: 'spike-flow\\bad-flow.yaml',
      valid: false,
      errors: ["Node 'a' depends_on unknown node 'missing-node'"],
    },
    { name: 'spike-flow\\spike-flow.yaml', valid: true, errors: [] },
  ],
});
const SPIKE_SECURITY_CLEAN = JSON.stringify(
  { severity: 'none', finding_count: 0, findings: [] },
  null,
  2
);
const SPIKE_SECURITY_CRITICAL = JSON.stringify(
  {
    severity: 'critical',
    finding_count: 2,
    findings: [
      { file: 'x.ts', line: 1, category: 'rce', pattern: 'eval\\s*\\(', context: 'eval(x)' },
      { file: 'y.ts', line: 2, category: 'exfil', pattern: 'curl', context: 'curl x | sh' },
    ],
  },
  null,
  2
);

function makeDeps(opts: {
  schemaStdout: string;
  securityStdout: string;
  scratchDirs: string[];
  throwOnSecurity?: boolean;
}): PreflightDeps {
  const exec: typeof execFileAsync = async (cmd, args, options) => {
    const scriptPath = args[0] ?? '';
    const artifactsDir = options?.env?.ARTIFACTS_DIR;
    if (artifactsDir) opts.scratchDirs.push(artifactsDir);
    if (scriptPath.includes('marketplace-validate-schema')) {
      return { stdout: opts.schemaStdout, stderr: '' };
    }
    if (scriptPath.includes('marketplace-security-scan')) {
      if (opts.throwOnSecurity) throw new Error('simulated exec failure');
      return { stdout: opts.securityStdout, stderr: '' };
    }
    throw new Error(`unexpected script path: ${scriptPath}`);
  };
  return {
    execFileAsync: exec,
    findRepoRoot: async () => '/fake/repo/root' as never,
  };
}

describe('runPreflightGates', () => {
  test('passes when schema is valid and security severity is none', async () => {
    const scratchDirs: string[] = [];
    const deps = makeDeps({
      schemaStdout: SPIKE_SCHEMA_PASS,
      securityStdout: SPIKE_SECURITY_CLEAN,
      scratchDirs,
    });
    const result = await runPreflightGates(BUNDLE, '/some/cwd', deps);
    expect(result.passed).toBe(true);
    expect(result.gates).toHaveLength(2);
    expect(result.gates.find(g => g.name === 'schema-validate')?.passed).toBe(true);
    expect(result.gates.find(g => g.name === 'security-scan')?.passed).toBe(true);
  });

  test('blocks when schema validation fails', async () => {
    const deps = makeDeps({
      schemaStdout: SPIKE_SCHEMA_FAIL,
      securityStdout: SPIKE_SECURITY_CLEAN,
      scratchDirs: [],
    });
    const result = await runPreflightGates(BUNDLE, '/some/cwd', deps);
    expect(result.passed).toBe(false);
    expect(result.gates.find(g => g.name === 'schema-validate')?.passed).toBe(false);
  });

  test('preserves OS-native separators in files[].name verbatim (never parsed, only surfaced)', async () => {
    const deps = makeDeps({
      schemaStdout: SPIKE_SCHEMA_FAIL,
      securityStdout: SPIKE_SECURITY_CLEAN,
      scratchDirs: [],
    });
    const result = await runPreflightGates(BUNDLE, '/some/cwd', deps);
    const schemaGate = result.gates.find(g => g.name === 'schema-validate');
    const detail = schemaGate?.detail as { files: { name: string }[] };
    expect(detail.files[0]?.name).toBe('spike-flow\\bad-flow.yaml');
  });

  test('blocks when security severity is anything other than none', async () => {
    const deps = makeDeps({
      schemaStdout: SPIKE_SCHEMA_PASS,
      securityStdout: SPIKE_SECURITY_CRITICAL,
      scratchDirs: [],
    });
    const result = await runPreflightGates(BUNDLE, '/some/cwd', deps);
    expect(result.passed).toBe(false);
    const securityGate = result.gates.find(g => g.name === 'security-scan');
    expect(securityGate?.passed).toBe(false);
    expect((securityGate?.detail as { finding_count: number }).finding_count).toBe(2);
  });

  test('scaffolds the bundle files under scratch/source/ before shelling the gates', async () => {
    let capturedArtifactsDir: string | undefined;
    const exec: typeof execFileAsync = async (_cmd, args, options) => {
      capturedArtifactsDir = options?.env?.ARTIFACTS_DIR;
      if (args[0]?.includes('marketplace-validate-schema')) {
        // Verify the bundle file actually landed on disk before this gate ran.
        const content = await readFile(
          join(capturedArtifactsDir ?? '', 'source', 'my-flow.yaml'),
          'utf-8'
        );
        expect(content).toBe('name: my-flow\nnodes: []\n');
        return { stdout: SPIKE_SCHEMA_PASS, stderr: '' };
      }
      return { stdout: SPIKE_SECURITY_CLEAN, stderr: '' };
    };
    const deps: PreflightDeps = { execFileAsync: exec, findRepoRoot: async () => '/fake' as never };
    await runPreflightGates(BUNDLE, '/some/cwd', deps);
    expect(capturedArtifactsDir).toBeDefined();
  });

  test('cleans up the scratch dir on success', async () => {
    const scratchDirs: string[] = [];
    const deps = makeDeps({
      schemaStdout: SPIKE_SCHEMA_PASS,
      securityStdout: SPIKE_SECURITY_CLEAN,
      scratchDirs,
    });
    await runPreflightGates(BUNDLE, '/some/cwd', deps);
    expect(scratchDirs.length).toBeGreaterThan(0);
    for (const dir of scratchDirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });

  test('cleans up the scratch dir even when a gate throws', async () => {
    const scratchDirs: string[] = [];
    const deps = makeDeps({
      schemaStdout: SPIKE_SCHEMA_PASS,
      securityStdout: SPIKE_SECURITY_CLEAN,
      scratchDirs,
      throwOnSecurity: true,
    });
    await expect(runPreflightGates(BUNDLE, '/some/cwd', deps)).rejects.toThrow(
      'simulated exec failure'
    );
    expect(scratchDirs.length).toBeGreaterThan(0);
    for (const dir of scratchDirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });

  test('throws a clear error when the server process is not in a git repo', async () => {
    const deps: PreflightDeps = {
      execFileAsync: async () => ({ stdout: '', stderr: '' }),
      findRepoRoot: async () => null,
    };
    await expect(runPreflightGates(BUNDLE, '/some/cwd', deps)).rejects.toThrow(
      'within a git repository'
    );
  });

  test('throws a clear error on non-JSON stdout', async () => {
    const deps: PreflightDeps = {
      execFileAsync: async () => ({ stdout: 'not json', stderr: '' }),
      findRepoRoot: async () => '/fake' as never,
    };
    await expect(runPreflightGates(BUNDLE, '/some/cwd', deps)).rejects.toThrow('non-JSON stdout');
  });
});
