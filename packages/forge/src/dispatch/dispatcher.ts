import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ZodType } from 'zod';
import {
  publicRequestSchema,
  publicRequestRepo,
  publicResultSchemas,
  type PublicRequest,
  type PublicResult,
} from '../schemas';
import {
  CHECKS_STATE_OP,
  RESOLVE_OP,
  FORGE_PROTOCOL_VERSION,
  checksStateRequestSchema,
  checksStateResultSchema,
  resolveRequestSchema,
  resolveResultSchema,
  repoRefSchema,
  forgeOpErrorSchema,
  forgeHostsConfigSchema,
  type ChecksStateRequest,
  type ChecksStateResult,
  type ForgeOpError,
  type ForgeHostsConfig,
  type PluginMetadata,
  type RepoRef,
  type ResolveResult,
  type ForgeOpAuditEvent,
  type ForgeProcessFailure,
} from '../schemas';
import { discoverHomePlugins, discoverPathPlugins } from './discovery';
import { pluginEnvironment, redactPluginText, type PluginCandidate } from './exec';
import {
  builtinPluginHandle,
  externalPluginHandle,
  type BuiltinPlugin,
  type PluginHandle,
  type RawOpOutcome,
} from './plugin-handle';
const execFileAsync = promisify(execFile);
export class DuplicateHostClaimError extends Error {
  constructor(host: string) {
    super(`Duplicate forge plugin claim for ${host}`);
    this.name = 'DuplicateHostClaimError';
  }
}
export interface ForgeDispatchOk<T> {
  kind: 'ok';
  value: T;
  plugin?: Pick<PluginMetadata, 'name' | 'version'>;
}
export interface ForgeDispatchErr {
  kind: 'error';
  error: ForgeOpError;
  plugin?: Pick<PluginMetadata, 'name' | 'version'>;
}
export type ForgeDispatchResult<T> = ForgeDispatchOk<T> | ForgeDispatchErr | ForgeProcessFailure;
interface HandshakenPlugin {
  handle: PluginHandle;
  metadata: PluginMetadata;
}
export interface DispatcherOptions {
  resolveCredential?: (host: string) => Promise<string | undefined>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  configuredHosts?: ForgeHostsConfig;
  discoverHome?: typeof discoverHomePlugins;
  discoverPath?: typeof discoverPathPlugins;
  diagnostic?: (reason: string) => void;
  audit?: (event: ForgeOpAuditEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export class ForgeDispatcher {
  private readonly configuredHosts: ForgeHostsConfig;
  private handshaken?: Promise<Map<string, HandshakenPlugin>>;
  private resolved?: Promise<ForgeDispatchResult<ResolveResult>>;
  constructor(
    private readonly builtins: (BuiltinPlugin | PluginCandidate)[],
    private readonly opts: DispatcherOptions
  ) {
    this.configuredHosts = forgeHostsConfigSchema.parse(opts.configuredHosts ?? {});
  }
  private plugins(): Promise<Map<string, HandshakenPlugin>> {
    return (this.handshaken ??= this.loadPlugins());
  }
  private async loadPlugins(): Promise<Map<string, HandshakenPlugin>> {
    const diagnostic = this.opts.diagnostic ?? console.error;
    const candidates = [
      ...Object.values(this.configuredHosts).map(entry => ({
        source: `config:${entry.plugin}`,
        command: entry.command,
        args: entry.args,
      })),
      ...(await (this.opts.discoverHome ?? discoverHomePlugins)(diagnostic)),
      ...(await (this.opts.discoverPath ?? discoverPathPlugins)(
        this.opts.env.PATH ?? this.opts.env.Path,
        diagnostic
      )),
    ];
    const distinct = candidates.filter(
      (candidate, index) =>
        candidates.findIndex(
          other =>
            other.command === candidate.command &&
            JSON.stringify(other.args) === JSON.stringify(candidate.args)
        ) === index
    );
    const handles = [
      ...this.builtins.map(plugin =>
        'command' in plugin
          ? externalPluginHandle(plugin, {
              env: this.opts.env,
              signal: this.opts.signal,
              opTimeoutMs: this.opts.timeoutMs,
            })
          : builtinPluginHandle(plugin)
      ),
      ...distinct.map(candidate =>
        externalPluginHandle(candidate, {
          env: this.opts.env,
          signal: this.opts.signal,
          opTimeoutMs: this.opts.timeoutMs,
        })
      ),
    ];
    const byHost = new Map<string, HandshakenPlugin>();
    const byName = new Map<string, HandshakenPlugin>();
    for (const handle of handles) {
      const response = await handle.metadata();
      if (response.kind === 'invalid' || response.value.protocol !== FORGE_PROTOCOL_VERSION) {
        diagnostic(
          `${handle.describe}: ${response.kind === 'invalid' ? response.detail : 'incompatible protocol'}`
        );
        continue;
      }
      const plugin = { handle, metadata: response.value };
      if (byName.has(plugin.metadata.name))
        throw new Error(`Duplicate forge plugin name: ${plugin.metadata.name}`);
      byName.set(plugin.metadata.name, plugin);
      for (const host of plugin.metadata.hosts) {
        if (byHost.has(host)) throw new DuplicateHostClaimError(host);
        byHost.set(host, plugin);
      }
    }
    for (const [host, entry] of Object.entries(this.configuredHosts)) {
      const plugin = byName.get(entry.plugin);
      if (!plugin)
        throw new Error(`Configured forge plugin ${entry.plugin} did not pass its handshake`);
      if (byHost.has(host) && byHost.get(host) !== plugin) throw new DuplicateHostClaimError(host);
      byHost.set(host, plugin);
    }
    return byHost;
  }
  private async audited<T>(
    op: string,
    target: string | (() => string),
    action: () => Promise<ForgeDispatchResult<T>>
  ): Promise<ForgeDispatchResult<T>> {
    const start = Date.now();
    let result: ForgeDispatchResult<T>;
    try {
      result = await action();
    } catch (error) {
      this.opts.audit?.({
        op,
        target: typeof target === 'string' ? target : target(),
        outcome: 'process_failure',
        duration_ms: Date.now() - start,
      });
      throw error;
    }
    this.opts.audit?.({
      op,
      target: typeof target === 'string' ? target : target(),
      plugin: result.plugin,
      outcome:
        result.kind === 'ok' ? 'ok' : result.kind === 'error' ? result.error.kind : result.kind,
      duration_ms: Date.now() - start,
    });
    return result;
  }
  resolve(): Promise<ForgeDispatchResult<ResolveResult>> {
    return (this.resolved ??= this.resolveWorkspace());
  }
  private async resolveWorkspace(): Promise<ForgeDispatchResult<ResolveResult>> {
    let repo: RepoRef | null = null;
    return this.audited(
      RESOLVE_OP,
      () => (repo ? `${repo.host}/${repo.path}` : 'workspace:origin'),
      async () => {
        // --get exit 1 means no configured origin; other failures are not no-forge.
        try {
          const result = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
            cwd: this.opts.cwd,
            env: this.opts.env,
            timeout: 10_000,
          });
          if (result.stdout.trim()) {
            const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
              cwd: this.opts.cwd,
              env: this.opts.env,
              timeout: 10_000,
            });
            repo = parseRemoteUrl(remote.stdout.trim());
          }
        } catch (error) {
          if ((error as { code?: unknown }).code !== 1)
            return { kind: 'process_failure', detail: 'Could not read git origin configuration' };
        }
        if (!repo) return { kind: 'ok', value: { forge: 'none' } };
        const result = await this.dispatch(
          RESOLVE_OP,
          repo.host,
          resolveRequestSchema.parse({ repo }),
          resolveResultSchema,
          false
        );
        if (result.kind === 'error' && result.error.kind === 'no_plugin_for_host')
          return { kind: 'ok', value: { forge: 'none', repo } };
        if (
          result.kind === 'ok' &&
          (result.value.repo?.host !== repo.host || result.value.repo.path !== repo.path)
        ) {
          return {
            kind: 'error',
            error: { kind: 'invalid_response', detail: 'resolve changed repository identity' },
          };
        }
        return result;
      }
    );
  }
  checksState(ref: ChecksStateRequest['ref']): Promise<ForgeDispatchResult<ChecksStateResult>> {
    const parsed = checksStateRequestSchema.safeParse({ ref });
    return this.audited(
      CHECKS_STATE_OP,
      parsed.success ? `${ref.repo.host}/${ref.repo.path}#${String(ref.number)}` : 'invalid-ref',
      async () => {
        if (!parsed.success)
          return {
            kind: 'error',
            error: { kind: 'invalid_request', detail: 'checks requires a qualified PR ref' },
          };
        return this.dispatch(
          CHECKS_STATE_OP,
          ref.repo.host,
          parsed.data,
          checksStateResultSchema,
          true
        );
      }
    );
  }
  publicOperation(request: PublicRequest): Promise<ForgeDispatchResult<PublicResult>> {
    const parsed = publicRequestSchema.safeParse(request);
    const repo = parsed.success ? publicRequestRepo(parsed.data) : undefined;
    return this.audited(
      parsed.success ? parsed.data.op : 'invalid',
      repo && parsed.success
        ? `${repo.host}/${repo.path}${parsed.data.op === 'pr.create' ? '' : parsed.data.op === 'comment.upsert' ? `#${String(parsed.data.target.ref.number)}:${parsed.data.target.kind}` : `#${String(parsed.data.ref.number)}`}`
        : 'invalid-ref',
      async () => {
        if (!parsed.success || !repo)
          return {
            kind: 'error',
            error: {
              kind: 'invalid_request',
              detail: 'Public operation requires qualified identity',
            },
          };
        const schema: ZodType<PublicResult> = publicResultSchemas[parsed.data.op];
        return this.dispatch(parsed.data.op, repo.host, parsed.data, schema, true);
      }
    );
  }
  private async dispatch<T>(
    op: string,
    host: string,
    request: unknown,
    schema: ZodType<T>,
    needsToken: boolean
  ): Promise<ForgeDispatchResult<T>> {
    const plugin = (await this.plugins()).get(host);
    if (!plugin) return { kind: 'error', error: { kind: 'no_plugin_for_host', host } };
    const id = { name: plugin.metadata.name, version: plugin.metadata.version };
    if (!plugin.metadata.capabilities.includes(op))
      return { kind: 'error', error: { kind: 'unsupported_op', op, plugin: id.name }, plugin: id };
    const tokenEnv = this.configuredHosts[host]?.token_env ?? plugin.metadata.token_env;
    let token = needsToken
      ? this.configuredHosts[host]?.token_env
        ? this.opts.env[tokenEnv ?? '']
        : host === 'github.com'
          ? this.opts.env.GH_TOKEN || this.opts.env.GITHUB_TOKEN
          : this.opts.env[tokenEnv ?? '']
      : undefined;
    if (needsToken && !token && !this.configuredHosts[host]?.token_env)
      token = await this.opts.resolveCredential?.(host);
    if (needsToken && tokenEnv && !token)
      return {
        kind: 'error',
        error: { kind: 'no_credential', host, token_env: tokenEnv },
        plugin: id,
      };
    const publicRequest = publicRequestSchema.safeParse(request);
    if (publicRequest.success && 'body' in publicRequest.data) {
      const content = [
        publicRequest.data.body,
        ...('title' in publicRequest.data ? [publicRequest.data.title] : []),
      ].join('\n');
      const artifacts = this.opts.env.ARTIFACTS_DIR?.replaceAll('\\', '/');
      if (
        (token && content.includes(token)) ||
        (artifacts && content.replaceAll('\\', '/').includes(artifacts))
      ) {
        return {
          kind: 'error',
          error: {
            kind: 'invalid_request',
            detail: 'Public content contains a selected credential or local artifact path',
          },
          plugin: id,
        };
      }
    }
    const env = pluginEnvironment(this.opts.env, token);
    let outcome: RawOpOutcome;
    try {
      outcome = await plugin.handle.execOp(op, request, env, this.opts.signal);
    } catch {
      return { kind: 'process_failure', detail: 'Plugin execution failed', plugin: id };
    }
    // Redact all plugin-controlled strings, including valid JSON errors and successes.
    const encodedToken = token ? JSON.stringify(token).slice(1, -1) : undefined;
    outcome = JSON.parse(
      redactPluginText(JSON.stringify(outcome), { ARCHON_FORGE_TOKEN: encodedToken })
    ) as RawOpOutcome;
    if (outcome.kind === 'process_failure') return { ...outcome, plugin: id };
    if (outcome.kind === 'op_error') {
      const parsed = forgeOpErrorSchema.safeParse(outcome.raw);
      return {
        kind: 'error',
        error: parsed.success
          ? parsed.data
          : { kind: 'invalid_response', detail: 'Plugin op error failed schema validation' },
        plugin: id,
      };
    }
    const parsed = schema.safeParse(outcome.value);
    return parsed.success
      ? { kind: 'ok', value: parsed.data, plugin: id }
      : {
          kind: 'error',
          error: { kind: 'invalid_response', detail: 'Plugin response failed schema validation' },
          plugin: id,
        };
  }
}
export function parseRemoteUrl(remote: string): RepoRef | null {
  if (/^[A-Za-z]:/.test(remote)) return null;
  let host: string;
  let path: string;
  try {
    const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
    if (scp && !remote.includes('://')) {
      host = scp[1].toLowerCase();
      path = scp[2];
    } else {
      const url = new URL(remote);
      if (
        !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) ||
        url.port ||
        url.search ||
        url.hash
      )
        return null;
      host = url.hostname.toLowerCase();
      path = url.pathname.replace(/^\//, '');
    }
    path = path.replace(/\.git\/?$/, '').replace(/\/$/, '');
    const parsed = repoRefSchema.safeParse({ host, path });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
