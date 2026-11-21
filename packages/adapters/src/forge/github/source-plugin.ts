import { createHash, randomUUID } from 'node:crypto';
import type { z } from '@hono/zod-openapi';
import {
  type ForgeEvent,
  mapForgeInputs,
  matchForgeEvent,
  readForgeEventField,
} from '@archon/forge';
import { normalizeGitHubWebhook, reviewState } from './normalize-event';
export { githubSourceCapabilities as capabilities } from './normalize-event';
import type { JsonValue } from '@archon/workflows/output-ref';
import {
  mappedItemKey,
  resourceStartBindingIntentSchema,
  type BindingWake,
  type ResourceStartBindingIntent,
  type SourceReceiptAcceptance,
  type SourceReceiptInput,
} from '@archon/workflows/schemas/resource-start';
import type {
  SourceObservation,
  WebhookSourcePlugin,
  WebhookSourcePluginFactory,
  WebhookSourceResult,
} from '@archon/workflows/webhook-source-plugin';
import { githubSourceBindingSchema, githubWebhookSourceConfigSchema } from './source-config';
import { verifyGitHubWebhookSignature } from './webhook-signature';

type GitHubSourceBinding = z.infer<typeof githubSourceBindingSchema>;

type EvaluatedBinding = NonNullable<
  Extract<WebhookSourceResult, { status: 'received' }>['acceptance']['evaluatedBindings']
>[number];

/**
 * The wake a binding hands the engine: the value of its `about` field, which the engine
 * matches against the open waits. The plugin reads the value and compares nothing.
 */
function wakeOf(
  wake: NonNullable<z.infer<typeof githubSourceBindingSchema>['wake']>,
  event: ForgeEvent
): { wake: BindingWake } | { reason: string } {
  const about = readForgeEventField(event, wake.about.field);
  if (typeof about === 'string' && about !== '')
    return {
      wake: {
        workflowName: wake.workflow,
        wait: wake.wait,
        about,
        ...(wake.input === undefined ? {} : { input: wake.input }),
      },
    };
  const state = about === undefined || about === null || about === '' ? 'missing' : 'not text';
  return { reason: `Wake: field '${wake.about.field}' is ${state}` };
}

/** The start one configured binding makes of `event`, or why it makes none. */
function evaluateBinding(
  binding: z.infer<typeof githubSourceBindingSchema>,
  event: ForgeEvent
): { start: ResourceStartBindingIntent } | { skipped: EvaluatedBinding } {
  const bindingRevision = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  const skipped = (status: EvaluatedBinding['status'], reason: string) => ({
    skipped: { bindingId: binding.bindingId, bindingRevision, status, reason },
  });
  const { selector, inputMapping, item, wake, ...intent } = binding;
  if (!matchForgeEvent(selector, event)) return skipped('unmatched', 'selector_did_not_match');
  const mapped = mapForgeInputs(inputMapping, event);
  if (!mapped.ok) return skipped('rejected', `Input '${mapped.input}': ${mapped.reason}`);
  const itemKey = item ? mappedItemKey(item, readForgeEventField(event, item.field)) : undefined;
  if (itemKey && !itemKey.ok) return skipped('rejected', `Item: ${itemKey.reason}`);
  const woken = wake ? wakeOf(wake, event) : undefined;
  if (woken && 'reason' in woken) return skipped('rejected', woken.reason);
  // Field mappings carry event content; literal mappings are the operator's own values.
  const literalInputs: Record<string, JsonValue> = {};
  const eventInputs: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(mapped.inputs))
    (inputMapping[name]?.source === 'field' ? eventInputs : literalInputs)[name] = value;
  return {
    start: resourceStartBindingIntentSchema.parse({
      ...intent,
      bindingRevision,
      launch: { ...binding.launch, inputs: { ...binding.launch.inputs, ...literalInputs } },
      eventInputs,
      ...(itemKey ? { itemKey: itemKey.key } : {}),
      ...(woken ? { wake: woken.wake } : {}),
    }),
  };
}

function evaluateBindings(
  configuredBindings: z.infer<typeof githubSourceBindingSchema>[],
  event: ForgeEvent
) {
  const bindings: ResourceStartBindingIntent[] = [];
  const evaluatedBindings: EvaluatedBinding[] = [];
  for (const binding of configuredBindings) {
    const evaluated = evaluateBinding(binding, event);
    if ('start' in evaluated) bindings.push(evaluated.start);
    else evaluatedBindings.push(evaluated.skipped);
  }
  return { bindings, evaluatedBindings };
}

type GitHubSourceConfig = z.infer<typeof githubWebhookSourceConfigSchema>;
type ObserveInput = Parameters<NonNullable<WebhookSourcePlugin['observe']>>[0];
type ObservedWait = ObserveInput['waits'][number];
type ObservedWaitRef = SourceObservation['unserved'][number]['wait'];

/** What one forge read is for: the checks at a commit, or a pull request's reviews. */
type ObserveTarget =
  | { kind: 'commit'; remote: string; revision: string }
  | { kind: 'pr'; remote: string; number: number };

/** The pull request number an item key names under `binding`'s item mapping, if it names one. */
function prNumberOf(binding: GitHubSourceBinding, itemKey: string): number | undefined {
  if (binding.item?.field !== 'subject.number') return undefined;
  const prefix = binding.item.prefix ?? '';
  const rest = itemKey.startsWith(prefix) ? itemKey.slice(prefix.length) : '';
  const number = /^[1-9][0-9]*$/.test(rest) ? Number(rest) : NaN;
  return Number.isSafeInteger(number) ? number : undefined;
}

/** What `binding` reads to observe `wait`, or why it cannot. */
function targetOf(
  binding: GitHubSourceBinding,
  wait: ObservedWait & { remote: string }
): ObserveTarget | { reason: string } {
  const field = binding.wake?.about.field;
  if (binding.selector.kind === 'check.changed' && field === 'check.revision')
    return { kind: 'commit', remote: wait.remote, revision: wait.about };
  if (binding.selector.kind === 'review.changed' && field === 'review.commit') {
    const number = prNumberOf(binding, wait.itemKey);
    return number === undefined
      ? { reason: `item '${wait.itemKey}' names no pull request under the binding's item mapping` }
      : { kind: 'pr', remote: wait.remote, number };
  }
  return { reason: `${binding.selector.kind} wakes about ${String(field)} are not observed` };
}

/**
 * The events a webhook would have carried for what one target reads, each with the key that
 * makes it one delivery. Built in a fixed key order, so the same state digests the same on
 * every pass.
 */
async function targetEvents(
  target: ObserveTarget,
  forge: ObserveInput['forge']
): Promise<{ host: string; events: { key: string; event: ForgeEvent }[] }> {
  if (target.kind === 'commit') {
    const observed = await forge.commitChecks({ remote: target.remote, revision: target.revision });
    const repo = { host: observed.repo.host, path: observed.repo.path };
    const events = observed.units.map(unit => ({
      key: `check:${repo.host}/${repo.path}@${observed.revision}:${unit.unit.kind}:${unit.unit.id}:${unit.phase}:${unit.nativeResult ?? ''}`,
      event: {
        kind: 'check.changed',
        action: 'changed',
        repo,
        revision: observed.revision,
        unit: { kind: unit.unit.kind, id: unit.unit.id, name: unit.unit.name },
        nativeState: unit.nativeState,
        phase: unit.phase,
        nativeResult: unit.nativeResult,
        result: unit.result,
        // A check event names no subject; no binding field reads its pull requests.
        pullRequests: [],
      },
    })) satisfies { key: string; event: ForgeEvent }[];
    return { host: repo.host, events };
  }
  const observed = await forge.prReviews({ remote: target.remote, number: target.number });
  const pr = {
    repo: { host: observed.ref.repo.host, path: observed.ref.repo.path },
    number: observed.ref.number,
  };
  const events: { key: string; event: ForgeEvent }[] = [];
  for (const item of observed.items) {
    // A pending review is not submitted yet; a webhook would not have carried it.
    if (item.kind !== 'review' || item.state === null || /^pending$/i.test(item.state)) continue;
    const nativeState = item.state.toLowerCase();
    const action = nativeState === 'dismissed' ? 'dismissed' : 'submitted';
    events.push({
      key: `review:${pr.repo.host}/${pr.repo.path}#${String(pr.number)}:${item.id}:${action}`,
      event: {
        kind: 'review.changed',
        action,
        pr,
        review: {
          id: item.id,
          state: reviewState(nativeState),
          nativeState,
          commit: item.commit,
          author: item.author,
        },
      },
    });
  }
  return { host: pr.repo.host, events };
}

/**
 * The events a webhook would have delivered for the state each open wait names, as
 * acceptances of the bindings that wake those waits. Only a binding that wakes a wait is
 * evaluated: observing must not start a binding nobody waits on, which would also start
 * twice on an install that receives webhooks too. Each acceptance is for one binding and
 * the wait's item, so a wait that opens later on another item, or for another binding,
 * is a new delivery and not a replay of one made before it existed.
 */
async function observeWaits(
  sourceInstanceId: string,
  config: GitHubSourceConfig,
  { waits, forge }: ObserveInput
): Promise<SourceObservation> {
  const unserved: SourceObservation['unserved'] = [];
  const failed: SourceObservation['failed'] = [];
  const targets = new Map<
    string,
    {
      target: ObserveTarget;
      served: { wait: ObservedWaitRef; binding: GitHubSourceBinding }[];
    }
  >();
  for (const wait of waits) {
    const ref = {
      workflowName: wait.workflowName,
      event: wait.event,
      about: wait.about,
      itemKey: wait.itemKey,
    };
    const bindings = config.bindings.filter(
      binding => binding.wake?.workflow === wait.workflowName && binding.wake.wait === wait.event
    );
    // Another source may serve a wait this one binds nothing to.
    if (bindings.length === 0) continue;
    const { remote } = wait;
    if (remote === null) {
      unserved.push({ wait: ref, reason: "the wait's project has no repository URL" });
      continue;
    }
    for (const binding of bindings) {
      const target = targetOf(binding, { ...wait, remote });
      if ('reason' in target) {
        unserved.push({ wait: ref, reason: target.reason });
        continue;
      }
      const key = JSON.stringify(target);
      const entry = targets.get(key) ?? { target, served: [] };
      entry.served.push({ wait: ref, binding });
      targets.set(key, entry);
    }
  }
  const acceptances: SourceReceiptAcceptance[] = [];
  const receivedAt = new Date().toISOString();
  for (const { target, served } of targets.values()) {
    let read: Awaited<ReturnType<typeof targetEvents>>;
    try {
      read = await targetEvents(target, forge);
    } catch (error) {
      // One unreadable target does not stop the others.
      const reason = error instanceof Error ? error.message : String(error);
      for (const { wait } of served) failed.push({ wait, reason });
      continue;
    }
    for (const { wait, binding } of served) {
      if (read.host !== config.host) {
        unserved.push({ wait, reason: `the wait's repository is not on ${config.host}` });
        continue;
      }
      for (const { key, event } of read.events) {
        const evaluated = evaluateBinding(binding, event);
        // A state the binding does not start on (a check still running), or one about
        // another commit than the wait's, would only be recorded as unmatched.
        if (!('start' in evaluated) || evaluated.start.wake?.about !== wait.about) continue;
        acceptances.push({
          receipt: {
            id: randomUUID(),
            sourceInstanceId,
            // A persisted contract: one delivery per observed state, binding and item. A
            // later pass that sees the same state is a replay, which never meets a wait, so
            // each state wakes an item's wait at most once per binding, as its webhook would,
            // even when the woken stage ends waiting at the same commit again.
            deliveryId: `observe:${key}:${binding.bindingId}:${wait.itemKey}`,
            contentDigest: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
            receivedAt,
            occurredAt: null,
            sourceActor: null,
          },
          outcome: 'matched',
          // The observation knows the wait's item, so the start goes to that item only.
          bindings: [{ ...evaluated.start, itemKey: wait.itemKey }],
        });
      }
    }
  }
  return { acceptances, unserved, failed };
}

/** Configured source plugins run as trusted operator-installed code. */
const createGitHubWebhookSource: WebhookSourcePluginFactory = ({
  sourceInstanceId,
  config: rawConfig,
}) => {
  const parsed = githubWebhookSourceConfigSchema.safeParse(rawConfig);
  if (!parsed.success) throw new Error('Invalid GitHub source plugin configuration');
  const config = parsed.data;
  const secret =
    config.webhookSecretEnv === undefined ? undefined : process.env[config.webhookSecretEnv];
  if (config.webhookSecretEnv !== undefined && !secret)
    throw new Error('GitHub source plugin webhook secret is unavailable');
  return {
    observe: input => observeWaits(sourceInstanceId, config, input),
    async receive(request): Promise<WebhookSourceResult> {
      if (
        secret === undefined ||
        !verifyGitHubWebhookSignature(
          request.body,
          request.headers['x-hub-signature-256'] ?? '',
          secret
        )
      )
        return { status: 'rejected', reason: 'unauthenticated' };
      const delivery = {
        deliveryId: request.headers['x-github-delivery'] ?? null,
        eventName: request.headers['x-github-event'],
        contentDigest: createHash('sha256').update(request.body).digest('hex'),
        receivedAt: request.receivedAt,
      };
      const receipt: SourceReceiptInput = {
        id: randomUUID(),
        sourceInstanceId: sourceInstanceId,
        deliveryId: delivery.deliveryId,
        contentDigest: delivery.contentDigest,
        receivedAt: delivery.receivedAt,
        occurredAt: null,
        sourceActor: null,
      };
      let payload: unknown;
      try {
        payload = JSON.parse(request.body) as unknown;
      } catch {
        return {
          status: 'received',
          acceptance: { receipt, outcome: 'malformed', reason: 'invalid_json', bindings: [] },
        };
      }
      const normalized = normalizeGitHubWebhook(payload, {
        sourceInstanceId: sourceInstanceId,
        deliveryId: delivery.deliveryId,
        contentDigest: delivery.contentDigest,
        receivedAt: delivery.receivedAt,
        host: config.host,
        eventName: delivery.eventName ?? '',
      });
      if (normalized.status !== 'normalized') {
        return {
          status: 'received',
          acceptance: {
            receipt,
            outcome: normalized.status,
            reason: normalized.reason,
            bindings: [],
          },
        };
      }
      receipt.occurredAt = normalized.envelope.occurredAt;
      if (normalized.envelope.sourceActor) {
        receipt.sourceActor = {
          source: sourceInstanceId,
          id: normalized.envelope.sourceActor.id,
        };
      }
      const { bindings, evaluatedBindings } = evaluateBindings(
        config.bindings,
        normalized.envelope.event
      );
      const [first, ...rest] = bindings;
      return {
        status: 'received',
        acceptance: {
          receipt,
          evaluatedBindings,
          ...(first
            ? { outcome: 'matched', bindings: [first, ...rest] }
            : { outcome: 'unmatched', bindings: [] }),
        },
      };
    },
  };
};

export default createGitHubWebhookSource;
