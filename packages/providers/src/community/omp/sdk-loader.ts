type DynamicImport = (specifier: string) => Promise<unknown>;

// External SDK source currently ships TypeScript imports that this package's tsc
// configuration cannot type-check directly. Use a runtime import indirection so
// Archon owns the structural boundary instead of compiling OMP internals.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImport;

export interface OmpAuthStorage {
  setRuntimeApiKey(provider: string, apiKey: string): void;
  getApiKey(provider: string, sessionId?: string): Promise<string | undefined>;
}

export interface OmpModelRegistry {
  find(provider: string, modelId: string): unknown;
  refreshInBackground(): void;
}

export type OmpSessionManager = object;

export interface OmpMcpSourceMeta {
  provider: string;
  providerName: string;
  path: string;
  level: 'project' | 'user' | 'native';
}

export interface OmpMcpLoadResult {
  tools: unknown[];
  errors: Map<string, string>;
  connectedServers: string[];
  exaApiKeys: string[];
}

export interface OmpMcpManager {
  connectServers(
    configs: Record<string, unknown>,
    sources: Record<string, OmpMcpSourceMeta>,
    onConnecting?: (serverNames: string[]) => void
  ): Promise<OmpMcpLoadResult>;
  disconnectAll(): Promise<void>;
}

export interface OmpSessionInfo {
  id: string;
  path: string;
}

export interface OmpExtensionRunner {
  setFlagValue(name: string, value: boolean | string): void;
}

export interface OmpSession {
  sessionId?: string;
  extensionRunner?: OmpExtensionRunner;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(prompt: string): Promise<unknown>;
  abort(): Promise<unknown>;
  dispose(): void;
}

export interface OmpCreateAgentSessionResult {
  session: OmpSession;
  modelFallbackMessage?: string;
  setToolUIContext(uiContext: unknown, hasUI: boolean): void;
}

export interface OmpCreateAgentSessionOptions {
  cwd: string;
  agentDir?: string;
  model: unknown;
  authStorage: OmpAuthStorage;
  modelRegistry: OmpModelRegistry;
  sessionManager: OmpSessionManager;
  settings: unknown;
  skills: unknown[];
  enableMCP: boolean;
  enableLsp: boolean;
  disableExtensionDiscovery?: boolean;
  additionalExtensionPaths?: string[];
  thinkingLevel?: string;
  systemPrompt?: string;
  mcpManager?: OmpMcpManager;
  customTools?: unknown[];
  toolNames: string[];
  hasUI: boolean;
}

export interface OmpCodingAgentSdk {
  MCPManager: new (cwd: string, toolCache?: unknown) => OmpMcpManager;
  createAgentSession(options: OmpCreateAgentSessionOptions): Promise<OmpCreateAgentSessionResult>;
  discoverAuthStorage(agentDir?: string): Promise<OmpAuthStorage>;
  ModelRegistry: new (authStorage: OmpAuthStorage) => OmpModelRegistry;
  Settings: { isolated(overrides?: Record<string, unknown>): unknown };
  SessionManager: {
    getDefaultSessionDir(cwd: string, agentDir?: string): string;
    create(cwd: string, sessionDir?: string): OmpSessionManager;
    list(cwd: string, sessionDir?: string): Promise<OmpSessionInfo[]>;
    open(filePath: string, sessionDir?: string): Promise<OmpSessionManager>;
  };
  discoverSkills(cwd?: string, agentDir?: string): Promise<{ skills: unknown[] }>;
}

export async function loadOmpSdk(): Promise<OmpCodingAgentSdk> {
  const [sdk, mcp] = await Promise.all([
    dynamicImport('@oh-my-pi/pi-coding-agent'),
    dynamicImport('@oh-my-pi/pi-coding-agent/mcp'),
  ]);
  return { ...(sdk as object), ...(mcp as object) } as OmpCodingAgentSdk;
}
