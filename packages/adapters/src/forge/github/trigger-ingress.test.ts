import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { GitHubAdapter } from './adapter';
import {
  createGitHubTriggerIngress,
  githubTriggerConfigSchema,
  type GitHubTriggerConfig,
} from './trigger-ingress';

type Intake = Parameters<typeof createGitHubTriggerIngress>[1];
type IntakeInput = Parameters<Intake>[0];

const secret = 'trigger-ingress-secret';

function sign(payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function checkRunPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: 'owner/repo' },
    sender: { id: 4242, login: 'event-author' },
    check_run: {
      id: 77,
      name: 'build',
      head_sha: 'opaque-revision-id',
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-09-22T10:00:00Z',
      completed_at: null,
      pull_requests: [],
    },
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: 'check-build',
    hostId: 'workstation-1',
    runAsUserId: 'archon-operator',
    resource: 'repo:owner/repo',
    overlap: 'queue',
    launch: {
      cwd: '/srv/owner/repo',
      workflowName: 'react-to-check',
      inputs: { configured: true },
      isolation: { kind: 'default' },
    },
    selector: {
      kind: 'check.changed',
      actions: ['changed'],
      repository: { host: 'github.com', path: 'owner/repo' },
      predicates: [{ field: 'check.unit.kind', equals: 'check' }],
    },
    inputMapping: {
      repository: { source: 'field', field: 'repository.path' },
      revision: { source: 'field', field: 'check.revision' },
      checkName: { source: 'field', field: 'check.unit.name' },
    },
    ...overrides,
  };
}

function config(bindings: unknown[] = [binding()]): GitHubTriggerConfig {
  return githubTriggerConfigSchema.parse({
    version: 1,
    sourceInstanceId: 'github-primary',
    host: 'github.com',
    bindings,
  });
}

function recorder(options?: { failWith?: Error }) {
  const calls: IntakeInput[] = [];
  const intake: Intake = async input => {
    calls.push(input);
    if (options?.failWith) throw options.failWith;
    return { receiptId: input.receipt.id, replay: false };
  };
  return { calls, intake };
}

function adapter(triggerConfig: GitHubTriggerConfig, intake: Intake): GitHubAdapter {
  return new GitHubAdapter(
    { kind: 'pat', token: 'test-token' },
    secret,
    { acquireLock: async () => ({ status: 'started' }) },
    undefined,
    { triggerIngress: createGitHubTriggerIngress(triggerConfig, intake) }
  );
}

describe('GitHub trigger ingress', () => {
  test('awaits signed delivery normalization and submits a resolved binding snapshot', async () => {
    const recorded = recorder();
    const github = adapter(config(), recorded.intake);
    const payload = JSON.stringify(checkRunPayload());

    await expect(
      github.receiveWebhook(payload, sign(payload), 'delivery-1', 'check_run')
    ).resolves.toBe('accepted');

    expect(recorded.calls).toHaveLength(1);
    const intake = recorded.calls[0];
    expect(intake).toMatchObject({
      outcome: 'matched',
      receipt: {
        sourceInstanceId: 'github-primary',
        deliveryId: 'delivery-1',
        sourceActor: { source: 'github-primary', id: '4242' },
      },
      bindings: [
        {
          bindingId: 'check-build',
          hostId: 'workstation-1',
          runAsUserId: 'archon-operator',
          resource: 'repo:owner/repo',
          overlap: 'queue',
          launch: {
            cwd: '/srv/owner/repo',
            workflowName: 'react-to-check',
            inputs: {
              configured: true,
              repository: 'owner/repo',
              revision: 'opaque-revision-id',
              checkName: 'build',
            },
          },
        },
      ],
    });
    expect(intake.bindings[0]?.bindingRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(intake.bindings[0]?.runAsUserId).not.toBe(intake.receipt.sourceActor?.id);
  });

  test('normalizes a check with no PR association using its qualified repo and revision', async () => {
    const recorded = recorder();
    const github = adapter(config(), recorded.intake);
    const payload = JSON.stringify(checkRunPayload());

    await github.receiveWebhook(payload, sign(payload), 'delivery-zero-pr', 'check_run');

    expect(recorded.calls[0]?.bindings[0]?.launch.inputs).toMatchObject({
      repository: 'owner/repo',
      revision: 'opaque-revision-id',
    });
  });

  test('rejects an invalid signature before trusted intake', async () => {
    const recorded = recorder();
    const github = adapter(config(), recorded.intake);
    const payload = JSON.stringify(checkRunPayload());

    await expect(
      github.receiveWebhook(payload, 'sha256=invalid', 'attacker-delivery', 'check_run')
    ).resolves.toBe('invalid_signature');
    expect(recorded.calls).toEqual([]);
  });

  test('records authenticated malformed and unsupported deliveries', async () => {
    const recorded = recorder();
    const github = adapter(config(), recorded.intake);
    const malformed = '{not-json';
    const unsupported = JSON.stringify({
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 4242, login: 'event-author' },
    });

    await expect(
      github.receiveWebhook(malformed, sign(malformed), 'delivery-malformed', 'check_run')
    ).resolves.toBe('malformed');
    await expect(
      github.receiveWebhook(unsupported, sign(unsupported), 'delivery-unsupported', 'deployment')
    ).resolves.toBe('accepted');

    expect(recorded.calls).toHaveLength(2);
    expect(recorded.calls[0]).toMatchObject({ outcome: 'malformed', reason: 'invalid_json' });
    expect(recorded.calls[1]).toMatchObject({
      outcome: 'unsupported',
      reason: 'Unsupported GitHub event: deployment',
    });
  });

  test('records unmatched selectors and rejected required mappings without starting', async () => {
    const recorded = recorder();
    const triggerConfig = config([
      binding({
        bindingId: 'wrong-repository',
        selector: {
          kind: 'check.changed',
          actions: ['changed'],
          repository: { host: 'github.com', path: 'other/repo' },
        },
      }),
      binding({
        bindingId: 'requires-result',
        inputMapping: { result: { source: 'field', field: 'check.result' } },
      }),
    ]);
    const github = adapter(triggerConfig, recorded.intake);
    const payload = JSON.stringify(checkRunPayload());

    await github.receiveWebhook(payload, sign(payload), 'delivery-no-start', 'check_run');

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({
      outcome: 'unmatched',
      bindings: [],
      evaluatedBindings: [
        {
          bindingId: 'wrong-repository',
          status: 'unmatched',
          reason: 'selector_did_not_match',
        },
        {
          bindingId: 'requires-result',
          status: 'rejected',
          reason: "Input 'result': Required event field check.result is unavailable",
        },
      ],
    });
  });

  test('preserves durable intake failure instead of acknowledging the delivery', async () => {
    const failure = new Error('durable intake unavailable');
    const recorded = recorder({ failWith: failure });
    const github = adapter(config(), recorded.intake);
    const payload = JSON.stringify(checkRunPayload());

    await expect(
      github.receiveWebhook(payload, sign(payload), 'delivery-failed', 'check_run')
    ).rejects.toBe(failure);
    expect(recorded.calls).toHaveLength(1);
  });
});
