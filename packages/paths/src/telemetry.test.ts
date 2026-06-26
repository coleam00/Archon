import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';

import {
  isTelemetryDisabled,
  captureWorkflowInvoked,
  captureArchonStarted,
  captureArchonActive,
  captureChatTurn,
  captureApprovalResolved,
  captureCodebaseRegistered,
  captureWorkflowCompleted,
  classifyWorkflowForTelemetry,
  sanitizeModelForTelemetry,
  shutdownTelemetry,
  resetTelemetryForTests,
  getOrCreateTelemetryId,
  getTelemetryStatus,
  resetTelemetryId,
} from './telemetry';

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

describe('telemetry opt-out detection', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
  });

  test('enabled by default when no opt-out env vars set', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('CI=true disables telemetry', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.POSTHOG_API_KEY;
    process.env.CI = 'true';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('CI=1 does not disable (only "true" is honored, not "1")', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.POSTHOG_API_KEY;
    process.env.CI = '1';
    expect(isTelemetryDisabled()).toBe(false);
  });

  test.each(['true', 'True', 'TRUE'])(
    'CI=%s disables (case-insensitive, AppVeyor sets True)',
    value => {
      delete process.env.ARCHON_TELEMETRY_DISABLED;
      delete process.env.DO_NOT_TRACK;
      delete process.env.POSTHOG_API_KEY;
      process.env.CI = value;
      expect(isTelemetryDisabled()).toBe(true);
    }
  );

  test('ARCHON_TELEMETRY_DISABLED=1 disables telemetry', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DO_NOT_TRACK=1 disables telemetry', () => {
    process.env.DO_NOT_TRACK = '1';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('ARCHON_TELEMETRY_DISABLED=0 does not disable (strict "1" match)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '0';
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('empty POSTHOG_API_KEY override disables telemetry', () => {
    process.env.POSTHOG_API_KEY = '';
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    expect(isTelemetryDisabled()).toBe(true);
  });

  test.each(['off', 'OFF', '0', 'false', 'disabled'])(
    'POSTHOG_API_KEY=%s disables telemetry',
    value => {
      process.env.POSTHOG_API_KEY = value;
      delete process.env.ARCHON_TELEMETRY_DISABLED;
      delete process.env.DO_NOT_TRACK;
      delete process.env.CI;
      expect(isTelemetryDisabled()).toBe(true);
    }
  );

  test('POSTHOG_API_KEY=phc_custom is treated as enabled (self-host)', () => {
    process.env.POSTHOG_API_KEY = 'phc_custom_self_hosted_key';
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    expect(isTelemetryDisabled()).toBe(false);
  });
});

describe('getTelemetryStatus', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-status-'));
    process.env.ARCHON_HOME = tmpHome;
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('reports enabled + embedded key source when no env vars set', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(true);
    expect(status.disabledReason).toBeNull();
    expect(status.keySource).toBe('embedded');
    expect(status.distinctId).toMatch(/^[0-9a-f-]+$/);
    expect(status.host).toContain('posthog');
  });

  test('does not create a telemetry-id file when inspected while disabled', () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
    expect(status.distinctId).toMatch(/^[0-9a-f-]+$/);
    // Opted-out users inspecting status must not have a UUID materialized for them.
    expect(existsSync(join(tmpHome, 'telemetry-id'))).toBe(false);
  });

  test('reports CI as the disabled reason', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    process.env.CI = 'true';
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toBe('CI');
  });

  test('reports POSTHOG_API_KEY when explicit "off" value is set', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.POSTHOG_API_KEY = 'off';
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toBe('POSTHOG_API_KEY');
    expect(status.keySource).toBe('none');
  });

  test('reports env key source for non-default API key', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.POSTHOG_API_KEY = 'phc_self_hosted';
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(true);
    expect(status.keySource).toBe('env');
  });

  test('precedence: ARCHON_TELEMETRY_DISABLED wins over CI', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    process.env.CI = 'true';
    expect(getTelemetryStatus().disabledReason).toBe('ARCHON_TELEMETRY_DISABLED');
  });
});

describe('resetTelemetryId', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-reset-'));
    process.env.ARCHON_HOME = tmpHome;
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('writes a new UUID to telemetry-id and returns it', () => {
    const id1 = getOrCreateTelemetryId();
    const id2 = resetTelemetryId();
    expect(id2).not.toBe(id1);
    expect(id2).toMatch(/^[0-9a-f-]+$/);
    const onDisk = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(onDisk).toBe(id2);
  });

  test('updates the in-process cache so subsequent calls see the new ID', () => {
    resetTelemetryId();
    const cached = getOrCreateTelemetryId();
    const onDisk = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(cached).toBe(onDisk);
  });
});

describe('first-run notice (via captureWorkflowInvoked)', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;
  let originalIsTTY: boolean | undefined;
  const stampPath = (): string => join(tmpHome, 'telemetry-notice-shown-v4');

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
    captureWorkflowInvoked({ workflowName: 'w' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(existsSync(stampPath())).toBe(false);
    writeSpy.mockRestore();
  });

  test('writes the notice once on first invocation (TTY, no stamp) and stamps it', () => {
    setTTY(true);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ workflowName: 'w' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain('anonymous usage telemetry');
    expect(existsSync(stampPath())).toBe(true);
    writeSpy.mockRestore();
  });

  test('does not write again in the same process (noticeChecked guard)', () => {
    setTTY(true);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ workflowName: 'w' });
    captureWorkflowInvoked({ workflowName: 'w2' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();
  });

  test('skips the notice when the stamp file already exists (cross-run idempotency)', () => {
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(stampPath(), '2026-01-01T00:00:00.000Z', 'utf8');
    setTTY(true);
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ workflowName: 'w' });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  test('does not write the notice when telemetry is disabled', () => {
    setTTY(true);
    process.env.DO_NOT_TRACK = '1';
    resetTelemetryForTests();
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    captureWorkflowInvoked({ workflowName: 'w' });
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
        workflowName: 'test-workflow',
        platform: 'cli',
      });
    }).not.toThrow();
  });

  test('shutdownTelemetry is a no-op when never initialized', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe('telemetry ID persistence', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-test-'));
    process.env.ARCHON_HOME = tmpHome;
    // Force-disable actual network capture — we only exercise the ID path.
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('calling capture while disabled does not create a telemetry-id file', () => {
    captureWorkflowInvoked({ workflowName: 'w' });
    expect(existsSync(join(tmpHome, 'telemetry-id'))).toBe(false);
  });

  test('an existing telemetry-id file is preserved (not overwritten)', async () => {
    const { writeFileSync, mkdirSync } = await import('fs');
    const existingId = '11111111-1111-4111-8111-111111111111';
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(join(tmpHome, 'telemetry-id'), existingId, 'utf8');

    resetTelemetryForTests();

    // Direct, synchronous call — no network, no fire-and-forget, no timer.
    const resolved = getOrCreateTelemetryId();

    expect(resolved).toBe(existingId);
    const stored = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(stored).toBe(existingId);
  });
});

describe('classifyWorkflowForTelemetry', () => {
  test('bundled workflows report their real name and is_builtin true', () => {
    expect(classifyWorkflowForTelemetry('implement', 'bundled')).toEqual({
      is_builtin: true,
      workflow_name: 'implement',
      workflow_source: 'bundled',
    });
  });

  test('project workflows are redacted to "custom" and report their source', () => {
    expect(classifyWorkflowForTelemetry('deploy-acme-prod', 'project')).toEqual({
      is_builtin: false,
      workflow_name: 'custom',
      workflow_source: 'project',
    });
  });

  test('global workflows are also redacted to "custom"', () => {
    expect(classifyWorkflowForTelemetry('my-global', 'global')).toEqual({
      is_builtin: false,
      workflow_name: 'custom',
      workflow_source: 'global',
    });
  });

  test('undefined source defaults to the privacy-safe custom/project treatment', () => {
    expect(classifyWorkflowForTelemetry('anything', undefined)).toEqual({
      is_builtin: false,
      workflow_name: 'custom',
      workflow_source: 'project',
    });
  });
});

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
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    // Stub the transport so the enabled path never touches the network, then
    // flush deterministically before restoring (no flaky timers / real ingest).
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":"ok"}', { status: 200 })
    );
    try {
      expect(() => captureArchonStarted({ surface: 'server' })).not.toThrow();
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('captureArchonActive does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() => captureArchonActive({ surface: 'server' })).not.toThrow();
  });

  test('captureArchonActive does not throw (enabled)', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":"ok"}', { status: 200 })
    );
    try {
      expect(() => captureArchonActive({ surface: 'server' })).not.toThrow();
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('captureChatTurn does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() =>
      captureChatTurn({ platform: 'slack', provider: 'claude', outcome: 'completed' })
    ).not.toThrow();
    expect(() => captureChatTurn({ outcome: 'failed' })).not.toThrow();
  });

  test('captureChatTurn does not throw (enabled)', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":"ok"}', { status: 200 })
    );
    try {
      expect(() =>
        captureChatTurn({ platform: 'web', provider: 'codex', outcome: 'completed' })
      ).not.toThrow();
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('captureApprovalResolved does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() => captureApprovalResolved({ resolution: 'approved' })).not.toThrow();
    expect(() => captureApprovalResolved({ resolution: 'rejected' })).not.toThrow();
  });

  test('captureApprovalResolved does not throw (enabled)', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":"ok"}', { status: 200 })
    );
    try {
      expect(() => captureApprovalResolved({ resolution: 'approved' })).not.toThrow();
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }
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

  test('captureWorkflowCompleted accepts v4 usage fields without throwing (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() =>
      captureWorkflowCompleted({
        outcome: 'completed',
        workflowName: 'implement',
        workflowSource: 'bundled',
        durationMs: 1234,
        nodesCompleted: 3,
        nodesTotal: 3,
        costUsd: 1.5,
        tokensIn: 50000,
        tokensOut: 12000,
        loopIterations: 4,
      })
    ).not.toThrow();
  });

  test('captureCodebaseRegistered does not throw (disabled)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(() => captureCodebaseRegistered()).not.toThrow();
  });

  test('captureCodebaseRegistered does not throw (enabled)', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":"ok"}', { status: 200 })
    );
    try {
      expect(() => captureCodebaseRegistered()).not.toThrow();
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }
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
        adapterSlack: true,
        adapterTelegram: false,
        adapterDiscord: false,
        adapterGitea: false,
        adapterGitlab: false,
      })
    ).not.toThrow();
  });

  test('captureArchonStarted serializes deployment shape to wire properties (enabled)', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const bodies: (string | Blob)[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      const body = (options as { body?: unknown } | undefined)?.body;
      if (typeof body === 'string' || body instanceof Blob) bodies.push(body);
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    });
    try {
      captureArchonStarted({
        surface: 'server',
        dbKind: 'postgresql',
        webAuthEnabled: true,
        githubAuthMode: 'app',
        adapterSlack: true,
        // multiUser and the remaining adapter booleans intentionally omitted —
        // absent fields must be omitted from the wire, not sent as undefined.
      });
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }

    interface WireEvent {
      event: string;
      properties: Record<string, unknown>;
    }
    // posthog-node gzips the /batch/ body into a Blob; decompress to inspect.
    const events: WireEvent[] = [];
    for (const body of bodies) {
      const text =
        typeof body === 'string'
          ? body
          : new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await body.arrayBuffer())));
      const payload = JSON.parse(text) as { batch?: WireEvent[] };
      events.push(...(payload.batch ?? []));
    }
    const started = events.find(e => e.event === 'archon_started');
    expect(started).toBeDefined();
    const props = started!.properties;
    expect(props.surface).toBe('server');
    expect(props.db_kind).toBe('postgresql');
    expect(props.web_auth_enabled).toBe(true);
    expect(props.github_auth_mode).toBe('app');
    expect(props.adapter_slack).toBe(true);
    // Omitted fields must not appear on the wire at all
    expect('multi_user' in props).toBe(false);
    expect('adapter_telegram' in props).toBe(false);
    expect('adapter_discord' in props).toBe(false);
    // Privacy invariants ride on every event
    expect(props.$process_person_profile).toBe(false);
    expect(props.$ip).toBe('');
  });

  test('captureChatTurn serializes v4 usage fields to snake_case wire keys (enabled)', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const bodies: (string | Blob)[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      const body = (options as { body?: unknown } | undefined)?.body;
      if (typeof body === 'string' || body instanceof Blob) bodies.push(body);
      return Promise.resolve(new Response('{"status":"ok"}', { status: 200 }));
    });
    try {
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
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }

    interface WireEvent {
      event: string;
      properties: Record<string, unknown>;
    }
    const events: WireEvent[] = [];
    for (const body of bodies) {
      const text =
        typeof body === 'string'
          ? body
          : new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await body.arrayBuffer())));
      const payload = JSON.parse(text) as { batch?: WireEvent[] };
      events.push(...(payload.batch ?? []));
    }
    const turn = events.find(e => e.event === 'chat_turn_handled');
    expect(turn).toBeDefined();
    const props = turn!.properties;
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
      captureWorkflowCompleted({
        outcome: 'completed',
        workflowName: 'implement',
        workflowSource: 'bundled',
        durationMs: 1234,
        nodesCompleted: 3,
        nodesTotal: 3,
      })
    ).not.toThrow();
    expect(() =>
      captureWorkflowCompleted({
        outcome: 'failed',
        workflowName: 'x',
        exitReason: 'node_error',
      })
    ).not.toThrow();
  });

  test('captureWorkflowCompleted does not throw (enabled)', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":"ok"}', { status: 200 })
    );
    try {
      expect(() =>
        captureWorkflowCompleted({
          outcome: 'failed',
          workflowName: 'implement',
          workflowSource: 'bundled',
          exitReason: 'unhandled_error',
        })
      ).not.toThrow();
      await shutdownTelemetry();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('sanitizeModelForTelemetry', () => {
  test('forwards real model refs verbatim', () => {
    for (const model of [
      'sonnet',
      'opus',
      'claude-sonnet-4-6',
      'gpt-5.3-codex',
      'anthropic/claude-haiku-4-5',
      'openrouter/qwen/qwen3-coder',
    ]) {
      expect(sanitizeModelForTelemetry(model)).toBe(model);
    }
  });

  test('drops free-text / non-categorical values so they cannot leak', () => {
    expect(sanitizeModelForTelemetry('claude for the acme prod deploy')).toBeUndefined();
    expect(sanitizeModelForTelemetry('john.doe@example.com is testing')).toBeUndefined();
    expect(sanitizeModelForTelemetry('x'.repeat(100))).toBeUndefined();
    expect(sanitizeModelForTelemetry('')).toBeUndefined();
  });

  test('passes through undefined', () => {
    expect(sanitizeModelForTelemetry(undefined)).toBeUndefined();
  });
});
