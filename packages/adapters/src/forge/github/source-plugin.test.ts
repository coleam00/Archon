import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, test } from 'bun:test';
import createGitHubWebhookSource from './source-plugin';
import { githubWebhookSourceConfigSchema } from './source-config';
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
      lane: { source: 'literal', value: 'ci' },
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
  test('starts every matching binding in configuration order with its own mapped inputs', async () => {
    const recorded = recorder();
    const github = await adapter(
      config([
        binding({ bindingId: 'first' }),
        binding({
          bindingId: 'second',
          capacity: 2,
          inputMapping: {
            status: { source: 'field', field: 'check.nativeState' },
            lane: { source: 'literal', value: 'follow-up' },
          },
        }),
      ]),
      recorded.intake
    );
    const payload = JSON.stringify(checkRunPayload());

    await expect(
      github.receiveWebhook(payload, sign(payload), 'delivery-two-matches', 'check_run')
    ).resolves.toBe('accepted');

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.bindings).toMatchObject([
      {
        bindingId: 'first',
        launch: { inputs: { configured: true, lane: 'ci' } },
        eventInputs: {
          repository: 'owner/repo',
          revision: 'opaque-revision-id',
          checkName: 'build',
        },
      },
      {
        bindingId: 'second',
        capacity: 2,
        launch: { inputs: { configured: true, lane: 'follow-up' } },
        eventInputs: { status: 'in_progress' },
      },
    ]);
    expect(recorded.calls[0]?.bindings).toHaveLength(2);
  });

  test('puts only a mapping binding on its item, and refuses one whose item field is absent', async () => {
    const recorded = recorder();
    const github = await adapter(
      config([
        binding({ bindingId: 'on-item', item: { field: 'check.unit.name', prefix: 'check-' } }),
        binding({ bindingId: 'no-item' }),
        binding({ bindingId: 'needs-result', item: { field: 'check.result' } }),
      ]),
      recorded.intake
    );
    const payload = JSON.stringify(checkRunPayload());

    await github.receiveWebhook(payload, sign(payload), 'delivery-items', 'check_run');

    const [acceptance] = recorded.calls;
    expect(acceptance?.receipt.itemKey).toBeUndefined();
    expect(acceptance?.bindings.map(b => [b.bindingId, b.itemKey])).toEqual([
      ['on-item', 'check-build'],
      ['no-item', undefined],
    ]);
    expect(acceptance?.evaluatedBindings).toEqual([
      {
        bindingId: 'needs-result',
        bindingRevision: expect.any(String),
        status: 'rejected',
        reason: "Item: field 'check.result' is missing",
      },
    ]);
  });

  test('refuses an item field the selected event kind does not carry', () => {
    const parsed = githubWebhookSourceConfigSchema.safeParse({
      version: 1,
      webhookSecretEnv: 'ARCHON_SOURCE_PLUGIN_TEST_SECRET',
      host: 'github.com',
      bindings: [binding({ item: { field: 'subject.number' } })],
    });
    expect(parsed.error?.issues.map(issue => [issue.path.join('.'), issue.message])).toEqual([
      ['bindings.0.item.field', 'subject.number is unavailable for check.changed'],
    ]);
  });

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
            inputs: { configured: true, lane: 'ci' },
          },
          // Field mappings carry event content, kept apart from the operator's literals.
          eventInputs: {
            repository: 'owner/repo',
            revision: 'opaque-revision-id',
            checkName: 'build',
          },
        },
      ],
    });
    expect(intake.bindings[0]?.bindingRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(intake.bindings[0]?.runAsUserId).not.toBe(intake.receipt.sourceActor?.id);
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

  test('delivers a label change with who made it, and a created comment with its author', async () => {
    const recorded = recorder();
    const github = await adapter(
      config([
        binding({
          bindingId: 'promote',
          selector: { kind: 'label.changed', actions: ['added'] },
          inputMapping: {
            number: { source: 'field', field: 'subject.number' },
            labeller: { source: 'field', field: 'label.actor.login' },
            labellerId: { source: 'field', field: 'label.actor.id' },
          },
        }),
        binding({
          bindingId: 'wake',
          selector: { kind: 'comment.changed', actions: ['created'] },
          inputMapping: {
            number: { source: 'field', field: 'subject.number' },
            author: { source: 'field', field: 'comment.author.login' },
          },
        }),
      ]),
      recorded.intake
    );
    const labelled = JSON.stringify({
      action: 'labeled',
      repository: { full_name: 'owner/repo' },
      sender: { id: 4242, login: 'maintainer' },
      issue: { number: 8, state: 'open' },
      label: { id: 1, name: 'archon-triage' },
    });
    const commented = JSON.stringify({
      action: 'created',
      repository: { full_name: 'owner/repo' },
      sender: { id: 5, login: 'reporter' },
      issue: { number: 8 },
      comment: { id: 900, user: { id: 5, login: 'reporter' }, body: 'more detail' },
    });

    await github.receiveWebhook(labelled, sign(labelled), 'delivery-label', 'issues');
    await github.receiveWebhook(commented, sign(commented), 'delivery-comment', 'issue_comment');

    expect(recorded.calls[0]).toMatchObject({
      outcome: 'matched',
      bindings: [
        {
          bindingId: 'promote',
          eventInputs: { number: 8, labeller: 'maintainer', labellerId: '4242' },
        },
      ],
    });
    expect(recorded.calls[1]).toMatchObject({
      outcome: 'matched',
      bindings: [{ bindingId: 'wake', eventInputs: { number: 8, author: 'reporter' } }],
    });
  });

  test('a binding with wake hands the engine the value its wait is matched on', async () => {
    const recorded = recorder();
    const github = await adapter(
      config([
        binding({
          bindingId: 'reviewed',
          selector: {
            kind: 'review.changed',
            actions: ['submitted', 'dismissed'],
            repository: { host: 'github.com', path: 'owner/repo' },
          },
          inputMapping: { state: { source: 'field', field: 'review.state' } },
          item: { field: 'subject.number', prefix: 'pr-' },
          wake: {
            workflow: 'host',
            wait: 'review',
            about: { field: 'review.commit' },
            input: 'waited',
          },
        }),
      ]),
      recorded.intake
    );
    const review = (commit: string | null) =>
      JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'owner/repo' },
        sender: { id: 5, login: 'reviewer' },
        pull_request: { number: 7, head: { sha: commit } },
        review: {
          id: 300,
          user: { id: 5, login: 'reviewer' },
          state: 'approved',
          commit_id: commit,
          body: 'looks good',
          submitted_at: '2026-09-22T10:00:00Z',
        },
      });
    const reviewed = review('c0ffee');
    await github.receiveWebhook(reviewed, sign(reviewed), 'delivery-review', 'pull_request_review');
    expect(recorded.calls[0]).toMatchObject({
      outcome: 'matched',
      bindings: [
        {
          bindingId: 'reviewed',
          eventInputs: { state: 'approved' },
          itemKey: 'pr-7',
          wake: { workflowName: 'host', wait: 'review', about: 'c0ffee', input: 'waited' },
        },
      ],
    });
    // The review text is not part of anything the plugin hands on.
    expect(JSON.stringify(recorded.calls[0])).not.toContain('looks good');

    const unplaced = review(null);
    await github.receiveWebhook(unplaced, sign(unplaced), 'delivery-none', 'pull_request_review');
    expect(recorded.calls[1]).toMatchObject({
      outcome: 'unmatched',
      evaluatedBindings: [
        {
          bindingId: 'reviewed',
          status: 'rejected',
          reason: "Wake: field 'review.commit' is missing",
        },
      ],
    });
  });

  test('a binding with wake maps the item its event names and reads a field its event has', () => {
    const wake = { workflow: 'host', wait: 'checks', about: { field: 'check.revision' as const } };
    // A review names its pull request: without the item, a review of another pull request at
    // the same commit could wake this one.
    const review = {
      selector: {
        kind: 'review.changed',
        actions: ['submitted'],
        repository: { host: 'github.com', path: 'owner/repo' },
      },
      inputMapping: {},
      wake: { workflow: 'host', wait: 'review', about: { field: 'review.commit' } },
    };
    expect(
      githubWebhookSourceConfigSchema.safeParse({
        version: 1,
        webhookSecretEnv: 'ARCHON_SOURCE_PLUGIN_TEST_SECRET',
        host: 'github.com',
        bindings: [binding(review)],
      }).success
    ).toBe(false);
    expect(
      config([binding({ ...review, item: { field: 'subject.number', prefix: 'pr-' } })]).bindings[0]
        ?.item
    ).toEqual({ field: 'subject.number', prefix: 'pr-' });
    expect(
      githubWebhookSourceConfigSchema.safeParse({
        version: 1,
        webhookSecretEnv: 'ARCHON_SOURCE_PLUGIN_TEST_SECRET',
        host: 'github.com',
        bindings: [binding({ wake: { ...wake, about: { field: 'review.commit' } } })],
      }).success
    ).toBe(false);
    expect(config([binding({ wake })]).bindings[0]?.wake).toEqual(wake);
  });
});

describe('GitHub source plugin observing open waits', () => {
  const revision = 'opaque-revision-id';
  const remote = 'https://github.com/owner/repo.git';
  const wait = { workflowName: 'host', event: 'checks', about: revision, remote };
  const checksWake = binding({
    bindingId: 'checks-done',
    selector: {
      kind: 'check.changed',
      actions: ['changed'],
      predicates: [{ field: 'check.phase', equals: 'completed' }],
    },
    wake: { workflow: 'host', wait: 'checks', about: { field: 'check.revision' } },
  });
  const unit = (id: string, status: 'in_progress' | 'completed') => ({
    unit: { kind: 'check' as const, id, name: 'build' },
    nativeState: status,
    phase: status === 'completed' ? ('completed' as const) : ('running' as const),
    nativeResult: status === 'completed' ? 'success' : null,
    result: status === 'completed' ? ('success' as const) : null,
    state: status === 'completed' ? ('green' as const) : ('pending' as const),
  });
  function reader(units: ReturnType<typeof unit>[]) {
    const reads: { remote: string; revision: string }[] = [];
    return {
      reads,
      forge: {
        async commitChecks(input: { remote: string; revision: string }) {
          reads.push(input);
          const green = units.filter(candidate => candidate.state === 'green').length;
          return {
            repo: { host: 'github.com', path: 'owner/repo' },
            branch: null,
            revision: input.revision,
            units,
            summary: {
              state: green === units.length ? ('green' as const) : ('pending' as const),
              counts: {
                total: units.length,
                green,
                red: 0,
                pending: units.length - green,
                gated: 0,
                unknown: 0,
              },
            },
          };
        },
      },
    };
  }
  async function observer(bindings: unknown[], withSecret = false) {
    const plugin = await createGitHubWebhookSource({
      sourceInstanceId: 'github-primary',
      config: githubWebhookSourceConfigSchema.parse({
        version: 1,
        host: 'github.com',
        bindings,
        ...(withSecret ? { webhookSecretEnv: 'ARCHON_SOURCE_PLUGIN_TEST_SECRET' } : {}),
      }),
    });
    if (!plugin.observe) throw new Error('The GitHub source plugin observes waits');
    return { plugin, observe: plugin.observe.bind(plugin) };
  }

  test('a completed check at the waited commit is the acceptance its webhook would make', async () => {
    const { observe } = await observer([checksWake], true);
    const { forge, reads } = reader([unit('77', 'completed'), unit('78', 'in_progress')]);
    const observed = await observe({ waits: [wait], forge });
    expect(reads).toEqual([{ remote, revision }]);
    // The check still running starts nothing, so it is not recorded.
    expect(observed.acceptances).toHaveLength(1);

    // The same check, delivered by webhook, starts the same binding with the same inputs.
    const recorded = recorder();
    const github = await adapter(config([checksWake]), recorded.intake);
    const payload = JSON.stringify(
      checkRunPayload({
        action: 'completed',
        check_run: {
          id: 77,
          name: 'build',
          head_sha: revision,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-09-22T10:00:00Z',
          completed_at: '2026-09-22T10:05:00Z',
          pull_requests: [],
        },
      })
    );
    await github.receiveWebhook(payload, sign(payload), 'delivery-77', 'check_run');
    expect(observed.acceptances[0]?.bindings).toEqual(recorded.calls[0]?.bindings ?? []);
    expect(observed.acceptances[0]?.receipt).toMatchObject({
      sourceInstanceId: 'github-primary',
      deliveryId: `observe:check:github.com/owner/repo@${revision}:check:77:completed:success`,
    });
  });

  test('observing the same check state again is the same delivery with the same content', async () => {
    const { observe } = await observer([checksWake]);
    const { forge } = reader([unit('77', 'completed')]);
    const [first] = (await observe({ waits: [wait], forge })).acceptances;
    const [second] = (await observe({ waits: [wait], forge })).acceptances;
    expect(second?.receipt.deliveryId).toBe(first?.receipt.deliveryId ?? '');
    expect(second?.receipt.contentDigest).toBe(first?.receipt.contentDigest ?? '');
  });

  test('reads only for waits a check wake serves, and names the ones it cannot', async () => {
    const reviewWake = binding({
      bindingId: 'reviewed',
      selector: { kind: 'review.changed', actions: ['submitted'] },
      inputMapping: {},
      item: { field: 'subject.number', prefix: 'pr-' },
      wake: { workflow: 'host', wait: 'review', about: { field: 'review.commit' } },
    });
    // A binding nobody waits on is never evaluated for an observed check.
    const unwaited = binding({ bindingId: 'any-check' });
    const { observe } = await observer([checksWake, reviewWake, unwaited]);
    const { forge, reads } = reader([unit('77', 'completed')]);
    const observed = await observe({
      waits: [
        { ...wait, event: 'review' },
        { ...wait, about: 'other-revision', remote: null },
        { ...wait, workflowName: 'unbound' },
      ],
      forge,
    });
    expect(reads).toEqual([]);
    expect(observed).toEqual({
      acceptances: [],
      unserved: [
        {
          wait: { workflowName: 'host', event: 'review', about: revision },
          reason: 'only check.changed wakes about check.revision are observed',
        },
        {
          wait: { workflowName: 'host', event: 'checks', about: 'other-revision' },
          reason: "the wait's project has no repository URL",
        },
      ],
    });
  });

  test('a waited commit on another forge host is named as not observed', async () => {
    const { observe } = await observer([checksWake]);
    const { forge } = reader([unit('77', 'completed')]);
    const elsewhere = {
      commitChecks: async (input: { remote: string; revision: string }) => ({
        ...(await forge.commitChecks(input)),
        repo: { host: 'gitlab.example.com', path: 'owner/repo' },
      }),
    };
    expect(await observe({ waits: [wait], forge: elsewhere })).toEqual({
      acceptances: [],
      unserved: [
        {
          wait: { workflowName: 'host', event: 'checks', about: revision },
          reason: "the wait's repository is not on github.com",
        },
      ],
    });
  });

  test('a source with no webhook secret refuses every delivery', async () => {
    const { plugin } = await observer([checksWake]);
    const payload = JSON.stringify(checkRunPayload());
    expect(
      await plugin.receive({
        body: payload,
        headers: { 'x-hub-signature-256': sign(payload), 'x-github-event': 'check_run' },
        receivedAt: '2026-09-22T10:00:00.000Z',
      })
    ).toEqual({ status: 'rejected', reason: 'unauthenticated' });
  });
});
