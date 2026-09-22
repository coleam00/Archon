import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, test } from 'bun:test';
import createGitHubWebhookSource, { githubWebhookSourceConfigSchema } from './source-plugin';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import type { z } from '@hono/zod-openapi';

type GitHubTriggerConfig = z.infer<typeof githubWebhookSourceConfigSchema>;
type IntakeInput = SourceReceiptAcceptance;
type Intake = (input: IntakeInput) => Promise<{ receiptId: string; replay: boolean }>;

const secret = 'trigger-ingress-secret';
const priorSecret = process.env.ARCHON_SOURCE_PLUGIN_TEST_SECRET;
process.env.ARCHON_SOURCE_PLUGIN_TEST_SECRET = secret;
afterAll(() => {
  if (priorSecret === undefined) delete process.env.ARCHON_SOURCE_PLUGIN_TEST_SECRET;
  else process.env.ARCHON_SOURCE_PLUGIN_TEST_SECRET = priorSecret;
});

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
  return githubWebhookSourceConfigSchema.parse({
    version: 1,
    webhookSecretEnv: 'ARCHON_SOURCE_PLUGIN_TEST_SECRET',
    host: 'github.com',
    bindings,
  });
}

function recorder() {
  const calls: IntakeInput[] = [];
  const intake: Intake = async input => {
    calls.push(input);
    return { receiptId: input.receipt.id, replay: false };
  };
  return { calls, intake };
}

async function adapter(triggerConfig: GitHubTriggerConfig, intake: Intake) {
  const plugin = await createGitHubWebhookSource({
    sourceInstanceId: 'github-primary',
    config: triggerConfig,
  });
  return {
    async receiveWebhook(body: string, signature: string, deliveryId: string, eventName: string) {
      const result = await plugin.receive({
        body,
        headers: {
          'x-hub-signature-256': signature,
          'x-github-delivery': deliveryId,
          'x-github-event': eventName,
        },
        receivedAt: '2026-09-22T10:00:00.000Z',
      });
      if (result.status === 'rejected') return 'invalid_signature';
      await intake(result.acceptance);
      return result.acceptance.outcome === 'malformed' ? 'malformed' : 'accepted';
    },
  };
}

describe('GitHub source plugin', () => {
  test('authenticates signed delivery and resolves its configured binding', async () => {
    const recorded = recorder();
    const github = await adapter(config(), recorded.intake);
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
    const github = await adapter(config(), recorded.intake);
    const payload = JSON.stringify(checkRunPayload());

    await github.receiveWebhook(payload, sign(payload), 'delivery-zero-pr', 'check_run');

    expect(recorded.calls[0]?.bindings[0]?.launch.inputs).toMatchObject({
      repository: 'owner/repo',
      revision: 'opaque-revision-id',
    });
  });

  test('rejects an invalid signature before trusted intake', async () => {
    const recorded = recorder();
    const github = await adapter(config(), recorded.intake);
    const payload = JSON.stringify(checkRunPayload());

    await expect(
      github.receiveWebhook(payload, 'sha256=invalid', 'attacker-delivery', 'check_run')
    ).resolves.toBe('invalid_signature');
    expect(recorded.calls).toEqual([]);
  });

  test('records authenticated malformed and unsupported deliveries', async () => {
    const recorded = recorder();
    const github = await adapter(config(), recorded.intake);
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
    const github = await adapter(triggerConfig, recorded.intake);
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
});
