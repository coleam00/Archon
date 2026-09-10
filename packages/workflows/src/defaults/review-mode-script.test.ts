import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCRIPT_PATH = join(
  REPO_ROOT,
  '.archon',
  'workflows',
  'sdlc',
  'review',
  'scripts',
  'resolve-review-mode.ts'
);
const tempFiles: string[] = [];

/**
 * Start the runtime once, for one input.
 *
 * The script's PROCESS contract is the subject — stdout JSON, exit status, and the
 * stderr message a failing node reports — so a real start is what proves it, under the
 * exact argv the engine uses for a named packaged script.
 */
async function runResolver(priorReport: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn(['bun', '--no-env-file', 'run', SCRIPT_PATH], {
    cwd: REPO_ROOT,
    env: { ...globalThis.process.env, INPUTS_PRIOR_REPORT: priorReport },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A path under the system temp dir that nothing creates. */
function unusedPath(): string {
  return join(tmpdir(), `archon-review-mode-${randomUUID()}.md`);
}

afterAll(async () => {
  await Promise.all(tempFiles.splice(0).map(path => rm(path, { force: true })));
});

describe('resolve-review-mode', () => {
  it('reports a full review when no prior report is named', async () => {
    const full = await runResolver('');
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout)).toEqual({ continuation: false });
  });

  it('reports a continuation when the named prior report exists', async () => {
    // A single file, not a directory: the script only stats the path it is given, and a
    // recursive temp-tree removal is the part of this fixture that is slow and flaky on
    // Windows (#2306).
    const existingReport = unusedPath();
    tempFiles.push(existingReport);
    await writeFile(existingReport, '# Prior review\n');

    const continuation = await runResolver(existingReport);
    expect(continuation.exitCode).toBe(0);
    expect(JSON.parse(continuation.stdout)).toEqual({ continuation: true });
  });

  it('fails when the named prior report does not exist', async () => {
    const missingReport = unusedPath();

    const broken = await runResolver(missingReport);
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toContain(`Previous review report does not exist: ${missingReport}`);
  });
});
