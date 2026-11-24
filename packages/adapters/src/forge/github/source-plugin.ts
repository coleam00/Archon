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
import { SourceForgeReadError } from '../source-forge-reader';
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
  ObservedLabels,
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

type CheckRead = { host: string; events: { key: string; event: ForgeEvent }[] };

function commitKey(remote: string, revision: string): string {
  return JSON.stringify([remote, revision]);
}

/**
 * The events a webhook would have carried for what one target reads, each with the key that
 * makes it one delivery. Built in a fixed key order, so the same state digests the same on
 * every pass. A commit whose checks are all completed is remembered for this process.
 */
async function targetEvents(
  target: ObserveTarget,
  forge: ObserveInput['forge'],
  remembered?: { host: string; cache: Map<string, CheckRead> }
): Promise<CheckRead> {
  if (target.kind === 'commit') {
    const key = commitKey(target.remote, target.revision);
    const cached = remembered?.cache.get(key);
    if (cached !== undefined && cached.host === remembered?.host) return cached;
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
    const read = { host: repo.host, events };
    if (
      remembered !== undefined &&
      repo.host === remembered.host &&
      observed.units.length > 0 &&
      observed.units.every(unit => unit.phase === 'completed')
    )
      remembered.cache.set(key, read);
    return read;
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
 * evaluated here: observing checks and reviews must not start a binding nobody waits on,
 * which would also start twice on an install that receives webhooks too. (Label bindings
 * start without a wait; `observeLabels` handles them.) Each acceptance is for one binding
 * and the wait's item, so a wait that opens later on another item, or for another binding,
 * is a new delivery and not a replay of one made before it existed.
 */
async function observeWaits(
  sourceInstanceId: string,
  config: GitHubSourceConfig,
  { waits, forge }: ObserveInput,
  cache: Map<string, CheckRead>
): Promise<Omit<SourceObservation, 'labelAcceptances' | 'labelFailures'>> {
  const { targets, unserved } = planTargets(config, waits);
  const planned = new Set(
    targets.flatMap(entry =>
      entry.target.kind === 'commit' ? [commitKey(entry.target.remote, entry.target.revision)] : []
    )
  );
  for (const key of cache.keys()) if (!planned.has(key)) cache.delete(key);
  const failed: SourceObservation['failed'] = [];
  const acceptances: SourceReceiptAcceptance[] = [];
  const receivedAt = new Date().toISOString();
  for (const { target, served } of targets) {
    let read: Awaited<ReturnType<typeof targetEvents>>;
    try {
      read = await targetEvents(target, forge, { host: config.host, cache });
    } catch (error) {
      // One unreadable target does not stop the others.
      const failure = readError(error);
      for (const { wait } of served)
        failed.push(withKind({ wait, reason: failure.reason }, failure.kind));
      continue;
    }
    for (const { wait, binding } of served) {
      if (read.host !== config.host) {
        unserved.push({ wait, reason: `the wait's repository is not on ${config.host}` });
        continue;
      }
      const result = waitAcceptances(sourceInstanceId, receivedAt, wait, binding, read.events);
      acceptances.push(...result.acceptances);
      unserved.push(...result.unserved);
    }
  }
  return { acceptances, unserved, failed };
}

/** Each read the waits need, with the waits and bindings it serves; and the waits it cannot. */
function planTargets(
  config: GitHubSourceConfig,
  waits: ObserveInput['waits']
): {
  targets: {
    target: ObserveTarget;
    served: { wait: ObservedWaitRef; binding: GitHubSourceBinding }[];
  }[];
  unserved: SourceObservation['unserved'];
} {
  const unserved: SourceObservation['unserved'] = [];
  const targets = new Map<
    string,
    { target: ObserveTarget; served: { wait: ObservedWaitRef; binding: GitHubSourceBinding }[] }
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
  return { targets: [...targets.values()], unserved };
}

/** The acceptances one binding makes for one wait from what its target read, or why none. */
function waitAcceptances(
  sourceInstanceId: string,
  receivedAt: string,
  wait: ObservedWaitRef,
  binding: GitHubSourceBinding,
  events: readonly { key: string; event: ForgeEvent }[]
): { acceptances: SourceReceiptAcceptance[]; unserved: SourceObservation['unserved'] } {
  const acceptances: SourceReceiptAcceptance[] = [];
  const rejections = new Set<string>();
  const field = binding.wake?.about.field;
  for (const { key, event } of events) {
    // An event about another commit than the wait's (an older review) is not for it.
    if (field === undefined || readForgeEventField(event, field) !== wait.about) continue;
    const evaluated = evaluateBinding(binding, event);
    if ('skipped' in evaluated) {
      // The binding matched the event but cannot start on it, such as a mapped field the
      // event lacks: a webhook would record that reason, so the observation reports it. A
      // state it does not select (a check still running) would only be recorded unmatched.
      if (evaluated.skipped.status === 'rejected')
        rejections.add(
          `binding '${binding.bindingId}' rejects the event: ${evaluated.skipped.reason}`
        );
      continue;
    }
    acceptances.push({
      receipt: {
        id: randomUUID(),
        sourceInstanceId,
        // A persisted contract: one delivery per observed state, binding and item. A later
        // pass that sees the same state is a replay, which never meets a wait, so each state
        // wakes an item's wait at most once per binding, as its webhook would, even when the
        // woken stage ends waiting at the same commit again.
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
  return { acceptances, unserved: [...rejections].map(reason => ({ wait, reason })) };
}

/**
 * The label reads this source's `label.changed` bindings name, one per label name, and the
 * label bindings it cannot observe, with why.
 */
function labelReadsOf(config: GitHubSourceConfig): ObservedLabels {
  const reads: ObservedLabels['reads'] = [];
  const unserved: NonNullable<ObservedLabels['unserved']> = [];
  for (const binding of config.bindings) {
    const { selector, bindingId } = binding;
    if (selector.kind !== 'label.changed') continue;
    const names = (selector.predicates ?? []).flatMap(predicate =>
      predicate.field !== 'label.name'
        ? []
        : predicate.equals === undefined
          ? (predicate.in ?? [])
          : [predicate.equals]
    );
    const read = labelReadOf(config, binding, names);
    if ('reason' in read) unserved.push({ bindingId, reason: read.reason });
    else for (const label of new Set(names)) reads.push({ bindingId, repo: read.repo, label });
  }
  return { reads, unserved };
}

/** The repository a label binding lists, or why it cannot be observed. */
function labelReadOf(
  config: GitHubSourceConfig,
  binding: GitHubSourceBinding,
  names: readonly string[]
): { repo: { host: string; path: string } } | { reason: string } {
  const { selector } = binding;
  // Observing as well would start it twice: by the webhook's delivery and by this read.
  if (config.webhookSecretEnv !== undefined)
    return { reason: 'this source receives webhooks; label events arrive by webhook' };
  if (selector.kind !== 'label.changed' || !selector.actions.includes('added'))
    return { reason: 'only an added label is observed' };
  if (binding.wake !== undefined) return { reason: 'a label wake is not observed' };
  if (selector.repository === undefined)
    return { reason: 'the selector names no repository to list' };
  if (selector.repository.host !== config.host)
    return { reason: `the selector's repository is not on ${config.host}` };
  if (names.length === 0) return { reason: 'the selector names no label' };
  return { repo: { host: config.host, path: selector.repository.path } };
}

type LabelRead = ObserveInput['labels'][number];
type LabelledItem = Awaited<ReturnType<ObserveInput['forge']['issuesWithLabel']>>['items'][number];

/**
 * Whether the selector's `subject` and `subject.kind` predicates admit this listed item,
 * compared as `matchForgeEvent` compares them. A label-event read costs one request per
 * item, and the selector may already rule some out, such as every issue for a binding on
 * pull requests. It must never admit less than the match; `evaluateBinding` still decides.
 */
function admitsSubject(selector: GitHubSourceBinding['selector'], item: LabelledItem): boolean {
  const { subject, predicates = [] } = selector;
  if (subject && (subject.kind !== item.kind || subject.number !== item.ref.number)) return false;
  return predicates.every(predicate =>
    predicate.field !== 'subject.kind'
      ? true
      : predicate.equals !== undefined
        ? predicate.equals === item.kind
        : predicate.in?.includes(item.kind) === true
  );
}

type LabelFailure = SourceObservation['labelFailures'][number];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function readError(error: unknown): { reason: string; kind?: string } {
  const reason = errorText(error);
  return error instanceof SourceForgeReadError ? { reason, kind: error.kind } : { reason };
}

function withKind<T extends { reason: string }>(failure: T, kind: string | undefined): T {
  return kind === undefined ? failure : { ...failure, kind };
}

/**
 * The label events a webhook would have carried for the open issues and pull requests each
 * read lists that the binding's selector admits: one `label.changed` added event per item,
 * with the forge's own label-added event. On a read's first sight every one is recorded
 * unmatched, and after it so is an add older than that sight, so a label already on an
 * item when the binding is first seen starts nothing, even on an item reopened later. Only
 * state is seen: a label added and removed between two passes is never read.
 */
async function observeLabels(
  sourceInstanceId: string,
  config: GitHubSourceConfig,
  { labels, forge }: ObserveInput
): Promise<Pick<SourceObservation, 'labelAcceptances' | 'labelFailures'>> {
  const labelAcceptances: SourceObservation['labelAcceptances'] = [];
  const labelFailures: LabelFailure[] = [];
  const receivedAt = new Date().toISOString();
  for (const read of labels) {
    const { bindingId, label, repo } = read;
    const binding = config.bindings.find(entry => entry.bindingId === bindingId);
    if (binding === undefined) continue;
    let listed: Awaited<ReturnType<ObserveInput['forge']['issuesWithLabel']>>;
    try {
      listed = await forge.issuesWithLabel({ repo, label });
    } catch (error) {
      const read = readError(error);
      labelFailures.push(withKind({ bindingId, label, reason: read.reason }, read.kind));
      continue;
    }
    // The list holds issues and pull requests; read only those the selector can match.
    for (const item of listed.items.filter(entry => admitsSubject(binding.selector, entry))) {
      const result = await labelAcceptance(sourceInstanceId, receivedAt, binding, read, {
        kind: item.kind,
        number: item.ref.number,
        forge,
      });
      if (result?.kind === 'failed') labelFailures.push(result.failure);
      else if (result?.kind === 'accepted')
        labelAcceptances.push({ bindingId, label, acceptance: result.acceptance });
    }
  }
  return { labelAcceptances, labelFailures };
}

/**
 * The acceptance one read makes for one labelled issue or pull request; why it cannot, as a
 * failure; or nothing, when the binding does not select the event.
 */
async function labelAcceptance(
  sourceInstanceId: string,
  receivedAt: string,
  binding: GitHubSourceBinding,
  read: LabelRead,
  {
    kind,
    number,
    forge,
  }: { kind: LabelledItem['kind']; number: number; forge: ObserveInput['forge'] }
): Promise<
  | { kind: 'accepted'; acceptance: SourceReceiptAcceptance }
  | { kind: 'failed'; failure: LabelFailure }
  | undefined
> {
  const { bindingId, label, repo } = read;
  const failure = (reason: string, kind?: string) => ({
    kind: 'failed' as const,
    failure: withKind({ bindingId, label, number, reason }, kind),
  });
  let added: Awaited<ReturnType<ObserveInput['forge']['labelAdded']>>['added'];
  try {
    ({ added } = await forge.labelAdded({ repo, kind, number, label }));
  } catch (error) {
    const read = readError(error);
    return failure(read.reason, read.kind);
  }
  // Without the forge's event there is no identity for this add; never invent one.
  if (added === null) return failure('the forge records no add');
  const event = {
    kind: 'label.changed',
    action: 'added',
    subject: { kind, ref: { repo, number } },
    // The list does not carry the label's own id.
    label: { name: label, id: null },
    actor: added.actor,
  } satisfies ForgeEvent;
  const evaluated = evaluateBinding(binding, event);
  if ('skipped' in evaluated)
    return evaluated.skipped.status === 'rejected'
      ? failure(`the binding rejects the event: ${evaluated.skipped.reason}`)
      : undefined;
  const receipt: SourceReceiptInput = {
    id: randomUUID(),
    sourceInstanceId,
    // A persisted contract: one delivery per label add and binding. The forge's event id
    // makes a remove and re-add a new delivery; the same add read on a later pass is a
    // replay, so it starts once. A forge numbers issues and pull requests in one sequence
    // per repository, so the number needs no kind. The item key is not part of it: a binding whose item
    // mapping changes must not start an add it has already recorded.
    deliveryId: `observe:label:${repo.host}/${repo.path}#${String(number)}:${added.id}:${bindingId}`,
    contentDigest: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
    receivedAt,
    occurredAt: added.at,
    sourceActor: added.actor === null ? null : { source: sourceInstanceId, id: added.actor.id },
  };
  // The two clocks are the forge's and this host's, so an add within their skew of the
  // first sight can fall on either side of it.
  const seen = read.seenSince === null || Date.parse(added.at) < Date.parse(read.seenSince);
  return {
    kind: 'accepted',
    acceptance: seen
      ? {
          receipt,
          outcome: 'unmatched',
          reason: 'label was on the item when the binding was first observed',
          bindings: [],
        }
      : { receipt, outcome: 'matched', bindings: [evaluated.start] },
  };
}

/** Configured source plugins run as trusted operator-installed code. */
const createGitHubWebhookSource: WebhookSourcePluginFactory = ({
  sourceInstanceId,
  config: rawConfig,
}) => {
  const parsed = githubWebhookSourceConfigSchema.safeParse(rawConfig);
  if (!parsed.success) throw new Error('Invalid GitHub source plugin configuration');
  const config = parsed.data;
  const terminalChecks = new Map<string, CheckRead>();
  const secret =
    config.webhookSecretEnv === undefined ? undefined : process.env[config.webhookSecretEnv];
  if (config.webhookSecretEnv !== undefined && !secret)
    throw new Error('GitHub source plugin webhook secret is unavailable');
  return {
    observedLabels: labelReadsOf(config),
    async observe(input) {
      const waits = await observeWaits(sourceInstanceId, config, input, terminalChecks);
      const labels = await observeLabels(sourceInstanceId, config, input);
      return { ...waits, ...labels };
    },
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
