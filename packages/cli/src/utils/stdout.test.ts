/**
 * Real-pipe regression tests for #2384 (piped `--json` output silently truncated).
 *
 * ## Why these tests spawn a shell pipeline
 *
 * The bug only exists when fd 1 is a **non-blocking pipe**, which is what a
 * shell creates for `archon ... --json | jq`. Two things had to be true at once:
 *
 *  1. Importing `@archon/paths` builds the pino root logger, whose default
 *     destination puts fd 1 into non-blocking mode. Every CLI command imports it
 *     transitively — a bare `bun script.ts` does not, and keeps fd 1 blocking.
 *  2. On a non-blocking pipe a large `write(2)` returns a SHORT count, and
 *     `console.log` discards the remainder without error.
 *
 * That combination is why redirecting to a file (`> out.json`) always looked
 * fine: a regular-file fd stays blocking, so one write always completes.
 *
 * It also means the harness matters more than the assertion. `Bun.spawn` with
 * `stdout: 'pipe'` does NOT reproduce the truncation, so a test built on it
 * passes with or without the fix and proves nothing. Neither does mocking
 * `process.stdout.write` — that mocks the exact thing that was broken. These
 * tests therefore drive a genuine `bun … | cat > file` shell pipeline.
 *
 * ## Calibration (measured on macOS/arm64, bun 1.3.11)
 *
 * The payload size below is not arbitrary. Against the pre-fix code, a
 * ~163 KB `workflow list --json` payload truncated at 98,304 bytes in 10/10
 * piped runs while exiting 0; the same command redirected to a file was
 * complete every time. With the fix, 12/12 piped runs were byte-identical to
 * the file redirect. Much larger payloads (~345 KB) stopped reproducing, so do
 * not "strengthen" this test by inflating WORKFLOW_COUNT or DESCRIPTION_WORDS
 * without re-measuring against a pre-fix build.
 *
 * POSIX-only: Windows has no equivalent non-blocking-pipe path and no bash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const BUN = process.execPath;

/** Tuned so the JSON payload lands in the size window proven to truncate pre-fix. */
const WORKFLOW_COUNT = 40;
const DESCRIPTION_WORDS = 450;
/** Piped runs per assertion. The pre-fix failure was probabilistic (10/10 at this size). */
const PIPED_RUNS = 10;

let repoDir: string;
let archonHome: string;
let scratch: string;

function runShell(script: string): { status: number | null; stdout: string } {
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, ARCHON_HOME: archonHome },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

/** `archon workflow list --json` with stdout redirected to a regular file (blocking fd). */
function listToFile(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --json --cwd "${repoDir}" 2>/dev/null > "${target}"`
  ).status;
}

/** The same command with stdout attached to a real pipe, exiting with the CLI's status. */
function listThroughPipe(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --json --cwd "${repoDir}" 2>/dev/null | cat > "${target}"; exit \${PIPESTATUS[0]}`
  ).status;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'archon-pipe-test-'));
  archonHome = join(scratch, 'home');
  repoDir = join(scratch, 'repo');
  mkdirSync(archonHome, { recursive: true });
  const workflowsDir = join(repoDir, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  spawnSync('git', ['init', '-q', '.'], { cwd: repoDir });

  const padding = 'padding '.repeat(DESCRIPTION_WORDS);
  for (let i = 0; i < WORKFLOW_COUNT; i++) {
    const name = `probe-${String(i).padStart(3, '0')}`;
    writeFileSync(
      join(workflowsDir, `${name}.yaml`),
      `name: ${name}\ndescription: ${padding}${i}\nnodes:\n  - id: only\n    prompt: hello\n`
    );
  }
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('CLI --json output over a real pipe (#2384)', () => {
  it('delivers the whole document, byte-identical to a file redirect', () => {
    const referencePath = join(scratch, 'reference.json');
    expect(listToFile(referencePath)).toBe(0);
    const reference = readFileSync(referencePath);

    // Guard the calibration: below the pipe capacity the bug cannot occur, so a
    // shrinking payload would silently turn this into a no-op test.
    expect(reference.byteLength).toBeGreaterThan(65_536);
    JSON.parse(reference.toString('utf8')); // reference itself must be valid

    for (let run = 0; run < PIPED_RUNS; run++) {
      const pipedPath = join(scratch, `piped-${run}.json`);
      const status = listThroughPipe(pipedPath);
      const piped = readFileSync(pipedPath);

      expect({ run, status }).toEqual({ run, status: 0 });
      // Report the byte count on failure — a bare buffer diff is unreadable.
      expect({ run, bytes: piped.byteLength }).toEqual({ run, bytes: reference.byteLength });
      expect(() => JSON.parse(piped.toString('utf8'))).not.toThrow();
      expect(piped.equals(reference)).toBe(true);
    }
  }, 180_000);

  it('propagates exit codes through a pipe', () => {
    const sink = join(scratch, 'sink.json');

    // Success still exits 0 …
    expect(listThroughPipe(sink)).toBe(0);

    // … and a failing command still exits non-zero rather than being masked by
    // the write path.
    const failure = runShell(
      `"${BUN}" "${CLI_ENTRY}" definitely-not-a-command --cwd "${repoDir}" 2>/dev/null | cat > "${sink}"; exit \${PIPESTATUS[0]}`
    );
    expect(failure.status).toBe(1);
  }, 60_000);
});
