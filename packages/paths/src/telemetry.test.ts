import { describe, test, expect, beforeEach, afterEach, spyOn, jest } from 'bun:test';
import { tmpdir } from 'os';
import { setImmediate } from 'node:timers/promises';
import { join } from 'path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';

import {
  captureWorkflowInvoked,
  captureArchonStarted,
  captureArchonActive,
  captureChatTurn,
  captureWorkflowNoMatch,
  captureApprovalResolved,
  captureCodebaseRegistered,
  captureWorkflowTerminal,
  resetTelemetryForTests,
} from './telemetry';
import { NOTICE_STAMP_FILENAME } from './telemetry-consent';
import { runRefForTelemetry, TELEMETRY_SCHEMA_VERSION } from './telemetry-events';
import { shutdownTelemetry } from './telemetry-transport';

const ENV_VARS = [
  'ARCHON_HOME',
  'ARCHON_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'CI',
  'POSTHOG_API_KEY',
  'POSTHOG_HOST',
];

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_VARS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe('first-run notice (via captureWorkflowInvoked)', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;
  let originalIsTTY: boolean | undefined;
  const stampPath = (): string => join(tmpHome, NOTICE_STAMP_FILENAME);

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-notice-'));
    process.env.ARCHON_HOME = tmpHome;
    // Telemetry must be enabled for the notice path to be reachable.
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    originalIsTTY = process.stderr.isTTY;
    resetTelemetryForTests();
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTTY, configurable: true });
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });
  }

  test('does not write the notice when stderr is not a TTY', () => {
    setTTY(false);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ runId: 'run-1', isChild: false, workflowName: 'w' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(existsSync(stampPath())).toBe(false);
    writeSpy.mockRestore();
  });

  test('writes the notice once on first invocation (TTY, no stamp) and stamps it', () => {
    setTTY(true);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ runId: 'run-1', isChild: false, workflowName: 'w' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain('anonymous usage telemetry');
    expect(existsSync(stampPath())).toBe(true);
    writeSpy.mockRestore();
  });

  test('does not write again in the same process (noticeChecked guard)', () => {
    setTTY(true);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ runId: 'run-1', isChild: false, workflowName: 'w' });
    captureWorkflowInvoked({ runId: 'run-1', isChild: false, workflowName: 'w2' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();
  });

  test('skips the notice when the stamp file already exists (cross-run idempotency)', () => {
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(stampPath(), '2026-01-01T00:00:00.000Z', 'utf8');
    setTTY(true);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ runId: 'run-1', isChild: false, workflowName: 'w' });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  test('does not write the notice when telemetry is disabled', () => {
    setTTY(true);
    process.env.DO_NOT_TRACK = '1';
    resetTelemetryForTests();
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ runId: 'run-1', isChild: false, workflowName: 'w' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(existsSync(stampPath())).toBe(false);
    writeSpy.mockRestore();
  });
});

describe('captureWorkflowInvoked when disabled', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    resetTelemetryForTests();
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
  });

  test('does not throw when telemetry is disabled', () => {
    expect(() => {
      captureWorkflowInvoked({
        runId: 'run-1',
        isChild: false,
        workflowName: 'test-workflow',
        platform: 'cli',
      });
    }).not.toThrow();
  });

  test('shutdownTelemetry is a no-op when never initialized', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

interface WireEvent {
  event: string;
  properties: Record<string, unknown>;
}

const TEST_FLUSH_TIMEOUT_MS = 10000;

async function captureTelemetry(capture: () => void): Promise<WireEvent[]> {
  delete process.env.ARCHON_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CI;
  delete process.env.POSTHOG_API_KEY;
  const bodies: (string | Blob)[] = [];
  const fetchImpl = Object.assign(
    (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      options?.signal?.throwIfAborted();
      const body = options?.body;
      if (String(url).endsWith('/batch/') && (typeof body === 'string' || body instanceof Blob)) {
        bodies.push(body);
      }
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    },
    { preconnect: (): void => undefined }
  );
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);
  try {
    try {
      capture();
    } finally {
      // Wire assertions need delivery even when CPU contention exceeds the exit budget.
      await shutdownTelemetry(TEST_FLUSH_TIMEOUT_MS);
    }
    const events: WireEvent[] = [];
    for (const body of bodies) {
      const text =
        typeof body === 'string'
          ? body
          : new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await body.arrayBuffer())));
      events.push(...(JSON.parse(text) as { batch: WireEvent[] }).batch);
    }
    return events;
  } finally {
    fetchSpy.mockRestore();
  }
}

function eventProperties(
  events: WireEvent[],
  name: string,
  workflowName?: string
): Record<string, unknown> {
  const event = events.find(
    event =>
      event.event === name &&
      (workflowName === undefined || event.properties.workflow_name === workflowName)
  );
  if (!event)
    throw new Error(`Missing telemetry event: ${name} (${workflowName ?? 'any workflow'})`);
  return event.properties;
}

describe('new capture functions are fire-and-forget no-throw', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-capture-'));
    process.env.ARCHON_HOME = tmpHome;
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('captureArchonStarted does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() => captureArchonStarted({ surface: 'cli' })).not.toThrow();
  });

  test('captureArchonStarted does not throw (enabled)', async () => {
    await captureTelemetry(() => {
      expect(() => captureArchonStarted({ surface: 'server' })).not.toThrow();
    });
  });

  test('wire capture survives compression completing after the production exit deadline', async () => {
    const compressed = Promise.withResolvers<void>();
    const releaseCompression = Promise.withResolvers<void>();
    const originalBlob = Response.prototype.blob;
    const blobSpy = spyOn(Response.prototype, 'blob').mockImplementation(async function (
      this: Response
    ) {
      const body = await originalBlob.call(this);
      compressed.resolve();
      await releaseCompression.promise;
      return body;
    });
    jest.useFakeTimers();
    try {
      const captured = captureTelemetry(() => captureArchonStarted({ surface: 'cli' }));
      await compressed.promise;
      // Hold the real gzip result past 75 ms, then drain deadline reactions before delivery.
      jest.advanceTimersByTime(76);
      await setImmediate();
      releaseCompression.resolve();
      const events = await captured;
      expect(eventProperties(events, 'archon_started')).toMatchObject({
        schema_version: TELEMETRY_SCHEMA_VERSION,
        surface: 'cli',
        $ip: '',
        $process_person_profile: false,
      });
    } finally {
      releaseCompression.resolve();
      jest.useRealTimers();
      blobSpy.mockRestore();
    }
  });

  test('captureArchonActive does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() => captureArchonActive({ surface: 'server' })).not.toThrow();
  });

  test('captureArchonActive does not throw (enabled)', async () => {
    await captureTelemetry(() => {
      expect(() => captureArchonActive({ surface: 'server' })).not.toThrow();
    });
  });

  test('no-match decisions have a separate anonymous event from ordinary chat', async () => {
    const events = await captureTelemetry(() => {
      captureChatTurn({ outcome: 'completed' });
      captureWorkflowNoMatch('native_tool');
      captureWorkflowNoMatch('cli');
    });
    expect(eventProperties(events, 'chat_turn_handled')).toMatchObject({ outcome: 'completed' });
    expect(eventProperties(events, 'workflow_no_match')).toMatchObject({
      $process_person_profile: false,
      $ip: '',
      schema_version: TELEMETRY_SCHEMA_VERSION,
      transport: 'native_tool',
    });
    expect(
      events
        .filter(event => event.event === 'workflow_no_match')
        .map(event => event.properties.transport)
    ).toEqual(['native_tool', 'cli']);
  });

  test('no-match reporting respects telemetry opt-out on both transports', async () => {
    const events = await captureTelemetry(() => {
      process.env.DO_NOT_TRACK = '1';
      captureWorkflowNoMatch('native_tool');
      captureWorkflowNoMatch('cli');
    });
    expect(events).toEqual([]);
  });

  test('captureChatTurn does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() =>
      captureChatTurn({ platform: 'slack', provider: 'claude', outcome: 'completed' })
    ).not.toThrow();
    expect(() => captureChatTurn({ outcome: 'failed' })).not.toThrow();
  });

  test('captureChatTurn does not throw (enabled)', async () => {
    await captureTelemetry(() => {
      expect(() =>
        captureChatTurn({ platform: 'web', provider: 'codex', outcome: 'completed' })
      ).not.toThrow();
    });
  });

  test('captureApprovalResolved does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() => captureApprovalResolved({ resolution: 'approved' })).not.toThrow();
    expect(() => captureApprovalResolved({ resolution: 'rejected' })).not.toThrow();
  });

  test('captureApprovalResolved does not throw (enabled)', async () => {
    await captureTelemetry(() => {
      expect(() => captureApprovalResolved({ resolution: 'approved' })).not.toThrow();
    });
  });

  test('captureChatTurn accepts v4 usage fields without throwing (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() =>
      captureChatTurn({
        platform: 'slack',
        provider: 'claude',
        model: 'sonnet',
        outcome: 'completed',
        durationMs: 4321,
        costUsd: 0.12,
        tokensIn: 1000,
        tokensOut: 250,
      })
    ).not.toThrow();
  });

  test('captureWorkflowCompleted accepts v5 cache usage fields without throwing (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() =>
      captureWorkflowTerminal({
        outcome: 'completed',
        workflowName: 'implement',
        workflowSource: 'bundled',
        durationMs: 1234,
        nodesCompleted: 3,
        nodesTotal: 3,
        costUsd: 1.5,
        tokensIn: 50000,
        tokensOut: 12000,
        cacheReadTokens: 40000,
        cacheWriteTokens: 0,
        loopIterations: 4,
      })
    ).not.toThrow();
  });

  test('captureCodebaseRegistered does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() => captureCodebaseRegistered()).not.toThrow();
  });

  test('captureCodebaseRegistered does not throw (enabled)', async () => {
    await captureTelemetry(() => {
      expect(() => captureCodebaseRegistered()).not.toThrow();
    });
  });

  test('captureArchonStarted accepts deployment-shape props without throwing (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() =>
      captureArchonStarted({
        surface: 'server',
        dbKind: 'postgresql',
        webAuthEnabled: true,
        multiUser: false,
        githubAuthMode: 'app',
        chatPluginIds: ['slack'],
        adapterTelegram: false,
        adapterDiscord: false,
        adapterGitea: false,
        adapterGitlab: false,
      })
    ).not.toThrow();
  });

  test('captureArchonStarted serializes deployment shape to wire properties (enabled)', async () => {
    const events = await captureTelemetry(() => {
      captureArchonStarted({
        surface: 'server',
        dbKind: 'postgresql',
        webAuthEnabled: true,
        githubAuthMode: 'app',
        chatPluginIds: ['slack', 'community-chat'],
        // multiUser and the remaining adapter booleans intentionally omitted —
        // absent fields must be omitted from the wire, not sent as undefined.
      });
    });
    const props = eventProperties(events, 'archon_started');
    expect(props.surface).toBe('server');
    expect(props.db_kind).toBe('postgresql');
    expect(props.web_auth_enabled).toBe(true);
    expect(props.github_auth_mode).toBe('app');
    expect(props.adapter_slack).toBe(true);
    expect(props.chat_plugins).toBe(2);
    expect(JSON.stringify(props)).not.toContain('community-chat');
    // Omitted fields must not appear on the wire at all
    expect('multi_user' in props).toBe(false);
    expect('adapter_telegram' in props).toBe(false);
    expect('adapter_discord' in props).toBe(false);
    // Privacy invariants ride on every event
    expect(props.$process_person_profile).toBe(false);
    expect(props.$ip).toBe('');
  });

  test('captureChatTurn serializes v4 usage fields to snake_case wire keys (enabled)', async () => {
    const events = await captureTelemetry(() => {
      captureChatTurn({
        platform: 'web',
        provider: 'claude',
        model: 'sonnet',
        outcome: 'completed',
        durationMs: 5120,
        costUsd: 0.03,
        tokensIn: 900,
        tokensOut: 210,
      });
    });
    const props = eventProperties(events, 'chat_turn_handled');
    expect(props.model).toBe('sonnet');
    expect(props.duration_ms).toBe(5120);
    expect(props.cost_usd).toBe(0.03);
    expect(props.tokens_in).toBe(900);
    expect(props.tokens_out).toBe(210);
    expect(props.$process_person_profile).toBe(false);
    expect(props.$ip).toBe('');
  });

  test('captureWorkflowCompleted does not throw for completed/failed (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() =>
      captureWorkflowTerminal({
        outcome: 'completed',
        workflowName: 'implement',
        workflowSource: 'bundled',
        durationMs: 1234,
        nodesCompleted: 3,
        nodesTotal: 3,
      })
    ).not.toThrow();
    expect(() =>
      captureWorkflowTerminal({
        outcome: 'failed',
        workflowName: 'x',
        exitReason: 'node_error',
      })
    ).not.toThrow();
  });

  test('captureWorkflowCompleted does not throw (enabled)', async () => {
    await captureTelemetry(() => {
      expect(() =>
        captureWorkflowTerminal({
          outcome: 'failed',
          workflowName: 'implement',
          workflowSource: 'bundled',
          exitReason: 'unhandled_error',
        })
      ).not.toThrow();
    });
  });

  test('captureWorkflowTerminal serializes run identity, outcome events, cache totals and machine context', async () => {
    const events = await captureTelemetry(() => {
      captureWorkflowTerminal({
        outcome: 'completed',
        runId: 'run-db-id-1',
        isChild: false,
        workflowName: 'implement',
        workflowSource: 'bundled',
        tokensIn: 100,
        tokensOut: 10,
        cacheReadTokens: 70,
        cacheWriteTokens: 0,
      });
      captureWorkflowTerminal({
        outcome: 'completed',
        workflowName: 'plan',
        workflowSource: 'bundled',
        tokensIn: 100,
        tokensOut: 10,
        cacheReadTokens: 70,
        cacheWriteTokens: 0,
        cachePartialTokens: true,
      });
      captureWorkflowTerminal({
        outcome: 'cancelled',
        runId: 'run-db-id-2',
        workflowName: 'deploy-acme-prod',
        workflowSource: 'project',
        cancelReason: 'operator',
      });
    });
    const exact = eventProperties(events, 'workflow_completed', 'implement');
    expect(exact).toMatchObject({
      schema_version: TELEMETRY_SCHEMA_VERSION,
      run_ref: runRefForTelemetry('run-db-id-1'),
      is_child: false,
      // Super-properties: this test runs from a source checkout.
      install_channel: 'source',
      git_commit: expect.stringMatching(/^[0-9a-f]{7}$/),
      tokens_in: 100,
      tokens_out: 10,
      cache_read_tokens: 70,
      cache_write_tokens: 0,
    });
    // A complete total carries no flag, so absence keeps its meaning.
    expect(exact).not.toHaveProperty('cache_partial');

    // Identical totals, but only a floor. Without the flag these two would pool together
    // and bias aggregate cache figures low across installs (#2662).
    const floor = eventProperties(events, 'workflow_completed', 'plan');
    expect(floor).toMatchObject({
      schema_version: TELEMETRY_SCHEMA_VERSION,
      cache_read_tokens: 70,
      cache_write_tokens: 0,
      cache_partial: true,
    });
    // The event name carries the outcome, so neither it nor is_builtin is repeated.
    expect(exact).not.toHaveProperty('outcome');
    expect(exact).not.toHaveProperty('is_builtin');
    const cancelled = eventProperties(events, 'workflow_cancelled');
    expect(cancelled).toMatchObject({ workflow_name: 'custom', cancel_reason: 'operator' });
    // Only the hashed reference leaves the machine, never the run's database id.
    expect(JSON.stringify(events)).not.toContain('run-db-id');
  });
  test('captureWorkflowInvoked serializes workflow shape and bundled ancestry', async () => {
    const events = await captureTelemetry(() => {
      captureWorkflowInvoked({
        runId: 'run-shape',
        isChild: false,
        workflowName: 'acme-intake',
        workflowSource: 'project',
        shape: {
          nodeCounts: { prompt: 3, bash: 1, loop: 0 },
          graphDepth: 4,
          maxFanOut: 2,
          commandRefs: 1,
          promptCharsBucket: '1k_5k',
        },
        ancestry: { derivedFrom: 'archon-implement', derivedSimilarity: 'modified' },
      });
    });
    const invoked = eventProperties(events, 'workflow_invoked');
    expect(invoked).toMatchObject({
      schema_version: TELEMETRY_SCHEMA_VERSION,
      workflow_name: 'custom',
      nodes_prompt: 3,
      nodes_bash: 1,
      graph_depth: 4,
      max_fan_out: 2,
      command_refs: 1,
      prompt_chars_bucket: '1k_5k',
      derived_from: 'archon-implement',
      derived_similarity: 'modified',
    });
    // A node type with no nodes is left out rather than sent as zero.
    expect(invoked).not.toHaveProperty('nodes_loop');
    expect(JSON.stringify(events)).not.toContain('acme-intake');
  });
});
