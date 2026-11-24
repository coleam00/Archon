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
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from '@hono/zod-openapi';
import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import type { StartReceiptInspection } from '@archon/workflows/resource-start-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import { createLogger } from '@archon/paths';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import type {
  ObservedItemWait,
  ObservedLabelRead,
  SourceForgeReader,
  SourceObservation,
  WebhookSourcePlugin,
  WebhookSourcePluginFactory,
  WebhookSourceRequest,
} from '@archon/workflows/webhook-source-plugin';
import {
  observedLabelsSchema,
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

/** A label binding a source cannot observe, with why. */
export interface UnservedBinding {
  bindingId: string;
  reason: string;
}

/**
 * A source that observes, how often, and the label reads its bindings name. The reads are
 * fixed when the plugin loads; a pass lists only these.
 */
export interface ObservingSource {
  sourceInstanceId: string;
  everySeconds: number;
  labels: readonly ObservedLabelRead[];
  unservedBindings: readonly UnservedBinding[];
}

/**
 * The delivery id of the receipt that says a label read has been observed once, so the
 * labels already on issues then are recorded as seen and only a later add starts. A
 * persisted contract: changing it makes every label binding a first sight again.
 */
function labelSeenMarker(read: ObservedLabelRead): string {
  return `observe:label-seen:${read.bindingId}:${read.repo.host}/${read.repo.path}:${read.label}`;
}

/**
 * The receipt id of a read's seen marker, derived from the source and the marker's delivery
 * id so a pass can read the marker, and its time, by id. A persisted contract as the
 * delivery id is. Shaped as a version 8 UUID, the version for ids built this way.
 */
function labelSeenMarkerId(sourceInstanceId: string, read: ObservedLabelRead): string {
  const hex = createHash('sha256')
    .update(`${sourceInstanceId}\n${labelSeenMarker(read)}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

/** What is wrong with a source configuration, by field for a schema failure. */
function configProblems(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues
      .map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
  return error instanceof Error ? error.message : String(error);
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

/** The label reads a loaded plugin declares, checked once so a malformed one fails the load. */
function declaredLabels(
  sourceInstanceId: string,
  plugin: WebhookSourcePlugin
): Pick<ObservingSource, 'labels' | 'unservedBindings'> {
  const parsed = observedLabelsSchema.safeParse(plugin.observedLabels ?? { reads: [] });
  if (!parsed.success)
    throw new Error(
      `Webhook source '${sourceInstanceId}' declares invalid label reads: ${configProblems(parsed.error)}`
    );
  return { labels: parsed.data.reads, unservedBindings: parsed.data.unserved };
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
        ...declaredLabels(source.sourceInstanceId, plugin),
      });
  }

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
        const marker = await dependencies.getReceipt(labelSeenMarkerId(sourceInstanceId, read));
        labels.push({ ...read, seenSince: marker === null ? null : marker.occurredAt });
      }
      let observation: SourceObservation;
      try {
        observation = sourceObservationSchema.parse(await plugin.observe({ waits, labels, forge }));
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
        ],
      };
      const record = async (acceptance: SourceReceiptAcceptance): Promise<boolean> => {
        try {
          const admitted = await admit(sourceInstanceId, acceptance);
          if (admitted.outcome === 'conflict') result.conflicts += 1;
          else result.admitted.push({ receiptId: admitted.receiptId, replay: admitted.replay });
          return admitted.outcome === 'accepted';
        } catch (error) {
          result.failures.push(causeChain(error));
          return false;
        }
      };
      for (const acceptance of observation.acceptances) await record(acceptance);
      // A read is seen once every issue it listed is recorded: no read of it failed and each
      // of its acceptances was admitted. Another read's failure does not hold it back. Until
      // then the next pass sees it for the first time again, which is safe because that
      // records only unmatched receipts; an issue whose read failed must not start later as
      // though its label were new.
      const unrecorded = new Set(
        observation.labelFailures.map(({ bindingId, label }) => JSON.stringify([bindingId, label]))
      );
      for (const { bindingId, label, acceptance } of observation.labelAcceptances)
        if (!(await record(acceptance))) unrecorded.add(JSON.stringify([bindingId, label]));
      for (const read of labels) {
        if (read.seenSince !== null || unrecorded.has(JSON.stringify([read.bindingId, read.label])))
          continue;
        const deliveryId = labelSeenMarker(read);
        await record({
          receipt: {
            id: labelSeenMarkerId(sourceInstanceId, read),
            sourceInstanceId,
            deliveryId,
            contentDigest: createHash('sha256').update(deliveryId).digest('hex'),
            receivedAt: new Date().toISOString(),
            // The cutoff later passes compare a label's add with: when this pass began.
            occurredAt: passStartedAt,
            sourceActor: null,
          },
          outcome: 'unmatched',
          reason: 'label binding first observed',
          bindings: [],
        });
      }
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
  /**
   * The forge reads the source made: a commit's checks, a pull request's reviews, a label's
   * open items, or when a label was added to one issue, each. An add answered from what this
   * process remembers of an unchanged issue is not a read.
   */
  reads: number;
  /** Receipts first recorded by this pass; a replay of an earlier pass is not one. */
  receipts: string[];
  conflicts: number;
  unserved: SourceObservation['unserved'];
  /** The label bindings the source declared it cannot observe. */
  unservedBindings: readonly UnservedBinding[];
  error?: string;
}

export interface ItemWaitObserver {
  readonly observing: readonly ObservingSource[];
  /**
   * Observe the open waits and the declared label reads through each source whose interval
   * has passed since it last observed. Calls no source, so reads nothing from the forge for
   * it, when no wait is open and it declares no label read; such a source is reported only
   * when it has label bindings it cannot observe. A pass started while another runs
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
  // The forge's last answer to when a label was added to an issue, with the issue's
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
  let running = false;

  const openWaits = async (): Promise<ObservedItemWait[]> => {
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
    const waits = new Map<string, ObservedItemWait>();
    for (const wait of await store.listOpenItemWaits()) {
      const item = await store.getItem(wait.itemId);
      if (item === null) continue;
      const observed = {
        workflowName: wait.workflowName,
        event: wait.event,
        about: wait.about,
        itemKey: item.key,
        remote: await remoteOf(wait.runId),
      };
      waits.set(JSON.stringify(observed), observed);
    }
    return [...waits.values()];
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
  ): Promise<ObservedSourceReport> => {
    // The forge is asked only about what an open wait names: the item's invariant, held
    // here at the boundary rather than trusted to each plugin. A pull request is named when
    // its number ends the key of an item a wait is on in that repository. How the number is
    // read from the key is the binding's own mapping, which only the plugin knows; any
    // prefix-and-number mapping leaves the number at the end, so this holds for each.
    const commits = new Set(waits.map(wait => JSON.stringify([wait.remote, wait.about])));
    const namesPullRequest = (remote: string, number: number): boolean =>
      waits.some(wait => wait.remote === remote && wait.itemKey.endsWith(String(number)));
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
    const guarded: SourceForgeReader = {
      commitChecks: async request => {
        const key = JSON.stringify(['commit', request.remote, request.revision]);
        if (!commits.has(JSON.stringify([request.remote, request.revision])))
          throw new Error(`No open wait names commit '${request.revision}' of '${request.remote}'`);
        read.add(key);
        return forge.commitChecks(request);
      },
      prReviews: async request => {
        const key = JSON.stringify(['pr', request.remote, String(request.number)]);
        if (!namesPullRequest(request.remote, request.number))
          throw new Error(
            `No open wait is on pull request ${String(request.number)} of '${request.remote}'`
          );
        read.add(key);
        return forge.prReviews(request);
      },
      issuesWithLabel: async request => {
        const { host, path } = request.repo;
        const named = JSON.stringify([host, path, request.label]);
        if (!labelReads.has(named))
          throw new Error(
            `No binding of this source names label '${request.label}' in '${host}/${path}'`
          );
        read.add(JSON.stringify(['label', host, path, request.label]));
        const result = await forge.issuesWithLabel({ repo: { host, path }, label: request.label });
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
        read.add(JSON.stringify(['label-added', host, path, request.label, item]));
        const answer = await forge.labelAdded({
          repo: { host, path },
          kind: request.kind,
          number: request.number,
          label: request.label,
        });
        if (updatedAt !== undefined) {
          const memo = labelAddedMemo.get(key) ?? new Map();
          memo.set(item, { updatedAt, answer });
          labelAddedMemo.set(key, memo);
        }
        return answer;
      },
    };
    const report = (
      admitted: SourceObservationAdmitted | undefined,
      error?: string
    ): ObservedSourceReport => ({
      source: source.sourceInstanceId,
      waits: waits.length,
      labels: source.labels.length,
      reads: read.size,
      receipts: (admitted?.admitted ?? [])
        .filter(receipt => !receipt.replay)
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
    return result;
  };

  /** The report of a source that is not called: only the label bindings it cannot observe. */
  const unobserved = (source: ObservingSource): ObservedSourceReport => {
    warnUnserved(source.sourceInstanceId, source.unservedBindings);
    return {
      source: source.sourceInstanceId,
      waits: 0,
      labels: 0,
      reads: 0,
      receipts: [],
      conflicts: 0,
      unserved: [],
      unservedBindings: source.unservedBindings,
    };
  };

  return {
    observing: sources.observing,
    async pass(now) {
      if (running) return [];
      const due = sources.observing.filter(source => {
        const last = lastObserved.get(source.sourceInstanceId);
        return last === undefined || now.getTime() - last >= source.everySeconds * 1000;
      });
      if (due.length === 0) return [];
      running = true;
      try {
        const waits = await openWaits();
        const reports: ObservedSourceReport[] = [];
        for (const source of due) {
          // A source with nothing to observe is not called, so it reads nothing; the label
          // bindings it cannot observe are still reported, so the operator learns why.
          if (waits.length === 0 && source.labels.length === 0) {
            if (source.unservedBindings.length === 0) continue;
            lastObserved.set(source.sourceInstanceId, now.getTime());
            reports.push(unobserved(source));
            continue;
          }
          lastObserved.set(source.sourceInstanceId, now.getTime());
          reports.push(await observeSource(source, waits));
        }
        return reports;
      } finally {
        running = false;
      }
    },
  };
}
