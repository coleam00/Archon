import { describe, expect, it } from 'bun:test';
import type { WorkflowConfig } from './deps';
import {
  applyWorkflowRunConfigLayer,
  readWorkflowRunConfigMetadata,
  WORKFLOW_RUN_CONFIG_METADATA_KEY,
} from './run-config';

function baseConfig(): WorkflowConfig {
  return {
    assistant: 'claude',
    assistants: {
      claude: { model: 'sonnet', settingSources: ['project'] },
      codex: { model: 'gpt-5.5' },
    },
    aliases: { '@planner': { provider: 'claude', model: 'opus' } },
    tiers: {
      small: { provider: 'claude', model: 'haiku' },
      medium: { provider: 'claude', model: 'sonnet' },
    },
    commands: { folder: '.archon/commands' },
    defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
    docsPath: 'docs',
    envVars: { LOWER: 'kept', SHARED: 'lower' },
    workflows: {
      autoResumeOnQuotaReset: false,
      quotaMaxAttempts: 1,
      quotaDeadlineMs: 86_400_000,
    },
  };
}

describe('applyWorkflowRunConfigLayer', () => {
  it('changes only supplied keys and merges nested maps per key', () => {
    const base = baseConfig();
    const resolved = applyWorkflowRunConfigLayer(base, {
      assistants: { claude: { model: 'opus' } },
      envVars: { SHARED: 'run' },
      workflows: { quotaMaxAttempts: 4 },
    });

    expect(resolved).toMatchObject({
      assistant: 'claude',
      assistants: {
        claude: { model: 'opus', settingSources: ['project'] },
        codex: { model: 'gpt-5.5' },
      },
      tiers: {
        small: { provider: 'claude', model: 'haiku' },
        medium: { provider: 'claude', model: 'sonnet' },
      },
      envVars: { LOWER: 'kept', SHARED: 'run' },
      workflows: {
        autoResumeOnQuotaReset: false,
        quotaMaxAttempts: 4,
        quotaDeadlineMs: 86_400_000,
      },
    });
    expect(base.assistants.claude.model).toBe('sonnet');
    expect(base.tiers?.large).toBeUndefined();
  });

  it('rejects a partial quota layer when the lower config omitted required defaults', () => {
    const base = { ...baseConfig(), workflows: undefined };
    expect(() => applyWorkflowRunConfigLayer(base, { workflows: { quotaMaxAttempts: 2 } })).toThrow(
      'missing quota policy defaults'
    );
  });
});

describe('readWorkflowRunConfigMetadata', () => {
  it('accepts the sealed public shape and rejects malformed metadata', () => {
    const valid = {
      version: 1 as const,
      ciphertext: 'opaque',
      source: { kind: 'http' as const, label: 'inline' },
      keys: ['tiers.large'],
    };
    expect(readWorkflowRunConfigMetadata({ [WORKFLOW_RUN_CONFIG_METADATA_KEY]: valid })).toEqual(
      valid
    );
    expect(() =>
      readWorkflowRunConfigMetadata({
        [WORKFLOW_RUN_CONFIG_METADATA_KEY]: { ...valid, version: 2 },
      })
    ).toThrow('invalid run_config metadata');
  });
});
