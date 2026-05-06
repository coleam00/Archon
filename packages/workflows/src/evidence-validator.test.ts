import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock logger BEFORE importing module under test ---

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
}));

// --- Mock @archon/git BEFORE importing module under test (Group C reality stubs) ---
//
// CLAUDE.md: mock.module() is process-global and irreversible. This file is
// added as its own `bun test` invocation in package.json so this mock cannot
// pollute other test files.

interface ExecCall {
  cmd: string;
  args: string[];
}

const execFileCalls: ExecCall[] = [];
let execFileImpl: (
  cmd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }> = () =>
  Promise.resolve({ stdout: '', stderr: '' });

mock.module('@archon/git', () => ({
  execFileAsync: async (
    cmd: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> => {
    execFileCalls.push({ cmd, args });
    return execFileImpl(cmd, args);
  },
}));

// --- Imports (after mocks) ---

import {
  validateEvidence,
  validateEvidenceShape,
  validateEvidenceIntegrity,
  verifyEvidenceReality,
  loadEvidenceFromArtifacts,
} from './evidence-validator';
import type { ExecutionEvidence } from './schemas';

// --- Fixtures ---

function makeRealExecutionEvidence(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kind: 'execution',
    workflow_run_id: 'run-1',
    provider: 'claude',
    provider_run_ids: ['session-abc'],
    changed_files: ['src/foo.ts'],
    diff_command: 'git diff --stat origin/dev...HEAD',
    test_commands: ['bun test'],
    test_output_summary: '15 passed',
    commit_sha: 'a'.repeat(40),
    pushed_branch: 'feature/foo',
    pr_url: 'https://github.com/owner/repo/pull/42',
    pr_number: 42,
    ...overrides,
  };
}

function makePlanningEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'planning',
    workflow_run_id: 'run-1',
    provider: 'claude',
    summary: 'wrote plan.md',
    ...overrides,
  };
}

const REAL_EVIDENCE: ExecutionEvidence = {
  kind: 'execution',
  workflow_run_id: 'run-1',
  provider: 'claude',
  provider_run_ids: ['session-abc'],
  changed_files: ['src/foo.ts'],
  diff_command: 'git diff --stat origin/dev...HEAD',
  test_commands: ['bun test'],
  test_output_summary: '15 passed',
  commit_sha: 'a'.repeat(40),
  pushed_branch: 'feature/foo',
  pr_url: 'https://github.com/owner/repo/pull/42',
  pr_number: 42,
};

// =============================================================================
// Group A — validateEvidenceShape
// =============================================================================

describe('validateEvidenceShape', () => {
  it('positive: full execution evidence parses', () => {
    const result = validateEvidenceShape(makeRealExecutionEvidence());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.evidence.kind).toBe('execution');
    }
  });

  it('positive: planning evidence parses (rejected later by integrity)', () => {
    const result = validateEvidenceShape(makePlanningEvidence());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.evidence.kind).toBe('planning');
    }
  });

  it('negative: missing commit_sha emits error on commit_sha field', () => {
    const raw = makeRealExecutionEvidence();
    delete raw.commit_sha;
    const result = validateEvidenceShape(raw);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'commit_sha')).toBe(true);
    }
  });

  it('negative: short commit_sha rejected', () => {
    const result = validateEvidenceShape(makeRealExecutionEvidence({ commit_sha: 'abc1234' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'commit_sha')).toBe(true);
    }
  });

  it('negative: uppercase commit_sha rejected (must be lowercase hex)', () => {
    const result = validateEvidenceShape(makeRealExecutionEvidence({ commit_sha: 'A'.repeat(40) }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'commit_sha')).toBe(true);
    }
  });

  it('negative: non-hex commit_sha rejected', () => {
    const result = validateEvidenceShape(makeRealExecutionEvidence({ commit_sha: 'z'.repeat(40) }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'commit_sha')).toBe(true);
    }
  });

  it('negative: http (not https) pr_url rejected', () => {
    const result = validateEvidenceShape(
      makeRealExecutionEvidence({ pr_url: 'http://github.com/owner/repo/pull/42' })
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'pr_url')).toBe(true);
    }
  });

  it('negative: non-github pr_url rejected', () => {
    const result = validateEvidenceShape(
      makeRealExecutionEvidence({ pr_url: 'https://gitlab.com/owner/repo/pull/42' })
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'pr_url')).toBe(true);
    }
  });

  it('negative: empty provider_run_ids array rejected', () => {
    const result = validateEvidenceShape(makeRealExecutionEvidence({ provider_run_ids: [] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field.startsWith('provider_run_ids'))).toBe(true);
    }
  });

  it('negative: empty changed_files array rejected', () => {
    const result = validateEvidenceShape(makeRealExecutionEvidence({ changed_files: [] }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field.startsWith('changed_files'))).toBe(true);
    }
  });

  it("negative: { kind: 'execution' } only — many missing-field errors", () => {
    const result = validateEvidenceShape({ kind: 'execution' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // commit_sha, pushed_branch, pr_url, pr_number, changed_files, etc.
      expect(result.issues.length).toBeGreaterThan(3);
    }
  });

  it('negative: malformed (string) raw value rejected', () => {
    const result = validateEvidenceShape('{ "broken": json');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('negative: null raw value rejected', () => {
    const result = validateEvidenceShape(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('negative: array raw value rejected', () => {
    const result = validateEvidenceShape(['some', 'array']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('negative: number raw value rejected', () => {
    const result = validateEvidenceShape(42);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('negative: missing kind field rejected', () => {
    const raw = makeRealExecutionEvidence();
    delete raw.kind;
    const result = validateEvidenceShape(raw);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'kind')).toBe(true);
    }
  });
});

// =============================================================================
// Group B — validateEvidenceIntegrity
// =============================================================================

describe('validateEvidenceIntegrity', () => {
  it('positive: well-formed execution evidence on feature branch returns []', () => {
    const issues = validateEvidenceIntegrity(REAL_EVIDENCE);
    expect(issues).toEqual([]);
  });

  it("negative: kind: 'planning' rejected with hint", () => {
    const issues = validateEvidenceIntegrity({
      kind: 'planning',
      workflow_run_id: 'r',
      provider: 'claude',
      summary: 's',
    });
    expect(issues.length).toBe(1);
    expect(issues[0].field).toBe('kind');
  });

  it("negative: pushed_branch === 'main' rejected", () => {
    const issues = validateEvidenceIntegrity({ ...REAL_EVIDENCE, pushed_branch: 'main' });
    expect(issues.some(i => i.field === 'pushed_branch')).toBe(true);
  });

  it("negative: pushed_branch === 'master' rejected", () => {
    const issues = validateEvidenceIntegrity({ ...REAL_EVIDENCE, pushed_branch: 'master' });
    expect(issues.some(i => i.field === 'pushed_branch')).toBe(true);
  });

  it("negative: pushed_branch === 'dev' rejected", () => {
    const issues = validateEvidenceIntegrity({ ...REAL_EVIDENCE, pushed_branch: 'dev' });
    expect(issues.some(i => i.field === 'pushed_branch')).toBe(true);
  });

  it("negative: pushed_branch === 'develop' rejected", () => {
    const issues = validateEvidenceIntegrity({ ...REAL_EVIDENCE, pushed_branch: 'develop' });
    expect(issues.some(i => i.field === 'pushed_branch')).toBe(true);
  });

  it('negative: zero-tree commit_sha rejected', () => {
    const issues = validateEvidenceIntegrity({ ...REAL_EVIDENCE, commit_sha: '0'.repeat(40) });
    expect(issues.some(i => i.field === 'commit_sha')).toBe(true);
  });
});

// =============================================================================
// Group C — verifyEvidenceReality
// =============================================================================

describe('verifyEvidenceReality', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileImpl = () => Promise.resolve({ stdout: '', stderr: '' });
  });

  it('positive: all 3 shells succeed and gh JSON matches → []', async () => {
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return Promise.resolve({
          stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
          stderr: '',
        });
      }
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'feature/foo',
            number: 42,
            headRefOid: 'a'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues).toEqual([]);
  });

  it('negative: ls-remote tip SHA mismatches commit_sha → commit_sha error', async () => {
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        // Branch exists, but tip is a DIFFERENT commit than evidence claims.
        return Promise.resolve({
          stdout: `${'b'.repeat(40)}\trefs/heads/feature/foo\n`,
          stderr: '',
        });
      }
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'feature/foo',
            number: 42,
            headRefOid: 'a'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(
      issues.some(
        i => i.field === 'commit_sha' && i.message.includes('does not match origin/feature/foo tip')
      )
    ).toBe(true);
  });

  it('negative: gh headRefOid mismatches commit_sha → commit_sha error', async () => {
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return Promise.resolve({
          stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
          stderr: '',
        });
      }
      if (cmd === 'gh') {
        // PR HEAD is a DIFFERENT commit than evidence claims.
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'feature/foo',
            number: 42,
            headRefOid: 'c'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues.some(i => i.field === 'commit_sha' && i.message.includes('headRefOid'))).toBe(
      true
    );
  });

  it('negative: git cat-file exits non-zero → commit_sha error', async () => {
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        const err = Object.assign(new Error('command failed'), { stderr: 'fatal: bad object' });
        return Promise.reject(err);
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return Promise.resolve({
          stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
          stderr: '',
        });
      }
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'feature/foo',
            number: 42,
            headRefOid: 'a'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues.some(i => i.field === 'commit_sha')).toBe(true);
  });

  it('negative: git ls-remote returns empty → pushed_branch error', async () => {
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'feature/foo',
            number: 42,
            headRefOid: 'a'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues.some(i => i.field === 'pushed_branch')).toBe(true);
  });

  it('negative: gh headRefName mismatch → pr_url error', async () => {
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return Promise.resolve({
          stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
          stderr: '',
        });
      }
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'other-branch',
            number: 42,
            headRefOid: 'a'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues.some(i => i.field === 'pr_url')).toBe(true);
  });

  it('negative: gh number mismatch → pr_number error', async () => {
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return Promise.resolve({
          stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
          stderr: '',
        });
      }
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'feature/foo',
            number: 99,
            headRefOid: 'a'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues.some(i => i.field === 'pr_number')).toBe(true);
  });

  it('negative: gh binary missing (ENOENT) → pr_url error with install hint', async () => {
    execFileImpl = (cmd, _args) => {
      if (cmd === 'git') {
        if (_args[0] === 'cat-file') return Promise.resolve({ stdout: '', stderr: '' });
        if (_args[0] === 'ls-remote') {
          return Promise.resolve({
            stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
            stderr: '',
          });
        }
      }
      if (cmd === 'gh') {
        const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues.some(i => i.field === 'pr_url' && i.hint?.includes('gh auth'))).toBe(true);
  });

  it('negative: gh non-JSON output → pr_url error', async () => {
    execFileImpl = (cmd, _args) => {
      if (cmd === 'git') {
        if (_args[0] === 'cat-file') return Promise.resolve({ stdout: '', stderr: '' });
        if (_args[0] === 'ls-remote') {
          return Promise.resolve({
            stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
            stderr: '',
          });
        }
      }
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: 'not json at all', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const issues = await verifyEvidenceReality(REAL_EVIDENCE, '/repo');
    expect(issues.some(i => i.field === 'pr_url')).toBe(true);
  });

  it('negative: planning evidence rejected with kind error', async () => {
    const planning = {
      kind: 'planning' as const,
      workflow_run_id: 'r',
      provider: 'claude',
      summary: 's',
    };
    const issues = await verifyEvidenceReality(planning, '/repo');
    expect(issues.some(i => i.field === 'kind')).toBe(true);
  });
});

// =============================================================================
// Group D — loadEvidenceFromArtifacts
// =============================================================================

describe('loadEvidenceFromArtifacts', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `evidence-load-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('returns { found: false } when file is missing', async () => {
    const result = await loadEvidenceFromArtifacts(testDir);
    expect(result.found).toBe(false);
  });

  it('returns parsed JSON when file present and valid', async () => {
    await writeFile(join(testDir, 'evidence.json'), JSON.stringify(makeRealExecutionEvidence()));
    const result = await loadEvidenceFromArtifacts(testDir);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(typeof result.raw).toBe('object');
    }
  });

  it('returns raw string when file is malformed JSON (no throw)', async () => {
    await writeFile(join(testDir, 'evidence.json'), '{ broken json');
    const result = await loadEvidenceFromArtifacts(testDir);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(typeof result.raw).toBe('string');
    }
  });

  it('absolute path rejected when piped through validateEvidence', async () => {
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'shape', path: '/etc/passwd' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'evidence_policy.path')).toBe(true);
    }
  });

  it("'..'-segment path rejected when piped through validateEvidence", async () => {
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'shape', path: '../escape.json' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'evidence_policy.path')).toBe(true);
    }
  });
});

// =============================================================================
// Group E — validateEvidence (orchestrator)
// =============================================================================

describe('validateEvidence (orchestrator)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `evidence-orch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    execFileCalls.length = 0;
    execFileImpl = () => Promise.resolve({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('missing file returns evidence_policy.path issue', async () => {
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'shape', path: 'evidence.json' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'evidence_policy.path')).toBe(true);
    }
  });

  it('shape error returns at shape layer; reality stub never called', async () => {
    await writeFile(
      join(testDir, 'evidence.json'),
      JSON.stringify(makeRealExecutionEvidence({ commit_sha: 'short' }))
    );
    let realityCalls = 0;
    execFileImpl = () => {
      realityCalls++;
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'reality', path: 'evidence.json' },
    });
    expect(result.valid).toBe(false);
    expect(realityCalls).toBe(0);
  });

  it('integrity error returns at integrity layer; reality stub never called', async () => {
    await writeFile(
      join(testDir, 'evidence.json'),
      JSON.stringify(makeRealExecutionEvidence({ pushed_branch: 'main' }))
    );
    let realityCalls = 0;
    execFileImpl = () => {
      realityCalls++;
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'reality', path: 'evidence.json' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'pushed_branch')).toBe(true);
    }
    expect(realityCalls).toBe(0);
  });

  it("shape ok + integrity ok + verify: 'shape' returns valid without I/O", async () => {
    await writeFile(join(testDir, 'evidence.json'), JSON.stringify(makeRealExecutionEvidence()));
    let realityCalls = 0;
    execFileImpl = () => {
      realityCalls++;
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'shape', path: 'evidence.json' },
    });
    expect(result.valid).toBe(true);
    expect(realityCalls).toBe(0);
  });

  it("shape ok + integrity ok + verify: 'reality' + reality ok returns valid", async () => {
    await writeFile(join(testDir, 'evidence.json'), JSON.stringify(makeRealExecutionEvidence()));
    execFileImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return Promise.resolve({
          stdout: `${'a'.repeat(40)}\trefs/heads/feature/foo\n`,
          stderr: '',
        });
      }
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify({
            headRefName: 'feature/foo',
            number: 42,
            headRefOid: 'a'.repeat(40),
          }),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'reality', path: 'evidence.json' },
    });
    expect(result.valid).toBe(true);
  });

  it('planning evidence rejected at integrity layer', async () => {
    await writeFile(join(testDir, 'evidence.json'), JSON.stringify(makePlanningEvidence()));
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'shape', path: 'evidence.json' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(i => i.field === 'kind')).toBe(true);
    }
  });

  it('custom path within artifactsDir is honored', async () => {
    const customDir = join(testDir, 'sub');
    await mkdir(customDir, { recursive: true });
    await writeFile(
      join(testDir, 'sub', 'proof.json'),
      JSON.stringify(makeRealExecutionEvidence())
    );
    const result = await validateEvidence({
      artifactsDir: testDir,
      cwd: '/repo',
      policy: { required: true, verify: 'shape', path: 'sub/proof.json' },
    });
    expect(result.valid).toBe(true);
  });
});
