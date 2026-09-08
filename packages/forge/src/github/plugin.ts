import { CHECKS_STATE_OP, RESOLVE_OP } from '../protocol';
import type { BuiltinPlugin, RawOpOutcome } from '../dispatch/plugin-handle';
import { GITHUB_HOST, metadata } from './metadata';
export { GITHUB_HOST } from './metadata';
export interface GitHubPluginOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}
// Handshakes report the same metadata without loading HTTP or validation code.
export function createGitHubPlugin(options: GitHubPluginOptions = {}): BuiltinPlugin {
  return {
    name: metadata.name,
    metadata: () => metadata,
    execOp: async (op, request, env, signal): Promise<RawOpOutcome> => {
      if (op === RESOLVE_OP) {
        const { resolveRequestSchema } = await import('../schemas');
        const parsed = resolveRequestSchema.safeParse(request);
        if (!parsed.success || parsed.data.repo.host !== GITHUB_HOST)
          return {
            kind: 'op_error',
            raw: { kind: 'invalid_request', detail: 'Invalid GitHub repository ref' },
          };
        return {
          kind: 'ok',
          value: {
            forge: metadata.forge,
            repo: parsed.data.repo,
            plugin: { name: metadata.name, version: metadata.version },
          },
        };
      }
      if (op === CHECKS_STATE_OP) {
        const { checksStateRequestSchema } = await import('../schemas');
        const parsed = checksStateRequestSchema.safeParse(request);
        if (!parsed.success)
          return {
            kind: 'op_error',
            raw: { kind: 'invalid_request', detail: 'Invalid checks request' },
          };
        const { checks } = await import('./checks');
        return checks(parsed.data, env, options, signal);
      }
      return { kind: 'op_error', raw: { kind: 'unsupported_op', op } };
    },
  };
}
