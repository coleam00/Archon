import { describe, expect, test } from 'bun:test';

import {
  QoderCliProvider,
  buildQoderCliArgs,
  type QoderCliProcess,
  type QoderCliSpawner,
} from './provider';

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

interface FakeProcess extends QoderCliProcess {
  killed: boolean;
}

function makeProcess(stdout: string, stderr = '', exitCode = 0): FakeProcess {
  const fakeProcess: FakeProcess = {
    stdout: streamFrom(stdout),
    stderr: streamFrom(stderr),
    exited: Promise.resolve(exitCode),
    killed: false,
    kill: () => {
      fakeProcess.killed = true;
    },
  };
  return fakeProcess;
}

function makeAbortableProcess(): FakeProcess {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const fakeProcess: FakeProcess = {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    }),
    stderr: streamFrom(''),
    exited: new Promise<number>(resolve => {
      resolveExit = resolve;
    }),
    killed: false,
    kill: () => {
      if (fakeProcess.killed) return;
      fakeProcess.killed = true;
      stdoutController?.close();
      resolveExit?.(0);
    },
  };
  return fakeProcess;
}

async function collect(provider: QoderCliProvider): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of provider.sendQuery('hello', '/repo', undefined, {
    assistantConfig: { model: 'qoder-pro', modelReasoningEffort: 'high' },
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for test condition');
}

function makeSpawner(processes: FakeProcess[], calls: string[][]): QoderCliSpawner {
  return (command): QoderCliProcess => {
    calls.push(command);
    const fakeProcess = processes.shift();
    if (!fakeProcess) throw new Error('No fake process queued');
    return fakeProcess;
  };
}

describe('buildQoderCliArgs', () => {
  test('builds non-interactive argv with model, effort, permission mode, and session id', () => {
    const result = buildQoderCliArgs({
      prompt: 'hello',
      cwd: '/repo',
      config: { model: 'qoder-pro', modelReasoningEffort: 'high' },
    });

    expect(result.args).toContain('--print');
    expect(result.args).toContain('--cwd');
    expect(result.args).toContain('/repo');
    expect(result.args).toContain('--model');
    expect(result.args).toContain('qoder-pro');
    expect(result.args).toContain('--reasoning-effort');
    expect(result.args).toContain('high');
    expect(result.args).toContain('--permission-mode');
    expect(result.args).toContain('bypass_permissions');
    expect(result.args).toContain('--session-id');
    expect(result.args.at(-2)).toBe('--');
    expect(result.args.at(-1)).toBe('hello');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  test('node effort overrides config reasoning effort', () => {
    const result = buildQoderCliArgs({
      prompt: 'hello',
      cwd: '/repo',
      config: { modelReasoningEffort: 'low' },
      requestOptions: { nodeConfig: { effort: 'max' } },
    });
    const effortIndex = result.args.indexOf('--reasoning-effort');
    expect(result.args[effortIndex + 1]).toBe('max');
  });

  test('resume uses prior session id without creating a new session flag', () => {
    const result = buildQoderCliArgs({
      prompt: 'hello',
      cwd: '/repo',
      config: {},
      resumeSessionId: 'existing-session',
    });
    expect(result.sessionId).toBe('existing-session');
    expect(result.args).toContain('--resume');
    expect(result.args).toContain('existing-session');
    expect(result.args).not.toContain('--session-id');
  });

  test('forked resume creates a new session id', () => {
    const result = buildQoderCliArgs({
      prompt: 'hello',
      cwd: '/repo',
      config: {},
      resumeSessionId: 'existing-session',
      requestOptions: { forkSession: true },
    });
    expect(result.sessionId).not.toBe('existing-session');
    expect(result.args).toContain('--fork-session');
    expect(result.args).toContain('--session-id');
  });

  test('adds warning for unsupported thinking object', () => {
    const result = buildQoderCliArgs({
      prompt: 'hello',
      cwd: '/repo',
      config: {},
      requestOptions: { nodeConfig: { thinking: { type: 'enabled' } } },
    });
    expect(result.warnings[0]?.message).toContain('thinking');
  });

  test('assistant outputFormat is ignored for structured-output requests', () => {
    const result = buildQoderCliArgs({
      prompt: 'hello',
      cwd: '/repo',
      config: { outputFormat: 'stream-json' },
      requestOptions: { outputFormat: { type: 'json_schema', schema: { type: 'object' } } },
    });
    expect(result.args).not.toContain('--output-format');
  });
});

describe('QoderCliProvider', () => {
  const originalEnvPath = process.env.QODERCLI_BIN_PATH;

  async function withEnvPath<T>(fn: () => Promise<T>): Promise<T> {
    process.env.QODERCLI_BIN_PATH = process.execPath;
    try {
      return await fn();
    } finally {
      if (originalEnvPath === undefined) {
        delete process.env.QODERCLI_BIN_PATH;
      } else {
        process.env.QODERCLI_BIN_PATH = originalEnvPath;
      }
    }
  }

  test('getType returns qodercli', () => {
    expect(new QoderCliProvider().getType()).toBe('qodercli');
  });

  test('getCapabilities exposes Qoder capabilities', () => {
    const caps = new QoderCliProvider().getCapabilities();
    expect(caps.sessionResume).toBe(true);
    expect(caps.effortControl).toBe(true);
    expect(caps.thinkingControl).toBe(true);
    expect(caps.structuredOutput).toBe('best-effort');
  });

  test('runs status preflight then query and streams stdout', async () => {
    await withEnvPath(async () => {
      const calls: string[][] = [];
      const provider = new QoderCliProvider({
        spawn: makeSpawner(
          [makeProcess('{"logged_in":true}'), makeProcess('Hello from Qoder')],
          calls
        ),
      });

      const chunks = await collect(provider);

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([process.execPath, 'status', '-o', 'json']);
      expect(calls[1]).toContain('--print');
      expect(calls[1]).toContain('--model');
      expect(calls[1]).toContain('qoder-pro');
      expect(calls[1]).toContain('--reasoning-effort');
      expect(calls[1]).toContain('high');
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello from Qoder' });
      expect(chunks.at(-1)).toMatchObject({ type: 'result' });
    });
  });

  test('fails fast when status reports logged out', async () => {
    await withEnvPath(async () => {
      const provider = new QoderCliProvider({
        spawn: makeSpawner([makeProcess('{"logged_in":false}')], []),
      });

      await expect(collect(provider)).rejects.toThrow('qodercli login');
    });
  });

  test('non-zero query emits terminal error result', async () => {
    await withEnvPath(async () => {
      const provider = new QoderCliProvider({
        spawn: makeSpawner([makeProcess('{"logged_in":true}'), makeProcess('', 'boom', 2)], []),
      });

      const chunks = await collect(provider);
      expect(chunks.at(-1)).toMatchObject({
        type: 'result',
        isError: true,
        errorSubtype: 'qodercli_exit_nonzero',
      });
    });
  });

  test('structured output parses stdout into result chunk', async () => {
    await withEnvPath(async () => {
      const calls: string[][] = [];
      const provider = new QoderCliProvider({
        spawn: makeSpawner(
          [makeProcess('{"logged_in":true}'), makeProcess('{"answer":"ok"}')],
          calls
        ),
      });

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('hello', '/repo', undefined, {
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })) {
        chunks.push(chunk);
      }

      expect(calls[1]?.at(-1)).toContain('CRITICAL: Respond with ONLY a JSON object');
      expect(chunks.at(-1)).toMatchObject({
        type: 'result',
        structuredOutput: { answer: 'ok' },
      });
    });
  });

  test('pre-aborted request stops before status preflight', async () => {
    await withEnvPath(async () => {
      const calls: string[][] = [];
      const controller = new AbortController();
      controller.abort();
      const provider = new QoderCliProvider({
        spawn: makeSpawner([], calls),
      });

      await expect(
        (async () => {
          for await (const chunk of provider.sendQuery('hello', '/repo', undefined, {
            abortSignal: controller.signal,
          })) {
            void chunk;
          }
        })()
      ).rejects.toThrow('Query aborted');
      expect(calls).toHaveLength(0);
    });
  });

  test('aborted request kills the query process', async () => {
    await withEnvPath(async () => {
      const calls: string[][] = [];
      const queryProcess = makeAbortableProcess();
      const controller = new AbortController();
      const provider = new QoderCliProvider({
        spawn: makeSpawner([makeProcess('{"logged_in":true}'), queryProcess], calls),
      });

      const run = (async (): Promise<void> => {
        for await (const chunk of provider.sendQuery('hello', '/repo', undefined, {
          abortSignal: controller.signal,
        })) {
          void chunk;
        }
      })();

      await waitFor(() => calls.length === 2);
      controller.abort();

      await expect(run).rejects.toThrow('Query aborted');
      expect(queryProcess.killed).toBe(true);
    });
  });
});
