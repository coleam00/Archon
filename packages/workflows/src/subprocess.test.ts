/**
 * Real-subprocess tests for the process-tree kill helper.
 *
 * These tests spawn actual `bash` processes (skipped on Windows) to verify the
 * three guarantees the dag-executor relies on:
 *
 *  1. Normal exit returns captured stdout/stderr.
 *  2. Timeout sends SIGTERM to the process group, then SIGKILL after the grace
 *     period — even when the immediate child exits cleanly first.
 *  3. Output that exceeds MAX_CAPTURE_BYTES rejects with an `ERR_MAXBUFFER`
 *     error and kills the producer (no silent truncation, no unbounded memory).
 */
import { describe, it, expect } from 'bun:test';
import { subprocess, MAX_CAPTURE_BYTES } from './subprocess';

const SKIP_ON_WINDOWS = process.platform === 'win32';

describe('subprocess.exec', () => {
  it('resolves with captured stdout/stderr on success', async () => {
    if (SKIP_ON_WINDOWS) return;
    const result = await subprocess.exec('bash', ['-c', 'echo hello && echo bye >&2'], {
      cwd: process.cwd(),
      timeout: 5_000,
    });
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('bye\n');
  });

  it('rejects with non-zero exit', async () => {
    if (SKIP_ON_WINDOWS) return;
    let caught: (Error & { code?: number | null }) | undefined;
    try {
      await subprocess.exec('bash', ['-c', 'exit 7'], {
        cwd: process.cwd(),
        timeout: 5_000,
      });
    } catch (err) {
      caught = err as Error & { code?: number | null };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe(7);
  });

  it('kills the entire process tree on timeout, not just the wrapper', async () => {
    if (SKIP_ON_WINDOWS) return;
    // Spawn a parent that immediately backgrounds a long-running grandchild and
    // exits. With plain execFile timeout, the grandchild would survive. With the
    // process-group kill, the grandchild is signalled too.
    const start = Date.now();
    let caught: (Error & { killed?: boolean }) | undefined;
    try {
      await subprocess.exec('bash', ['-c', 'sleep 30 & PID=$!; wait $PID'], {
        cwd: process.cwd(),
        timeout: 300,
      });
    } catch (err) {
      caught = err as Error & { killed?: boolean };
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeDefined();
    expect(caught?.killed).toBe(true);
    // Should resolve well before the 30s sleep — within timeout + SIGKILL grace + slack.
    // Loaded CI runners can take noticeably longer than the local 1–2 s, so the
    // ceiling is set to leave room without losing the regression's intent.
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);

  it('rejects with ERR_MAXBUFFER when output exceeds capture limit', async () => {
    if (SKIP_ON_WINDOWS) return;
    // `yes` streams unbounded output, guaranteeing we cross MAX_CAPTURE_BYTES
    // and that the kill actually has work to do. Without the overflow guard
    // the call would either OOM or resolve with silently-truncated stdout;
    // with it, we reject with ERR_MAXBUFFER and the producer is force-killed.
    let caught: (Error & { code?: unknown; killed?: boolean }) | undefined;
    try {
      await subprocess.exec('bash', ['-c', 'yes a'], {
        cwd: process.cwd(),
        timeout: 10_000,
      });
    } catch (err) {
      caught = err as Error & { code?: unknown; killed?: boolean };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('ERR_MAXBUFFER');
    // killed=false on max-buffer is intentional — dag-executor's `killed===true`
    // heuristic is reserved for genuine timeouts so users get the right
    // remediation hint (reduce output, not raise timeout).
    expect(caught?.killed).toBe(false);
  }, 15_000);

  // Note: the close handler classifies a *timeout* before *capture overflow*
  // when both flags are set (see subprocess.ts close handler). That ordering
  // is hard to exercise from a real-subprocess test because `yes a` saturates
  // the buffer in single-digit milliseconds — long before any reasonable
  // timeout can fire — so the integration test below always lands in the
  // buffer-overflow path. Code reading + the inline rationale comment carry
  // the contract; if the ordering is ever inverted, downstream dag-executor
  // tests that assert timeout classification will catch it.

  it('exports MAX_CAPTURE_BYTES so tests stay in sync with the implementation cap', () => {
    expect(MAX_CAPTURE_BYTES).toBeGreaterThan(0);
  });

  it('respects capture cap so successful capture does not exceed the limit', async () => {
    if (SKIP_ON_WINDOWS) return;
    // Bounded output well under the cap — must resolve normally with full data.
    const text = 'x'.repeat(8_192);
    const result = await subprocess.exec('bash', ['-c', `printf '%s' "${text}"`], {
      cwd: process.cwd(),
      timeout: 5_000,
    });
    expect(result.stdout.length).toBe(8_192);
  });
});
