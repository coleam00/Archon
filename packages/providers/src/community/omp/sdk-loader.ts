import { importOmpCodingAgent, importOmpMcp } from './sdk-runtime-imports.js';

export interface OmpAuthStorage {
  setRuntimeApiKey(provider: string, apiKey: string): void;
  getApiKey(provider: string, sessionId?: string): Promise<string | undefined>;
}

export interface OmpModelRegistry {
  find(provider: string, modelId: string): unknown;
  getApiKey(model: unknown, sessionId?: string): Promise<string | undefined>;
  refresh(strategy?: string): Promise<void>;
  refreshInBackground(strategy?: string): void;
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
  setAuthStorage(authStorage: OmpAuthStorage): void;
  disconnectAll(): Promise<void>;
}

export interface OmpSessionInfo {
  id: string;
  path: string;
}

export interface OmpSkill {
  name: string;
  [key: string]: unknown;
}

export interface OmpExtensionRunner {
  setFlagValue(name: string, value: boolean | string): void;
}

export interface OmpToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface OmpExtensionApi {
  on(event: 'tool_call', handler: (event: OmpToolCallEvent) => void | Promise<void>): void;
}

export type OmpExtensionFactory = (api: OmpExtensionApi) => void | Promise<void>;

export interface OmpCustomToolResult {
  content: { type: 'text'; text: string }[];
  details?: unknown;
  isError?: boolean;
}

export interface OmpCustomTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    onUpdate?: unknown,
    context?: unknown,
    signal?: AbortSignal
  ): Promise<OmpCustomToolResult>;
}

export interface OmpSession {
  sessionId?: string;
  extensionRunner?: OmpExtensionRunner;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(prompt: string): Promise<unknown>;
  abort(): Promise<unknown>;
  dispose(): void | Promise<void>;
}

export interface OmpCreateAgentSessionResult {
  session: OmpSession;
  modelFallbackMessage?: string;
  mcpManager?: OmpMcpManager;
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
  skills: OmpSkill[];
  enableMCP: boolean;
  enableLsp: boolean;
  disableExtensionDiscovery?: boolean;
  additionalExtensionPaths?: string[];
  extensions?: OmpExtensionFactory[];
  spawns?: string;
  thinkingLevel?: string;
  systemPrompt?: string[] | ((defaultPrompt: string[]) => string[]);
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
    inMemory?(cwd?: string): OmpSessionManager;
    list(cwd: string, sessionDir?: string): Promise<OmpSessionInfo[]>;
    open(filePath: string, sessionDir?: string): Promise<OmpSessionManager>;
    forkFrom?(filePath: string, cwd: string, sessionDir?: string): Promise<OmpSessionManager>;
  };
  discoverSkills(cwd?: string, agentDir?: string): Promise<{ skills: OmpSkill[] }>;
}

export async function loadOmpSdk(): Promise<OmpCodingAgentSdk> {
  const [sdk, mcp] = await Promise.all([importOmpCodingAgent(), importOmpMcp()]);
  return { ...(sdk as object), ...(mcp as object) } as OmpCodingAgentSdk;
}
