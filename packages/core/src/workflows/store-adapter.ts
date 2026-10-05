import type { CredentialStatus } from '@archon/provider-contract';
/**
 * WorkflowStore adapter — bridges @archon/core DB modules to the
 * IWorkflowStore trait defined in @archon/workflows.
 */
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowConfig, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import type { MergedConfig } from '../config/config-types';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import * as workflowNodeSessionDb from '../db/workflow-node-sessions';
import {
  listWorkflowRunNodeSessions,
  upsertWorkflowRunNodeSession,
} from '../db/workflow-run-node-sessions';
import * as codebaseDb from '../db/codebases';
import * as envVarDb from '../db/env-vars';
import { getAgentProvider } from '../services/provider-admission';
import { loadConfig as loadMergedConfig } from '../config/config-loader';
import { createLogger } from '@archon/paths';
import type { IGitHubAppAuthProvider } from '../github-auth/types';
import { createGitHubAppAuthProvider } from '../github-auth/auth';
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

async function requiredCredentialRows(
  userId: string,
  vendors: readonly string[]
): Promise<{ vendor: string; provider: string }[]> {
  const rows = await listUserProviderKeys(userId);
  return vendors.flatMap(vendor => {
    const row =
      rows.find(r => r.provider === vendor) ??
      rows.find(r => normalizeCredentialVendor(r.provider) === vendor);
    return row ? [{ vendor, provider: row.provider }] : [];
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

export function createWorkflowStore(): IWorkflowStore {
  return {
    resolveApprovalGate: workflowDb.resolveApprovalGate,
    resolveAndCancelApprovalGate: workflowDb.resolveAndCancelApprovalGate,
    cancelResumableRunsForConversation: workflowDb.cancelResumableRunsForConversation,
    deleteWorkflowNodeSessions: workflowNodeSessionDb.deleteWorkflowNodeSessions,
    listWorkflowRuns: workflowDb.listDashboardRuns,
    findWorkflowRunsByIdPrefix: workflowDb.findWorkflowRunsByIdPrefix,
    createWorkflowRun: workflowDb.createWorkflowRun,
    claimPendingWorkflowRun: workflowDb.claimPendingWorkflowRun,
    recordWorkflowRunCheckoutBaseline: workflowDb.recordWorkflowRunCheckoutBaseline,
    getWorkflowRun: workflowDb.getWorkflowRun,
    findChildRuns: workflowDb.findChildRuns,
    getRunAncestry: workflowDb.getRunAncestry,
    getActiveWorkflowRunByPath: workflowDb.getActiveWorkflowRunByPath,
    findResumableRun: workflowDb.findResumableRun,
    resumeWorkflowRun: workflowDb.resumeWorkflowRun,
    recoverCancelledFanOutRun: workflowDb.recoverCancelledFanOutRun,
    updateWorkflowRun: workflowDb.updateWorkflowRun,
    updateWorkflowActivity: workflowDb.updateWorkflowActivity,
    // DB returns string | null; IWorkflowStore declares WorkflowRunStatus | null.
    // The remote_agent_workflow_runs.status column is constrained to valid enum values
    // in SQL, so this cast is safe as long as the column constraint matches WorkflowRunStatus.
    getWorkflowRunStatus: id =>
      workflowDb.getWorkflowRunStatus(id) as Promise<WorkflowRunStatus | null>,
    completeWorkflowRun: workflowDb.completeWorkflowRun,
    failWorkflowRun: workflowDb.failWorkflowRun,
    pauseWorkflowRun: workflowDb.pauseWorkflowRun,
    pauseWorkflowRunForWait: workflowDb.pauseWorkflowRunForWait,
    failPausedAttentionWait: workflowDb.failPausedAttentionWait,
    clearWorkflowWaitContext: workflowDb.clearWorkflowWaitContext,
    failPausedApproval: workflowDb.failPausedApproval,
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

/**
 * Create the canonical WorkflowDeps for the workflow engine.
 * Single construction point — avoids duplicating the wiring across callers.
 */
export function createWorkflowDeps(): WorkflowDeps {
  const provider = registeredGitHubAppAuthProvider;
  return {
    store: createWorkflowStore(),
    getAgentProvider,
    loadConfig: loadMergedConfig,
    sealRunConfig: sealWorkflowRunConfig,
    unsealRunConfig: unsealWorkflowRunConfig,
    // App mode: resolve fresh installation tokens for subprocess env. PAT mode:
    // undefined → engine falls back to env inheritance, preserving legacy
    // behaviour for solo installs.
    resolveBotGitHubToken: provider
      ? (owner, repo): Promise<string> => provider.getInstallationToken(owner, repo)
      : undefined,
    // Per-user token policy (PR-C): when per-user mode is on, route a run's
    // gh/git through the originating user's personal token (decrypted, refreshed
    // on read), or scrub the org/bot token when they haven't connected.
    isPerUserGitHubEnabled: () => isPerUserGitHubEnabled(),
    getUserGithubAuthor,
    getUserGithubToken: async (userId: string): Promise<string | undefined> => {
      try {
        return (await getDecryptedAccessToken(userId)) ?? undefined;
      } catch (err) {
        getLog().warn({ err: err as Error, userId }, 'workflow_deps.user_token_resolve_failed');
        return undefined;
      }
    },
    // Deliver only this graph's vendors. A failed connected credential must not
    // disappear and allow the provider to use another account.
    // Exact decrypted values travel
    // beside that bag only so the workflow subprocess boundary can scrub echoed
    // file-delivered credentials without knowing provider-specific file shapes.
    isPerUserProviderKeysEnabled: () => isPerUserProviderKeysEnabled(),
    getUserProviderCredentialStatus: async (userId, vendor): Promise<CredentialStatus> => {
      const [row] = await requiredCredentialRows(userId, [vendor]);
      return row
        ? getStoredCredentialStatus(userId, row.provider)
        : { state: 'not_connected', source: 'archon' };
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
        const result = deliverCredential(provider, cred, { artifactsDir });
        Object.assign(env, result.env);
        if (result.files) files.push(...result.files);
        if (cred.kind === 'api_key') {
          protectedValues.add(cred.apiKey);
        } else {
          protectedValues.add(cred.oauthApiKey);
          collectOAuthCredentialValues(cred.rawCreds, protectedValues);
        }
      }
      // Aggregate Pi auth.json (the user's keys + subscriptions) so a `pi` node
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
        getLog().warn({ err: err as Error, userId }, 'workflow_deps.user_ai_prefs_resolve_failed');
        return {};
      }
    },
  };
}
