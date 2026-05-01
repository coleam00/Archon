/**
 * Unit tests for the GitHub Copilot CLI community provider.
 *
 * Tests cover:
 *   - Argument building (buildCopilotArgs)
 *   - Config parsing (parseCopilotConfig)
 *   - Binary resolver (resolveCopilotBinaryPath)
 *   - Provider streaming: happy path, exit-code failure, abort signal, timeouts
 *
 * Tests use bun:test and mock node:child_process so no real copilot binary
 * is needed. The provider internals are tested via a fake spawn that drives
 * events through the same queue-based pipeline the real process uses.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock @archon/paths so tests are quiet and deterministic ────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/mock/archon/home'),
}));

// ─── Import subjects AFTER mocking ─────────────────────────────────────────

import { buildCopilotArgs } from './args';
import { parseCopilotConfig } from './config';
import { resolveCopilotBinaryPath } from './binary-resolver';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Drain an async generator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of gen) {
    result.push(item);
  }
  return result;
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

type ResultChunk = {
  type: 'result';
  isError?: boolean;
  errorSubtype?: string;
  errors?: string[];
};

type SystemChunk = {
  type: 'system';
  content: string;
};

async function createProvider(): Promise<import('./provider').CopilotProvider> {
  const { CopilotProvider } = await import('./provider');
  return new CopilotProvider();
}

// ─────────────────────────────────────────────────────────────────────────────
// buildCopilotArgs
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCopilotArgs', () => {
  test('minimal: prompt only → -p <prompt> and --no-ask-user by default', () => {
    const args = buildCopilotArgs({ prompt: 'hello world', config: {} });
    expect(args).toEqual(['-p', 'hello world', '--no-ask-user']);
  });

  test('prompt with model override', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      modelOverride: 'gpt-5.3-codex',
      config: {},
    });
    expect(args).toContain('--model=gpt-5.3-codex');
  });

  test('config model used when no override', () => {
    const args = buildCopilotArgs({ prompt: 'test', config: { model: 'my-model' } });
    expect(args).toContain('--model=my-model');
  });

  test('modelOverride takes precedence over config model', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      modelOverride: 'override-model',
      config: { model: 'config-model' },
    });
    expect(args).toContain('--model=override-model');
    expect(args).not.toContain('--model=config-model');
  });

  test('noAskUser: false omits --no-ask-user', () => {
    const args = buildCopilotArgs({ prompt: 'test', config: { noAskUser: false } });
    expect(args).not.toContain('--no-ask-user');
  });

  test('allowAllTools → --allow-all-tools', () => {
    const args = buildCopilotArgs({ prompt: 'test', config: { allowAllTools: true } });
    expect(args).toContain('--allow-all-tools');
  });

  test('allowAll → --allow-all', () => {
    const args = buildCopilotArgs({ prompt: 'test', config: { allowAll: true } });
    expect(args).toContain('--allow-all');
  });

  test('allowAllPaths → --allow-all-paths', () => {
    const args = buildCopilotArgs({ prompt: 'test', config: { allowAllPaths: true } });
    expect(args).toContain('--allow-all-paths');
  });

  test('allowAllUrls → --allow-all-urls', () => {
    const args = buildCopilotArgs({ prompt: 'test', config: { allowAllUrls: true } });
    expect(args).toContain('--allow-all-urls');
  });

  test('allowTools from config → repeated --allow-tool=', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { allowTools: ['read', 'write'] },
    });
    expect(args).toContain('--allow-tool=read');
    expect(args).toContain('--allow-tool=write');
  });

  test('denyTools from config → repeated --deny-tool=', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { denyTools: ['shell', 'bash'] },
    });
    expect(args).toContain('--deny-tool=shell');
    expect(args).toContain('--deny-tool=bash');
  });

  test('nodeConfig.allowed_tools merged with config allowTools (deduplicated)', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { allowTools: ['read'] },
      nodeConfig: { allowed_tools: ['read', 'write'] },
    });
    const allowToolArgs = args.filter(a => a.startsWith('--allow-tool='));
    // 'read' appears only once (dedup), 'write' added from nodeConfig
    expect(allowToolArgs).toHaveLength(2);
    expect(allowToolArgs).toContain('--allow-tool=read');
    expect(allowToolArgs).toContain('--allow-tool=write');
  });

  test('nodeConfig.denied_tools merged with config denyTools (deduplicated)', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { denyTools: ['bash'] },
      nodeConfig: { denied_tools: ['bash', 'shell'] },
    });
    const denyToolArgs = args.filter(a => a.startsWith('--deny-tool='));
    expect(denyToolArgs).toHaveLength(2);
    expect(denyToolArgs).toContain('--deny-tool=bash');
    expect(denyToolArgs).toContain('--deny-tool=shell');
  });

  test('deny tools take precedence over overlapping allow tools', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { allowTools: ['read', 'shell'], denyTools: ['shell'] },
      nodeConfig: { allowed_tools: ['bash'], denied_tools: ['bash'] },
    });

    expect(args).toContain('--allow-tool=read');
    expect(args).toContain('--deny-tool=shell');
    expect(args).toContain('--deny-tool=bash');
    expect(args).not.toContain('--allow-tool=shell');
    expect(args).not.toContain('--allow-tool=bash');
  });

  test('addDirs → repeated --add-dir=', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { addDirs: ['/foo', '/bar'] },
    });
    expect(args).toContain('--add-dir=/foo');
    expect(args).toContain('--add-dir=/bar');
  });

  test('allowUrls → repeated --allow-url=', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { allowUrls: ['https://example.com'] },
    });
    expect(args).toContain('--allow-url=https://example.com');
  });

  test('denyUrls → repeated --deny-url=', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { denyUrls: ['https://evil.example'] },
    });
    expect(args).toContain('--deny-url=https://evil.example');
  });

  test('secretEnvVars → single comma-separated --secret-env-vars=', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { secretEnvVars: ['MY_SECRET', 'ANOTHER_SECRET'] },
    });
    expect(args).toContain('--secret-env-vars=MY_SECRET,ANOTHER_SECRET');
  });

  test('secretEnvVars single entry → no trailing comma', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { secretEnvVars: ['ONE_VAR'] },
    });
    expect(args).toContain('--secret-env-vars=ONE_VAR');
  });

  test('extraArgs appended verbatim', () => {
    const args = buildCopilotArgs({
      prompt: 'test',
      config: { extraArgs: ['--available-tools=write_powershell', '--debug'] },
    });
    expect(args).toContain('--available-tools=write_powershell');
    expect(args).toContain('--debug');
    // extraArgs should be at the end
    const extraStart = args.indexOf('--available-tools=write_powershell');
    expect(extraStart).toBeGreaterThan(0);
  });

  test('prompt is always first two args (-p <prompt>)', () => {
    const prompt = 'my prompt text';
    const args = buildCopilotArgs({ prompt, config: { model: 'gpt-5' } });
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(prompt);
  });

  test('no allowAll or allowAllTools by default', () => {
    const args = buildCopilotArgs({ prompt: 'test', config: {} });
    expect(args).not.toContain('--allow-all');
    expect(args).not.toContain('--allow-all-tools');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseCopilotConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('parseCopilotConfig', () => {
  test('empty object returns empty config', () => {
    expect(parseCopilotConfig({})).toEqual({});
  });

  test('valid string fields are parsed', () => {
    const result = parseCopilotConfig({
      copilotBinaryPath: '/usr/local/bin/copilot',
      model: 'gpt-5.3-codex',
    });
    expect(result.copilotBinaryPath).toBe('/usr/local/bin/copilot');
    expect(result.model).toBe('gpt-5.3-codex');
  });

  test('valid boolean fields are parsed', () => {
    const result = parseCopilotConfig({
      noAskUser: false,
      allowAllTools: true,
      allowAll: false,
      allowAllPaths: true,
      allowAllUrls: false,
    });
    expect(result.noAskUser).toBe(false);
    expect(result.allowAllTools).toBe(true);
    expect(result.allowAll).toBe(false);
    expect(result.allowAllPaths).toBe(true);
    expect(result.allowAllUrls).toBe(false);
  });

  test('valid number fields are parsed', () => {
    const result = parseCopilotConfig({
      firstEventTimeoutMs: 30000,
      processTimeoutMs: 600000,
    });
    expect(result.firstEventTimeoutMs).toBe(30000);
    expect(result.processTimeoutMs).toBe(600000);
  });

  test('invalid timeout fields are dropped', () => {
    const result = parseCopilotConfig({
      firstEventTimeoutMs: Number.NaN,
      processTimeoutMs: -1,
    });

    expect(result.firstEventTimeoutMs).toBeUndefined();
    expect(result.processTimeoutMs).toBeUndefined();
  });

  test('positive fractional timeout fields are truncated', () => {
    const result = parseCopilotConfig({
      firstEventTimeoutMs: 123.9,
      processTimeoutMs: 456.1,
    });

    expect(result.firstEventTimeoutMs).toBe(123);
    expect(result.processTimeoutMs).toBe(456);
  });

  test('valid string arrays are parsed', () => {
    const result = parseCopilotConfig({
      allowTools: ['read', 'write'],
      denyTools: ['shell'],
      extraArgs: ['--available-tools=write_powershell'],
      addDirs: ['/workspace'],
      allowUrls: ['https://example.com'],
      denyUrls: ['https://blocked.example'],
      secretEnvVars: ['MY_TOKEN'],
    });
    expect(result.allowTools).toEqual(['read', 'write']);
    expect(result.denyTools).toEqual(['shell']);
    expect(result.extraArgs).toEqual(['--available-tools=write_powershell']);
    expect(result.addDirs).toEqual(['/workspace']);
    expect(result.allowUrls).toEqual(['https://example.com']);
    expect(result.denyUrls).toEqual(['https://blocked.example']);
    expect(result.secretEnvVars).toEqual(['MY_TOKEN']);
  });

  test('blank string array entries are trimmed and dropped', () => {
    const result = parseCopilotConfig({
      allowTools: [' read ', '', '   ', 'write'],
    });

    expect(result.allowTools).toEqual(['read', 'write']);
  });

  test('non-string entries in array fields are dropped', () => {
    const result = parseCopilotConfig({
      allowTools: ['read', 42, null, 'write'],
    });
    expect(result.allowTools).toEqual(['read', 'write']);
  });

  test('empty array fields are not included in result', () => {
    const result = parseCopilotConfig({ allowTools: [] });
    expect(result.allowTools).toBeUndefined();
  });

  test('invalid type fields are dropped silently', () => {
    const result = parseCopilotConfig({
      model: 123,
      noAskUser: 'yes',
      copilotBinaryPath: true,
    });
    expect(result.model).toBeUndefined();
    expect(result.noAskUser).toBeUndefined();
    expect(result.copilotBinaryPath).toBeUndefined();
  });

  test('unknown fields are ignored', () => {
    const result = parseCopilotConfig({ unknownKey: 'value', another: 42 });
    expect((result as Record<string, unknown>).unknownKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCopilotBinaryPath
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveCopilotBinaryPath', () => {
  const originalEnv = process.env.COPILOT_BIN_PATH;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COPILOT_BIN_PATH;
    } else {
      process.env.COPILOT_BIN_PATH = originalEnv;
    }
  });

  test('returns default command name when no env or config', () => {
    delete process.env.COPILOT_BIN_PATH;
    const result = resolveCopilotBinaryPath(undefined);
    // Should be 'copilot' on non-windows or 'copilot.cmd' on windows
    expect(result).toMatch(/^copilot(\.cmd)?$/);
  });

  test('COPILOT_BIN_PATH bare name is returned without existence check', () => {
    process.env.COPILOT_BIN_PATH = 'copilot';
    const result = resolveCopilotBinaryPath(undefined);
    expect(result).toBe('copilot');
  });

  test('COPILOT_BIN_PATH is trimmed and rejects blank values', () => {
    process.env.COPILOT_BIN_PATH = '  copilot  ';
    expect(resolveCopilotBinaryPath(undefined)).toBe('copilot');

    process.env.COPILOT_BIN_PATH = '   ';
    expect(() => resolveCopilotBinaryPath(undefined)).toThrow('COPILOT_BIN_PATH is set but empty');
  });

  test('COPILOT_BIN_PATH absolute path that does not exist throws', () => {
    process.env.COPILOT_BIN_PATH = '/nonexistent/path/to/copilot';
    expect(() => resolveCopilotBinaryPath(undefined)).toThrow('COPILOT_BIN_PATH');
  });

  test('config binary path is trimmed and rejects blank values', () => {
    delete process.env.COPILOT_BIN_PATH;
    expect(resolveCopilotBinaryPath('  copilot  ')).toBe('copilot');
    expect(() => resolveCopilotBinaryPath('   ')).toThrow('copilotBinaryPath must not be empty');
  });

  test('config path that does not exist throws', () => {
    delete process.env.COPILOT_BIN_PATH;
    expect(() => resolveCopilotBinaryPath('/nonexistent/copilot')).toThrow('copilotBinaryPath');
  });

  test('config bare name (PATH lookup) does not throw', () => {
    delete process.env.COPILOT_BIN_PATH;
    // A bare name without path separators should not trigger existence check
    const result = resolveCopilotBinaryPath('copilot');
    expect(result).toBe('copilot');
  });

  test('COPILOT_BIN_PATH takes precedence over config', () => {
    process.env.COPILOT_BIN_PATH = 'env-copilot';
    const result = resolveCopilotBinaryPath('config-copilot');
    expect(result).toBe('env-copilot');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CopilotProvider — spawn mock infrastructure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fake child process that lets tests script stdout/stderr/exit events.
 */
class FakeChildProcess extends EventEmitter {
  stdout: EventEmitter & { on: (event: string, listener: (...args: unknown[]) => void) => this };
  stderr: EventEmitter & { on: (event: string, listener: (...args: unknown[]) => void) => this };
  killed = false;
  pid = 12345;

  // scheduled events
  private _stdoutChunks: { data: string; delayMs: number }[] = [];
  private _stderrChunks: { data: string; delayMs: number }[] = [];
  private _exitCode: number | null = 0;
  private _exitSignal: string | null = null;
  private _exitDelayMs = 5;
  private _spawnError: Error | null = null;
  private _exitBeforeStreamEnd = false;

  constructor() {
    super();
    this.stdout = Object.assign(new EventEmitter(), {
      on(event: string, listener: (...args: unknown[]) => void) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      },
    }) as typeof this.stdout;
    this.stderr = Object.assign(new EventEmitter(), {
      on(event: string, listener: (...args: unknown[]) => void) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      },
    }) as typeof this.stderr;
  }

  /** Schedule a stdout chunk at an offset from start. */
  scheduleStdout(data: string, delayMs = 1): this {
    this._stdoutChunks.push({ data, delayMs });
    return this;
  }

  /** Schedule a stderr chunk at an offset from start. */
  scheduleStderr(data: string, delayMs = 1): this {
    this._stderrChunks.push({ data, delayMs });
    return this;
  }

  /** Configure exit behavior. */
  scheduleExit(code: number | null, signal: string | null = null, delayMs = 5): this {
    this._exitCode = code;
    this._exitSignal = signal;
    this._exitDelayMs = delayMs;
    return this;
  }

  scheduleSpawnError(err: Error): this {
    this._spawnError = err;
    return this;
  }

  scheduleExitBeforeStreamEnd(): this {
    this._exitBeforeStreamEnd = true;
    return this;
  }

  /** Start driving events. Called by the mock spawn. */
  start(): void {
    if (this._spawnError) {
      setTimeout(() => this.emit('error', this._spawnError), 1);
      return;
    }

    for (const { data, delayMs } of this._stdoutChunks) {
      setTimeout(() => {
        this.stdout.emit('data', Buffer.from(data));
      }, delayMs);
    }
    for (const { data, delayMs } of this._stderrChunks) {
      setTimeout(() => {
        this.stderr.emit('data', Buffer.from(data));
      }, delayMs);
    }

    const maxChunkDelay = Math.max(
      ...this._stdoutChunks.map(c => c.delayMs),
      ...this._stderrChunks.map(c => c.delayMs),
      0
    );
    const exitDelay = Math.max(this._exitDelayMs, maxChunkDelay + 1);

    setTimeout(() => {
      if (this._exitBeforeStreamEnd) {
        this.emit('exit', this._exitCode, this._exitSignal);
      }
      this.stdout.emit('end');
      this.stderr.emit('end');
      if (!this._exitBeforeStreamEnd) {
        this.emit('exit', this._exitCode, this._exitSignal);
      }
      this.emit('close', this._exitCode, this._exitSignal);
    }, exitDelay);
  }

  kill(signal?: string): boolean {
    if (!this.killed) {
      this.killed = true;
      // Simulate the process dying from the signal
      setTimeout(() => {
        this.stdout.emit('end');
        this.stderr.emit('end');
        this.emit('exit', null, signal ?? 'SIGTERM');
        this.emit('close', null, signal ?? 'SIGTERM');
      }, 5);
    }
    return true;
  }
}

/** The spawn call arguments for the last invocation. */
let lastSpawnArgs: string[] = [];
let spawnArgHistory: string[][] = [];

// Intercept node:child_process spawn
mock.module('node:child_process', () => ({
  spawn: mock((binary: string, args: string[]) => {
    void binary;
    lastSpawnArgs = args;
    spawnArgHistory.push(args);
    const child = new FakeChildProcess();
    // Schedule start asynchronously so the provider can attach listeners first
    Promise.resolve().then(() => child.start());
    return child as unknown as ChildProcess;
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// CopilotProvider — sendQuery tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CopilotProvider.sendQuery', () => {
  beforeEach(() => {
    lastSpawnArgs = [];
    spawnArgHistory = [];
    delete process.env.COPILOT_BIN_PATH;
  });

  test('happy path: stdout lines become assistant chunks, exit 0 yields result', async () => {
    const provider = await createProvider();

    // Prime the fake child before the call so it's ready
    // The mock spawn creates the FakeChildProcess in the spawn call
    // We need to configure it after spawn is called, so we use a post-spawn hook.
    // The FakeChildProcess is created in spawn() and then start() is called async.
    // We configure the behavior via the scheduled events set before start().

    // Since we can't configure before spawn, we'll use a different approach:
    // set up a spy that returns our pre-configured fake.
    const fake = new FakeChildProcess();
    fake.scheduleStdout('Hello from copilot\n', 5);
    fake.scheduleStdout('Second line\n', 10);
    fake.scheduleExit(0, null, 20);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
        (binary: string, args: string[]) => {
          void binary;
          lastSpawnArgs = args;
          spawnArgHistory.push(args);
          Promise.resolve().then(() => fake.start());
          return fake as unknown as ChildProcess;
        }
    );

    const chunks = await collect(
      provider.sendQuery('test prompt', '/tmp/cwd', undefined, {
        assistantConfig: { model: 'gpt-5' },
      })
    );

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    const resultChunk = chunks.find(c => c.type === 'result');

    expect(assistantChunks).toHaveLength(2);
    expect((assistantChunks[0] as { type: 'assistant'; content: string }).content).toBe(
      'Hello from copilot'
    );
    expect((assistantChunks[1] as { type: 'assistant'; content: string }).content).toBe(
      'Second line'
    );
    expect(resultChunk).toBeDefined();
    expect((resultChunk as { type: 'result'; isError?: boolean }).isError).toBeUndefined();

    // Verify spawn was called with correct binary and -p flag
    const promptFlagIndex = lastSpawnArgs.indexOf('-p');
    expect(promptFlagIndex).toBeGreaterThanOrEqual(0);
    expect(lastSpawnArgs[promptFlagIndex + 1]).toBe('test prompt');
    expect(lastSpawnArgs).toContain('--model=gpt-5');
  });

  test('stderr lines become system chunks', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleStderr('Warning: something happened\n', 5);
    fake.scheduleExit(0, null, 20);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(provider.sendQuery('test', '/tmp', undefined, {}));

    const systemChunks = chunks.filter(c => c.type === 'system');
    expect(systemChunks.length).toBeGreaterThan(0);
    expect((systemChunks[0] as { type: 'system'; content: string }).content).toContain(
      'Warning: something happened'
    );
  });

  test('non-zero exit yields result with isError and errorSubtype copilot_cli_exit', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleStderr('Error: authentication failed\n', 5);
    fake.scheduleExit(1, null, 20);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(provider.sendQuery('test', '/tmp', undefined, {}));

    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;

    expect(resultChunk).toBeDefined();
    const result = requireDefined(resultChunk, 'Expected non-zero exit result chunk');
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('copilot_cli_exit');
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('exited with code 1'))).toBe(true);
  });

  test('spawn error yields result with isError', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleSpawnError(new Error('spawn ENOENT'));

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(provider.sendQuery('test', '/tmp', undefined, {}));

    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;

    expect(resultChunk).toBeDefined();
    const result = requireDefined(resultChunk, 'Expected spawn error result chunk');
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('copilot_cli_exit');
  });

  test('resolver setup errors yield result chunk instead of throwing', async () => {
    process.env.COPILOT_BIN_PATH = '   ';

    const provider = await createProvider();
    const chunks = await collect(provider.sendQuery('test', '/tmp', undefined, {}));

    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;
    const result = requireDefined(resultChunk, 'Expected resolver setup error result chunk');
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('copilot_cli_exit');
    expect(result.errors?.some(e => e.includes('COPILOT_BIN_PATH is set but empty'))).toBe(true);
  });

  test('abort signal kills process and yields abort error result', async () => {
    const fake = new FakeChildProcess();
    // Don't schedule any output — the process hangs
    fake.scheduleExit(0, null, 10000); // long delay

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const controller = new AbortController();
    const provider = await createProvider();

    // Abort after a tiny delay
    setTimeout(() => controller.abort(), 10);

    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        abortSignal: controller.signal,
        assistantConfig: { firstEventTimeoutMs: 30000, processTimeoutMs: 30000 },
      })
    );

    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;

    expect(resultChunk).toBeDefined();
    const result = requireDefined(resultChunk, 'Expected abort result chunk');
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('copilot_cli_exit');
    expect(result.errors?.some(e => e.toLowerCase().includes('abort'))).toBe(true);
  });

  test('first-event timeout yields error result when no output arrives', async () => {
    const fake = new FakeChildProcess();
    // No stdout/stderr — process hangs silently
    fake.scheduleExit(0, null, 60000); // very long exit

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { firstEventTimeoutMs: 20, processTimeoutMs: 60000 },
      })
    );

    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;

    expect(resultChunk).toBeDefined();
    const result = requireDefined(resultChunk, 'Expected first-event timeout result chunk');
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('copilot_cli_exit');
    expect(result.errors?.some(e => e.includes('did not produce any output'))).toBe(true);
  }, 5000);

  test('first-event timeout is satisfied by raw output before newline', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleStdout('partial output without newline', 5);
    fake.scheduleExit(0, null, 40);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { firstEventTimeoutMs: 20, processTimeoutMs: 60000 },
      })
    );

    const assistantChunk = chunks.find(c => c.type === 'assistant') as
      | { type: 'assistant'; content: string }
      | undefined;
    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;

    expect(assistantChunk?.content).toBe('partial output without newline');
    expect(resultChunk).toBeDefined();
    const result = requireDefined(resultChunk, 'Expected raw output result chunk');
    expect(result.isError).toBeUndefined();
  });

  test('final unterminated output is preserved when exit fires before stream end', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleStdout('final line without newline', 5);
    fake.scheduleExit(0, null, 20).scheduleExitBeforeStreamEnd();

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(provider.sendQuery('test', '/tmp', undefined, {}));

    const assistantChunk = chunks.find(c => c.type === 'assistant') as
      | { type: 'assistant'; content: string }
      | undefined;
    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;

    expect(assistantChunk?.content).toBe('final line without newline');
    expect(resultChunk).toBeDefined();
  });

  test('process timeout yields error result when process runs too long', async () => {
    const fake = new FakeChildProcess();
    // Produces output (so first-event timeout doesn't fire) but never exits
    fake.scheduleStdout('starting...\n', 5);
    fake.scheduleExit(0, null, 60000); // very long exit

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { firstEventTimeoutMs: 60000, processTimeoutMs: 30 },
      })
    );

    const resultChunk = chunks.find(c => c.type === 'result') as ResultChunk | undefined;

    expect(resultChunk).toBeDefined();
    const result = requireDefined(resultChunk, 'Expected process timeout result chunk');
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('copilot_cli_exit');
    expect(result.errors?.some(e => e.includes('timeout'))).toBe(true);
  }, 5000);

  test('security warning emitted for allowAll', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { allowAll: true },
      })
    );

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const warningChunk = systemChunks.find(c => c.content.includes('allowAll'));
    expect(warningChunk).toBeDefined();
    expect(requireDefined(warningChunk, 'Expected allowAll warning chunk').content).toContain('⚠️');
  });

  test('security warning emitted for allowAllTools', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { allowAllTools: true },
      })
    );

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const warningChunk = systemChunks.find(c => c.content.includes('allowAllTools'));
    expect(warningChunk).toBeDefined();
  });

  test('security warning emitted when allowAll is supplied through extraArgs', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { extraArgs: ['--allow-all'] },
      })
    );

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const warningChunk = systemChunks.find(c => c.content.includes('allowAll'));
    expect(warningChunk).toBeDefined();
  });

  test('security warning emitted when allowAllTools is supplied through extraArgs', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { extraArgs: ['--allow-all-tools'] },
      })
    );

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const warningChunk = systemChunks.find(c => c.content.includes('allowAllTools'));
    expect(warningChunk).toBeDefined();
  });

  test('security warning emitted when yolo is supplied through extraArgs', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { extraArgs: ['--yolo'] },
      })
    );

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const warningChunk = systemChunks.find(c => c.content.includes('allowAll'));
    expect(warningChunk).toBeDefined();
  });

  test('security warning emitted for allowAllPaths from final argv', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { extraArgs: ['--allow-all-paths'] },
      })
    );

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const warningChunk = systemChunks.find(c => c.content.includes('allowAllPaths'));
    expect(warningChunk).toBeDefined();
  });

  test('security warning emitted for allowAllUrls from final argv', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { extraArgs: ['--allow-all-urls'] },
      })
    );

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const warningChunk = systemChunks.find(c => c.content.includes('allowAllUrls'));
    expect(warningChunk).toBeDefined();
  });

  test('missing stdout or stderr pipes yields explicit error result', async () => {
    const childWithoutPipes = Object.assign(new EventEmitter(), {
      stdout: undefined,
      stderr: undefined,
      killed: false,
      kill() {
        this.killed = true;
        return true;
      },
    });

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => childWithoutPipes as unknown as ChildProcess
    );

    const provider = await createProvider();
    const chunks = await collect(provider.sendQuery('test', '/tmp', undefined, {}));
    const resultChunk = chunks.find(c => c.type === 'result') as
      | { type: 'result'; isError?: boolean; errorSubtype?: string; errors?: string[] }
      | undefined;

    expect(resultChunk).toBeDefined();
    expect(resultChunk?.isError).toBe(true);
    expect(resultChunk?.errorSubtype).toBe('copilot_cli_exit');
    expect(resultChunk?.errors).toContain('Copilot CLI did not expose stdout/stderr pipes.');
  });

  test('no allowAll warning when allowAll is false or not set', async () => {
    const fake = new FakeChildProcess();
    fake.scheduleExit(0, null, 10);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce(
      (_b: string, _a: string[]) => {
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      }
    );

    const provider = await createProvider();
    const chunks = await collect(provider.sendQuery('test', '/tmp', undefined, {}));

    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const hasAllowAllWarning = systemChunks.some(c => c.content.includes('allowAll'));
    expect(hasAllowAllWarning).toBe(false);
  });

  test('getType returns copilot', async () => {
    const provider = await createProvider();
    expect(provider.getType()).toBe('copilot');
  });

  test('getCapabilities returns COPILOT_CAPABILITIES', async () => {
    const provider = await createProvider();
    const caps = provider.getCapabilities();
    expect(caps.toolRestrictions).toBe(true);
    expect(caps.envInjection).toBe(true);
    expect(caps.sessionResume).toBe(false);
    expect(caps.mcp).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.fallbackModel).toBe(true);
  });

  test('retries with fallbackModel on rate-limit failure before assistant output', async () => {
    const first = new FakeChildProcess();
    first.scheduleStderr('Error: rate limit exceeded\n', 5);
    first.scheduleExit(1, null, 20);

    const second = new FakeChildProcess();
    second.scheduleStdout('Recovered with fallback\n', 5);
    second.scheduleExit(0, null, 20);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>)
      .mockImplementationOnce((_b: string, args: string[]) => {
        lastSpawnArgs = args;
        spawnArgHistory.push(args);
        Promise.resolve().then(() => first.start());
        return first as unknown as ChildProcess;
      })
      .mockImplementationOnce((_b: string, args: string[]) => {
        lastSpawnArgs = args;
        spawnArgHistory.push(args);
        Promise.resolve().then(() => second.start());
        return second as unknown as ChildProcess;
      });

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        model: 'claude-haiku-4.5',
        fallbackModel: 'gpt-5-mini',
      })
    );

    const assistantChunks = chunks.filter(c => c.type === 'assistant') as Array<{
      type: 'assistant';
      content: string;
    }>;
    const systemChunks = chunks.filter(c => c.type === 'system') as SystemChunk[];
    const resultChunk = chunks.findLast(c => c.type === 'result') as ResultChunk | undefined;

    expect(spawnArgHistory).toHaveLength(2);
    expect(spawnArgHistory[0]).toContain('--model=claude-haiku-4.5');
    expect(spawnArgHistory[1]).toContain('--model=gpt-5-mini');
    expect(systemChunks.some(c => c.content.includes('Retrying with fallback model "gpt-5-mini"'))).toBe(true);
    expect(assistantChunks.map(c => c.content)).toContain('Recovered with fallback');
    expect(resultChunk?.isError).toBeUndefined();
  });

  test('does not retry fallback after assistant output has already started', async () => {
    const first = new FakeChildProcess();
    first.scheduleStdout('Partial output\n', 5);
    first.scheduleStderr('Error: rate limit exceeded\n', 10);
    first.scheduleExit(1, null, 20);

    const spawnMod = await import('node:child_process');
    (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce((_b: string, args: string[]) => {
      lastSpawnArgs = args;
      spawnArgHistory.push(args);
      Promise.resolve().then(() => first.start());
      return first as unknown as ChildProcess;
    });

    const provider = await createProvider();
    const chunks = await collect(
      provider.sendQuery('test', '/tmp', undefined, {
        model: 'claude-haiku-4.5',
        fallbackModel: 'gpt-5-mini',
      })
    );

    const resultChunk = chunks.findLast(c => c.type === 'result') as ResultChunk | undefined;
    expect(spawnArgHistory).toHaveLength(1);
    expect(resultChunk?.isError).toBe(true);
  });

  test('injects project-local GitHub skills into the Copilot prompt', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'archon-copilot-skills-'));
    const cwd = join(tmpRoot, 'project');
    const skillDir = join(cwd, '.github', 'skills', 'pitch-presentation');

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Pitch skill\nAlways use Polish.\n', 'utf-8');

    try {
      const fake = new FakeChildProcess();
      fake.scheduleStdout('OK\n', 5);
      fake.scheduleExit(0, null, 20);

      const spawnMod = await import('node:child_process');
      (spawnMod.spawn as ReturnType<typeof mock>).mockImplementationOnce((_b: string, args: string[]) => {
        lastSpawnArgs = args;
        spawnArgHistory.push(args);
        Promise.resolve().then(() => fake.start());
        return fake as unknown as ChildProcess;
      });

      const provider = await createProvider();
      await collect(
        provider.sendQuery('Build the deck', cwd, undefined, {
          nodeConfig: { skills: ['pitch-presentation'] },
        })
      );

      const promptArgIndex = lastSpawnArgs.indexOf('-p');
      const injectedPrompt = promptArgIndex >= 0 ? lastSpawnArgs[promptArgIndex + 1] : '';

      expect(injectedPrompt).toContain('Additional project skill context is provided below.');
      expect(injectedPrompt).toContain('<skill name="pitch-presentation"');
      expect(injectedPrompt).toContain('Always use Polish.');
      expect(injectedPrompt).toContain('Task:\nBuild the deck');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
