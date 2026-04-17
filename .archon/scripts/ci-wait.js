#!/usr/bin/env bun
/**
 * Wait for GitHub CI on a PR to finish, with a hard wall-clock timeout.
 *
 * Usage: bun .archon/scripts/ci-wait.js <pr-number-or-url> [timeout-ms]
 *
 * Exit codes:
 *   0 — all required checks passed
 *   1 — at least one required check failed
 *   3 — timeout reached before CI finished
 *   2 — bad args / missing gh
 *
 * Used by archon-slack-feature-to-review-app to gate review-app deploy.
 */
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

function main() {
  const [pr, timeoutArg] = process.argv.slice(2);

  if (!pr) {
    console.error('Usage: ci-wait.js <pr-number-or-url> [timeout-ms]');
    process.exit(2);
  }

  const timeoutMs = timeoutArg ? Number(timeoutArg) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`Invalid timeout-ms: ${timeoutArg}`);
    process.exit(2);
  }

  console.log(
    `Waiting for CI on PR ${pr} (timeout: ${Math.round(timeoutMs / 1000)}s)...`
  );

  const child = spawn(
    'gh',
    ['pr', 'checks', pr, '--watch', '--fail-fast', '--interval', '30'],
    { stdio: 'inherit' }
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`\nCI wait timed out after ${Math.round(timeoutMs / 1000)}s`);
    child.kill('SIGTERM');
    setTimeout(() => process.exit(3), 2000).unref();
  }, timeoutMs);
  timer.unref();

  child.on('exit', (code, _signal) => {
    clearTimeout(timer);
    if (timedOut) return;
    if (code === 0) {
      console.log('CI passed.');
      process.exit(0);
    }
    console.error(`CI failed (gh exit code ${code ?? 'null'})`);
    process.exit(1);
  });

  child.on('error', err => {
    clearTimeout(timer);
    console.error(`Failed to spawn gh: ${err.message}`);
    process.exit(2);
  });
}

main();
