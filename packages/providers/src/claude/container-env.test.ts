import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildRequestSubprocessEnv } from './provider';

/**
 * Env-isolation enforcement point: a container run must receive ONLY the
 * Archon-managed env bag over a minimal base — host `process.env` must NEVER
 * cross into the container. A host run keeps inheriting the host env unchanged.
 */
describe('buildRequestSubprocessEnv — container env isolation', () => {
  const CANARY = 'ARCHON_HOST_CANARY_SECRET';

  beforeEach(() => {
    process.env[CANARY] = 'leaked-host-secret';
  });
  afterEach(() => {
    delete process.env[CANARY];
  });

  test('container run EXCLUDES host process.env (canary absent), keeps managed creds', () => {
    const env = buildRequestSubprocessEnv({
      execContext: { kind: 'container', containerId: 'c1' },
      env: { ANTHROPIC_API_KEY: 'sk-managed', CODEBASE_VAR: 'x' },
    });
    expect(env[CANARY]).toBeUndefined(); // host secret did NOT cross the boundary
    expect(env.ANTHROPIC_API_KEY).toBe('sk-managed'); // managed creds delivered
    expect(env.CODEBASE_VAR).toBe('x');
    expect(env.TERM).toBe('dumb'); // minimal base only
  });

  test('host run INHERITS host process.env (canary present) — unchanged behavior', () => {
    const env = buildRequestSubprocessEnv({ env: { FOO: 'bar' } });
    expect(env[CANARY]).toBe('leaked-host-secret');
    expect(env.FOO).toBe('bar');
  });

  test('container run mirrors CLAUDE_API_KEY -> ANTHROPIC_API_KEY', () => {
    const env = buildRequestSubprocessEnv({
      execContext: { kind: 'container', containerId: 'c1' },
      env: { CLAUDE_API_KEY: 'sk-claude' },
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-claude');
    expect(env[CANARY]).toBeUndefined();
  });
});
