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

export interface OmpSessionInfo {
  id: string;
  path: string;
}

export interface OmpSession {
  sessionId?: string;
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
  disableExtensionDiscovery: boolean;
  additionalExtensionPaths?: string[];
  thinkingLevel?: string;
  systemPrompt?: string;
  toolNames: string[];
  hasUI: boolean;
}

export interface OmpCodingAgentSdk {
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
  return (await dynamicImport('@oh-my-pi/pi-coding-agent')) as OmpCodingAgentSdk;
}
