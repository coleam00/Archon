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
  dateScript?: string;
  env?: Record<string, string>;
  seedGithubDir?: (cwd: string) => void;
}) {
  const cwd = mkdtempSync(join(tmpdir(), 'triage-gather-test-'));
  const binDir = mkdtempSync(join(tmpdir(), 'triage-gather-bin-'));
  const artifacts = mkdtempSync(join(tmpdir(), 'triage-gather-art-'));
  try {
    stub(binDir, 'gh', opts.ghScript);
    // Deterministic cutoff so the test doesn't depend on BSD vs GNU date.
    stub(binDir, 'date', opts.dateScript ?? 'echo 2026-04-17');
    opts.seedGithubDir?.(cwd);

    const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, 'repo-triage-gather.ts')], {
      cwd,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ARTIFACTS_DIR: artifacts, ...opts.env },
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
        issuesStale: readJson('issues-stale.json'),
        prsStale: readJson('prs-stale.json'),
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
  test('writes all list files + meta + stale slices, fetchOk true on a clean run', async () => {
    const result = await runGather({ ghScript: ROUTING_GH });
    expect(result.exitCode).toBe(0);

    // Manifest on stdout
    expect(result.manifest.repoSlug).toBe('coleam00/Archon');
    expect(result.manifest.botLogin).toBe('archon-bot');
    expect(result.manifest.cutoff90d).toBe('2026-04-17');
    expect(result.manifest.fetchOk).toBe(true);
    expect(result.manifest.fetchErrors).toEqual([]);
    expect(result.manifest.capped).toEqual([]);
    expect(result.manifest.counts).toEqual({
      openIssues: 1,
      closedIssues: 1,
      openPrs: 1,
      closedPrs: 1,
      staleIssues: 1,
      stalePrs: 1,
    });
    expect(typeof result.manifest.gatherDir).toBe('string');

    // Files on disk
    expect((result.files.issuesOpen as { number: number }[])[0].number).toBe(10);
    expect((result.files.issuesClosed as { number: number }[])[0].number).toBe(3);
    expect((result.files.prsOpen as { number: number }[])[0].number).toBe(20);
    expect((result.files.prsClosed as { state: string }[])[0].state).toBe('MERGED');
    expect(Array.isArray(result.files.issuesStale)).toBe(true);
    expect(Array.isArray(result.files.prsStale)).toBe(true);
    expect((result.files.meta as { fetchOk: boolean }).fetchOk).toBe(true);
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

  test('gh failures degrade to empty lists, but fetchOk=false records the failures', async () => {
    const result = await runGather({ ghScript: 'exit 1' });
    expect(result.exitCode).toBe(0);
    expect(result.files.issuesOpen).toEqual([]);
    expect(result.files.prsOpen).toEqual([]);
    expect(result.manifest.repoSlug).toBe('');
    expect(result.manifest.botLogin).toBe('');
    // The whole snapshot is degraded — consumers must abort/flag, not treat as quiet.
    expect(result.manifest.fetchOk).toBe(false);
    expect(result.manifest.fetchErrors.length).toBeGreaterThan(0);
    // The empty bot login is surfaced explicitly (reconcile-passes hazard).
    expect(
      (result.manifest.fetchErrors as { message: string }[]).some((e) => /bot login/i.test(e.message)),
    ).toBe(true);
  });

  test('malformed but exit-0 gh output (non-array) does not crash and flips fetchOk', async () => {
    const MALFORMED = `
case "$1 $2" in
  "repo view") echo "coleam00/Archon" ;;
  "api user") echo "archon-bot" ;;
  "issue list") echo '{"message":"Bad credentials"}' ;;
  "pr list") echo '{"message":"Bad credentials"}' ;;
esac
`;
    const result = await runGather({ ghScript: MALFORMED });
    expect(result.exitCode).toBe(0);
    expect(result.files.issuesOpen).toEqual([]);
    expect(result.files.prsOpen).toEqual([]);
    expect(result.manifest.fetchOk).toBe(false);
    expect(
      (result.manifest.fetchErrors as { message: string }[]).some((e) => /non-array/i.test(e.message)),
    ).toBe(true);
  });

  test('partial failure (issues ok, PRs fail) flips fetchOk but keeps the good list', async () => {
    const PARTIAL = `
case "$1 $2" in
  "repo view") echo "coleam00/Archon" ;;
  "api user") echo "archon-bot" ;;
  "issue list")
    case "$*" in
      *"--state open"*) echo '[{"number":10,"labels":[],"comments":[]}]' ;;
      *) echo '[]' ;;
    esac ;;
  "pr list") exit 1 ;;
esac
`;
    const result = await runGather({ ghScript: PARTIAL });
    expect(result.exitCode).toBe(0);
    expect((result.files.issuesOpen as unknown[]).length).toBe(1);
    expect(result.files.prsOpen).toEqual([]);
    expect(result.manifest.fetchOk).toBe(false);
  });

  test('hitting --limit is recorded in meta.capped and warned', async () => {
    const CAPPED = `
case "$1 $2" in
  "repo view") echo "coleam00/Archon" ;;
  "api user") echo "archon-bot" ;;
  "issue list")
    case "$*" in
      *"--state open"*)
        printf '['
        for i in $(seq 1 200); do [ "$i" -gt 1 ] && printf ','; printf '{"number":%d,"labels":[],"comments":[]}' "$i"; done
        printf ']'
        ;;
      *) echo '[]' ;;
    esac ;;
  "pr list") echo '[]' ;;
esac
`;
    const result = await runGather({ ghScript: CAPPED });
    expect(result.exitCode).toBe(0);
    expect((result.files.issuesOpen as unknown[]).length).toBe(200);
    expect(result.manifest.capped).toContain('open issues');
    expect(result.stderr).toContain('hit --limit');
  });

  test('date failure falls back to a JS-computed cutoff (still YYYY-MM-DD)', async () => {
    const result = await runGather({ ghScript: ROUTING_GH, dateScript: 'exit 1' });
    expect(result.exitCode).toBe(0);
    expect(result.manifest.cutoff90d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.manifest.staleCutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('STALE_DAYS is honored for the stale cutoff window', async () => {
    const result = await runGather({ ghScript: ROUTING_GH, env: { STALE_DAYS: '30' } });
    expect(result.exitCode).toBe(0);
    expect(result.manifest.staleDays).toBe(30);
  });
});
