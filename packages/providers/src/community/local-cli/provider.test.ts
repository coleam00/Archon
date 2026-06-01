import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { MessageChunk } from '../../types';

import { runLocalCliProvider } from './provider';

async function collect(chunks: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const result: MessageChunk[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

function makeStdinAwareCli(): { cwd: string; bin: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-local-cli-provider-'));
  const bin = join(cwd, 'stdin-aware-cli');
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
const timer = setTimeout(() => {
  console.error('stdin did not close');
  process.exit(9);
}, 1000);

let stdin = '';
process.stdin.on('data', chunk => {
  stdin += String(chunk);
});
process.stdin.on('end', () => {
  clearTimeout(timer);
  console.log(JSON.stringify({ args: process.argv.slice(2), stdin }));
});
`,
    'utf8'
  );
  chmodSync(bin, 0o755);
  return { cwd, bin };
}

function makeGrandchildCli(): { cwd: string; bin: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-local-cli-provider-grandchild-'));
  const bin = join(cwd, 'grandchild-cli');
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { spawn } from 'node:child_process';

const child = spawn('sh', ['-c', 'trap "exit 0" TERM; while true; do sleep 1; done'], {
  stdio: 'ignore',
});
child.unref();
console.log(String(child.pid));
setInterval(() => {}, 1000);
process.stdin.resume();
`,
    'utf8'
  );
  chmodSync(bin, 0o755);
  return { cwd, bin };
}

function makeTermIgnoringGrandchildCli(): { cwd: string; bin: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-local-cli-provider-term-ignore-'));
  const bin = join(cwd, 'term-ignoring-grandchild-cli');
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { spawn } from 'node:child_process';

const child = spawn('sh', ['-c', 'trap "" TERM; while true; do sleep 1; done'], {
  stdio: 'ignore',
});
child.unref();
console.log(String(child.pid));
setInterval(() => {}, 1000);
process.stdin.resume();
`,
    'utf8'
  );
  chmodSync(bin, 0o755);
  return { cwd, bin };
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`process ${String(pid)} still alive`);
}

describe('runLocalCliProvider', () => {
  test('closes stdin even when prompt is passed as an argument', async () => {
    const { cwd, bin } = makeStdinAwareCli();
    const chunks = await collect(
      runLocalCliProvider({
        providerId: 'test',
        prompt: 'hello',
        cwd,
        command: {
          command: bin,
          args: ['--flag'],
          promptMode: 'arg',
        },
      })
    );

    const assistant = chunks.find(c => c.type === 'assistant');
    const payload = JSON.parse(assistant?.content ?? '{}') as { args: string[]; stdin: string };
    expect(payload.args).toEqual(['--flag', 'hello']);
    expect(payload.stdin).toBe('');
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'result' });
  });

  test('terminates the spawned process group when aborted', async () => {
    if (process.platform === 'win32') return;

    const { cwd, bin } = makeGrandchildCli();
    const abortController = new AbortController();
    const generator = runLocalCliProvider({
      providerId: 'test',
      prompt: 'hello',
      cwd,
      command: {
        command: bin,
        args: [],
        promptMode: 'stdin',
      },
      requestOptions: {
        abortSignal: abortController.signal,
      },
    });

    let grandchildPid: number | undefined;
    let aborted = false;
    try {
      for await (const chunk of generator) {
        if (chunk.type !== 'assistant') continue;
        grandchildPid = Number(chunk.content.trim());
        abortController.abort();
      }
    } catch (error) {
      aborted = String((error as Error).message).includes('query aborted');
    } finally {
      if (grandchildPid !== undefined) {
        try {
          await waitForProcessExit(grandchildPid);
        } catch (error) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            // Ignore cleanup races; the assertion below reports the failure.
          }
          throw error;
        }
      }
    }

    expect(typeof grandchildPid).toBe('number');
    expect(aborted).toBe(true);
  });

  test('escalates to SIGKILL when a spawned process group ignores SIGTERM', async () => {
    if (process.platform === 'win32') return;

    const previousGraceMs = process.env.ARCHON_LOCAL_CLI_TERMINATION_GRACE_MS;
    process.env.ARCHON_LOCAL_CLI_TERMINATION_GRACE_MS = '100';

    const { cwd, bin } = makeTermIgnoringGrandchildCli();
    const abortController = new AbortController();
    const generator = runLocalCliProvider({
      providerId: 'test',
      prompt: 'hello',
      cwd,
      command: {
        command: bin,
        args: [],
        promptMode: 'stdin',
      },
      requestOptions: {
        abortSignal: abortController.signal,
      },
    });

    let grandchildPid: number | undefined;
    let aborted = false;
    try {
      for await (const chunk of generator) {
        if (chunk.type !== 'assistant') continue;
        grandchildPid = Number(chunk.content.trim());
        abortController.abort();
      }
    } catch (error) {
      aborted = String((error as Error).message).includes('query aborted');
    } finally {
      if (previousGraceMs === undefined) {
        delete process.env.ARCHON_LOCAL_CLI_TERMINATION_GRACE_MS;
      } else {
        process.env.ARCHON_LOCAL_CLI_TERMINATION_GRACE_MS = previousGraceMs;
      }

      if (grandchildPid !== undefined) {
        try {
          await waitForProcessExit(grandchildPid);
        } catch (error) {
          try {
            process.kill(grandchildPid, 'SIGKILL');
          } catch {
            // Ignore cleanup races; the assertion below reports the failure.
          }
          throw error;
        }
      }
    }

    expect(typeof grandchildPid).toBe('number');
    expect(aborted).toBe(true);
  });
});
