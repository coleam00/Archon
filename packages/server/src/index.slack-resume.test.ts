import {
  clearPlatformPolicies,
  retainsWorkspace,
  getRegisteredPlatformPolicies,
} from '@archon/core/platforms/registry';
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { EventEmitter } from 'events';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowResumeTarget } from './services/workflow-resume-service';

type SlackWorkflowResume = (runId: string, slackUserId: string) => Promise<boolean>;

const persistedRun: WorkflowRun = {
  origin: { conversationId: 'conversation-1' },
  id: 'run-1',
  workflow_name: 'deliver',
  conversation_id: 'conversation-1',
  parent_conversation_id: null,
  codebase_id: null,
  status: 'paused',
  outcome: null,
  user_message: 'deliver',
  metadata: {},
  started_at: new Date('2026-10-03T10:00:00.000Z'),
  completed_at: null,
  last_activity_at: null,
  working_path: '/tmp/worktree',
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
};

const workflowPlatform = {
  sendMessage: mock(async (): Promise<void> => undefined),
  getStreamingMode: (): 'batch' => 'batch',
  getPlatformType: (): string => 'slack',
} satisfies IWorkflowPlatform;
const resumeTarget: WorkflowResumeTarget = {
  kind: 'platform',
  destination: {
    platform: workflowPlatform,
    conversationId: 'slack-thread-1',
  },
};

const mockGetWorkflowRun = mock(
  async (_runId: string): Promise<WorkflowRun | null> => persistedRun
);
const mockFindOrCreateUser = mock(async (): Promise<{ id: string }> => ({ id: 'actor-user-1' }));
const mockWorkflowResumeTargetForRun = mock(
  async (
    _run: WorkflowRun,
    _platforms: ReadonlyMap<string, IWorkflowPlatform>
  ): Promise<WorkflowResumeTarget> => resumeTarget
);
const mockResumeWorkflowRunFromServer = mock(async (): Promise<boolean> => true);

let capturedResume: SlackWorkflowResume | undefined;
let slackAdapterInstance: MockSlackAdapter | undefined;

class MockSlackAdapter implements IWorkflowPlatform {
  constructor(_botToken: string, _appToken: string, _streamingMode: 'stream' | 'batch') {
    slackAdapterInstance = this;
  }

  onMessage(_handler: (event: never) => Promise<void>): void {}
  getConversationId(): string {
    return 'slack-thread-1';
  }
  stripBotMention(text: string): string {
    return text;
  }
  isThread(): boolean {
    return false;
  }
  async fetchThreadHistory(): Promise<string[]> {
    return [];
  }
  getParentConversationId(): undefined {
    return undefined;
  }
  async start(): Promise<void> {}
  stop(): void {}
  async sendMessage(): Promise<void> {}
  getStreamingMode(): 'batch' {
    return 'batch';
  }
  getPlatformType(): string {
    return 'slack';
  }
}

class MockSlackWorkflowBridge {
  constructor(_adapter: MockSlackAdapter, resumeWorkflow: SlackWorkflowResume) {
    capturedResume = resumeWorkflow;
  }

  attach(): void {}
  detach(): void {}
}

class DisabledAdapter {
  constructor(..._args: unknown[]) {}
}

mock.module('@archon/paths/strip-cwd-env-boot', () => ({}));
mock.module('./boot/claude-auth-posture', () => ({
  shouldDefaultClaudeGlobalAuth: (): boolean => false,
  hasClaudeBootAuthPosture: (): boolean => true,
}));
mock.module('dotenv', () => ({ config: (): object => ({}) }));
mock.module('@archon/paths/env-loader', () => ({ loadArchonEnv: (): void => undefined }));
mock.module('@archon/paths/cli-command', () => ({
  publishArchonCliCommand: (): void => undefined,
}));
const mockRegisterBuiltinProviders = mock((): void => undefined);
const mockRegisterCommunityProviders = mock((): void => undefined);
mock.module('@archon/providers', () => ({
  claimPiExtensionProcessError: (): boolean => false,
  registerBuiltinProviders: mockRegisterBuiltinProviders,
  registerCommunityProviders: mockRegisterCommunityProviders,
}));

interface TestLogger {
  fatal: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  child: () => TestLogger;
  bindings: () => object;
  isLevelEnabled: () => boolean;
  level: string;
}

const logger: TestLogger = {
  fatal: (..._args: unknown[]): void => undefined,
  error: (..._args: unknown[]): void => undefined,
  warn: (..._args: unknown[]): void => undefined,
  info: (..._args: unknown[]): void => undefined,
  debug: (..._args: unknown[]): void => undefined,
  trace: (..._args: unknown[]): void => undefined,
  child(): typeof logger {
    return logger;
  },
  bindings: (): object => ({ module: 'server' }),
  isLevelEnabled: (): boolean => true,
  level: 'info',
};

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: false,
  getArchonEnvPath: (): string => '/tmp/.archon/.env',
  createLogger: (): typeof logger => logger,
  logArchonPaths: (): void => undefined,
  validateAppDefaultsPaths: async (): Promise<void> => undefined,
  shutdownTelemetry: async (): Promise<void> => undefined,
  captureArchonStarted: (): void => undefined,
  captureArchonActive: (): void => undefined,
  getSourceWebDistDir: (): string => '/tmp/web-dist',
}));

class MockConversationLockManager {
  constructor(_maxConcurrent: number) {}

  async acquireLock(_conversationId: string, callback: () => Promise<void>): Promise<void> {
    await callback();
  }

  getStats(): { active: number; queuedTotal: number; maxConcurrent: number } {
    return { active: 0, queuedTotal: 0, maxConcurrent: 10 };
  }
}

mock.module('@archon/core', () => ({
  getVendorCatalog: (): object => ({}),
  handleMessage: async (): Promise<void> => undefined,
  pool: {
    query: async (): Promise<object> => ({}),
    end: async (): Promise<void> => undefined,
  },
  ConversationLockManager: MockConversationLockManager,
  classifyAndFormatError: (error: unknown): string => String(error),
  startCleanupScheduler: (): void => {
    expect(retainsWorkspace('telegram')).toBe(true);
  },
  stopCleanupScheduler: (): void => undefined,
  getDbNotificationListener: (): null => null,
  loadConfig: async (): Promise<{ botName: string }> => {
    expect(
      getRegisteredPlatformPolicies()
        .map(policy => policy.id)
        .sort()
    ).toEqual(['discord', 'slack', 'telegram']);
    return { botName: 'Archon' };
  },
  logConfig: (): void => undefined,
  getPort: async (): Promise<number> => 12345,
  createGitHubAppAuthProvider: (): never => {
    throw new Error('unexpected GitHub App initialization');
  },
  loadAppPrivateKey: (): string => 'unused',
  registerGitHubAppAuthProvider: (): void => undefined,
  isPerUserGitHubEnabled: (): boolean => false,
  isPerUserProviderKeysEnabled: (): boolean => false,
  getDatabaseType: (): string => 'sqlite',
  assertEncryptionKeyAtBoot: (): void => undefined,
  assertProviderKeysKeyAtBoot: (): void => undefined,
  getDecryptedAccessToken: async (): Promise<undefined> => undefined,
}));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));
mock.module('@archon/core/db/workflows', () => ({ getWorkflowRun: mockGetWorkflowRun }));

mock.module('@archon/adapters', () => ({
  TelegramAdapter: DisabledAdapter,
  GitHubAdapter: DisabledAdapter,
  DiscordAdapter: DisabledAdapter,
  SlackAdapter: MockSlackAdapter,
  SlackWorkflowBridge: MockSlackWorkflowBridge,
}));
mock.module('@archon/adapters/community/forge/gitea', () => ({ GiteaAdapter: DisabledAdapter }));
mock.module('@archon/adapters/community/forge/gitlab', () => ({ GitLabAdapter: DisabledAdapter }));

class MockSSETransport {
  constructor(_onCleanup: (conversationId: string) => void) {}
  emit(): void {}
}

class MockMessagePersistence {
  constructor(_emitEvent: (conversationId: string, event: unknown) => void) {}
  startPeriodicFlush(): void {}
  stopPeriodicFlush(): void {}
  async flush(): Promise<void> {}
  async flushAll(): Promise<void> {}
}

class MockWorkflowEventBridge {
  constructor(_transport: MockSSETransport) {}
}

class MockWebAdapter implements IWorkflowPlatform {
  constructor(
    _transport: MockSSETransport,
    _persistence: MockMessagePersistence,
    _workflowBridge: MockWorkflowEventBridge
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  getStreamingMode(): 'stream' {
    return 'stream';
  }
  getPlatformType(): string {
    return 'web';
  }
}

class MockDashboardEventPoller {
  start(): void {}
  stop(): void {}
}

class MockPgNotifyListener {
  constructor(..._args: unknown[]) {}
  async start(): Promise<void> {}
  stop(): void {}
}

mock.module('./adapters/web', () => ({ WebAdapter: MockWebAdapter }));
mock.module('./adapters/web/persistence', () => ({ MessagePersistence: MockMessagePersistence }));
mock.module('./adapters/web/transport', () => ({ SSETransport: MockSSETransport }));
mock.module('./adapters/web/workflow-bridge', () => ({
  WorkflowEventBridge: MockWorkflowEventBridge,
}));
mock.module('./adapters/web/dashboard-event-poller', () => ({
  DashboardEventPoller: MockDashboardEventPoller,
}));
mock.module('./adapters/web/pg-notify-listener', () => ({
  PgNotifyListener: MockPgNotifyListener,
}));
mock.module('./static-cache', () => ({ serveWebUi: (): void => undefined }));
mock.module('./routes/openapi-defaults', () => ({ validationErrorHook: (): void => undefined }));
mock.module('./routes/api', () => ({ registerApiRoutes: (): void => undefined }));
mock.module('./routes/webhooks', () => ({
  registerGithubWebhookRoute: (): void => undefined,
  registerWebhookSourceRoutes: (): void => undefined,
}));
mock.module('./services/webhook-source-plugins', () => ({
  loadWebhookSourcePlugins: async (): Promise<undefined> => undefined,
}));
mock.module('./services/resource-start-hosting', () => ({
  createServerResourceStartHost: (): undefined => undefined,
}));
mock.module('./services/workflow-resume-service', () => ({
  resumeWorkflowRunFromServer: mockResumeWorkflowRunFromServer,
  startWorkflowContinuationScheduler: (): void => undefined,
  stopWorkflowContinuationScheduler: (): void => undefined,
  workflowResumeTargetForRun: mockWorkflowResumeTargetForRun,
}));
mock.module('./github-auth-bootstrap', () => ({
  selectGitHubAuthMode: (): { kind: 'none' } => ({ kind: 'none' }),
  parseGitCredentialPath: (): undefined => undefined,
}));
mock.module('./discord-mention', () => ({ isDiscordMentionRequired: (): boolean => false }));
mock.module('./auth', () => ({
  getAuth: (): null => null,
  closeAuth: async (): Promise<void> => undefined,
  isWebAuthEnabled: (): boolean => false,
  assertWebAuthAtBoot: (): void => undefined,
  getSignupMode: (): 'disabled' => 'disabled',
  isArchonOwnedAuthPath: (): boolean => false,
}));
mock.module('@archon/git', () => ({
  execFileAsync: async (): Promise<{ stdout: string; stderr: string }> => ({
    stdout: '',
    stderr: '',
  }),
}));

const envKeys = [
  'ARCHON_WEBHOOK_SOURCES',
  'CLAUDE_USE_GLOBAL_AUTH',
  'CODEX_ACCESS_TOKEN',
  'CODEX_ID_TOKEN',
  'DISCORD_BOT_TOKEN',
  'GITEA_TOKEN',
  'GITEA_URL',
  'GITEA_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_WEBHOOK_SECRET',
  'HOST',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'WEB_UI_DEV',
] as const;
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const processEvents = ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException'] as const;
const processEmitter: EventEmitter = process;
const originalListeners = new Map(
  processEvents.map(event => [event, new Set(processEmitter.listeners(event))] as const)
);

beforeAll(() => {
  for (const key of envKeys) delete process.env[key];
  process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
  process.env.HOST = '127.0.0.1';
  process.env.SLACK_APP_TOKEN = 'xapp-test';
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.WEB_UI_DEV = '1';
});

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const event of processEvents) {
    const retained = originalListeners.get(event);
    for (const listener of processEmitter.listeners(event)) {
      if (!retained?.has(listener)) {
        processEmitter.removeListener(event, listener as (...args: unknown[]) => void);
      }
    }
  }
});

describe('Slack workflow resume composition', () => {
  test('server registers offline policies with all platform transports skipped', async () => {
    clearPlatformPolicies();
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      const { startServer } = await import('./index');
      await startServer({ port: 12345, skipPlatformAdapters: true });
      expect(mockRegisterBuiltinProviders).toHaveBeenCalledTimes(1);
      expect(mockRegisterCommunityProviders).toHaveBeenCalledTimes(1);
      expect(retainsWorkspace('telegram')).toBe(true);
    } finally {
      serveSpy.mockRestore();
    }
  });

  test('server startup injects the persisted, destination-aware resume path', async () => {
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      const { startServer } = await import('./index');
      await startServer({ port: 12345 });

      expect(capturedResume).toBeDefined();
      expect(slackAdapterInstance).toBeDefined();

      const accepted = await capturedResume?.('run-1', 'U123');

      expect(accepted).toBe(true);
      expect(mockGetWorkflowRun).toHaveBeenCalledWith('run-1');
      expect(mockFindOrCreateUser).toHaveBeenCalledWith('slack', 'U123', undefined);
      expect(mockWorkflowResumeTargetForRun).toHaveBeenCalledTimes(1);
      expect(mockWorkflowResumeTargetForRun.mock.calls[0]?.[0]).toBe(persistedRun);
      const platforms = mockWorkflowResumeTargetForRun.mock.calls[0]?.[1];
      expect(platforms?.get('slack')).toBe(slackAdapterInstance);
      expect(platforms?.get('web')).toBeInstanceOf(MockWebAdapter);
      expect(mockResumeWorkflowRunFromServer).toHaveBeenCalledWith(
        persistedRun,
        'actor-user-1',
        resumeTarget
      );
    } finally {
      serveSpy.mockRestore();
    }
  });
});
