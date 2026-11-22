import { createRunResourceRelease } from '../services/cleanup/run-verification-images';
/**
 * WorkflowStore adapter — bridges @archon/core DB modules to the
 * IWorkflowStore trait defined in @archon/workflows.
 */
import { createSqlStateDocumentStore } from '../db/state-documents';
import { getDatabase } from '../db/connection';
import { providerRegistry } from '@archon/providers';
import type { StoredCredentialKind } from '@archon/provider-contract';
import {
  WorkflowEventCursorError,
  type WorkflowEventCursor,
  type WorkflowEventPage,
  type IWorkflowStore,
  type WorkflowStoreKind,
} from '@archon/workflows/store';
import type { WorkflowConfig, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import type { HeldItemStart } from '@archon/workflows/resource-start-store';
import type { MergedConfig } from '../config/config-types';
import * as itemsDb from '../db/items';
import * as itemLinksDb from '../db/item-links';
import * as itemRulingsDb from '../db/item-rulings';
import * as itemMergesDb from '../db/item-merges';
import * as itemLandingsDb from '../db/item-landings';
import * as itemAsksDb from '../db/item-asks';
import * as itemWaitsDb from '../db/item-waits';
import * as workflowDb from '../db/workflows';
import * as resourceStarts from '../db/resource-starts';
import { acceptStartReceipt } from '../db/start-receipt-writes';
import { updateWorkflowRunMetadataIfPending } from '../db/workflow-run-writes';
import * as installHold from '../db/install-hold';
import { toHydratedTimestamp } from '../db/timestamps';
import * as workflowEventDb from '../db/workflow-events';
import { listMetricRecords } from '../db/workflow-metrics';
import { listAttentionWaitStarts, listWorkflowNoticeRows } from '../db/attention-wait-starts';
import * as workflowNodeSessionDb from '../db/workflow-node-sessions';
import {
  listWorkflowRunNodeSessions,
  upsertWorkflowRunNodeSession,
} from '../db/workflow-run-node-sessions';
import * as codebaseDb from '../db/codebases';
import * as isolationEnvironmentsDb from '../db/isolation-environments';
import type { IIsolationStore } from '@archon/isolation';
import * as envVarDb from '../db/env-vars';
import { getAgentProvider } from '../services/provider-admission';
import type { WorktreeOwnershipReaders } from '../services/cleanup/run-worktree';
import { loadConfig as loadMergedConfig } from '../config/config-loader';
import { createLogger } from '@archon/paths';
import {
  createRunEndedPreflight,
  createRunEndedStarts,
  getTriggersPath,
  launchProjectKey,
  type RunEndedStartsDependencies,
} from './run-ended';
import {
  createAsksCheckout,
  createAsksSettledPreflight,
  createAsksSettledStarts,
} from './asks-settled';
import { createEndedCheckout } from './ended-checkout';
import {
  registeredProjectForPath,
  registeredProjectKeyForPath,
} from '../services/codebase-checkout-resolver';
import type { IGitHubAppAuthProvider } from '../github-auth/types';
import { createGitHubAppAuthProvider } from '../github-auth/auth';
import { installGitHubCliShim } from '../github-auth/gh-shim-install';
import { loadGitHubAppConfig, isPerUserGitHubEnabled } from '../github-auth/config';
import { getDecryptedAccessToken, getUserGithubAuthor } from '../db/user-github-token-store';
import { isPerUserProviderKeysEnabled } from '../credentials/config';
import { join } from 'node:path';
import {
  deliverCredential,
  buildPiAuthJson,
  PI_AUTH_JSON_RELATIVE_PATH,
  PI_AUTH_PATH_ENV,
} from '../credentials/delivery';
import {
  listUserProviderKeys,
  getDecryptedProviderCredential,
  getStoredCredentialStatus,
} from '../db/user-provider-key-store';
import { normalizeCredentialVendor } from '@archon/providers';
import { StoredCredentialDeliveryError } from '@archon/workflows/run-preflight';

function hydrateWorkflowEventRow(row: WorkflowEventRow): WorkflowEventRow {
  return { ...row, created_at: toHydratedTimestamp(row.created_at).toISOString() };
}

function sqlCursor(order: string | number): WorkflowEventCursor {
  return `sql:${String(order)}` as WorkflowEventCursor;
}
function sqlCursorOrder(cursor: WorkflowEventCursor): string {
  if (!/^sql:(0|[1-9][0-9]*)$/.test(cursor)) throw new WorkflowEventCursorError();
  const order = cursor.slice(4);
  if (BigInt(order) > 9223372036854775807n) throw new WorkflowEventCursorError();
  return order;
}

async function requiredCredentialRows(
  userId: string,
  vendors: readonly string[]
): Promise<{ vendor: string; provider: string; kind: StoredCredentialKind }[]> {
  const rows = await listUserProviderKeys(userId);
  return vendors.flatMap(vendor => {
    const row =
      rows.find(r => r.provider === vendor) ??
      rows.find(r => normalizeCredentialVendor(r.provider) === vendor);
    return row ? [{ vendor, provider: row.provider, kind: row.kind }] : [];
  });
}

import { getUserAiPrefs, type UserAiPrefs } from '../db/user-ai-prefs-store';
import { sealWorkflowRunConfig, unsealWorkflowRunConfig } from '../config/run-config';

// Compile-time assertion: MergedConfig must remain a structural subtype of WorkflowConfig.
// If MergedConfig drifts from WorkflowConfig, this line becomes a type error.
const assertConfigCompat: WorkflowConfig = {} as MergedConfig;
void assertConfigCompat;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.store-adapter');
  return cachedLog;
}

// The supported OAuth deliveries use access/refresh tokens, while OpenAI also
// writes its OIDC token. Other raw fields are public provider metadata.
const OAUTH_SECRET_FIELDS = ['access', 'refresh', 'id_token'] as const;

function collectOAuthCredentialValues(
  rawCreds: Record<string, unknown>,
  values: Set<string>
): void {
  for (const field of OAUTH_SECRET_FIELDS) {
    const value = rawCreds[field];
    if (typeof value === 'string' && value.length > 0) values.add(value);
  }
}

const launchProjectKeyOf = launchProjectKey(cwd => registeredProjectKeyForPath(cwd, codebaseDb));
const launchProjectOf = (cwd: string) => registeredProjectForPath(cwd, codebaseDb);

/**
 * The held binding starts on item `itemId`: those naming its key whose checkout is in its
 * project. A binding is resolved to a project only when it is prepared, so the checkout
 * decides it here the way it will then.
 */
async function listHeldItemStarts(itemId: string): Promise<HeldItemStart[]> {
  const item = await itemsDb.getItem(itemId);
  if (!item) return [];
  const held: HeldItemStart[] = [];
  for (const start of await installHold.listHeldStarts()) {
    if (start.kind !== 'trigger' || start.itemKey !== item.key || start.cwd === null) continue;
    if ((await launchProjectKeyOf(start.cwd)) !== item.projectKey) continue;
    const { receiptId, bindingId, hostId, workflow, receivedAt } = start;
    held.push({ receiptId, bindingId, hostId, workflow, receivedAt });
  }
  return held;
}

/** Where trigger files with `on` are read from and how a binding is placed in a project. */
function onBindingDeps(
  getItem: IWorkflowStore['getItem']
): Omit<RunEndedStartsDependencies, 'endedCheckout' | 'listItemAsks' | 'now'> {
  return {
    triggersDirectory: getTriggersPath,
    getItem,
    projectKeyOf: launchProjectKeyOf,
  };
}

export function createWorkflowStore(): IWorkflowStore {
  // The close that settles a set writes the starts its asks-settled bindings cause.
  const asksSettledStarts = createAsksSettledStarts({
    ...onBindingDeps(itemsDb.getItem),
    getItemAsk: itemAsksDb.getItemAsk,
  });
  return {
    ...createSqlStateDocumentStore(getDatabase),
    setToolCallAttention: workflowDb.setToolCallAttention,
    getInstallHold: installHold.getInstallHold,
    setInstallHold: installHold.setInstallHold,
    liftInstallHold: installHold.liftInstallHold,
    listHeldStarts: installHold.listHeldStarts,
    listHeldItemStarts,
    admitResourceStart: resourceStarts.admitResourceStart,
    admitPendingRun: resourceStarts.admitPendingRun,
    drainResourceStarts: resourceStarts.drainResourceStarts,
    hasStartReceiptForDelivery: resourceStarts.hasStartReceiptForDelivery,
    acceptStartReceipt: input => acceptStartReceipt(input, launchProjectKeyOf),
    getStartReceipt: resourceStarts.getStartReceipt,
    listStartReceipts: resourceStarts.listStartReceipts,
    listPendingStartBindings: resourceStarts.listPendingStartBindings,
    getResourceStartRequest: resourceStarts.getResourceStartRequest,
    listSkippedItemStarts: resourceStarts.listSkippedItemStarts,
    listWaitedItemHolders: resourceStarts.listWaitedItemHolders,
    listQueuedResourceStartsForHost: resourceStarts.listQueuedResourceStartsForHost,
    listQueuedItemStarts: resourceStarts.listQueuedItemStarts,
    withdrawQueuedResourceStart: resourceStarts.withdrawQueuedResourceStart,
    claimStartBindingPreparation: resourceStarts.claimStartBindingPreparation,
    completeStartBindingPreparation: resourceStarts.completeStartBindingPreparation,
    failStartBindingPreparation: resourceStarts.failStartBindingPreparation,
    resetStartBindingPreparation: resourceStarts.resetStartBindingPreparation,
    resolveApprovalGate: workflowDb.resolveApprovalGate,
    resolveAndCancelApprovalGate: workflowDb.resolveAndCancelApprovalGate,
    cancelResumableRunsForConversation: workflowDb.cancelResumableRunsForConversation,
    deleteWorkflowNodeSessions: workflowNodeSessionDb.deleteWorkflowNodeSessions,
    listWorkflowRuns: workflowDb.listDashboardRuns,
    findOpenWorkRuns: workflowDb.findOpenWorkRuns,
    getItemRuns: itemsDb.getItemRuns,
    getItem: itemsDb.getItem,
    listItemRulings: itemRulingsDb.listItemRulings,
    recordItemRuling: itemRulingsDb.recordItemRuling,
    withdrawItemRuling: itemRulingsDb.withdrawItemRuling,
    listItemsInWindow: itemsDb.listItemsInWindow,
    getItemMerge: itemMergesDb.getItemMerge,
    recordItemMerge: itemMergesDb.recordItemMerge,
    getItemLanding: itemLandingsDb.getItemLanding,
    recordItemLanding: itemLandingsDb.recordItemLanding,
    listItemLinks: itemLinksDb.listItemLinks,
    recordItemLink: itemLinksDb.recordItemLink,
    endItemLink: itemLinksDb.endItemLink,
    listOpenItemAsks: itemAsksDb.listOpenItemAsks,
    listItemAsks: itemAsksDb.listItemAsks,
    getItemAsk: itemAsksDb.getItemAsk,
    answerItemAsk: async input =>
      itemAsksDb.answerItemAsk(input, await asksSettledStarts(input.askId)),
    withdrawItemAsk: async input =>
      itemAsksDb.withdrawItemAsk(input, await asksSettledStarts(input.askId)),
    listOpenItemWaits: itemWaitsDb.listOpenItemWaits,
    withdrawItemWaits: itemWaitsDb.withdrawItemWaits,
    findAdoptingRuns: workflowDb.findAdoptingRuns,
    deleteOldWorkflowRuns: workflowDb.deleteOldWorkflowRuns,
    getWorkflowEventHead: async () => sqlCursor(await workflowEventDb.getWorkflowEventHead()),
    readWorkflowEventsAfter: async (after, { limit, eventTypes }): Promise<WorkflowEventPage> => {
      const order = sqlCursorOrder(after);
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new RangeError('limit must be a positive integer');
      const rows = await workflowEventDb.readWorkflowEventsAfter(order, limit);
      // A returned row proves the cursor is behind the head; only an empty page can hide
      // a cursor this install never issued (another database, a restored backup).
      if (rows.length === 0 && BigInt(order) > BigInt(await workflowEventDb.getWorkflowEventHead()))
        throw new WorkflowEventCursorError();
      const deliveries = rows.map(event => {
        if (event.event_order == null) throw new Error('Feed row has no event order');
        return { cursor: sqlCursor(event.event_order), event: hydrateWorkflowEventRow(event) };
      });
      return {
        events: deliveries.filter(
          ({ event }) =>
            eventTypes === undefined || eventTypes.some(type => type === event.event_type)
        ),
        next: deliveries.at(-1)?.cursor ?? after,
      };
    },
    listWorkflowEvents: async (...args) =>
      (await workflowEventDb.listWorkflowEvents(...args)).map(hydrateWorkflowEventRow),
    listEventsForRuns: async (...args) =>
      new Map(
        [...(await workflowEventDb.listEventsForRuns(...args))].map(([id, rows]) => [
          id,
          rows.map(hydrateWorkflowEventRow),
        ])
      ),
    listMetricRecords,
    findWorkflowRunsByIdPrefix: workflowDb.findWorkflowRunsByIdPrefix,
    createWorkflowRun: workflowDb.createWorkflowRun,
    claimPendingWorkflowRun: workflowDb.claimPendingWorkflowRun,
    recordWorkflowRunCheckoutBaseline: workflowDb.recordWorkflowRunCheckoutBaseline,
    getWorkflowRun: workflowDb.getWorkflowRun,
    getWorkflowRunsByIds: workflowDb.getWorkflowRunsByIds,
    getWorkflowRunForAttention: workflowDb.getWorkflowRunForAttention,
    findChildRuns: workflowDb.findChildRuns,
    getRunAncestry: workflowDb.getRunAncestry,
    getActiveWorkflowRunByPath: workflowDb.getActiveWorkflowRunByPath,
    listDueWorkflowContinuations: (now, limit = 25) =>
      workflowDb.listDueWorkflowContinuations(now, limit),
    deferWorkflowContinuation: workflowDb.deferWorkflowContinuation,
    releaseRunForUnreadableSource: workflowDb.releaseRunForUnreadableSource,
    pauseWorkflowRunForOperator: workflowDb.pauseWorkflowRunForOperator,
    requestOperatorPause: workflowDb.requestOperatorPause,
    answerAttentionWait: workflowDb.answerAttentionWait,
    labelAttentionWait: workflowDb.labelAttentionWait,
    listAttentionQueueRows: () => workflowDb.listAttentionQueueRows(),
    listAttentionWaitStarts,
    listWorkflowNoticeRows,
    signalWorkflowWait: workflowDb.signalWorkflowWait,
    resumeWorkflowRun: workflowDb.resumeWorkflowRun,
    releasePausedRunSlot: workflowDb.releasePausedRunSlot,
    recoverCancelledFanOutRun: workflowDb.recoverCancelledFanOutRun,
    updateWorkflowRun: workflowDb.updateWorkflowRun,
    updateWorkflowRunMetadataIfRunning: workflowDb.updateWorkflowRunMetadataIfRunning,
    updateWorkflowRunMetadataIfPending,
    updateWorkflowActivity: workflowDb.updateWorkflowActivity,
    getWorkflowRunStatus: workflowDb.getWorkflowRunStatus,
    completeWorkflowRun: workflowDb.completeWorkflowRun,
    failWorkflowRun: workflowDb.failWorkflowRun,
    pauseWorkflowRun: workflowDb.pauseWorkflowRun,
    pauseWorkflowRunForWait: workflowDb.pauseWorkflowRunForWait,
    clearWorkflowWaitContext: workflowDb.clearWorkflowWaitContext,
    claimWriteback: workflowDb.claimWriteback,
    releaseWritebackClaim: workflowDb.releaseWritebackClaim,
    cancelWorkflowRun: workflowDb.cancelWorkflowRun,
    cancelFanOutRun: workflowDb.cancelFanOutRun,
    createWorkflowEvent: async (data): Promise<void> => {
      try {
        await workflowEventDb.createWorkflowEvent(data);
      } catch (err) {
        // Belt-and-suspenders: workflowEventDb.createWorkflowEvent already catches internally,
        // but this wrapper guarantees the IWorkflowStore non-throwing contract at the boundary.
        getLog().error(
          { err: err as Error, eventType: data.event_type, runId: data.workflow_run_id },
          'workflow_event_create_unexpected_throw'
        );
      }
    },
    persistWorkflowEvent: workflowEventDb.persistWorkflowEvent,
    persistWorkflowEventIfRunning: workflowEventDb.persistWorkflowEventIfRunning,
    getDagResumeSnapshot: workflowEventDb.getDagResumeSnapshot,
    listProviderEvents: workflowEventDb.listProviderEvents,
    getCodebase: codebaseDb.getCodebase,
    getCodebaseEnvVars: envVarDb.getCodebaseEnvVars,
    listWorkflowNodeSessions: workflowNodeSessionDb.listWorkflowNodeSessions,
    upsertWorkflowNodeSession: workflowNodeSessionDb.upsertWorkflowNodeSession,
    listWorkflowRunNodeSessions,
    upsertWorkflowRunNodeSession,
  };
}

/** One provider cache per process, shared by workflow execution and server adapters. */
let registeredGitHubAppAuthProvider: IGitHubAppAuthProvider | null = null;

export function registerGitHubAppAuthProvider(provider: IGitHubAppAuthProvider | null): void {
  registeredGitHubAppAuthProvider = provider;
}

export function initializeWorkflowGitHubAppAuth(
  env: NodeJS.ProcessEnv = process.env
): IGitHubAppAuthProvider | null {
  if (registeredGitHubAppAuthProvider) return registeredGitHubAppAuthProvider;
  const config = loadGitHubAppConfig(env);
  if (!config) return null;
  const provider = createGitHubAppAuthProvider(config);
  registerGitHubAppAuthProvider(provider);
  return provider;
}

export interface CompletedRunWorktreeTools {
  cleanup: typeof import('../services/cleanup/run-worktree');
  store: IIsolationStore;
  readers: WorktreeOwnershipReaders;
}

/**
 * Wire a host's completed-run worktree release. A failed load is reported as a
 * `check_failed` retention like any other failed check: it runs before the assessment's
 * own catch, and `assess` must not throw.
 */
export function completedRunWorktreeDeps(
  load: () => Promise<CompletedRunWorktreeTools>
): NonNullable<WorkflowDeps['completedRunWorktree']> {
  return {
    assess: async run => {
      let tools: CompletedRunWorktreeTools;
      try {
        tools = await load();
      } catch (err) {
        getLog().warn({ err, workflowRunId: run.id }, 'completed_worktree_load_failed');
        return { disposition: 'retained', reason: 'check_failed', detail: (err as Error).message };
      }
      return tools.cleanup.assessCompletedRunWorktree(run, tools.store, tools.readers);
    },
    release: async run => {
      const { cleanup, store, readers } = await load();
      await cleanup.releaseCompletedRunWorktree(run, store, readers);
    },
  };
}

// Lazy for the same reason as the SQL host's abandon release: the run worktree cleanup
// loads the isolation provider.
const sqlCompletedRunWorktree = completedRunWorktreeDeps(async () => {
  const [cleanup, isolationDb] = await Promise.all([
    import('../services/cleanup/run-worktree'),
    import('../db/isolation-environments'),
  ]);
  return {
    cleanup,
    store: isolationDb.createIsolationStore(),
    readers: {
      getCodebase: codebaseDb.getCodebase,
      getLiveRunOwningEnv: isolationDb.getLiveRunOwningEnv,
    },
  };
});

/**
 * Create the canonical WorkflowDeps for the workflow engine.
 * Single construction point — avoids duplicating the wiring across callers.
 */
export function createWorkflowDeps(
  store: IWorkflowStore = createWorkflowStore(),
  credentialStore: WorkflowStoreKind = 'database'
): Omit<WorkflowDeps, 'loadConfig'> & {
  loadConfig: typeof loadMergedConfig;
} {
  const provider = registeredGitHubAppAuthProvider;
  const onBindings = {
    ...onBindingDeps(id => store.getItem(id)),
    loadConfig: loadMergedConfig,
    providers: providerRegistry,
    projectOf: launchProjectOf,
  };
  const runEndedPreflight = createRunEndedPreflight(onBindings);
  const asksSettledPreflight = createAsksSettledPreflight(onBindings);
  // Only the SQL store records items, so only its runs reach this.
  const endedCheckout = createEndedCheckout({
    findEnvironmentByPath: isolationEnvironmentsDb.findLatestByCodebaseAndWorkingPath,
  });
  return {
    store,
    credentialStore,
    runEndedStarts: createRunEndedStarts({
      ...onBindings,
      endedCheckout,
      listItemAsks: id => store.listItemAsks(id),
    }),
    asksCheckout: createAsksCheckout({
      ...onBindings,
      endedCheckout,
      getRun: id => store.getWorkflowRun(id),
    }),
    // A run is refused before it starts for a broken binding its end or its asks could fire.
    checkRunEndedBindings: async run => {
      await runEndedPreflight(run);
      await asksSettledPreflight(run);
    },
    releaseRunResources: createRunResourceRelease(store),
    providers: providerRegistry,
    getAgentProvider,
    loadConfig: loadMergedConfig,
    sealRunConfig: sealWorkflowRunConfig,
    unsealRunConfig: unsealWorkflowRunConfig,
    // App mode: resolve fresh installation tokens for subprocess env. PAT mode:
    // undefined → engine falls back to env inheritance, preserving legacy
    // behaviour for solo installs.
    githubApp: provider
      ? {
          resolveInstallationToken: (owner, repo): Promise<string> =>
            provider.getInstallationToken(owner, repo),
          installCliShim: installGitHubCliShim,
        }
      : undefined,
    // Per-user token policy (PR-C): when per-user mode is on, route a run's
    // gh/git through the originating user's personal token (decrypted, refreshed
    // on read), or scrub the org/bot token when they haven't connected.
    ...(credentialStore === 'database'
      ? {
          completedRunWorktree: sqlCompletedRunWorktree,
          isPerUserGitHubEnabled: () => isPerUserGitHubEnabled(),
          getUserGithubAuthor,
          getUserGithubToken: async (userId: string): Promise<string | undefined> => {
            try {
              return (await getDecryptedAccessToken(userId)) ?? undefined;
            } catch (err) {
              getLog().warn(
                { err: err as Error, userId },
                'workflow_deps.user_token_resolve_failed'
              );
              return undefined;
            }
          },
          // Deliver only this graph's vendors. A failed connected credential must not
          // disappear and allow the provider to use another account.
          // Exact decrypted values travel
          // beside that bag only so the workflow subprocess boundary can scrub echoed
          // file-delivered credentials without knowing provider-specific file shapes.
          isPerUserProviderKeysEnabled: () => isPerUserProviderKeysEnabled(),
          getUserProviderCredential: async (userId, vendor) => {
            const [row] = await requiredCredentialRows(userId, [vendor]);
            return row
              ? { kind: row.kind, getStatus: () => getStoredCredentialStatus(userId, row.provider) }
              : undefined;
          },
          getUserProviderEnv: async (
            userId: string,
            artifactsDir: string,
            vendors: readonly string[],
            connectedVendors: readonly string[]
          ): Promise<{
            env: Record<string, string>;
            files: { path: string; contents: string }[];
            protectedValues: string[];
          }> => {
            const rows = await requiredCredentialRows(userId, vendors);
            for (const vendor of connectedVendors) {
              if (!rows.some(row => row.vendor === vendor)) {
                throw new StoredCredentialDeliveryError(vendor, {
                  state: 'not_connected',
                  source: 'archon',
                });
              }
            }
            const creds = [];
            for (const { vendor, provider } of rows) {
              const stored = await getDecryptedProviderCredential(userId, provider);
              if (stored.state === 'usable') creds.push({ provider, cred: stored.credential });
              else throw new StoredCredentialDeliveryError(vendor, stored);
            }
            const env: Record<string, string> = {};
            const files: { path: string; contents: string }[] = [];
            const protectedValues = new Set<string>();
            for (const { provider, cred } of creds) {
              Object.assign(env, deliverCredential(provider, cred).env);
              if (cred.kind === 'api_key') {
                protectedValues.add(cred.apiKey);
              } else {
                protectedValues.add(cred.oauthApiKey);
                collectOAuthCredentialValues(cred.rawCreds, protectedValues);
              }
            }
            // Aggregate Pi auth.json (the keys + subscriptions Pi consumes) so a `pi` node
            // consumes them via AuthStorage(authPath) without moving Pi's home. Needs
            // a real artifactsDir (file delivery); the chat path is env-only.
            if (artifactsDir) {
              const piAuthJson = buildPiAuthJson(creds);
              if (piAuthJson) {
                const piAuthPath = join(artifactsDir, PI_AUTH_JSON_RELATIVE_PATH);
                files.push({ path: piAuthPath, contents: piAuthJson });
                env[PI_AUTH_PATH_ENV] = piAuthPath;
              }
            }
            return { env, files, protectedValues: [...protectedValues] };
          },
          // Per-user AI prefs (Phase 3): personal tiers/aliases/default-provider,
          // folded into buildAiProfile as the highest-precedence layer. Non-throwing —
          // a DB failure means the run falls back to install-wide config.
          getUserAiPrefs: async (userId: string): Promise<UserAiPrefs> => {
            try {
              return await getUserAiPrefs(userId);
            } catch (err) {
              getLog().warn(
                { err: err as Error, userId },
                'workflow_deps.user_ai_prefs_resolve_failed'
              );
              return {};
            }
          },
        }
      : // Files hold no stored credentials; providers authenticate through native configuration.
        { isPerUserProviderKeysEnabled: () => isPerUserProviderKeysEnabled() }),
  };
}
