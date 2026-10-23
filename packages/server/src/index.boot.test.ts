import { mkdir, mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureStubLogOutput, removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import {
  clearPlatformPolicies,
  retainsWorkspace,
  getRegisteredPlatformPolicies,
} from '@archon/core/platforms/registry';
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { IGitHubAppAuthProvider, GitHubAuth } from '@archon/core';
import type { EventEmitter } from 'events';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { clearConfigCache, loadConfig, toSafeConfig } from '@archon/core/config/config-loader';
import { InvalidConfigError } from '@archon/core/config';

const trackTempRoot = trackTempRoots();
let pluginsDir: string;

const DEFAULT_POLICY_IDS = [
  'api',
  'cli',
  'discord',
  'gitea',
  'github',
  'gitlab',
  'telegram',
  'web',
];
let expectedPolicyIds = DEFAULT_POLICY_IDS;

async function writeChatReceipt(
  id: string,
  policy: { workspaceRetention: 'age-based' | 'retain'; streaming?: object }
): Promise<string> {
  const file = join(pluginsDir, 'installed', 'owner', 'chat-fixture', 'receipt.json');
  await mkdir(dirname(file), { recursive: true });
  const executable = 'archon-chat-fixture' + (process.platform === 'win32' ? '.exe' : '');
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      id: 'owner/chat-fixture',
      manifest: {
        schemaVersion: 1,
        kind: 'chat',
        name: 'fixture',
        description: 'Fixture',
        executable: 'archon-chat-fixture',
      },
      tag: 'v1',
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
      files: [{ path: executable, sha256: 'b'.repeat(64) }],
      descriptor: {
        protocol: 'archon-chat/1',
        id,
        displayName: 'Fixture',
        version: '1',
        capabilities: { defaultWorkflowDispatch: 'background' },
        policy,
      },
    })
  );
  return file;
}

const hostedPlugins: string[][] = [];
const mockChatHostStart = mock(() => {});
const mockChatHostStop = mock(async () => {});
const mockWebStop = mock(async () => {});
mock.module('./chat-host/runtime', () => ({
  createChatHost: (installed: { descriptor: { id: string } }[]) => {
    hostedPlugins.push(installed.map(plugin => plugin.descriptor.id));
    return { start: mockChatHostStart, stop: mockChatHostStop, attentionDestinations: [] };
  },
}));

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
// In-process boots must not publish a store id or server record into the real home.
mock.module('@archon/paths/server-discovery', () => ({
  getStoreIdPath: (): string => '/nonexistent/archon-home/store-id',
  getServerRecordPath: (): string => '/nonexistent/archon-home/server.json',
  ensureStoreId: (): string => '00000000-0000-4000-8000-000000000000',
  readStoreId: (): null => null,
  readLiveServerRecord: (): null => null,
  writeServerRecord: (): void => undefined,
  removeServerRecord: (): void => undefined,
}));
mock.module('@archon/paths/cli-command', () => ({
  publishArchonCliCommand: (): void => undefined,
}));
const mockRegisterHostProviders = mock(async (): Promise<void> => undefined);
mock.module('@archon/core/providers/register-host-providers', () => ({
  registerHostProviders: mockRegisterHostProviders,
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
  getPluginsPath: (): string => pluginsDir,
  getArchonConfigPath: (): string => join(pluginsDir, 'config.yaml'),
  getArchonWorkspacesPath: (): string => join(pluginsDir, 'workspaces'),
  getArchonWorktreesPath: (): string => join(pluginsDir, 'worktrees'),
  createLogger: (): typeof logger => logger,
  logArchonPaths: (): void => undefined,
  validateAppDefaultsPaths: async (): Promise<void> => undefined,
  shutdownTelemetry: async (): Promise<void> => undefined,
  captureArchonStarted: (): void => undefined,
  captureArchonActive: (): void => undefined,
  captureApprovalResolved: (): void => undefined,
  getSourceWebDistDir: (): string => '/tmp/web-dist',
}));

mock.module('@archon/core', () => ({
  handleMessage: async (): Promise<void> => undefined,
  pool: {
    query: async (): Promise<object> => ({}),
    end: async (): Promise<void> => undefined,
  },
  ConversationLockManager,
  classifyAndFormatError: (error: unknown): string => String(error),
  startCleanupScheduler: (): void => {
    expect(retainsWorkspace('telegram')).toBe(true);
  },
  stopCleanupScheduler: (): void => undefined,
  getDbNotificationListener: (): null => null,
  loadConfig: async () => {
    expect(mockRegisterHostProviders).toHaveBeenCalledTimes(1);
    expect(
      getRegisteredPlatformPolicies()
        .map(policy => policy.id)
        .sort()
    ).toEqual(expectedPolicyIds);
    return loadConfig();
  },
  logConfig: (): void => undefined,
  getPort: async (): Promise<number> => 12345,
  initializeWorkflowGitHubAppAuth: (): IGitHubAppAuthProvider => installationTokenProvider,
  isPerUserGitHubEnabled: (): boolean => false,
  isPerUserProviderKeysEnabled: (): boolean => false,
  getDatabaseType: (): string => 'sqlite',
  assertProviderKeysKeyAtBoot: (): void => undefined,
  getDecryptedAccessToken: async (): Promise<undefined> => undefined,
}));
mock.module('@archon/core/config/store-selection', () => ({
  loadStoreSelection: async (): Promise<'database'> => 'database',
}));

const mockInstallationToken = mock(async (_owner: string, _repo: string) => 'inherited-port-token');
const installationTokenProvider = {
  slug: 'test-app',
  getInstallationToken: mockInstallationToken,
  getInstallationTokenById: async () => {
    throw new Error('Unexpected token by id');
  },
  getOctokitForInstallation: async () => {
    throw new Error('Unexpected Octokit');
  },
  primeInstallationLookup: () => {},
  resolveInstallationId: async () => {
    throw new Error('Unexpected installation lookup');
  },
  invalidateToken: () => {},
  invalidateRepo: () => {},
} satisfies IGitHubAppAuthProvider;

const mockGitHubAuth = mock((_auth: GitHubAuth): void => undefined);
class MockGitHubAdapter {
  constructor(private readonly auth: GitHubAuth) {
    mockGitHubAuth(auth);
  }
  async start(): Promise<void> {}
  getPlatformType(): string {
    return 'github';
  }
  getAuthMode(): GitHubAuth['kind'] {
    return this.auth.kind;
  }
  async getInstallationToken(owner: string, repo: string): Promise<string> {
    if (this.auth.kind !== 'app') throw new Error('Expected App mode');
    return this.auth.provider.getInstallationToken(owner, repo);
  }
}

mock.module('@archon/adapters', () => ({
  TelegramAdapter: DisabledAdapter,
  GitHubAdapter: MockGitHubAdapter,
  DiscordAdapter: DisabledAdapter,
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
  async stop(): Promise<void> {
    await mockWebStop();
  }
  async sendMessage(): Promise<void> {}
  getStreamingMode(): 'stream' {
    return 'stream';
  }
  getPlatformType(): string {
    return 'web';
  }
}

class MockDashboardEventPoller {
  async start(): Promise<void> {}
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
const mockRegisterApiRoutes = mock<typeof import('./routes/api').registerApiRoutes>(
  () => undefined
);
mock.module('./routes/api', () => ({ registerApiRoutes: mockRegisterApiRoutes }));
mock.module('./routes/webhooks', () => ({
  registerGiteaWebhookRoute: (): void => undefined,
  registerGitlabWebhookRoute: (): void => undefined,
  registerGithubWebhookRoute: (): void => undefined,
  registerWebhookSourceRoutes: (): void => undefined,
}));
mock.module('./services/webhook-source-plugins', () => ({
  loadWebhookSourcePlugins: async (): Promise<undefined> => undefined,
}));
mock.module('./services/resource-start-hosting', () => ({
  createServerResourceStartHost: (): undefined => undefined,
}));
mock.module('./services/attention-router', () => ({
  AttentionRouter: class {
    start(): void {}
    async stop(): Promise<void> {}
  },
}));
mock.module('./services/web-push', () => ({ WebPushDestination: class {} }));
const workflowHost = {} as import('@archon/core/workflows/host-store').WorkflowHost;
mock.module('@archon/core/workflows/sql-host', () => ({
  createSqlWorkflowHost: () => workflowHost,
  createSqlWorkflowOperations: () => {
    throw new Error('No plugin action expected during boot');
  },
}));
mock.module('@archon/core/workflows/store-adapter', () => ({ createWorkflowStore: () => ({}) }));

mock.module('./services/workflow-resume-service', () => ({
  resumeWorkflowRunFromServer: async (): Promise<never> => {
    throw new Error('No resume expected during boot');
  },
  startWorkflowContinuationScheduler: (): void => undefined,
  stopWorkflowContinuationScheduler: (): void => undefined,
  workflowResumeTargetForRun: async (): Promise<never> => {
    throw new Error('No resume expected during boot');
  },
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
  'ARCHON_PORT',
  'PORT',
  'MAX_CONCURRENT_CONVERSATIONS',
  'DEFAULT_AI_ASSISTANT',
  'CLAUDE_USE_GLOBAL_AUTH',
  'CODEX_ACCESS_TOKEN',
  'CODEX_ID_TOKEN',
  'DISCORD_BOT_TOKEN',
  'GITEA_TOKEN',
  'GITEA_URL',
  'GITEA_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'WEBHOOK_SECRET',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_WEBHOOK_SECRET',
  'HOST',
  'ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND',
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

beforeAll(async () => {
  pluginsDir = await mkdtemp(join(tmpdir(), 'server-chat-policies-'));
  for (const key of envKeys) delete process.env[key];
  process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
  process.env.HOST = '127.0.0.1';
  process.env.WEB_UI_DEV = '1';
});

afterAll(async () => {
  await removeTempTree(pluginsDir);
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

describe('server conversation admission configuration', () => {
  test.each([
    {
      name: 'global YAML',
      yaml: 'concurrency:\n  maxConversations: 3\n',
      env: undefined,
      limit: 3,
    },
    {
      name: 'environment overrides YAML',
      yaml: 'concurrency:\n  maxConversations: 3\n',
      env: '5',
      limit: 5,
    },
    {
      name: 'invalid environment preserves YAML',
      yaml: 'concurrency:\n  maxConversations: 3\n',
      env: 'abc',
      limit: 3,
    },
    { name: 'default', yaml: '', env: undefined, limit: 10 },
    { name: 'environment only', yaml: '', env: '4', limit: 4 },
    { name: 'invalid environment preserves default', yaml: '', env: 'abc', limit: 10 },
  ])('$name admits $limit conversations', async ({ yaml, env, limit }) => {
    const configPath = join(pluginsDir, 'config.yaml');
    await writeFile(configPath, yaml);
    clearConfigCache();
    if (env === undefined) delete process.env.MAX_CONCURRENT_CONVERSATIONS;
    else process.env.MAX_CONCURRENT_CONVERSATIONS = env;
    mockRegisterApiRoutes.mockClear();
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 43210,
    })) as unknown as typeof Bun.serve);
    const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
    try {
      const { startServer } = await import('./index');
      await startServer({ port: 12345, skipPlatformAdapters: true });
      const manager = mockRegisterApiRoutes.mock.calls[0]?.[2];
      if (!manager) throw new Error('Startup did not pass a lock manager to the API');
      expect(manager.getStats().maxConcurrent).toBe(limit);
      expect(manager.getStats().maxConcurrent).toBe(
        toSafeConfig(await loadConfig()).concurrency.maxConversations
      );
      for (let i = 0; i < limit; i++) {
        expect(await manager.acquireLock(`active-${i}`, () => blocked)).toEqual({
          status: 'started',
        });
      }
      expect(await manager.acquireLock('overflow', () => blocked)).toEqual({
        status: 'queued-capacity',
      });
    } finally {
      release();
      serveSpy.mockRestore();
      await unlink(configPath);
      clearConfigCache();
      delete process.env.MAX_CONCURRENT_CONVERSATIONS;
    }
  });

  test.each(['-1', '1.5', 'abc', 'true', '{}', '[]', '.inf', '0', 'null', '.nan'])(
    'invalid global YAML maxConversations %s stops startup before admitting conversations',
    async value => {
      const configPath = join(pluginsDir, 'config.yaml');
      await writeFile(configPath, `concurrency:\n  maxConversations: ${value}\n`);
      clearConfigCache();
      mockRegisterApiRoutes.mockClear();
      try {
        const { startServer } = await import('./index');
        const error = await startServer({ port: 12345, skipPlatformAdapters: true }).catch(
          (err: unknown) => err
        );
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect((error as Error).message).toContain(configPath);
        expect((error as Error).message).toContain('concurrency.maxConversations');
        expect(mockRegisterApiRoutes).not.toHaveBeenCalled();
      } finally {
        await unlink(configPath);
        clearConfigCache();
      }
    }
  );

  test('repository config cannot override server-wide conversation admission', async () => {
    const repoPath = trackTempRoot(await mkdtemp(join(tmpdir(), 'server-conversation-repo-')));
    await mkdir(join(repoPath, '.archon'));
    await writeFile(join(repoPath, '.archon/config.yaml'), 'concurrency:\n  maxConversations: 1\n');
    await writeFile(join(pluginsDir, 'config.yaml'), 'concurrency:\n  maxConversations: 3\n');
    clearConfigCache();
    try {
      expect((await loadConfig(repoPath)).concurrency.maxConversations).toBe(3);
    } finally {
      await unlink(join(pluginsDir, 'config.yaml'));
      clearConfigCache();
    }
  });
});

describe('server platform composition', () => {
  test.each([
    {
      GH_TOKEN: 'gh-selected-identity',
      GITHUB_TOKEN: 'github-other-identity',
      expected: 'gh-selected-identity',
    },
    { GH_TOKEN: undefined, GITHUB_TOKEN: 'github-only-identity', expected: 'github-only-identity' },
    {
      GH_TOKEN: '',
      GITHUB_TOKEN: 'github-fallback-identity',
      expected: 'github-fallback-identity',
    },
    { GH_TOKEN: 'gh-only-identity', GITHUB_TOKEN: undefined, expected: undefined },
  ])('server PAT API auth uses the shared token order after activation: %j', async env => {
    const logOutput = captureStubLogOutput(logger);
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    process.env.WEBHOOK_SECRET = 'test-webhook';
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      mockGitHubAuth.mockClear();
      const { startServer } = await import('./index');
      await startServer({ port: 12345 });
      if (env.expected) {
        expect(mockGitHubAuth).toHaveBeenCalledWith({ kind: 'pat', token: env.expected });
      } else {
        expect(mockGitHubAuth).not.toHaveBeenCalled();
      }
      expect(logOutput.output()).not.toBe('');
      for (const token of [env.GH_TOKEN, env.GITHUB_TOKEN]) {
        if (token) expect(logOutput.output()).not.toContain(token);
      }
    } finally {
      logOutput.restore();
      serveSpy.mockRestore();
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.WEBHOOK_SECRET;
    }
  });

  test('server passes its configured App provider to the URL API routes', async () => {
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test-key';
    process.env.WEBHOOK_SECRET = 'test-webhook';
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      mockRegisterApiRoutes.mockClear();
      const { startServer } = await import('./index');
      await startServer({ port: 12345 });
      expect(mockRegisterApiRoutes.mock.calls.at(-1)?.[5]?.githubAppAuth).toBe(
        installationTokenProvider
      );
    } finally {
      serveSpy.mockRestore();
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.WEBHOOK_SECRET;
    }
  });

  test.each([
    { HOST: '0.0.0.0', allow: undefined, rejects: true },
    { HOST: '0.0.0.0', allow: '1', rejects: false },
    { HOST: 'localhost', allow: undefined, rejects: false },
  ])('App mode refuses a public bind before listening: %j', async env => {
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test-key';
    process.env.WEBHOOK_SECRET = 'test-webhook';
    process.env.HOST = env.HOST;
    if (env.allow) process.env.ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND = env.allow;
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      const { startServer } = await import('./index');
      const started = startServer({ port: 12345 });
      if (env.rejects) {
        await expect(started).rejects.toThrow(/non-loopback/);
        expect(serveSpy).not.toHaveBeenCalled();
      } else {
        await started;
        expect(serveSpy).toHaveBeenCalledTimes(1);
      }
    } finally {
      serveSpy.mockRestore();
      process.env.HOST = '127.0.0.1';
      delete process.env.ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND;
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.WEBHOOK_SECRET;
    }
  });

  test('server publishes the bound port to credential-helper children', async () => {
    process.env.ARCHON_PORT = '3090';
    process.env.PORT = '3000';
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 43210,
    })) as unknown as typeof Bun.serve);
    try {
      const { startServer } = await import('./index');
      await startServer({ port: 12345, skipPlatformAdapters: true });
      expect(process.env.ARCHON_PORT).toBe('43210');
    } finally {
      serveSpy.mockRestore();
      delete process.env.ARCHON_PORT;
      delete process.env.PORT;
    }
  });

  test.skipIf(process.platform === 'win32')(
    'installed Git helper inherits the port published by server startup',
    async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'server-credential-handoff-')));
      const repoPath = join(root, 'repo');
      const env = {
        ...process.env,
        ARCHON_HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      };
      const init = Bun.spawnSync(['git', 'init', repoPath], { env });
      expect(init.exitCode).toBe(0);
      const installer = join(
        import.meta.dir,
        '../../core/src/github-auth/credential-helper-install.ts'
      );
      const install = Bun.spawnSync(
        [
          process.execPath,
          '-e',
          `import { installCredentialHelper } from ${JSON.stringify(installer)};
         const result = await installCredentialHelper(${JSON.stringify(repoPath)});
         if (result.kind === 'failed') throw result.error;`,
        ],
        { env }
      );
      expect(install.exitCode, install.stderr.toString()).toBe(0);
      const realServe = Bun.serve.bind(Bun);
      let listener: ReturnType<typeof Bun.serve> | undefined;
      const serveSpy = spyOn(Bun, 'serve').mockImplementation((options => {
        listener = realServe(options);
        return listener;
      }) as typeof Bun.serve);
      process.env.ARCHON_PORT = '3090';
      process.env.PORT = '3000';
      process.env.GITHUB_APP_ID = '123';
      process.env.GITHUB_APP_PRIVATE_KEY = 'test-key';
      process.env.WEBHOOK_SECRET = 'test-secret';
      mockInstallationToken.mockClear();
      try {
        const { startServer } = await import('./index');
        await startServer({ port: 0 });
        expect(listener?.port).not.toBe(3090);
        const child = Bun.spawn(['git', '-C', repoPath, 'credential', 'fill'], {
          env: {
            ...process.env,
            ARCHON_HOME: root,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        child.stdin.write('protocol=https\nhost=github.com\npath=owner/.github-private.git\n\n');
        child.stdin.end();
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain('password=inherited-port-token');
        expect(stderr).toBe('');
        expect(mockInstallationToken).toHaveBeenCalledTimes(1);
        expect(mockInstallationToken).toHaveBeenCalledWith('owner', '.github-private');
      } finally {
        serveSpy.mockRestore();
        listener?.stop(true);
        delete process.env.GITHUB_APP_ID;
        delete process.env.GITHUB_APP_PRIVATE_KEY;
        delete process.env.WEBHOOK_SECRET;
        delete process.env.ARCHON_PORT;
        delete process.env.PORT;
      }
    }
  );

  test('server registers offline policies with all platform transports skipped', async () => {
    clearPlatformPolicies();
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      const { startServer } = await import('./index');
      await startServer({ port: 12345, skipPlatformAdapters: true });
      expect(mockRegisterHostProviders).toHaveBeenCalledTimes(1);
      expect(retainsWorkspace('telegram')).toBe(true);
    } finally {
      serveSpy.mockRestore();
    }
  });

  test('server reads a chat receipt before config loading and supersedes its bundled policy', async () => {
    const file = await writeChatReceipt('discord', {
      workspaceRetention: 'retain',
      streaming: { defaultMode: 'stream', envVar: 'FIXTURE_STREAMING_MODE' },
    });
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      const { startServer } = await import('./index');
      await startServer({ port: 12345, skipPlatformAdapters: true });
      expect(getRegisteredPlatformPolicies().filter(policy => policy.id === 'discord')).toEqual([
        {
          id: 'discord',
          workspaceRetention: 'retain',
          streaming: { defaultMode: 'stream', envVar: 'FIXTURE_STREAMING_MODE' },
        },
      ]);
    } finally {
      serveSpy.mockRestore();
      await unlink(file);
    }
  });

  test('a Slack token without the Slack plugin logs the install command and hosts no Slack', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const warnSpy = spyOn(logger, 'warn');
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      const { startServer } = await import('./index');
      await startServer({ port: 12345 });
      expect(warnSpy).toHaveBeenCalledWith(
        {
          platform: 'slack',
          hint: 'Docker images provision Slack offline when SLACK_BOT_TOKEN is set. Check provisioning logs and restart with a current image. Outside Docker, install the plugin and restart. Manual install: archon plugin add coleam00/Archon/plugins/chat-slack',
        },
        'chat.bundled_adapter_retired'
      );
      expect(hostedPlugins.at(-1)).toEqual([]);
    } finally {
      serveSpy.mockRestore();
      warnSpy.mockRestore();
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  test('an installed Slack plugin is hosted at boot and silences the retired-adapter notice', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const file = await writeChatReceipt('slack', { workspaceRetention: 'age-based' });
    const warnSpy = spyOn(logger, 'warn');
    const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
      port: 12345,
    })) as unknown as typeof Bun.serve);
    try {
      expectedPolicyIds = [...DEFAULT_POLICY_IDS, 'slack'].sort();
      const { startServer } = await import('./index');
      mockChatHostStart.mockClear();
      await startServer({ port: 12345 });
      expect(mockChatHostStart).toHaveBeenCalledTimes(1);
      expect(hostedPlugins.at(-1)).toEqual(['slack']);
      expect(warnSpy.mock.calls.map(call => call.at(-1))).not.toContain(
        'chat.bundled_adapter_retired'
      );
    } finally {
      serveSpy.mockRestore();
      warnSpy.mockRestore();
      await unlink(file);
      expectedPolicyIds = DEFAULT_POLICY_IDS;
      delete process.env.SLACK_BOT_TOKEN;
    }
  });
});

test('a chat host stop error preserves diagnostics and still stops the web adapter', async () => {
  const serveSpy = spyOn(Bun, 'serve').mockImplementation((() => ({
    port: 12345,
  })) as unknown as typeof Bun.serve);
  const exitSpy = spyOn(process, 'exit').mockImplementation(
    (() => undefined) as typeof process.exit
  );
  const logSpy = spyOn(logger, 'error');
  const failure = new Error('tree termination failed');
  const previous = new Set(processEmitter.listeners('SIGTERM'));
  mockWebStop.mockClear();
  mockChatHostStop.mockRejectedValueOnce(failure);
  try {
    const { startServer } = await import('./index');
    await startServer({ port: 12345 });
    const shutdown = processEmitter.listeners('SIGTERM').find(listener => !previous.has(listener));
    expect(shutdown).toBeDefined();
    shutdown?.();
    for (let i = 0; i < 100 && exitSpy.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(mockWebStop).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith({ err: failure }, 'chat_host_stop_error');
    expect(exitSpy).toHaveBeenCalledWith(0);
  } finally {
    serveSpy.mockRestore();
    exitSpy.mockRestore();
    logSpy.mockRestore();
  }
});
