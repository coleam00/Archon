import { dirname } from "node:path";
import { DEFAULTS } from "./defaults.js";
import { resolveEnvIndirection, resolvePath } from "./coerce.js";
import type { WorkflowConfig, WorkflowDefinition } from "../workflow/parse.js";

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key: string;
  project_slug: string | null;
  active_states: string[];
  terminal_states: string[];
  /** Optional `owner/repo` shorthand surfaced to the dashboard for grouping. */
  repository: string | null;
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HookScripts {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export type AgentBackend = "codex" | "claude";

export interface AgentConfig {
  /** Which agent backend the orchestrator should drive. */
  backend: AgentBackend;
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
  /** Resolved per-turn timeout for the active backend (ms). */
  turn_timeout_ms: number;
  /** Resolved orchestrator-level stall threshold for the active backend (ms). */
  stall_timeout_ms: number;
  /**
   * Continuation guidance sent on turns 2..N. Per `SPEC.md:633-634`,
   * continuation turns SHOULD send only continuation guidance, not the full
   * rendered task prompt that already exists in thread history.
   */
  continuation_prompt: string;
}

export interface CodexConfig {
  command: string;
  approval_policy: unknown;
  thread_sandbox: unknown;
  turn_sandbox_policy: unknown;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface ClaudeConfig {
  /** Claude model id (e.g., "claude-sonnet-4-6"). Required when agent.backend = "claude". */
  model: string | null;
  allowed_tools: string[];
  permission_mode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  force_subscription_auth: boolean;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface ServerConfig {
  port: number | null;
  bind_host: string;
}

export interface ConfigSnapshot {
  workflow_path: string;
  workflow_dir: string;
  prompt_template: string;
  raw: WorkflowConfig;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HookScripts;
  agent: AgentConfig;
  codex: CodexConfig;
  claude: ClaudeConfig;
  server: ServerConfig;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  return v.filter((x): x is string => typeof x === "string");
}

function asPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return fallback;
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return fallback;
}

function asStringOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  return null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return fallback;
}

function asNumberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof key !== "string") continue;
    const num = asPositiveInt(value, -1);
    if (num >= 0) out[key.toLowerCase()] = num;
  }
  return out;
}

export function buildSnapshot(
  workflowPath: string,
  definition: WorkflowDefinition,
  env: NodeJS.ProcessEnv = process.env,
): ConfigSnapshot {
  const cfg = definition.config;
  const workflowDir = dirname(workflowPath);

  const tracker = asObject(cfg.tracker);
  const polling = asObject(cfg.polling);
  const workspace = asObject(cfg.workspace);
  const hooks = asObject(cfg.hooks);
  const agent = asObject(cfg.agent);
  const codex = asObject(cfg.codex);
  const claude = asObject(cfg.claude);
  const server = asObject(cfg.server);

  const trackerKind = typeof tracker.kind === "string" ? tracker.kind : "";
  const trackerEndpoint =
    typeof tracker.endpoint === "string"
      ? tracker.endpoint
      : trackerKind === "linear"
        ? DEFAULTS.tracker.endpoint_linear
        : "";

  const apiKeyResolved = resolveEnvIndirection(tracker.api_key, env);
  const trackerCfg: TrackerConfig = {
    kind: trackerKind,
    endpoint: trackerEndpoint,
    api_key: apiKeyResolved ?? "",
    project_slug:
      typeof tracker.project_slug === "string" && tracker.project_slug.trim() !== ""
        ? tracker.project_slug.trim()
        : null,
    active_states: asStringList(tracker.active_states, DEFAULTS.tracker.active_states as unknown as string[]),
    terminal_states: asStringList(
      tracker.terminal_states,
      DEFAULTS.tracker.terminal_states as unknown as string[],
    ),
    repository:
      typeof tracker.repository === "string" && tracker.repository.trim() !== ""
        ? tracker.repository.trim()
        : null,
  };

  const pollingCfg: PollingConfig = {
    interval_ms: asPositiveInt(polling.interval_ms, DEFAULTS.polling.interval_ms),
  };

  const workspaceRootRaw =
    typeof workspace.root === "string" && workspace.root.trim() !== ""
      ? workspace.root.trim()
      : DEFAULTS.workspace.rootDefault();

  const workspaceCfg: WorkspaceConfig = {
    root: resolvePath(workspaceRootRaw, workflowDir, env),
  };

  const hooksCfg: HookScripts = {
    after_create: asStringOrNull(hooks.after_create),
    before_run: asStringOrNull(hooks.before_run),
    after_run: asStringOrNull(hooks.after_run),
    before_remove: asStringOrNull(hooks.before_remove),
    timeout_ms: asPositiveInt(hooks.timeout_ms, DEFAULTS.hooks.timeout_ms),
  };

  const codexCfg: CodexConfig = {
    command:
      typeof codex.command === "string" && codex.command.trim() !== ""
        ? codex.command
        : DEFAULTS.codex.command,
    approval_policy: codex.approval_policy ?? null,
    thread_sandbox: codex.thread_sandbox ?? null,
    turn_sandbox_policy: codex.turn_sandbox_policy ?? null,
    turn_timeout_ms: asPositiveInt(codex.turn_timeout_ms, DEFAULTS.codex.turn_timeout_ms),
    read_timeout_ms: asPositiveInt(codex.read_timeout_ms, DEFAULTS.codex.read_timeout_ms),
    stall_timeout_ms: asInt(codex.stall_timeout_ms, DEFAULTS.codex.stall_timeout_ms),
  };

  const permissionModeRaw =
    typeof claude.permission_mode === "string" ? claude.permission_mode : "";
  const permissionMode: ClaudeConfig["permission_mode"] =
    permissionModeRaw === "default" ||
    permissionModeRaw === "acceptEdits" ||
    permissionModeRaw === "plan" ||
    permissionModeRaw === "bypassPermissions"
      ? permissionModeRaw
      : DEFAULTS.claude.permission_mode;

  const claudeCfg: ClaudeConfig = {
    model: typeof claude.model === "string" && claude.model.trim() !== "" ? claude.model.trim() : null,
    allowed_tools: asStringList(claude.allowed_tools, DEFAULTS.claude.allowed_tools as unknown as string[]),
    permission_mode: permissionMode,
    force_subscription_auth: asBool(claude.force_subscription_auth, DEFAULTS.claude.force_subscription_auth),
    turn_timeout_ms: asPositiveInt(claude.turn_timeout_ms, DEFAULTS.claude.turn_timeout_ms),
    read_timeout_ms: asPositiveInt(claude.read_timeout_ms, DEFAULTS.claude.read_timeout_ms),
    stall_timeout_ms: asInt(claude.stall_timeout_ms, DEFAULTS.claude.stall_timeout_ms),
  };

  const backendRaw = typeof agent.backend === "string" ? agent.backend.toLowerCase() : "";
  const backend: AgentBackend = backendRaw === "claude" ? "claude" : "codex";

  const continuationRaw =
    typeof agent.continuation_prompt === "string" && agent.continuation_prompt.trim() !== ""
      ? agent.continuation_prompt
      : DEFAULTS.agent.continuation_prompt;

  const agentCfg: AgentConfig = {
    backend,
    max_concurrent_agents: asPositiveInt(
      agent.max_concurrent_agents,
      DEFAULTS.agent.max_concurrent_agents,
    ),
    max_turns: Math.max(
      1,
      asPositiveInt(agent.max_turns, DEFAULTS.agent.max_turns),
    ),
    max_retry_backoff_ms: asPositiveInt(
      agent.max_retry_backoff_ms,
      DEFAULTS.agent.max_retry_backoff_ms,
    ),
    max_concurrent_agents_by_state: asNumberMap(agent.max_concurrent_agents_by_state),
    turn_timeout_ms: backend === "claude" ? claudeCfg.turn_timeout_ms : codexCfg.turn_timeout_ms,
    stall_timeout_ms: backend === "claude" ? claudeCfg.stall_timeout_ms : codexCfg.stall_timeout_ms,
    continuation_prompt: continuationRaw,
  };

  const serverCfg: ServerConfig = {
    port:
      typeof server.port === "number" && Number.isFinite(server.port)
        ? Math.max(0, Math.floor(server.port))
        : null,
    bind_host:
      typeof server.bind_host === "string" && server.bind_host.trim() !== ""
        ? server.bind_host.trim()
        : DEFAULTS.http.bind_host,
  };

  return {
    workflow_path: workflowPath,
    workflow_dir: workflowDir,
    prompt_template: definition.prompt_template,
    raw: cfg,
    tracker: trackerCfg,
    polling: pollingCfg,
    workspace: workspaceCfg,
    hooks: hooksCfg,
    agent: agentCfg,
    codex: codexCfg,
    claude: claudeCfg,
    server: serverCfg,
  };
}
