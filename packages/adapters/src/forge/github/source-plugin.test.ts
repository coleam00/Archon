import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  createItemWaitObserver,
  loadWebhookSourcePlugins,
} from '@archon/core/workflows/source-plugins';
import { removeTempTree } from '@archon/paths/test-utils';
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
  const wait = { workflowName: 'host', event: 'checks', about: revision, itemKey: 'pr-7', remote };
  const reviewWait = { ...wait, event: 'review' };
  const checksWake = binding({
    bindingId: 'checks-done',
    selector: {
      kind: 'check.changed',
      actions: ['changed'],
      predicates: [{ field: 'check.phase', equals: 'completed' }],
    },
    wake: { workflow: 'host', wait: 'checks', about: { field: 'check.revision' } },
  });
  const reviewWake = binding({
    bindingId: 'reviewed',
    selector: { kind: 'review.changed', actions: ['submitted', 'dismissed'] },
    inputMapping: { state: { source: 'field', field: 'review.state' } },
    item: { field: 'subject.number', prefix: 'pr-' },
    wake: { workflow: 'host', wait: 'review', about: { field: 'review.commit' } },
  });
  const unit = (id: string, status: 'in_progress' | 'completed') => ({
    unit: { kind: 'check' as const, id, name: 'build' },
    nativeState: status,
    phase: status === 'completed' ? ('completed' as const) : ('running' as const),
    nativeResult: status === 'completed' ? 'success' : null,
    result: status === 'completed' ? ('success' as const) : null,
    state: status === 'completed' ? ('green' as const) : ('pending' as const),
  });
  const review = (id: string, state: string, commit: string) => ({
    kind: 'review' as const,
    id,
    author: { host: 'github.com', id: '5', login: 'reviewer' } as {
      host: string;
      id: string;
      login: string;
    } | null,
    commit,
    state,
    createdAt: '2026-09-22T10:00:00Z',
    url: `https://github.com/owner/repo/pull/7#pullrequestreview-${id}`,
    body: 'looks good',
  });
  function reader(
    units: ReturnType<typeof unit>[],
    reviews: ReturnType<typeof review>[] = [],
    host = 'github.com'
  ) {
    const reads: unknown[] = [];
    return {
      reads,
      forge: {
        async commitChecks(input: { remote: string; revision: string }) {
          reads.push(input);
          if (input.revision === 'gone') throw new Error('commit not found');
          const green = units.filter(candidate => candidate.state === 'green').length;
          return {
            repo: { host, path: 'owner/repo' },
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
        async prReviews(input: { remote: string; number: number }) {
          reads.push(input);
          return {
            ref: { repo: { host, path: 'owner/repo' }, number: input.number },
            items: reviews,
          };
        },
        issuesWithLabel: async (): Promise<never> => {
          throw new Error('no label read expected');
        },
        labelAdded: async (): Promise<never> => {
          throw new Error('no label read expected');
        },
        issuesOpened: async (): Promise<never> => {
          throw new Error('no opened-issue read expected');
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

  test('a completed check at the waited commit is the start its webhook would make, on the wait’s item', async () => {
    const { observe } = await observer([checksWake], true);
    const { forge, reads } = reader([unit('77', 'completed'), unit('78', 'in_progress')]);
    const observed = await observe({ labels: [], waits: [wait], forge });
    expect(reads).toEqual([{ remote, revision }]);
    // The check still running starts nothing, so it is not recorded.
    expect(observed.acceptances).toHaveLength(1);

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
    const [delivered] = recorded.calls[0]?.bindings ?? [];
    if (!delivered) throw new Error('The webhook delivery started the binding');
    expect(observed.acceptances[0]?.bindings).toEqual([{ ...delivered, itemKey: 'pr-7' }]);
    expect(observed.acceptances[0]?.receipt.deliveryId).toBe(
      `observe:check:github.com/owner/repo@${revision}:check:77:completed:success:checks-done:pr-7`
    );
  });

  test('the same state again is the same delivery; another item or binding is a new one', async () => {
    const otherWake = binding({
      bindingId: 'checks-done-too',
      selector: checksWake.selector,
      wake: { workflow: 'build', wait: 'checks', about: { field: 'check.revision' } },
    });
    const { observe } = await observer([checksWake, otherWake]);
    const { forge } = reader([unit('77', 'completed')]);
    const [first] = (await observe({ labels: [], waits: [wait], forge })).acceptances;
    const [second] = (await observe({ labels: [], waits: [wait], forge })).acceptances;
    expect(second?.receipt.deliveryId).toBe(first?.receipt.deliveryId ?? '');
    expect(second?.receipt.contentDigest).toBe(first?.receipt.contentDigest ?? '');
    // A wait that opened after the first observation, on another item or for another
    // workflow, is not a replay of a delivery made before it existed.
    const later = await observe({
      labels: [],
      waits: [wait, { ...wait, itemKey: 'issue-3' }, { ...wait, workflowName: 'build' }],
      forge,
    });
    expect(new Set(later.acceptances.map(a => a.receipt.deliveryId)).size).toBe(3);
  });

  test('a submitted review on the waited commit is the start its webhook would make', async () => {
    const { observe } = await observer([reviewWake], true);
    const { forge, reads } = reader(
      [],
      [
        review('300', 'APPROVED', revision),
        review('301', 'COMMENTED', 'older-commit'),
        review('302', 'PENDING', revision),
      ]
    );
    const observed = await observe({ labels: [], waits: [reviewWait], forge });
    expect(reads).toEqual([{ remote, number: 7 }]);
    // The review of another commit and the unsubmitted one are not recorded.
    expect(observed.acceptances).toHaveLength(1);

    const recorded = recorder();
    const github = await adapter(config([reviewWake]), recorded.intake);
    const payload = JSON.stringify({
      action: 'submitted',
      repository: { full_name: 'owner/repo' },
      sender: { id: 5, login: 'reviewer' },
      pull_request: { number: 7, head: { sha: revision } },
      review: {
        id: 300,
        user: { id: 5, login: 'reviewer' },
        state: 'approved',
        commit_id: revision,
        body: 'looks good',
        submitted_at: '2026-09-22T10:00:00Z',
      },
    });
    await github.receiveWebhook(payload, sign(payload), 'delivery-300', 'pull_request_review');
    expect(observed.acceptances[0]?.bindings).toEqual(recorded.calls[0]?.bindings ?? []);
    expect(observed.acceptances[0]?.receipt.deliveryId).toBe(
      'observe:review:github.com/owner/repo#7:300:submitted:reviewed:pr-7'
    );
    expect(JSON.stringify(observed.acceptances)).not.toContain('looks good');
  });

  test('a binding that cannot start on the waited event says why', async () => {
    const mapsAuthor = binding({
      ...reviewWake,
      inputMapping: { reviewer: { source: 'field', field: 'review.author.login' } },
    });
    const { observe } = await observer([mapsAuthor]);
    const { forge } = reader([], [{ ...review('300', 'APPROVED', revision), author: null }]);
    const observed = await observe({ labels: [], waits: [reviewWait], forge });
    expect(observed.acceptances).toEqual([]);
    expect(observed.unserved).toHaveLength(1);
    expect(observed.unserved[0]?.reason).toContain("binding 'reviewed' rejects the event");
    expect(observed.unserved[0]?.reason).toContain('review.author.login');
  });

  test('one unreadable commit does not stop the others', async () => {
    const { observe } = await observer([checksWake]);
    const { forge } = reader([unit('77', 'completed')]);
    const observed = await observe({
      labels: [],
      waits: [{ ...wait, about: 'gone', itemKey: 'pr-8' }, wait],
      forge,
    });
    expect(observed.failed).toEqual([
      {
        wait: { workflowName: 'host', event: 'checks', about: 'gone', itemKey: 'pr-8' },
        reason: 'commit not found',
      },
    ]);
    expect(observed.acceptances.map(a => a.bindings[0]?.itemKey)).toEqual(['pr-7']);
  });

  test('names each wait it binds but cannot read, and evaluates no binding nobody waits on', async () => {
    const unwaited = binding({ bindingId: 'any-check' });
    const { observe } = await observer([checksWake, reviewWake, unwaited]);
    const { forge, reads } = reader([unit('77', 'completed')]);
    const observed = await observe({
      labels: [],
      waits: [
        { ...reviewWait, itemKey: 'issue-3' },
        { ...wait, remote: null },
        { ...wait, workflowName: 'unbound' },
      ],
      forge,
    });
    expect(reads).toEqual([]);
    expect(observed).toEqual({
      acceptances: [],
      failed: [],
      labelAcceptances: [],
      labelFailures: [],
      unserved: [
        {
          wait: { workflowName: 'host', event: 'review', about: revision, itemKey: 'issue-3' },
          reason: "item 'issue-3' names no pull request under the binding's item mapping",
        },
        {
          wait: { workflowName: 'host', event: 'checks', about: revision, itemKey: 'pr-7' },
          reason: "the wait's project has no repository URL",
        },
      ],
    });
  });

  test('a waited commit on another forge host is named as not observed', async () => {
    const { observe } = await observer([checksWake]);
    const { forge } = reader([unit('77', 'completed')], [], 'gitlab.example.com');
    expect(await observe({ labels: [], waits: [wait], forge })).toEqual({
      acceptances: [],
      failed: [],
      labelAcceptances: [],
      labelFailures: [],
      unserved: [
        {
          wait: { workflowName: 'host', event: 'checks', about: revision, itemKey: 'pr-7' },
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

describe('GitHub source plugin observing label bindings', () => {
  const repo = { host: 'github.com', path: 'owner/repo' };
  const intake = (overrides: Record<string, unknown> = {}) =>
    binding({
      bindingId: 'factory-intake',
      selector: {
        kind: 'label.changed',
        actions: ['added'],
        repository: repo,
        predicates: [{ field: 'label.name', equals: 'factory' }],
      },
      inputMapping: {
        number: { source: 'field', field: 'subject.number' },
        labeller: { source: 'field', field: 'label.actor.login' },
      },
      item: { field: 'subject.number', prefix: 'issue-' },
      ...overrides,
    });
  async function labelSource(bindings: unknown[], withSecret = false) {
    return createGitHubWebhookSource({
      sourceInstanceId: 'github-primary',
      config: githubWebhookSourceConfigSchema.parse({
        version: 1,
        host: 'github.com',
        bindings,
        ...(withSecret ? { webhookSecretEnv: 'ARCHON_SOURCE_PLUGIN_TEST_SECRET' } : {}),
      }),
    });
  }
  /** Issue 8 labelled by event 555, pull request 9 by event 556, and issue 10 with no add. */
  function labelReader() {
    const reads: string[] = [];
    return {
      reads,
      forge: {
        commitChecks: async (): Promise<never> => {
          throw new Error('no check read expected');
        },
        prReviews: async (): Promise<never> => {
          throw new Error('no review read expected');
        },
        async issuesWithLabel(input: { repo: typeof repo; label: string }) {
          reads.push(`list ${input.label}`);
          const item = (number: number, kind: 'issue' | 'pr') => ({
            ref: { repo, number },
            kind,
            url: `https://github.com/owner/repo/issues/${String(number)}`,
            state: 'open' as const,
          });
          return { ...input, items: [item(8, 'issue'), item(9, 'pr'), item(10, 'issue')] };
        },
        async labelAdded(input: {
          repo: typeof repo;
          kind: 'issue' | 'pr';
          number: number;
          label: string;
        }) {
          reads.push(`added ${input.kind} ${String(input.number)}`);
          return {
            subject: { kind: input.kind, ref: { repo, number: input.number } },
            name: input.label,
            added:
              input.number === 8 || input.number === 9
                ? {
                    id: String(547 + input.number),
                    at: '2026-11-23T10:00:00Z',
                    actor: {
                      host: 'github.com',
                      id: '4242',
                      login: 'maintainer',
                      type: 'user' as const,
                    },
                  }
                : null,
          };
        },
        issuesOpened: async (): Promise<never> => {
          throw new Error('no opened-issue read expected');
        },
      },
    };
  }

  test('called as an engine without opened-issue reads calls it, the result has no new field', async () => {
    const plugin = await labelSource([
      intake({
        bindingId: 'triage',
        selector: { kind: 'issue.lifecycle', actions: ['opened'], repository: repo },
        inputMapping: { number: { source: 'field', field: 'subject.number' } },
      }),
    ]);
    const { forge } = labelReader();
    const observed = await plugin.observe?.({ waits: [], labels: [], forge });
    // An older engine parses the observation strictly; a key it does not know fails the pass.
    expect(observed).toBeDefined();
    expect(Object.keys(observed ?? {})).not.toContain('openedIssueFailures');
  });

  test('declares one read per labelled binding, and names each it cannot observe', async () => {
    const plugin = await labelSource([
      intake({
        selector: {
          kind: 'label.changed',
          actions: ['added'],
          repository: repo,
          predicates: [{ field: 'label.name', in: ['factory', 'urgent'] }],
        },
      }),
      intake({
        bindingId: 'pr-labels',
        selector: {
          kind: 'label.changed',
          actions: ['added'],
          repository: repo,
          subject: { kind: 'pr', number: 3 },
          predicates: [{ field: 'label.name', equals: 'factory' }],
        },
      }),
      intake({
        bindingId: 'anywhere',
        selector: {
          kind: 'label.changed',
          actions: ['added'],
          predicates: [{ field: 'label.name', equals: 'factory' }],
        },
      }),
      intake({
        bindingId: 'any-label',
        selector: { kind: 'label.changed', actions: ['added'], repository: repo },
      }),
      intake({
        bindingId: 'removed-only',
        selector: {
          kind: 'label.changed',
          actions: ['removed'],
          repository: repo,
          predicates: [{ field: 'label.name', equals: 'factory' }],
        },
      }),
      intake({
        bindingId: 'waking',
        wake: { workflow: 'host', wait: 'labelled', about: { field: 'label.name' } },
      }),
      intake({
        bindingId: 'elsewhere',
        selector: {
          kind: 'label.changed',
          actions: ['added'],
          repository: { host: 'gitlab.example.com', path: 'owner/repo' },
          predicates: [{ field: 'label.name', equals: 'factory' }],
        },
      }),
      binding(),
    ]);
    expect(plugin.observedLabels).toEqual({
      reads: [
        { bindingId: 'factory-intake', repo, label: 'factory' },
        { bindingId: 'factory-intake', repo, label: 'urgent' },
        { bindingId: 'pr-labels', repo, label: 'factory' },
      ],
      unserved: [
        { bindingId: 'anywhere', reason: 'the selector names no repository to list' },
        { bindingId: 'any-label', reason: 'the selector names no label' },
        { bindingId: 'removed-only', reason: 'only an added label is observed' },
        { bindingId: 'waking', reason: 'a label wake is not observed' },
        { bindingId: 'elsewhere', reason: "the selector's repository is not on github.com" },
      ],
    });
    // A source that receives webhooks gets its label events by webhook, never twice.
    expect((await labelSource([intake()], true)).observedLabels).toEqual({
      reads: [],
      unserved: [
        {
          bindingId: 'factory-intake',
          reason: 'this source receives webhooks; label events arrive by webhook',
        },
      ],
    });
  });

  const onlyKind = (kind: 'issue' | 'pr', overrides: Record<string, unknown> = {}) =>
    intake({
      selector: {
        kind: 'label.changed',
        actions: ['added'],
        repository: repo,
        predicates: [
          { field: 'label.name', equals: 'factory' },
          { field: 'subject.kind', equals: kind },
        ],
      },
      ...overrides,
    });

  test('a labelled issue is the start its webhook would make; a pull request is not read', async () => {
    const issues = onlyKind('issue');
    const plugin = await labelSource([issues]);
    const { forge, reads } = labelReader();
    const read = { bindingId: 'factory-intake', repo, label: 'factory' };
    const observed = await plugin.observe?.({
      waits: [],
      labels: [{ ...read, seenSince: '2026-11-01T00:00:00Z' }],
      forge,
    });
    expect(reads).toEqual(['list factory', 'added issue 8', 'added issue 10']);
    expect(observed?.labelFailures).toEqual([
      {
        bindingId: 'factory-intake',
        label: 'factory',
        number: 10,
        reason: 'the forge records no add',
      },
    ]);
    const [accepted] = (observed?.labelAcceptances ?? []).map(entry => entry.acceptance);
    expect(observed?.labelAcceptances).toHaveLength(1);
    expect(observed?.acceptances).toEqual([]);
    expect(accepted?.receipt.deliveryId).toBe(
      'observe:label:github.com/owner/repo#8:555:factory-intake'
    );

    // The webhook for the same add starts the same binding with the same inputs and item.
    const recorded = recorder();
    const github = await adapter(config([issues]), recorded.intake);
    const payload = JSON.stringify({
      action: 'labeled',
      repository: { full_name: 'owner/repo' },
      sender: { id: 4242, login: 'maintainer', type: 'User' },
      issue: { number: 8, state: 'open' },
      label: { id: 1, name: 'factory' },
    });
    await github.receiveWebhook(payload, sign(payload), 'delivery-label', 'issues');
    expect(accepted?.outcome).toBe('matched');
    expect(accepted?.bindings).toEqual(recorded.calls[0]?.bindings ?? []);

    // On the read's first sight, or when the add is older than it, the same add is recorded
    // under the same delivery, unmatched.
    const seeded = await plugin.observe?.({
      waits: [],
      labels: [{ ...read, seenSince: null }],
      forge: labelReader().forge,
    });
    const older = await plugin.observe?.({
      waits: [],
      labels: [{ ...read, seenSince: '2026-11-24T00:00:00Z' }],
      forge: labelReader().forge,
    });
    expect(older?.labelAcceptances.map(entry => entry.acceptance.outcome)).toEqual(['unmatched']);
    expect(seeded?.labelAcceptances.map(entry => entry.acceptance)).toMatchObject([
      { outcome: 'unmatched', bindings: [], receipt: { deliveryId: accepted?.receipt.deliveryId } },
    ]);
    expect(seeded?.labelAcceptances[0]?.acceptance.receipt.contentDigest).toBe(
      accepted?.receipt.contentDigest
    );
  });

  test('a labelled pull request is the start its webhook would make; an issue is not read', async () => {
    const prs = onlyKind('pr', { item: { field: 'subject.number', prefix: 'pr-' } });
    const plugin = await labelSource([prs]);
    const { forge, reads } = labelReader();
    const observed = await plugin.observe?.({
      waits: [],
      labels: [
        { bindingId: 'factory-intake', repo, label: 'factory', seenSince: '2026-11-01T00:00:00Z' },
      ],
      forge,
    });
    expect(reads).toEqual(['list factory', 'added pr 9']);
    expect(observed?.labelFailures).toEqual([]);
    const [accepted] = (observed?.labelAcceptances ?? []).map(entry => entry.acceptance);
    expect(observed?.labelAcceptances).toHaveLength(1);
    expect(accepted?.receipt.deliveryId).toBe(
      'observe:label:github.com/owner/repo#9:556:factory-intake'
    );
    expect(accepted?.outcome).toBe('matched');
    expect(accepted?.bindings.map(start => start.itemKey)).toEqual(['pr-9']);

    const recorded = recorder();
    const github = await adapter(config([prs]), recorded.intake);
    const payload = JSON.stringify({
      action: 'labeled',
      repository: { full_name: 'owner/repo' },
      sender: { id: 4242, login: 'maintainer', type: 'User' },
      pull_request: { number: 9, state: 'open' },
      label: { id: 1, name: 'factory' },
    });
    await github.receiveWebhook(payload, sign(payload), 'delivery-label', 'pull_request');
    // Same inputs, labeller included, and the same item as the webhook's.
    expect(accepted?.bindings).toEqual(recorded.calls[0]?.bindings ?? []);
  });

  test('a selector that names no kind observes issues and pull requests', async () => {
    const plugin = await labelSource([intake()]);
    const { forge, reads } = labelReader();
    const observed = await plugin.observe?.({
      waits: [],
      labels: [
        { bindingId: 'factory-intake', repo, label: 'factory', seenSince: '2026-11-01T00:00:00Z' },
      ],
      forge,
    });
    expect(reads).toEqual(['list factory', 'added issue 8', 'added pr 9', 'added issue 10']);
    expect(
      observed?.labelAcceptances.map(entry => [
        entry.acceptance.receipt.deliveryId,
        entry.acceptance.outcome,
      ])
    ).toEqual([
      ['observe:label:github.com/owner/repo#8:555:factory-intake', 'matched'],
      ['observe:label:github.com/owner/repo#9:556:factory-intake', 'matched'],
    ]);
  });
});

describe('GitHub source plugin label bindings, observed through the engine', () => {
  const repo = { host: 'github.com', path: 'owner/repo' };
  const later = () => new Date(Date.now() + 60_000).toISOString();
  const intake = (overrides: Record<string, unknown> = {}) =>
    binding({
      bindingId: 'intake',
      selector: {
        kind: 'label.changed',
        actions: ['added'],
        repository: repo,
        predicates: [{ field: 'label.name', equals: 'factory' }],
      },
      inputMapping: { number: { source: 'field', field: 'subject.number' } },
      item: { field: 'subject.number', prefix: 'issue-' },
      ...overrides,
    });
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map(removeTempTree));
  });

  /**
   * One install: its receipts, the open labelled items with their latest add (issues unless
   * marked `pr`), and a pass.
   */
  function install() {
    const receipts = new Map<string, SourceReceiptAcceptance>();
    const issues = new Map<number, { id: string; at: string; kind?: 'pr' }>();
    // Open issues by when they were created, for opened-issue reads.
    const opened = new Map<number, string>();
    const reads: string[] = [];
    // Items whose label events the forge cannot read.
    const failing = new Set<number>();
    const known = { users: (_id: string) => true };
    const forge = {
      commitChecks: async (): Promise<never> => {
        throw new Error('no check read expected');
      },
      prReviews: async (): Promise<never> => {
        throw new Error('no review read expected');
      },
      async issuesWithLabel(input: { repo: typeof repo; label: string }) {
        reads.push(`list ${input.label}`);
        return {
          ...input,
          items: [...issues].map(([number, entry]) => ({
            ref: { repo, number },
            kind: entry.kind ?? ('issue' as const),
            url: `https://github.com/owner/repo/issues/${String(number)}`,
            state: 'open' as const,
          })),
        };
      },
      async labelAdded(input: {
        repo: typeof repo;
        kind: 'issue' | 'pr';
        number: number;
        label: string;
      }) {
        reads.push(`added ${String(input.number)}`);
        if (failing.has(input.number)) throw new Error('events unavailable');
        const added = issues.get(input.number);
        return {
          subject: { kind: input.kind, ref: { repo, number: input.number } },
          name: input.label,
          added: added ? { id: added.id, at: added.at, actor: null } : null,
        };
      },
      async issuesOpened(input: { repo: typeof repo; since: string }) {
        reads.push(`opened since ${input.since}`);
        return {
          ...input,
          items: [...opened]
            .filter(([, createdAt]) => Date.parse(createdAt) >= Date.parse(input.since))
            .map(([number, createdAt]) => ({
              ref: { repo, number },
              kind: 'issue' as const,
              url: `https://github.com/owner/repo/issues/${String(number)}`,
              state: 'open' as const,
              createdAt,
              author: { host: 'github.com', id: '77', login: 'reporter', type: 'user' as const },
            })),
        };
      },
    };
    const pass = async (bindings: unknown[]) => {
      const root = await mkdtemp(join(tmpdir(), 'archon-label-observe-'));
      roots.push(root);
      const configPath = join(root, 'sources.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          sources: [
            {
              sourceInstanceId: 'github-primary',
              module: join(import.meta.dir, 'source-plugin.ts'),
              config: { version: 1, host: 'github.com', bindings },
              observe: { everySeconds: 15 },
            },
          ],
        })
      );
      const sources = await loadWebhookSourcePlugins(configPath, {
        acceptReceipt: async input => {
          const deliveryId = input.receipt.deliveryId ?? input.receipt.id;
          const replay = receipts.has(deliveryId);
          if (!replay) receipts.set(deliveryId, input);
          return { receiptId: deliveryId, replay };
        },
        isKnownUser: async id => known.users(id),
        hasDeliveryReceipt: async (_source, deliveryId) => receipts.has(deliveryId),
        getReceipt: async id => {
          const found = [...receipts.values()].find(receipt => receipt.receipt.id === id);
          return found ? { occurredAt: found.receipt.occurredAt } : null;
        },
      });
      const observer = createItemWaitObserver({
        sources,
        store: {
          listOpenItemWaits: async () => [],
          getItem: async () => null,
          getWorkflowRun: async () => null,
          getCodebase: async () => null,
        },
        forge,
      });
      const [report] = (await observer?.pass(new Date())) ?? [];
      return report;
    };
    const matched = () =>
      [...receipts.values()]
        .filter(receipt => receipt.outcome === 'matched')
        .map(receipt => receipt.receipt.deliveryId);
    return { receipts, issues, opened, failing, reads, known, pass, matched };
  }

  test('an issue reopened after the first sight does not start the label it already had', async () => {
    const observed = install();
    // Issue 7 is closed when the binding is first seen, so the first pass lists nothing.
    await observed.pass([intake()]);
    observed.issues.set(7, { id: 'event-7', at: '2020-01-01T00:00:00Z' });
    expect((await observed.pass([intake()]))?.error).toBeUndefined();
    expect(observed.matched()).toEqual([]);
    // Removed and added again after the first sight, it starts.
    observed.issues.set(7, { id: 'event-8', at: later() });
    await observed.pass([intake()]);
    expect(observed.matched()).toEqual(['observe:label:github.com/owner/repo#7:event-8:intake']);
  });

  test('a label added while the first pass has a failed read starts once the read recovers', async () => {
    const observed = install();
    // Issue 5 carries the label before the binding is first seen, and its events fail to read.
    observed.issues.set(5, { id: 'event-5', at: '2020-01-01T00:00:00Z' });
    observed.failing.add(5);
    expect((await observed.pass([intake()]))?.error).toContain('events unavailable');
    // Issue 7 is labelled before the pass on which issue 5 reads again.
    observed.issues.set(7, { id: 'event-7', at: later() });
    observed.failing.clear();
    expect((await observed.pass([intake()]))?.error).toBeUndefined();
    expect(observed.matched()).toEqual(['observe:label:github.com/owner/repo#7:event-7:intake']);
  });

  const triage = (overrides: Record<string, unknown> = {}) =>
    binding({
      bindingId: 'triage',
      selector: { kind: 'issue.lifecycle', actions: ['opened'], repository: repo },
      inputMapping: { number: { source: 'field', field: 'subject.number' } },
      item: { field: 'subject.number', prefix: 'issue-' },
      ...overrides,
    });

  test('an issue opened after the binding is first seen starts once, also after a restart', async () => {
    const observed = install();
    // Issue 3 is open before the binding is first seen. The first pass reads no issues.
    observed.opened.set(3, '2020-01-01T00:00:00Z');
    expect((await observed.pass([triage()]))?.error).toBeUndefined();
    expect(observed.reads).toEqual([]);

    // Each pass is a new process, so the second one is also a restarted watch.
    observed.opened.set(9, later());
    expect((await observed.pass([triage()]))?.receipts).toEqual([
      'observe:issue-opened:github.com/owner/repo#9:triage',
    ]);
    const receipt = observed.receipts.get('observe:issue-opened:github.com/owner/repo#9:triage');
    expect(receipt?.bindings).toMatchObject([{ bindingId: 'triage', itemKey: 'issue-9' }]);
    expect(receipt?.receipt.sourceActor).toEqual({ source: 'github-primary', id: '77' });

    // Listed again, it is a replay and starts nothing; issue 3 never starts.
    expect((await observed.pass([triage()]))?.receipts).toEqual([]);
    expect(observed.matched()).toEqual(['observe:issue-opened:github.com/owner/repo#9:triage']);
  });

  test('every binding the source cannot observe is reported, with why', async () => {
    const observed = install();
    const comments = binding({
      bindingId: 'comments',
      selector: { kind: 'comment.changed', actions: ['created'], repository: repo },
      inputMapping: { number: { source: 'field', field: 'subject.number' } },
      item: { field: 'subject.number', prefix: 'issue-' },
    });
    const closing = triage({
      bindingId: 'closing',
      selector: { kind: 'issue.lifecycle', actions: ['closed'], repository: repo },
    });
    expect((await observed.pass([triage(), closing, comments]))?.unservedBindings).toEqual([
      { bindingId: 'closing', reason: 'only an opened issue is observed' },
      { bindingId: 'comments', reason: 'a comment.changed event is not observed' },
    ]);
  });

  test('changing the item mapping does not start an add already recorded', async () => {
    const observed = install();
    await observed.pass([intake()]);
    observed.issues.set(7, { id: 'event-7', at: later() });
    await observed.pass([intake()]);
    const remapped = intake({ item: { field: 'subject.number', prefix: 'ticket-' } });
    expect((await observed.pass([remapped]))?.receipts).toEqual([]);
    expect(observed.matched()).toHaveLength(1);
  });

  test('a binding that cannot start does not stop a new binding from being seen', async () => {
    const observed = install();
    const stale = intake({ runAsUserId: 'removed-user' });
    await observed.pass([stale]);
    observed.known.users = id => id !== 'removed-user';
    observed.issues.set(7, { id: 'event-7', at: later() });
    const fresh = intake({ bindingId: 'fresh' });
    expect((await observed.pass([stale, fresh]))?.error).toContain('unknown run-as user');
    // A label added after the fresh binding's first sight starts it.
    observed.issues.set(8, { id: 'event-8', at: later() });
    await observed.pass([stale, fresh]);
    expect(observed.matched()).toEqual(['observe:label:github.com/owner/repo#8:event-8:fresh']);
  });

  test('a label added to a pull request starts its binding once on the pull request', async () => {
    const observed = install();
    const prs = intake({
      selector: {
        kind: 'label.changed',
        actions: ['added'],
        repository: repo,
        predicates: [
          { field: 'label.name', equals: 'factory' },
          { field: 'subject.kind', equals: 'pr' },
        ],
      },
      item: { field: 'subject.number', prefix: 'pr-' },
    });
    // Pull request 6 has the label when the binding is first seen, so it starts nothing.
    observed.issues.set(6, { id: 'event-6', at: '2020-01-01T00:00:00Z', kind: 'pr' });
    await observed.pass([prs]);
    observed.issues.set(7, { id: 'event-7', at: later(), kind: 'pr' });
    observed.issues.set(8, { id: 'event-8', at: later() });
    observed.reads.length = 0;
    expect((await observed.pass([prs]))?.error).toBeUndefined();
    // Issue 8 is never read: the binding selects pull requests.
    expect(observed.reads).toEqual(['list factory', 'added 6', 'added 7']);
    expect(observed.matched()).toEqual(['observe:label:github.com/owner/repo#7:event-7:intake']);
    expect(
      observed.receipts.get('observe:label:github.com/owner/repo#7:event-7:intake')?.bindings
    ).toMatchObject([{ bindingId: 'intake', itemKey: 'pr-7' }]);
    // The same add on the next pass is a replay; removed and added again, it starts again.
    expect((await observed.pass([prs]))?.receipts).toEqual([]);
    observed.issues.set(7, { id: 'event-9', at: later(), kind: 'pr' });
    await observed.pass([prs]);
    expect(observed.matched()).toEqual([
      'observe:label:github.com/owner/repo#7:event-7:intake',
      'observe:label:github.com/owner/repo#7:event-9:intake',
    ]);
  });
});
