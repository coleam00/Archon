/**
 * The installed source plugins (the file `ARCHON_WEBHOOK_SOURCES` names) and the two ways
 * their events reach the engine: a webhook delivery (`receive`) and, for a source that
 * declares `observe`, a pass over the open item waits (`createItemWaitObserver`). Both
 * admit through the same `admit`, so an observed event is recorded, deduplicated and
 * matched against the waits exactly as a delivered one is. Loaded by the server and by
 * `archon workflow wake`, which is why it lives here and not in the server.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from '@hono/zod-openapi';
import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import { createLogger } from '@archon/paths';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import type {
  ObservedItemWait,
  SourceForgeReader,
  SourceObservation,
  WebhookSourcePlugin,
  WebhookSourcePluginFactory,
  WebhookSourceRequest,
} from '@archon/workflows/webhook-source-plugin';
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

/** A source that observes the open waits, and how often. */
export interface ObservingSource {
  sourceInstanceId: string;
  everySeconds: number;
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

export async function loadWebhookSourcePlugins(
  configPath: string,
  dependencies: WebhookSourceHostDependencies
): Promise<WebhookSourcePluginHost> {
  let parsed: z.infer<typeof sourceConfigSchema>;
  try {
    parsed = sourceConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  } catch (error) {
    log.error({ err: error as Error, stage: 'config' }, 'webhook_source_load_failed');
    throw new Error('Webhook source configuration is invalid', { cause: error });
  }
  const plugins = new Map<string, WebhookSourcePlugin>();
  const observing: ObservingSource[] = [];

  for (const source of parsed.sources) {
    if (plugins.has(source.sourceInstanceId)) {
      throw new Error(`Duplicate webhook source instance '${source.sourceInstanceId}'`);
    }
    if (!isAbsolute(source.module)) {
      throw new Error(`Webhook source module for '${source.sourceInstanceId}' must be absolute`);
    }
    let loaded: unknown;
    try {
      loaded = await import(pathToFileURL(source.module).href);
    } catch (error) {
      log.error(
        { err: error as Error, sourceInstanceId: source.sourceInstanceId, stage: 'import' },
        'webhook_source_load_failed'
      );
      throw new Error(`Webhook source '${source.sourceInstanceId}' could not be loaded`, {
        cause: error,
      });
    }
    const factory = (loaded as { default?: unknown }).default;
    if (typeof factory !== 'function') {
      throw new Error(
        `Webhook source module for '${source.sourceInstanceId}' has no default factory`
      );
    }
    let plugin: unknown;
    try {
      plugin = await (factory as (input: Parameters<WebhookSourcePluginFactory>[0]) => unknown)({
        sourceInstanceId: source.sourceInstanceId,
        config: source.config,
      });
    } catch (error) {
      log.error(
        { err: error as Error, sourceInstanceId: source.sourceInstanceId, stage: 'factory' },
        'webhook_source_load_failed'
      );
      throw new Error(`Webhook source '${source.sourceInstanceId}' factory failed`, {
        cause: error,
      });
    }
    if (!isWebhookSourcePlugin(plugin)) {
      throw new Error(
        `Webhook source module for '${source.sourceInstanceId}' returned no receiver`
      );
    }
    if (source.observe !== undefined) {
      if (typeof plugin.observe !== 'function')
        throw new Error(
          `Webhook source '${source.sourceInstanceId}' declares observe, but its plugin cannot observe waits`
        );
      observing.push({
        sourceInstanceId: source.sourceInstanceId,
        everySeconds: source.observe.everySeconds,
      });
    }
    plugins.set(source.sourceInstanceId, plugin);
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
      if (
        !observing.some(source => source.sourceInstanceId === sourceInstanceId) ||
        !plugin.observe
      )
        throw new Error(`Webhook source '${sourceInstanceId}' does not observe waits`);
      let observation: SourceObservation;
      try {
        observation = sourceObservationSchema.parse(await plugin.observe({ waits, forge }));
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
        failures: [],
      };
      for (const acceptance of observation.acceptances) {
        try {
          const admitted = await admit(sourceInstanceId, acceptance);
          if (admitted.outcome === 'conflict') result.conflicts += 1;
          else result.admitted.push({ receiptId: admitted.receiptId, replay: admitted.replay });
        } catch (error) {
          result.failures.push(causeChain(error));
        }
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
  'listOpenItemWaits' | 'getWorkflowRun' | 'getCodebase'
>;

/** One source's part of an observation pass. */
export interface ObservedSourceReport {
  source: string;
  /** The open waits passed to the source. */
  waits: number;
  /** The commits whose checks the source read. */
  commits: number;
  /** Receipts first recorded by this pass; a replay of an earlier pass is not one. */
  receipts: string[];
  conflicts: number;
  unserved: SourceObservation['unserved'];
  error?: string;
}

export interface ItemWaitObserver {
  readonly observing: readonly ObservingSource[];
  /**
   * Observe the open waits through each source whose interval has passed since it last
   * observed. Reads nothing from the forge, and calls no source, when no wait is open.
   * A pass started while another runs returns nothing.
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
      const observed = {
        workflowName: wait.workflowName,
        event: wait.event,
        about: wait.about,
        remote: await remoteOf(wait.runId),
      };
      waits.set(JSON.stringify(observed), observed);
    }
    return [...waits.values()];
  };

  const observeSource = async (
    source: ObservingSource,
    waits: readonly ObservedItemWait[]
  ): Promise<ObservedSourceReport> => {
    // The forge is asked only about a commit an open wait names: the item's invariant, held
    // here at the boundary rather than trusted to each plugin.
    const named = new Set(waits.map(wait => JSON.stringify([wait.remote, wait.about])));
    const read = new Set<string>();
    const guarded: SourceForgeReader = {
      commitChecks: async request => {
        const key = JSON.stringify([request.remote, request.revision]);
        if (!named.has(key))
          throw new Error(`No open wait names commit '${request.revision}' of '${request.remote}'`);
        read.add(key);
        return forge.commitChecks(request);
      },
    };
    const report = (
      admitted: SourceObservationAdmitted | undefined,
      error?: string
    ): ObservedSourceReport => ({
      source: source.sourceInstanceId,
      waits: waits.length,
      commits: read.size,
      receipts: (admitted?.admitted ?? [])
        .filter(receipt => !receipt.replay)
        .map(receipt => receipt.receiptId),
      conflicts: admitted?.conflicts ?? 0,
      unserved: admitted?.unserved ?? [],
      ...(error === undefined ? {} : { error }),
    });
    try {
      const admitted = await sources.observe(source.sourceInstanceId, waits, guarded);
      return report(
        admitted,
        admitted.failures.length === 0 ? undefined : admitted.failures.join('; ')
      );
    } catch (error) {
      log.error(
        { err: error as Error, sourceInstanceId: source.sourceInstanceId },
        'source_observe_failed'
      );
      return report(undefined, causeChain(error));
    }
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
        if (waits.length === 0) return [];
        const reports: ObservedSourceReport[] = [];
        for (const source of due) {
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
