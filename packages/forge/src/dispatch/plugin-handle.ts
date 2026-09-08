import { pluginMetadataSchema, type PluginMetadata } from '../schemas';
import { execPlugin, pluginEnvironment, type PluginCandidate } from './exec';
export type RawOpOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'op_error'; raw: unknown }
  | { kind: 'process_failure'; detail: string };
export interface PluginHandle {
  readonly describe: string;
  metadata(): Promise<{ kind: 'ok'; value: PluginMetadata } | { kind: 'invalid'; detail: string }>;
  execOp(
    op: string,
    request: unknown,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<RawOpOutcome>;
}
export interface BuiltinPlugin {
  name: string;
  metadata(): PluginMetadata;
  execOp(
    op: string,
    request: unknown,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<RawOpOutcome>;
}
function validateMetadata(value: unknown): Awaited<ReturnType<PluginHandle['metadata']>> {
  const parsed = pluginMetadataSchema.safeParse(value);
  return parsed.success
    ? { kind: 'ok', value: parsed.data }
    : { kind: 'invalid', detail: 'metadata failed schema validation' };
}
export function builtinPluginHandle(plugin: BuiltinPlugin): PluginHandle {
  return {
    describe: `${plugin.name} (builtin)`,
    metadata: () => Promise.resolve(validateMetadata(plugin.metadata())),
    execOp: (op, request, env, signal) =>
      plugin.execOp(op, request, pluginEnvironment(env, env.ARCHON_FORGE_TOKEN), signal),
  };
}
function parseJson(
  stdout: string
): { kind: 'ok'; value: unknown } | { kind: 'invalid'; detail: string } {
  try {
    return { kind: 'ok', value: JSON.parse(stdout) as unknown };
  } catch {
    return { kind: 'invalid', detail: 'plugin stdout must contain exactly one JSON value' };
  }
}
export function externalPluginHandle(
  candidate: PluginCandidate,
  opts: { env: NodeJS.ProcessEnv; timeoutMs?: number; opTimeoutMs?: number; signal?: AbortSignal }
): PluginHandle {
  return {
    describe: candidate.source,
    metadata: async (): ReturnType<PluginHandle['metadata']> => {
      const result = await execPlugin(candidate, ['metadata'], {
        env: pluginEnvironment(opts.env),
        stdin: '',
        timeoutMs: opts.timeoutMs ?? 10_000,
        signal: opts.signal,
      });
      if (
        result.spawnError ||
        result.timedOut ||
        result.cancelled ||
        result.bufferExceeded ||
        result.exitCode !== 0
      ) {
        return {
          kind: 'invalid',
          detail: 'metadata process failed, timed out, was cancelled, or exceeded its output bound',
        };
      }
      const parsed = parseJson(result.stdout);
      return parsed.kind === 'ok' ? validateMetadata(parsed.value) : parsed;
    },
    execOp: async (op, request, env, signal): Promise<RawOpOutcome> => {
      const result = await execPlugin(candidate, ['op', op], {
        env,
        stdin: JSON.stringify(request),
        timeoutMs: opts.opTimeoutMs,
        signal,
      });
      if (
        result.spawnError ||
        result.timedOut ||
        result.cancelled ||
        result.bufferExceeded ||
        result.terminationError
      ) {
        return {
          kind: 'process_failure',
          detail:
            result.terminationError ??
            (result.timedOut
              ? 'plugin timed out'
              : result.cancelled
                ? 'plugin cancelled'
                : result.bufferExceeded
                  ? 'plugin output exceeded bound'
                  : 'plugin could not launch'),
        };
      }
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return {
          kind: 'process_failure',
          detail: `plugin exited ${String(result.exitCode)}: ${result.stderr.slice(0, 1000)}`,
        };
      }
      const parsed = parseJson(result.stdout);
      if (parsed.kind === 'invalid') return { kind: 'process_failure', detail: parsed.detail };
      return result.exitCode === 0 ? parsed : { kind: 'op_error', raw: parsed.value };
    },
  };
}
