import { createHash, randomUUID } from 'node:crypto';
import type { z } from '@hono/zod-openapi';
import {
  type ForgeEvent,
  mapForgeInputs,
  matchForgeEvent,
  readForgeEventField,
} from '@archon/forge';
import { normalizeGitHubWebhook } from './normalize-event';
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

/**
 * The `check.changed` events a webhook would have delivered for the checks at each commit
 * an open wait names, as acceptances of the bindings that wake those waits. Only a binding
 * that wakes a wait is evaluated: observing a commit for a wait must not start a binding
 * nobody waits on, which would also start twice on an install that receives webhooks too.
 */
async function observeWaits(
  sourceInstanceId: string,
  config: GitHubSourceConfig,
  { waits, forge }: ObserveInput
): Promise<SourceObservation> {
  const unserved: SourceObservation['unserved'] = [];
  // Per commit, the bindings that wake a wait about it.
  const commits = new Map<
    string,
    {
      remote: string;
      revision: string;
      bindings: Set<GitHubSourceBinding>;
      waits: SourceObservation['unserved'][number]['wait'][];
    }
  >();
  for (const wait of waits) {
    const bindings = config.bindings.filter(
      binding => binding.wake?.workflow === wait.workflowName && binding.wake.wait === wait.event
    );
    // Another source may serve a wait this one binds nothing to.
    if (bindings.length === 0) continue;
    const { workflowName, event, about } = wait;
    const served = bindings.filter(
      binding =>
        binding.selector.kind === 'check.changed' && binding.wake?.about.field === 'check.revision'
    );
    if (served.length < bindings.length)
      unserved.push({
        wait: { workflowName, event, about },
        reason: 'only check.changed wakes about check.revision are observed',
      });
    if (served.length === 0) continue;
    if (wait.remote === null) {
      unserved.push({
        wait: { workflowName, event, about },
        reason: "the wait's project has no repository URL",
      });
      continue;
    }
    const key = JSON.stringify([wait.remote, about]);
    const commit = commits.get(key) ?? {
      remote: wait.remote,
      revision: about,
      bindings: new Set(),
      waits: [],
    };
    for (const binding of served) commit.bindings.add(binding);
    commit.waits.push({ workflowName, event, about });
    commits.set(key, commit);
  }
  const acceptances: SourceReceiptAcceptance[] = [];
  const receivedAt = new Date().toISOString();
  for (const { remote, revision, bindings, waits: served } of commits.values()) {
    const observed = await forge.commitChecks({ remote, revision });
    if (observed.repo.host !== config.host) {
      for (const wait of served)
        unserved.push({ wait, reason: `the wait's repository is not on ${config.host}` });
      continue;
    }
    for (const unit of observed.units) {
      // Built in a fixed key order, so the same check state digests the same on every pass.
      const event: ForgeEvent = {
        kind: 'check.changed',
        action: 'changed',
        repo: { host: observed.repo.host, path: observed.repo.path },
        revision: observed.revision,
        unit: { kind: unit.unit.kind, id: unit.unit.id, name: unit.unit.name },
        nativeState: unit.nativeState,
        phase: unit.phase,
        nativeResult: unit.nativeResult,
        result: unit.result,
        // A check event names no subject; no binding field reads its pull requests.
        pullRequests: [],
      };
      const evaluated = evaluateBindings([...bindings], event);
      const [first, ...rest] = evaluated.bindings;
      // A check state no binding starts on (one still running) is not recorded.
      if (first === undefined) continue;
      const content = JSON.stringify(event);
      acceptances.push({
        receipt: {
          id: randomUUID(),
          sourceInstanceId,
          // One delivery per observed check state, a persisted contract: a later pass that
          // sees the same state is a replay, which never meets a wait, so each completed
          // check wakes at most once, as its webhook would.
          deliveryId: `observe:check:${event.repo.host}/${event.repo.path}@${event.revision}:${event.unit.kind}:${event.unit.id}:${event.phase}:${event.nativeResult ?? ''}`,
          contentDigest: createHash('sha256').update(content).digest('hex'),
          receivedAt,
          occurredAt: null,
          sourceActor: null,
        },
        outcome: 'matched',
        bindings: [first, ...rest],
        evaluatedBindings: evaluated.evaluatedBindings,
      });
    }
  }
  return { acceptances, unserved };
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
