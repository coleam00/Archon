/**
 * The installed source plugins (the file `ARCHON_WEBHOOK_SOURCES` names) and the two ways
 * their events reach the engine: a webhook delivery (`receive`) and, for a source that
 * declares `observe`, a pass over the open item waits and the labels its bindings start on
 * (`createItemWaitObserver`). Both admit through the same `admit`, so an observed event is
 * recorded, deduplicated and matched against the waits exactly as a delivered one is.
 * Loaded by the server and by `archon workflow wake`, which is why it lives here and not in
 * the server.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from '@hono/zod-openapi';
import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import type { StartReceiptInspection } from '@archon/workflows/resource-start-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import { createLogger } from '@archon/paths';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import { configProblems, declaredReads } from './declared-reads';
import { guardedOpenedLists, openedIssueReads, openedSeenMarker } from './opened-issue-reads';
import { labelSeenMarker, seenMarkerAcceptance, seenMarkerId } from './seen-markers';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import {
  type ObservedItemWait,
  type ObservedLabelRead,
  type ObservedOpenedIssueRead,
  type SourceForgeReader,
  type SourceObservation,
  type UnservedBinding,
  type WebhookSourcePlugin,
  type WebhookSourcePluginFactory,
  type WebhookSourceRequest,
} from '@archon/workflows/webhook-source-plugin';
import { declaredWakes, freshOverdue, isTemporaryForgeFailure, nextBackoff } from './observe-read';
import {
  sourceObservationSchema,
  webhookSourceResultSchema,
} from '@archon/workflows/webhook-source-plugin';

const sourceInstanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const sourceConfigSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(
      z
        .object({
          sourceInstanceId: sourceInstanceIdSchema,
          module: z.string().min(1),
          config: jsonValueSchema,
          /** Observe the open item waits this often, for an install that receives no webhooks. */
          observe: z
            .object({ everySeconds: z.number().int().min(15) })
            .strict()
            .optional(),
        })
        .strict()
    ),
  })
  .strict();

export type WebhookSourceOutcome = 'accepted' | 'malformed' | 'unauthenticated' | 'conflict';

export type { UnservedBinding };

/**
 * A source that observes, how often, and the label and opened-issue reads its bindings
 * name. The reads are fixed when the plugin loads; a pass lists only these.
 * `unservedBindings` is every binding the source declared it cannot observe, of any kind.
 */
export interface ObservingSource {
  sourceInstanceId: string;
  everySeconds: number;
  labels: readonly ObservedLabelRead[];
  openedIssues: readonly ObservedOpenedIssueRead[];
  unservedBindings: readonly UnservedBinding[];
  wakes: readonly { workflow: string; wait: string }[];
}

/**
 * What one source's observation admitted: each receipt, the waits it could not read, and
 * why an acceptance could not be admitted. One failed acceptance does not hide the others,
 * so their starts are still handed on.
 */
export interface SourceObservationAdmitted {
  admitted: { receiptId: string; replay: boolean }[];
  conflicts: number;
  unserved: SourceObservation['unserved'];
  failures: string[];
}

export interface WebhookSourcePluginHost {
  hasSource(sourceInstanceId: string): boolean;
  receive(sourceInstanceId: string, request: WebhookSourceRequest): Promise<WebhookSourceOutcome>;
  /** The sources configured with `observe`; empty when none is, and then nothing observes. */
  readonly observing: readonly ObservingSource[];
  observe(
    sourceInstanceId: string,
    waits: readonly ObservedItemWait[],
    forge: SourceForgeReader
  ): Promise<SourceObservationAdmitted>;
}

export interface WebhookSourceHostDependencies {
  acceptReceipt: IWorkflowStore['acceptStartReceipt'];
  isKnownUser: (id: string) => Promise<boolean>;
  hasDeliveryReceipt: (sourceInstanceId: string, deliveryId: string) => Promise<boolean>;
  /** A recorded receipt by id; observation reads a label read's seen marker with it. */
  getReceipt: (id: string) => Promise<Pick<StartReceiptInspection, 'occurredAt'> | null>;
}

const log = createLogger('webhook-sources');

function isWebhookSourcePlugin(value: unknown): value is WebhookSourcePlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    'receive' in value &&
    typeof value.receive === 'function'
  );
}

type SourceEntry = z.infer<typeof sourceConfigSchema>['sources'][number];

async function readSourceConfig(configPath: string): Promise<z.infer<typeof sourceConfigSchema>> {
  try {
    return sourceConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  } catch (error) {
    log.error({ err: error as Error, stage: 'config' }, 'webhook_source_load_failed');
    // The JSON output of a CLI host shows only this message, so it names what to fix.
    throw new Error(
      `Webhook source configuration ${configPath} is invalid: ${configProblems(error)}`,
      { cause: error }
    );
  }
}

/** One configured source's plugin: its module imported and its factory run. */
async function loadSourcePlugin(source: SourceEntry): Promise<WebhookSourcePlugin> {
  const { sourceInstanceId } = source;
  if (!isAbsolute(source.module))
    throw new Error(`Webhook source module for '${sourceInstanceId}' must be absolute`);
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(source.module).href);
  } catch (error) {
    log.error(
      { err: error as Error, sourceInstanceId, stage: 'import' },
      'webhook_source_load_failed'
    );
    throw new Error(
      `Webhook source '${sourceInstanceId}' could not be loaded: ${configProblems(error)}`,
      { cause: error }
    );
  }
  const factory = (loaded as { default?: unknown }).default;
  if (typeof factory !== 'function')
    throw new Error(`Webhook source module for '${sourceInstanceId}' has no default factory`);
  let plugin: unknown;
  try {
    plugin = await (factory as (input: Parameters<WebhookSourcePluginFactory>[0]) => unknown)({
      sourceInstanceId,
      config: source.config,
    });
  } catch (error) {
    log.error(
      { err: error as Error, sourceInstanceId, stage: 'factory' },
      'webhook_source_load_failed'
    );
    throw new Error(
      `Webhook source '${sourceInstanceId}' factory failed: ${configProblems(error)}`,
      { cause: error }
    );
  }
  if (!isWebhookSourcePlugin(plugin))
    throw new Error(`Webhook source module for '${sourceInstanceId}' returned no receiver`);
  if (source.observe !== undefined && typeof plugin.observe !== 'function')
    throw new Error(
      `Webhook source '${sourceInstanceId}' declares observe, but its plugin cannot observe waits`
    );
  return plugin;
}

/**
 * The configured sources' plugins. `observingOnly` loads just the sources that declare
 * `observe`, for a host that receives no webhooks: a source it would never call cannot
 * stop it, such as one whose webhook secret is only in the server's environment.
 */
export async function loadWebhookSourcePlugins(
  configPath: string,
  dependencies: WebhookSourceHostDependencies,
  options: { observingOnly?: boolean } = {}
): Promise<WebhookSourcePluginHost> {
  const parsed = await readSourceConfig(configPath);
  const plugins = new Map<string, WebhookSourcePlugin>();
  const observing: ObservingSource[] = [];
  const loaded = options.observingOnly
    ? parsed.sources.filter(source => source.observe !== undefined)
    : parsed.sources;

  for (const source of loaded) {
    if (plugins.has(source.sourceInstanceId))
      throw new Error(`Duplicate webhook source instance '${source.sourceInstanceId}'`);
    const plugin = await loadSourcePlugin(source);
    plugins.set(source.sourceInstanceId, plugin);
    if (source.observe !== undefined)
      observing.push({
        sourceInstanceId: source.sourceInstanceId,
        everySeconds: source.observe.everySeconds,
        ...declaredReads(source.sourceInstanceId, plugin),
        wakes: declaredWakes(source.config),
      });
  }

  const opened = openedIssueReads();

  const pluginFor = (sourceInstanceId: string): WebhookSourcePlugin => {
    const plugin = plugins.get(sourceInstanceId);
    if (!plugin) throw new Error(`Unknown webhook source instance '${sourceInstanceId}'`);
    return plugin;
  };

  /**
   * Record one acceptance a source produced, delivered or observed: the identity check, the
   * run-as gate and the receipt, where the store deduplicates the delivery and resolves wakes.
   */
  const admit = async (
    sourceInstanceId: string,
    acceptance: SourceReceiptAcceptance
  ): Promise<
    { outcome: 'conflict' } | { outcome: 'accepted'; receiptId: string; replay: boolean }
  > => {
    if (acceptance.receipt.sourceInstanceId !== sourceInstanceId) {
      log.error({ sourceInstanceId, stage: 'identity' }, 'webhook_source_failed');
      throw new Error(`Webhook source '${sourceInstanceId}' returned a receipt for another source`);
    }
    // A redelivery keeps the binding snapshot of its first acceptance, so today's users
    // must not turn a recorded delivery into a failure; the store answers replay or
    // conflict for it. This lookup is the only run-as gate before persistence. It holds
    // because receipts are never deleted: retention would let a vanished receipt pass
    // here as an unvalidated first acceptance.
    const { deliveryId } = acceptance.receipt;
    const recorded =
      deliveryId !== null && (await dependencies.hasDeliveryReceipt(sourceInstanceId, deliveryId));
    for (const binding of recorded ? [] : acceptance.bindings) {
      if (!(await dependencies.isKnownUser(binding.runAsUserId))) {
        log.error({ sourceInstanceId, stage: 'run_as' }, 'webhook_source_failed');
        throw new Error(`Webhook source '${sourceInstanceId}' resolved an unknown run-as user`);
      }
    }
    try {
      return { outcome: 'accepted', ...(await dependencies.acceptReceipt(acceptance)) };
    } catch (error) {
      if (error instanceof SourceReceiptDigestConflictError) {
        log.warn(
          { sourceInstanceId, stage: 'persist', reason: 'delivery_conflict' },
          'webhook_source_rejected'
        );
        return { outcome: 'conflict' };
      }
      log.error(
        { err: error as Error, sourceInstanceId, stage: 'persist' },
        'webhook_source_failed'
      );
      throw new Error(`Webhook source '${sourceInstanceId}' receipt persistence failed`, {
        cause: error,
      });
    }
  };

  return {
    hasSource: sourceInstanceId => plugins.has(sourceInstanceId),
    observing,
    async receive(sourceInstanceId, request): Promise<WebhookSourceOutcome> {
      const plugin = pluginFor(sourceInstanceId);
      let result;
      try {
        result = webhookSourceResultSchema.parse(await plugin.receive(request));
      } catch (error) {
        log.error(
          { err: error as Error, sourceInstanceId, stage: 'normalize' },
          'webhook_source_failed'
        );
        throw new Error(`Webhook source '${sourceInstanceId}' failed to normalize a receipt`, {
          cause: error,
        });
      }
      if (result.status === 'rejected') {
        log.warn(
          {
            sourceInstanceId,
            stage: 'authenticate',
            reason: result.reason,
            attemptId: randomUUID(),
          },
          'webhook_source_rejected'
        );
        return 'unauthenticated';
      }
      const admitted = await admit(sourceInstanceId, result.acceptance);
      if (admitted.outcome === 'conflict') return 'conflict';
      return result.acceptance.outcome === 'malformed' ? 'malformed' : 'accepted';
    },
    async observe(sourceInstanceId, waits, forge): Promise<SourceObservationAdmitted> {
      const plugin = pluginFor(sourceInstanceId);
      const source = observing.find(entry => entry.sourceInstanceId === sourceInstanceId);
      if (!source || !plugin.observe)
        throw new Error(`Webhook source '${sourceInstanceId}' does not observe waits`);
      // A read with no marker yet is seen for the first time: what it lists is recorded,
      // and starts nothing. Once seen, a label added before the marker's time starts
      // nothing either, such as one on an issue that was closed during the first sight.
      const passStartedAt = new Date().toISOString();
      const labels = [];
      for (const read of source.labels) {
        const marker = await dependencies.getReceipt(
          seenMarkerId(sourceInstanceId, labelSeenMarker(read))
        );
        labels.push({ ...read, seenSince: marker === null ? null : marker.occurredAt });
      }
      // An opened-issue read's first sight is the engine's: it records the marker and hands
      // the read on from the next pass, so an issue opened before that starts nothing.
      const openedPass = await opened.pass({
        sourceInstanceId,
        reads: source.openedIssues,
        passStartedAt,
        forge,
        marker: read =>
          dependencies.getReceipt(seenMarkerId(sourceInstanceId, openedSeenMarker(read))),
      });
      let observation: SourceObservation;
      try {
        observation = sourceObservationSchema.parse(
          await plugin.observe({
            waits,
            labels,
            openedIssues: openedPass.handed,
            forge: openedPass.forge,
          })
        );
      } catch (error) {
        log.error(
          { err: error as Error, sourceInstanceId, stage: 'observe' },
          'webhook_source_failed'
        );
        throw new Error(`Webhook source '${sourceInstanceId}' failed to observe waits`, {
          cause: error,
        });
      }
      const result: SourceObservationAdmitted = {
        admitted: [],
        conflicts: 0,
        unserved: observation.unserved,
        failures: [
          ...observation.failed.map(
            ({ wait, reason }) =>
              `wait '${wait.event}' about '${wait.about}' on item '${wait.itemKey}': ${reason}`
          ),
          ...observation.labelFailures.map(
            ({ bindingId, label, number, reason }) =>
              `binding '${bindingId}' label '${label}'${number === undefined ? '' : ` on issue ${String(number)}`}: ${reason}`
          ),
          ...observation.openedIssueFailures.map(
            ({ bindingId, reason }) => `binding '${bindingId}' opened issues: ${reason}`
          ),
        ],
      };
      const record = async (acceptance: SourceReceiptAcceptance): Promise<void> => {
        try {
          const admitted = await admit(sourceInstanceId, acceptance);
          if (admitted.outcome === 'conflict') result.conflicts += 1;
          else result.admitted.push({ receiptId: admitted.receiptId, replay: admitted.replay });
        } catch (error) {
          result.failures.push(causeChain(error));
        }
      };
      for (const acceptance of observation.acceptances) await record(acceptance);
      for (const { acceptance } of observation.labelAcceptances) await record(acceptance);
      // A read is seen after its first pass even when some of that pass's reads failed: the
      // marker's time is the cutoff, and a label added after it starts on a later pass. An
      // issue whose read failed is compared with the same cutoff when it reads, so a label
      // it already carried still starts nothing.
      const markers = [
        ...labels
          .filter(read => read.seenSince === null)
          .map(read => ({
            deliveryId: labelSeenMarker(read),
            reason: 'label binding first observed',
          })),
        ...openedPass.unseen.map(read => ({
          deliveryId: openedSeenMarker(read),
          reason: 'opened-issue binding first observed',
        })),
      ];
      for (const marker of markers)
        await record(seenMarkerAcceptance(sourceInstanceId, marker, passStartedAt));
      // A clean pass read every issue opened since each read's `since`.
      openedPass.settle(result.failures.length === 0);
      return result;
    },
  };
}

/** An error's message with its causes', for the operator who reads the pass's report. */
function causeChain(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current !== undefined; ) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(': ');
}

/** The store reads an observation pass makes. */
export type ItemWaitObserverStore = Pick<
  IWorkflowStore,
  'listOpenItemWaits' | 'getItem' | 'getWorkflowRun' | 'getCodebase'
>;

/** One source's part of an observation pass. */
export interface ObservedSourceReport {
  source: string;
  /** The open waits passed to the source. */
  waits: number;
  /** The label reads passed to the source: one repository and label each. */
  labels: number;
  /** The opened-issue reads the source declares: one binding and repository each. */
  openedIssues: number;
  /**
   * The forge reads the source made: a commit's checks, a pull request's reviews, a label's
   * open items, when a label was added to one issue, or a repository's opened issues, each. An add answered from what this
   * process remembers of an unchanged issue is not a read.
   */
  reads: number;
  /** Receipts first recorded by this pass; a replay of an earlier pass is not one. */
  receipts: string[];
  /**
   * Receipts this pass observed again that an earlier pass, or an earlier process, recorded,
   * such as a label still on its item. They start nothing new, but a start one recorded may
   * still be waiting for capacity on its host.
   */
  replayed: string[];
  conflicts: number;
  unserved: SourceObservation['unserved'];
  /** The bindings the source declared it cannot observe, of any kind. */
  unservedBindings: readonly UnservedBinding[];
  error?: string;
}

export interface ItemWaitObserver {
  readonly observing: readonly ObservingSource[];
  /**
   * Observe the open waits and the declared label and opened-issue reads through each source
   * whose interval has passed since it last observed. Calls no source, so reads nothing from
   * the forge for it, when no wait is open and it declares no read; such a source is
   * reported only when it has bindings it cannot observe. A pass started while another runs
   * returns nothing.
   */
  pass(now: Date): Promise<ObservedSourceReport[]>;
}

/**
 * The observer for `sources`, or `undefined` when no source declares `observe`: an install
 * that receives its events by webhook observes nothing.
 */
export function createItemWaitObserver(input: {
  sources: WebhookSourcePluginHost;
  store: ItemWaitObserverStore;
  forge: SourceForgeReader;
}): ItemWaitObserver | undefined {
  const { sources, store, forge } = input;
  if (sources.observing.length === 0) return undefined;
  const lastObserved = new Map<string, number>();
  // The forge's last answer naming when a label was added to an issue, with the issue's
  // `updatedAt` from the list it was read for. A later label add bumps `updatedAt`, so an
  // unchanged value means the answer is unchanged: replaying it rebuilds the same delivery,
  // which admission records as a replay. Only this process remembers, so its first pass
  // still reads every listed item. Entries leave when their item leaves the list or changes.
  // Keyed by source, repository and label, then by the item's kind and number.
  const labelAddedMemo = new Map<
    string,
    Map<string, { updatedAt: string; answer: Awaited<ReturnType<SourceForgeReader['labelAdded']>> }>
  >();
  // Each unserved wait is logged once per process, not on every pass.
  const warned = new Set<string>();
  const seenOverdue = new Set<string>();
  const backoff = new Map<string, { failures: number; retryAt: number }>();
  let running = false;

  const ready = (source: ObservingSource, now: Date): boolean => {
    const held = backoff.get(source.sourceInstanceId);
    if (held !== undefined && now.getTime() < held.retryAt) return false;
    const last = lastObserved.get(source.sourceInstanceId);
    return last === undefined || now.getTime() - last >= source.everySeconds * 1000;
  };

  const settleBackoff = (source: ObservingSource, now: Date, temporary: boolean): void => {
    if (!temporary) {
      backoff.delete(source.sourceInstanceId);
      return;
    }
    const next = nextBackoff(
      backoff.get(source.sourceInstanceId)?.failures ?? 0,
      source.everySeconds,
      now.getTime()
    );
    backoff.set(source.sourceInstanceId, next);
    log.warn(
      { sourceInstanceId: source.sourceInstanceId, retryAt: new Date(next.retryAt).toISOString() },
      'source_observe_backoff'
    );
  };

  const openWaits = async (
    now: Date
  ): Promise<{
    active: ObservedItemWait[];
    overdue: Array<{ wait: ObservedItemWait; deadlineAt: string }>;
  }> => {
    const remotes = new Map<string, Promise<string | null>>();
    const remoteOf = async (runId: string): Promise<string | null> => {
      const run = await store.getWorkflowRun(runId);
      if (run?.codebase_id == null) return null;
      const { codebase_id: codebaseId } = run;
      const remote =
        remotes.get(codebaseId) ??
        store.getCodebase(codebaseId).then(codebase => codebase?.repository_url ?? null);
      remotes.set(codebaseId, remote);
      return remote;
    };
    const active = new Map<string, ObservedItemWait>();
    const overdue: Array<{ wait: ObservedItemWait; deadlineAt: string }> = [];
    const nowTime = now.getTime();
    for (const wait of await store.listOpenItemWaits()) {
      const item = await store.getItem(wait.itemId);
      if (item === null) continue;
      const observed = {
        workflowName: wait.workflowName,
        event: wait.event,
        about: wait.about,
        subject: wait.subject,
        itemKey: item.key,
        remote: await remoteOf(wait.runId),
      };
      // Partition by deadline: deadlineAt <= now means overdue
      const deadlineTime = new Date(wait.deadlineAt).getTime();
      if (deadlineTime <= nowTime) {
        overdue.push({ wait: observed, deadlineAt: wait.deadlineAt });
      } else {
        active.set(JSON.stringify(observed), observed);
      }
    }
    return { active: [...active.values()], overdue };
  };

  const warnUnserved = (sourceInstanceId: string, bindings: readonly UnservedBinding[]): void => {
    for (const { bindingId, reason } of bindings) {
      const key = JSON.stringify([sourceInstanceId, bindingId, reason]);
      if (warned.has(key)) continue;
      warned.add(key);
      log.warn({ sourceInstanceId, bindingId, reason }, 'source_observe_unserved');
    }
  };

  const observeSource = async (
    source: ObservingSource,
    waits: readonly ObservedItemWait[]
  ): Promise<{ report: ObservedSourceReport; temporary: boolean }> => {
    // The forge is asked only about what an open wait names: the item's invariant, held
    // here at the boundary rather than trusted to each plugin. A pull request is named when a
    // wait in that repository names it as its subject, or, for a wait that names none, when
    // its number ends the key of the wait's item. How the number is read from the key is the
    // binding's own mapping, which only the plugin knows; any prefix-and-number mapping
    // leaves the number at the end, so this holds for each.
    const commits = new Set(waits.map(wait => JSON.stringify([wait.remote, wait.about])));
    const namesPullRequest = (remote: string, number: number): boolean =>
      waits.some(
        wait =>
          wait.remote === remote &&
          (wait.subject === null
            ? wait.itemKey.endsWith(String(number))
            : wait.subject.kind === 'pr' && wait.subject.number === number)
      );
    // A label list must be one a declared read names, and a label-added read must be of an
    // issue or pull request such a list returned in this pass, as the kind it was listed as.
    const labelReads = new Set(
      source.labels.map(entry => JSON.stringify([entry.repo.host, entry.repo.path, entry.label]))
    );
    // The items each label list returned in this pass, by kind and number, with their
    // `updatedAt`. Some forges number issues and pull requests apart, so both name an item.
    const listed = new Map<string, Map<string, string | undefined>>();
    const itemOf = (kind: string, number: number): string => `${kind} ${String(number)}`;
    const read = new Set<string>();
    const listKey = (host: string, path: string, label: string): string =>
      JSON.stringify([source.sourceInstanceId, host, path, label]);
    let stopped = false;
    let temporary = false;
    const call = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
      if (stopped) throw new Error('forge reads paused after a temporary failure');
      read.add(key);
      try {
        return await run();
      } catch (error) {
        if (isTemporaryForgeFailure(error)) {
          stopped = true;
          temporary = true;
        }
        throw error;
      }
    };
    const guarded: SourceForgeReader = {
      commitChecks: async request => {
        const key = JSON.stringify(['commit', request.remote, request.revision]);
        if (!commits.has(JSON.stringify([request.remote, request.revision])))
          throw new Error(`No open wait names commit '${request.revision}' of '${request.remote}'`);
        return call(key, () => forge.commitChecks(request));
      },
      prReviews: async request => {
        const key = JSON.stringify(['pr', request.remote, String(request.number)]);
        if (!namesPullRequest(request.remote, request.number))
          throw new Error(
            `No open wait is on pull request ${String(request.number)} of '${request.remote}'`
          );
        return call(key, () => forge.prReviews(request));
      },
      issuesWithLabel: async request => {
        const { host, path } = request.repo;
        const named = JSON.stringify([host, path, request.label]);
        if (!labelReads.has(named))
          throw new Error(
            `No binding of this source names label '${request.label}' in '${host}/${path}'`
          );
        const result = await call(JSON.stringify(['label', host, path, request.label]), () =>
          forge.issuesWithLabel({ repo: { host, path }, label: request.label })
        );
        const key = listKey(host, path, request.label);
        const items = listed.get(key) ?? new Map<string, string | undefined>();
        for (const item of result.items)
          items.set(itemOf(item.kind, item.ref.number), item.updatedAt);
        listed.set(key, items);
        const memo = labelAddedMemo.get(key);
        if (memo !== undefined)
          for (const [item, entry] of memo)
            if (items.get(item) !== entry.updatedAt) memo.delete(item);
        return result;
      },
      labelAdded: async request => {
        const { host, path } = request.repo;
        const key = listKey(host, path, request.label);
        const item = itemOf(request.kind, request.number);
        const items = listed.get(key);
        if (items?.has(item) !== true)
          throw new Error(
            `${request.kind === 'pr' ? 'Pull request' : 'Issue'} ${String(request.number)} of '${host}/${path}' was not listed with label '${request.label}' in this pass`
          );
        // A remembered answer is not a forge read, so it does not count in `reads`.
        const updatedAt = items.get(item);
        const remembered = labelAddedMemo.get(key)?.get(item);
        if (updatedAt !== undefined && remembered?.updatedAt === updatedAt)
          return remembered.answer;
        const answer = await call(
          JSON.stringify(['label-added', host, path, request.label, item]),
          () =>
            forge.labelAdded({
              repo: { host, path },
              kind: request.kind,
              number: request.number,
              label: request.label,
            })
        );
        // An answer that names no add is not kept: the event can become readable after the
        // label shows in the list, with no change to `updatedAt` to say so.
        if (updatedAt !== undefined && answer.added !== null) {
          const memo = labelAddedMemo.get(key) ?? new Map();
          memo.set(item, { updatedAt, answer });
          labelAddedMemo.set(key, memo);
        }
        return answer;
      },
      issuesOpened: guardedOpenedLists(source.openedIssues, forge, key => read.add(key)),
    };
    const report = (
      admitted: SourceObservationAdmitted | undefined,
      error?: string
    ): ObservedSourceReport => ({
      source: source.sourceInstanceId,
      waits: waits.length,
      labels: source.labels.length,
      openedIssues: source.openedIssues.length,
      reads: read.size,
      receipts: (admitted?.admitted ?? [])
        .filter(receipt => !receipt.replay)
        .map(receipt => receipt.receiptId),
      replayed: (admitted?.admitted ?? [])
        .filter(receipt => receipt.replay)
        .map(receipt => receipt.receiptId),
      conflicts: admitted?.conflicts ?? 0,
      unserved: admitted?.unserved ?? [],
      unservedBindings: source.unservedBindings,
      ...(error === undefined ? {} : { error }),
    });
    let result: ObservedSourceReport;
    try {
      const admitted = await sources.observe(source.sourceInstanceId, waits, guarded);
      result = report(
        admitted,
        admitted.failures.length === 0 ? undefined : admitted.failures.join('; ')
      );
    } catch (error) {
      result = report(undefined, causeChain(error));
    }
    // Logged here so a server, which prints no report, still says why a wait is not met.
    const { sourceInstanceId } = source;
    if (result.error !== undefined)
      log.error({ sourceInstanceId, error: result.error }, 'source_observe_failed');
    for (const { wait, reason } of result.unserved) {
      const key = JSON.stringify([sourceInstanceId, wait, reason]);
      if (warned.has(key)) continue;
      warned.add(key);
      log.warn({ sourceInstanceId, ...wait, reason }, 'source_observe_unserved');
    }
    warnUnserved(sourceInstanceId, result.unservedBindings);
    return { report: result, temporary };
  };

  /** The report of a source that is not called: only the bindings it cannot observe. */
  const unobserved = (source: ObservingSource): ObservedSourceReport => {
    warnUnserved(source.sourceInstanceId, source.unservedBindings);
    return {
      source: source.sourceInstanceId,
      waits: 0,
      labels: 0,
      openedIssues: 0,
      reads: 0,
      receipts: [],
      replayed: [],
      conflicts: 0,
      unserved: [],
      unservedBindings: source.unservedBindings,
    };
  };

  const readSource = async (
    source: ObservingSource,
    waits: readonly ObservedItemWait[],
    overdue: readonly { wait: ObservedItemWait; deadlineAt: string }[],
    now: Date
  ): Promise<ObservedSourceReport | undefined> => {
    const due = freshOverdue(source.sourceInstanceId, source.wakes, overdue, seenOverdue);
    for (const { wait, deadlineAt } of due)
      log.warn({ ...wait, deadlineAt }, 'source_observe_overdue');
    const fresh = due.map(({ wait, deadlineAt }) => ({
      wait,
      reason: `deadline passed at ${deadlineAt}; read once more, polling stopped`,
    }));
    // A wait just found overdue is read one last time: what happened between the previous
    // pass and its deadline, such as the last check finishing, still meets it. Later passes
    // in this process do not read it.
    const read = [...waits, ...due.map(({ wait }) => wait)];
    const idle =
      read.length === 0 && source.labels.length === 0 && source.openedIssues.length === 0;
    if (idle && source.unservedBindings.length === 0 && fresh.length === 0) return undefined;
    lastObserved.set(source.sourceInstanceId, now.getTime());
    if (idle) {
      settleBackoff(source, now, false);
      const report = unobserved(source);
      if (fresh.length > 0) report.unserved = fresh;
      return report;
    }
    const observed = await observeSource(source, read);
    settleBackoff(source, now, observed.temporary);
    const report = observed.report;
    if (fresh.length > 0) report.unserved = [...report.unserved, ...fresh];
    return report;
  };

  return {
    observing: sources.observing,
    async pass(now) {
      if (running) return [];
      const due = sources.observing.filter(source => ready(source, now));
      if (due.length === 0) return [];
      running = true;
      try {
        const { active: waits, overdue } = await openWaits(now);
        const reports: ObservedSourceReport[] = [];
        for (const source of due) {
          const report = await readSource(source, waits, overdue, now);
          if (report !== undefined) reports.push(report);
        }
        return reports;
      } finally {
        running = false;
      }
    },
  };
}
