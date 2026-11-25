import { describe, test, expect } from 'bun:test';

import {
  chatTurnEventProperties,
  workflowTerminalEventProperties,
  type TelemetryUsageProperties,
  classifyWorkflowForTelemetry,
  resolveInstallChannel,
  runRefForTelemetry,
  sanitizeModelForTelemetry,
} from './telemetry-events';

describe('classifyWorkflowForTelemetry', () => {
  test('bundled workflows report their real name', () => {
    expect(classifyWorkflowForTelemetry('implement', 'bundled')).toEqual({
      workflow_name: 'implement',
      workflow_source: 'bundled',
    });
  });

  test('project workflows are redacted to "custom" and report their source', () => {
    expect(classifyWorkflowForTelemetry('deploy-acme-prod', 'project')).toEqual({
      workflow_name: 'custom',
      workflow_source: 'project',
    });
  });

  test('global workflows are also redacted to "custom"', () => {
    expect(classifyWorkflowForTelemetry('my-global', 'global')).toEqual({
      workflow_name: 'custom',
      workflow_source: 'global',
    });
  });

  test('installed workflow names are redacted and preserve their source', () => {
    expect(classifyWorkflowForTelemetry('acme/private:deploy', 'installed')).toEqual({
      workflow_name: 'custom',
      workflow_source: 'installed',
    });
  });

  test('undefined source defaults to the privacy-safe custom/project treatment', () => {
    expect(classifyWorkflowForTelemetry('anything', undefined)).toEqual({
      workflow_name: 'custom',
      workflow_source: 'project',
    });
  });
});

describe('runRefForTelemetry', () => {
  test('is a stable 16-hex reference per run that differs between runs', () => {
    const ref = runRefForTelemetry('run-a');
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(runRefForTelemetry('run-a')).toBe(ref);
    expect(runRefForTelemetry('run-b')).not.toBe(ref);
  });
});

describe('resolveInstallChannel', () => {
  test('a source build is docker only when running in the Archon image', () => {
    expect(resolveInstallChannel({})).toBe('source');
    expect(resolveInstallChannel({ ARCHON_DOCKER: 'true' })).toBe('docker');
  });
});

describe('sanitizeModelForTelemetry', () => {
  test('forwards real model refs verbatim', () => {
    for (const model of [
      'sonnet',
      'opus',
      'claude-sonnet-4-6',
      'gpt-5.6-sol',
      'anthropic/claude-haiku-4-5',
      'openrouter/qwen/qwen3-coder',
      'opus[1m]',
      'claude-opus-4-7[1m]',
    ]) {
      expect(sanitizeModelForTelemetry(model)).toBe(model);
    }
  });

  test('drops free-text / non-categorical values so they cannot leak', () => {
    expect(sanitizeModelForTelemetry('claude for the acme prod deploy')).toBeUndefined();
    expect(sanitizeModelForTelemetry('john.doe@example.com is testing')).toBeUndefined();
    expect(sanitizeModelForTelemetry('x'.repeat(100))).toBeUndefined();
    expect(sanitizeModelForTelemetry('')).toBeUndefined();
    expect(sanitizeModelForTelemetry('opus[1 m]')).toBeUndefined();
    expect(sanitizeModelForTelemetry('opus[<script>]')).toBeUndefined();
    expect(sanitizeModelForTelemetry('opus[1m][2m]')).toBeUndefined();
  });

  test('passes through undefined', () => {
    expect(sanitizeModelForTelemetry(undefined)).toBeUndefined();
  });
});

describe('shared telemetry usage wire contract', () => {
  const specimen: Required<TelemetryUsageProperties> = {
    costUsd: 0.75,
    tokensIn: 5000,
    tokensOut: 1200,
    cacheReadTokens: 4000,
    cacheWriteTokens: 250,
    cachePartialTokens: true,
  };
  const wireKeys: Record<keyof TelemetryUsageProperties, string> = {
    costUsd: 'cost_usd',
    tokensIn: 'tokens_in',
    tokensOut: 'tokens_out',
    cacheReadTokens: 'cache_read_tokens',
    cacheWriteTokens: 'cache_write_tokens',
    cachePartialTokens: 'cache_partial',
  };
  const serializers = {
    chat: (usage: TelemetryUsageProperties) =>
      chatTurnEventProperties({ ...usage, outcome: 'completed' }),
    terminal: (usage: TelemetryUsageProperties) =>
      workflowTerminalEventProperties({ ...usage, outcome: 'completed', workflowName: 'custom' }),
  };

  for (const [name, serialize] of Object.entries(serializers)) {
    test(`${name}: carries every shared usage property to its stable wire key`, () => {
      const wire = serialize(specimen);
      for (const axis of Object.keys(wireKeys) as (keyof TelemetryUsageProperties)[]) {
        expect(wire[wireKeys[axis]], `${axis} -> ${wireKeys[axis]}`).toBe(specimen[axis]);
      }
    });

    test(`${name}: leaves unreported shared usage properties absent`, () => {
      const wire = serialize({});
      for (const key of Object.values(wireKeys)) expect(wire).not.toHaveProperty(key);
    });
  }
});
