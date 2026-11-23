// Test preload. Under load, Bun loses the exit notification of the first
// node:child_process spawn made after the test runner starts: `spawn` fires, but
// `exit` and `close` never do (oven-sh/bun issue 49481). runPluginProcess resolves
// on `close`, so whichever forge test spawns first would hang until its timeout.
// This throwaway spawn takes that hit instead. It is a beforeAll because a spawn at
// preload top level runs before the test runner starts and does not take the hit.
// Plain `bun` (the production runtime) is not affected. Delete this file once the
// upstream issue is fixed.
import { beforeAll } from 'bun:test';
import { spawn } from 'node:child_process';

beforeAll(async () => {
  await new Promise<void>(resolve => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    child.stdout.resume();
    child.stderr.resume();
    // If this spawn is the one that hangs, stop waiting and let it go: the cap stays
    // well under the hook timeout, and unref keeps it from holding the process open.
    const cap = setTimeout(() => {
      child.unref();
      resolve();
    }, 2_000);
    const done = (): void => {
      clearTimeout(cap);
      resolve();
    };
    child.on('close', done);
    // A failed throwaway spawn hides nothing: the next real spawn reports its own error.
    child.on('error', done);
  });
});
