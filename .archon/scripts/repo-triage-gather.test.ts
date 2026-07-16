import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Gather shells out to `gh` and `date`. We stub both by writing fake executables
 * into a temp dir prepended to PATH, so the test exercises the file-assembly +
 * field wiring deterministically without hitting the network.
 */
function stub(binDir: string, name: string, body: string): void {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

async function runGather(opts: {
  ghScript: string;
  seedGithubDir?: (cwd: string) => void;
}) {
  const cwd = mkdtempSync(join(tmpdir(), 'triage-gather-test-'));
  const binDir = mkdtempSync(join(tmpdir(), 'triage-gather-bin-'));
  const artifacts = mkdtempSync(join(tmpdir(), 'triage-gather-art-'));
  try {
    stub(binDir, 'gh', opts.ghScript);
    // Deterministic cutoff so the test doesn't depend on BSD vs GNU date.
    stub(binDir, 'date', 'echo 2026-04-17');
    opts.seedGithubDir?.(cwd);

    const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, 'repo-triage-gather.ts')], {
      cwd,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ARTIFACTS_DIR: artifacts },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const gDir = join(artifacts, 'gather');
    const readJson = (name: string): unknown => {
      try {
        return JSON.parse(readFileSync(join(gDir, name), 'utf8'));
      } catch {
        return null;
      }
    };
    const readText = (name: string): string | null => {
      try {
        return readFileSync(join(gDir, name), 'utf8');
      } catch {
        return null;
      }
    };
    return {
      exitCode,
      stdout,
      stderr,
      manifest: exitCode === 0 ? JSON.parse(stdout) : null,
      files: {
        issuesOpen: readJson('issues-open.json'),
        issuesClosed: readJson('issues-closed.json'),
        prsOpen: readJson('prs-open.json'),
        prsClosed: readJson('prs-closed.json'),
        issueTemplates: readText('issue-templates.md'),
        prTemplate: readText('pr-template.md'),
        meta: readJson('meta.json'),
      },
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
}

// A gh stub that routes on the argv it receives.
const ROUTING_GH = `
case "$1 $2" in
  "repo view") echo "coleam00/Archon" ;;
  "api user") echo "archon-bot" ;;
  "issue list")
    case "$*" in
      *"--state open"*) echo '[{"number":10,"title":"open bug","body":"b","labels":[],"comments":[]}]' ;;
      *"--state closed"*) echo '[{"number":3,"title":"closed","body":"c","stateReason":"COMPLETED","closedAt":"2026-04-01"}]' ;;
    esac ;;
  "pr list")
    case "$*" in
      *"--state open"*) echo '[{"number":20,"title":"open pr","body":"p","headRefName":"feat","isDraft":false}]' ;;
      *"--state closed"*) echo '[{"number":5,"title":"merged pr","body":"m","state":"MERGED","mergedAt":"2026-04-02"}]' ;;
    esac ;;
esac
`;

describe('repo-triage-gather', () => {
  test('writes all list files + meta, and a stdout manifest', async () => {
    const result = await runGather({ ghScript: ROUTING_GH });
    expect(result.exitCode).toBe(0);

    // Manifest on stdout
    expect(result.manifest.repoSlug).toBe('coleam00/Archon');
    expect(result.manifest.botLogin).toBe('archon-bot');
    expect(result.manifest.cutoff90d).toBe('2026-04-17');
    expect(result.manifest.counts).toEqual({
      openIssues: 1,
      closedIssues: 1,
      openPrs: 1,
      closedPrs: 1,
    });
    expect(typeof result.manifest.gatherDir).toBe('string');

    // Files on disk
    expect((result.files.issuesOpen as { number: number }[])[0].number).toBe(10);
    expect((result.files.issuesClosed as { number: number }[])[0].number).toBe(3);
    expect((result.files.prsOpen as { number: number }[])[0].number).toBe(20);
    expect((result.files.prsClosed as { state: string }[])[0].state).toBe('MERGED');
    expect((result.files.meta as { repoSlug: string }).repoSlug).toBe('coleam00/Archon');
  });

  test('reads issue + PR templates from .github when present', async () => {
    const result = await runGather({
      ghScript: ROUTING_GH,
      seedGithubDir: (cwd) => {
        mkdirSync(join(cwd, '.github/ISSUE_TEMPLATE'), { recursive: true });
        writeFileSync(join(cwd, '.github/ISSUE_TEMPLATE/bug.md'), '## Bug\nDescribe it');
        writeFileSync(join(cwd, '.github/pull_request_template.md'), '## Summary (required)');
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.files.issueTemplates).toContain('### bug.md');
    expect(result.files.issueTemplates).toContain('Describe it');
    expect(result.files.prTemplate).toContain('## Summary (required)');
  });

  test('empty template files when .github is absent', async () => {
    const result = await runGather({ ghScript: ROUTING_GH });
    expect(result.exitCode).toBe(0);
    expect(result.files.issueTemplates).toBe('');
    expect(result.files.prTemplate).toBe('');
  });

  test('gh failures degrade to empty lists, not a crash', async () => {
    const result = await runGather({ ghScript: 'exit 1' });
    expect(result.exitCode).toBe(0);
    expect(result.files.issuesOpen).toEqual([]);
    expect(result.files.prsOpen).toEqual([]);
    expect(result.manifest.repoSlug).toBe('');
    expect(result.manifest.botLogin).toBe('');
  });
});
