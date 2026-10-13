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
 * ~163 KB `workflow list --full --json` payload truncated at 98,304 bytes in 10/10
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
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { removeTempTree } from '@archon/paths/test-utils';
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

/** `archon workflow list --full --json` redirected to a regular file (blocking fd). */
function listToFile(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --full --json --cwd "${repoDir}" 2>/dev/null > "${target}"`
  ).status;
}

/** The same command with stdout attached to a real pipe, exiting with the CLI's status. */
function listThroughPipe(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --full --json --cwd "${repoDir}" 2>/dev/null | cat > "${target}"; exit \${PIPESTATUS[0]}`
  ).status;
}

beforeAll(() => {
  ({ scratch, archonHome, repoDir } = createPipeFixture(
    WORKFLOW_COUNT,
    'padding '.repeat(DESCRIPTION_WORDS)
  ));
});

afterAll(async () => {
  if (scratch) await removeTempTree(scratch);
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

let template: string | undefined;
afterAll(async () => {
  if (template) await removeTempTree(template);
});

function createPipeFixture(
  count: number,
  padding: string
): {
  scratch: string;
  archonHome: string;
  repoDir: string;
} {
  if (!template) {
    template = mkdtempSync(join(tmpdir(), 'archon-pipe-template-'));
    const result = spawnSync('git', ['init', '-q', '.'], { cwd: template });
    if (result.status !== 0) throw new Error(String(result.stderr));
  }
  const scratch = mkdtempSync(join(tmpdir(), 'archon-pipe-test-'));
  const archonHome = join(scratch, 'home');
  const repoDir = join(scratch, 'repo');
  mkdirSync(archonHome);
  cpSync(template, repoDir, { recursive: true });
  const workflowsDir = join(repoDir, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const name = `probe-${String(i).padStart(3, '0')}`;
    writeFileSync(
      join(workflowsDir, `${name}.yaml`),
      `name: ${name}\ndescription: ${padding}${i}\nnodes:\n  - id: only\n    prompt: hello\n`
    );
  }
  return { scratch, archonHome, repoDir };
}

describePosix('CLI human-readable console.log over a real pipe (#2400)', () => {
  /** Tuned so the human-readable payload lands in the proven truncation window. */
  const WORKFLOW_COUNT = 150;
  const DESCRIPTION_CHARS = 7000;
  /** Piped runs per assertion. Pre-fix truncates 5/5; post-fix passes 10/10. */
  const PIPED_RUNS = 5;

  let repoDir: string;
  let archonHome: string;
  let scratch: string;

  function runShell(script: string): { status: number | null; stdout: string } {
    // LOG_LEVEL=silent silences pino's diagnostic lines so two CLI invocations
    // produce byte-identical stdout (each invocation carries a unique timestamp
    // + pid in the first JSON line; the human-readable payload underneath is
    // stable, but pino's preamble is not). Without this the test would diff on
    // the pino preamble and pass trivially even when the real payload truncates.
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { status: result.status, stdout: result.stdout ?? '' };
  }

  /** `archon workflow list --full` redirected to a regular file (blocking fd). */
  function listToFile(target: string): number | null {
    return runShell(
      `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null > "${target}"`
    ).status;
  }

  /**
   * The same command with stdout attached to a real pipe. The consumer sleeps
   * for 500 ms before draining so the writer fills the pipe buffer before the
   * reader pulls anything — that is what makes the pre-fix truncation
   * deterministic. `cat` alone truncates too rarely to be a useful test.
   */
  function listThroughPipe(target: string): number | null {
    return runShell(
      `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null | { sleep 0.5; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
    ).status;
  }

  /**
   * Very-slow consumer (1 s before reading). The CLI finishes in ~620 ms; with
   * the fire-and-forget shim and no exit-path flush, `process.exit()` would
   * fire while bytes are still queued in the stream buffer and the truncation
   * described in R1 (review report) returns. `flushPendingWrites()` in
   * `cli.ts` is what closes that window — do not delete it without re-running
   * this test.
   */
  function listThroughVerySlowPipe(target: string): number | null {
    return runShell(
      `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null | { sleep 1; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
    ).status;
  }

  beforeAll(() => {
    ({ scratch, archonHome, repoDir } = createPipeFixture(
      WORKFLOW_COUNT,
      'x'.repeat(DESCRIPTION_CHARS)
    ));
  });

  afterAll(async () => {
    if (scratch) await removeTempTree(scratch);
  });

  it('delivers the whole document, byte-identical to a file redirect, against a slow consumer', () => {
    const referencePath = join(scratch, 'reference.txt');
    expect(listToFile(referencePath)).toBe(0);
    const reference = readFileSync(referencePath);

    // Guard the calibration: below the pipe capacity the bug cannot occur, so a
    // shrinking payload would silently turn this into a no-op test.
    expect(reference.byteLength).toBeGreaterThan(65_536);

    for (let run = 0; run < PIPED_RUNS; run++) {
      const pipedPath = join(scratch, `piped-${run}.txt`);
      const status = listThroughPipe(pipedPath);
      const piped = readFileSync(pipedPath);

      expect({ run, status }).toEqual({ run, status: 0 });
      // Report the byte count on failure — a bare buffer diff is unreadable.
      expect({ run, bytes: piped.byteLength }).toEqual({ run, bytes: reference.byteLength });
      expect(piped.equals(reference)).toBe(true);
    }
  }, 180_000);

  /**
   * Regression guard for the EPIPE propagation contract
   * (`safe-console.ts` file comment + `exit-with-drain.ts`'s
   * `consumeWriteError()` branch). A defensive
   * `writeStdout(text).catch(() => {})` regression in the shim that
   * failed to record the error in `writeError` would turn
   * `archon … | head -c 100` into a silent exit 0 on the Linux CI runner
   * — the only test above uses `cat` and would not catch it.
   *
   * `head -c 100` closes the read end of the pipe after the first 100
   * bytes, so the writer's next `process.stdout.write` fails with EPIPE.
   * The shim records that error in `writeError`, `exitWithDrain()` reads
   * it back via `consumeWriteError()` after the drain, and the writer
   * exits non-zero regardless of whether Bun's unhandled-rejection trap
   * fires before or after `process.exit()` (macOS fires it before, Linux
   * CI schedules it after — see `safe-console.ts` file comment for the
   * full ordering analysis). We capture `${PIPESTATUS[0]}` (the writer's
   * status) so the surrounding pipeline cannot mask a non-zero exit with
   * a clean `head`.
   */
  it('propagates EPIPE as a non-zero exit when the consumer hangs up early', () => {
    const result = runShell(
      `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null | head -c 100 > /dev/null; exit \${PIPESTATUS[0]}`
    );
    expect(result.status).not.toBe(0);
  }, 60_000);

  /**
   * Regression guard for R1 (review report): the fire-and-forget shim
   * discards the per-write completion promise, so `process.exit()` would
   * race the stream drain and re-introduce the silent-exit-0 truncation
   * the patch is meant to eliminate. The fix is `flushPendingWrites()` in
   * `cli.ts` (awaited between `main()` and `process.exit()`); this test
   * sleeps 1 s on the consumer side — longer than the CLI's own runtime —
   * so without the flush the queued bytes are lost. With the flush in
   * place the output is byte-identical to the file redirect.
   */
  it('delivers the whole document to a very-slow consumer (sleep >= 1 s) without truncating', () => {
    const referencePath = join(scratch, 'reference.txt');
    const pipedPath = join(scratch, 'very-slow.txt');
    const status = listThroughVerySlowPipe(pipedPath);
    const reference = readFileSync(referencePath);
    const piped = readFileSync(pipedPath);

    expect(status).toBe(0);
    expect({ bytes: piped.byteLength }).toEqual({ bytes: reference.byteLength });
    expect(piped.equals(reference)).toBe(true);
  }, 120_000);

  /**
   * Regression guard for R9 (review report): the `.catch()` arm of cli.ts's
   * top-level promise chain must also drain `pendingWrites` before calling
   * `process.exit(1)` — otherwise a fatal `main()` rejection against a slow
   * reader drops queued stdout bytes the same way the success arm used to
   * pre-R1. The success-arm R1 test above would not catch a regression here
   * (it drives `workflow list`, which returns 0); this test drives a small
   * fixture that throws after emitting a known marker through the patched
   * `console.log`. With the drain shared across both arms the marker is
   * delivered to a slow pipe; without it the bytes are truncated.
   *
   * The fixture is a self-contained TS script under `scratch/`. It imports
   * the shim from the source tree (not from a published package) so a
   * regression in `flushPendingWrites()` itself is also caught here. It
   * also imports `withDrainedExit` from the same module cli.ts imports it
   * from (`./utils/exit-with-drain.ts`), so a regression inside
   * `withDrainedExit`/`exitWithDrain` itself (e.g. dropping the
   * `flushPendingWrites()` await) is caught here too. A regression that
   * instead bypasses `withDrainedExit` at the cli.ts call site — swapping
   * it for a direct `process.exit` — is NOT caught by this fixture, since
   * the fixture never imports cli.ts; that case is caught by the separate
   * static-contract test below.
   */
  it('drains queued console.log writes before process.exit(1) on the catch arm (R9)', () => {
    const marker = `R9-MARKER-${Date.now()}`;
    // Mirror the cli.ts exit chain via the shared helper: success and
    // fatal both route through `exitWithDrain`, which awaits
    // `flushPendingWrites()` before `process.exit()`. The chain wiring
    // lives in `withDrainedExit` (`./utils/exit-with-drain.ts`), imported
    // from the same module cli.ts imports it from, so a regression inside
    // that shared module is caught here too. A bypass of `withDrainedExit`
    // specifically at the cli.ts call site is NOT caught by this fixture
    // (see the static-contract test below).
    const fixturePath = join(scratch, 'r9-fixture.ts');
    const shimEntry = join(import.meta.dir, 'safe-console.ts');
    const exitWithDrainEntry = join(import.meta.dir, 'exit-with-drain.ts');
    writeFileSync(
      fixturePath,
      [
        `import { installPipeSafeConsole } from ${JSON.stringify(shimEntry)};`,
        `import { withDrainedExit } from ${JSON.stringify(exitWithDrainEntry)};`,
        `installPipeSafeConsole();`,
        `// Emit a large payload FIRST so the pipe buffer (64 KiB on macOS)`,
        `// fills and the marker cannot reach the OS before the catch arm`,
        `// exits the process. The marker is written LAST so it sits behind`,
        `// the pipe-full payload; without the drain the marker is dropped`,
        `// when process.exit fires.`,
        `for (let i = 0; i < 4000; i++) console.log('x'.repeat(200));`,
        `console.log(${JSON.stringify(marker)});`,
        `// Simulate a fatal main() rejection.`,
        `async function main(): Promise<number> { throw new Error('simulated fatal'); }`,
        `withDrainedExit(main);`,
        ``,
      ].join('\n')
    );

    const target = join(scratch, 'r9-output.txt');
    // Sleep 1 s on the consumer side — same calibration as the R1 test,
    // longer than the fixture's own runtime so without the drain the
    // queued bytes are lost when process.exit fires.
    const result = runShell(
      `"${BUN}" "${fixturePath}" 2>/dev/null | { sleep 1; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
    );
    const output = readFileSync(target, 'utf8');

    // The marker must be present and the writer must have exited non-zero
    // (the simulated throw). Both are part of the contract: a future
    // regression that swallows the throw and exits 0 would also be
    // caught by the status assertion.
    expect(result.status).toBe(1);
    expect(output).toContain(marker);
  }, 60_000);

  /**
   * R20 (review report): `withDrainedExit`'s default fatal-error handler
   * prints `Fatal error: <message>` to stderr — the only diagnostic a user
   * sees on an uncaught `main()` rejection. The R9 fixture above redirects
   * stderr to `/dev/null`, so this content has never been captured or
   * asserted by any test. This variant redirects stderr to a file instead
   * and asserts the message survives.
   */
  it('withDrainedExit logs the fatal rejection message to stderr (R20)', () => {
    const fixturePath = join(scratch, 'r20-fixture.ts');
    const exitWithDrainEntry = join(import.meta.dir, 'exit-with-drain.ts');
    writeFileSync(
      fixturePath,
      [
        `import { withDrainedExit } from ${JSON.stringify(exitWithDrainEntry)};`,
        `async function main(): Promise<number> { throw new Error('r20 simulated fatal'); }`,
        `withDrainedExit(main);`,
        ``,
      ].join('\n')
    );

    const stderrTarget = join(scratch, 'r20-stderr.txt');
    const result = runShell(`"${BUN}" "${fixturePath}" > /dev/null 2> "${stderrTarget}"`);
    const stderr = readFileSync(stderrTarget, 'utf8');

    expect(result.status).toBe(1);
    expect(stderr).toContain('Fatal error: r20 simulated fatal');
  }, 30_000);

  /**
   * Static-contract test for R12 (review report): even with the chain
   * wiring extracted to `withDrainedExit`, a regression that bypasses
   * the helper at the cli.ts call site (e.g. replacing
   * `withDrainedExit(main)` with `main().then((c) => process.exit(c))`)
   * is not caught by the R9 pipe test above — the fixture is a self-
   * contained TS script that does not import cli.ts, so its own chain
   * stays correct even when cli.ts drifts. Read cli.ts as a string and
   * assert the call site is the shared helper, so a cli.ts bypass lands
   * here.
   */
  it('routes cli.ts through withDrainedExit — no direct process.exit chain', () => {
    const cliSrc = readFileSync(join(import.meta.dir, '..', 'cli.ts'), 'utf8');
    // Strip line comments so a regression that comments out the import
    // is still caught — `cliSrc.toMatch(/.../)` would still see the
    // text inside the comment and pass falsely otherwise.
    const codeLines = cliSrc.split('\n').filter(line => !line.trimStart().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    // Must import the helper from the module that owns the chain shape.
    expect(codeOnly).toMatch(
      /import\s*\{[^}]*\bwithDrainedExit\b[^}]*\}\s*from\s*['"]\.\/utils\/exit-with-drain['"]/
    );
    // Must invoke it at the top level, with main as the argument. Anchor
    // on `withDrainedExit(` so a future alias import or wrap-in-helper
    // regression is still caught.
    expect(codeOnly).toMatch(/withDrainedExit\s*\(\s*main\s*\)/);
    // Must NOT carry a parallel exit chain. The only legitimate
    // `process.exit` mentions in cli.ts are comments — the filter above
    // already stripped them, so any remaining line with `process.exit`
    // is a regression.
    const offendingExit = codeLines.filter(line => /process\.exit\b/.test(line));
    expect(offendingExit).toEqual([]);
  });
});
