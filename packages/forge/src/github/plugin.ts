import { z } from 'zod';
import {
  CHECKS,
  CHECKS_STATE_OP,
  RESOLVE_OP,
  FORGE_PROTOCOL_VERSION,
  CHECKS_VERDICT_UNITS_CAP,
  aggregateChecks,
  emptyCounts,
  resolveRequestSchema,
  checksStateRequestSchema,
  shaSchema,
  type ChecksStateRequest,
  type ChecksVerdict,
  type PluginMetadata,
  type ForgeOpError,
  type unitStateSchema,
} from '../schemas';
import type { BuiltinPlugin, RawOpOutcome } from '../dispatch/plugin-handle';
export const GITHUB_HOST = 'github.com';
export interface GitHubPluginOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}
const metadata: PluginMetadata = {
  protocol: FORGE_PROTOCOL_VERSION,
  name: 'github',
  version: '1.0.0',
  forge: 'github',
  hosts: [GITHUB_HOST],
  capabilities: [RESOLVE_OP, CHECKS_STATE_OP],
  token_env: 'GH_TOKEN',
};
// Validate the REST fields we consume. Open strings preserve unknown upstream states.
const pullSchema = z.object({ head: z.object({ sha: shaSchema }) });
const runSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  head_sha: shaSchema,
  status: z.string(),
  conclusion: z.string().nullable(),
  check_suite: z.object({ id: z.number().int() }),
  app: z.object({ id: z.number().int() }).nullable(),
});
const statusSchema = z.object({ id: z.number().int(), context: z.string(), state: z.string() });
const runsPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(runSchema),
});
function runState(run: z.infer<typeof runSchema>): z.infer<typeof unitStateSchema> {
  switch (run.status) {
    case 'queued':
    case 'in_progress':
      return CHECKS.pending;
    case 'waiting':
    case 'requested':
    case 'pending':
      return CHECKS.gated;
    case 'completed':
      break;
    default:
      return CHECKS.unknown;
  }
  switch (run.conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return CHECKS.green;
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'stale':
      return CHECKS.red;
    case 'action_required':
      return CHECKS.gated;
    default:
      return CHECKS.unknown;
  }
}
function statusState(state: string): z.infer<typeof unitStateSchema> {
  switch (state) {
    case 'success':
      return CHECKS.green;
    case 'pending':
      return CHECKS.pending;
    case 'failure':
    case 'error':
      return CHECKS.red;
    default:
      return CHECKS.unknown;
  }
}
class ApiError extends Error {
  constructor(readonly error: ForgeOpError) {
    super(error.kind);
  }
}
async function checks(
  request: ChecksStateRequest,
  env: NodeJS.ProcessEnv,
  options: GitHubPluginOptions,
  signal?: AbortSignal
): Promise<RawOpOutcome> {
  if (request.ref.repo.host !== GITHUB_HOST || request.ref.repo.path.split('/').length !== 2) {
    return {
      kind: 'op_error',
      raw: { kind: 'invalid_request', detail: 'GitHub requires a github.com owner/repo ref' },
    };
  }
  const token = env.ARCHON_FORGE_TOKEN;
  if (!token)
    return {
      kind: 'op_error',
      raw: { kind: 'no_credential', host: GITHUB_HOST, token_env: metadata.token_env },
    };
  const timeout = AbortSignal.timeout(30_000);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  async function api<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await (options.fetchImpl ?? fetch)(
      `${options.apiBase ?? 'https://api.github.com'}${path}`,
      {
        signal: boundedSignal,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'archon-forge-github',
        },
      }
    );
    if (!response.ok) {
      // Response bodies may contain reflected secrets; the dispatcher redacts before exposing evidence.
      throw new ApiError({
        kind: 'forge_error',
        status: response.status,
        evidence: (await response.text()).slice(0, 1000),
      });
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new ApiError({
        kind: 'invalid_response',
        detail: 'GitHub response failed schema validation',
      });
    return parsed.data;
  }
  try {
    const base = `/repos/${request.ref.repo.path.split('/').map(encodeURIComponent).join('/')}`;
    const prPath = `${base}/pulls/${String(request.ref.number)}`;
    const headSha = (await api(prPath, pullSchema)).head.sha;
    const runs: z.infer<typeof runSchema>[] = [];
    const statuses: z.infer<typeof statusSchema>[] = [];
    // Fixed-origin page numbers, never follow a server-supplied URL with credentials.
    for (let page = 1; ; page++) {
      if (page > 100)
        throw new ApiError({
          kind: 'invalid_response',
          detail: 'Too many check-run pages to produce a complete verdict',
        });
      const result = await api(
        `${base}/commits/${headSha}/check-runs?filter=all&per_page=100&page=${String(page)}`,
        runsPageSchema
      );
      runs.push(...result.check_runs);
      if (runs.length >= result.total_count) break;
      if (result.check_runs.length === 0)
        throw new ApiError({
          kind: 'invalid_response',
          detail: 'Incomplete check-run enumeration',
        });
    }
    for (let page = 1; ; page++) {
      if (page > 100)
        throw new ApiError({
          kind: 'invalid_response',
          detail: 'Too many status pages to produce a complete verdict',
        });
      const result = await api(
        `${base}/commits/${headSha}/statuses?per_page=100&page=${String(page)}`,
        z.array(statusSchema)
      );
      statuses.push(...result);
      if (result.length < 100) break;
    }
    if (runs.some(run => run.head_sha !== headSha))
      throw new ApiError({
        kind: 'invalid_response',
        detail: 'Check run belongs to a different SHA',
      });
    const observed = (await api(prPath, pullSchema)).head.sha;
    if (observed !== headSha)
      throw new ApiError({ kind: 'verify_failed', expected: headSha, observed });
    // A push suite and a PR suite may have the same job name. Both are current.
    const latestRuns = new Map<string, z.infer<typeof runSchema>>();
    for (const run of runs) {
      const key = JSON.stringify([run.app?.id, run.check_suite.id, run.name]);
      if ((latestRuns.get(key)?.id ?? -1) < run.id) latestRuns.set(key, run);
    }
    const latestStatuses = new Map<string, z.infer<typeof statusSchema>>();
    for (const status of statuses) {
      if ((latestStatuses.get(status.context)?.id ?? -1) < status.id)
        latestStatuses.set(status.context, status);
    }
    const units: ChecksVerdict['units'] = [
      ...[...latestRuns.values()].map(run => ({
        name: run.name,
        source: 'check-run' as const,
        state: runState(run),
      })),
      ...[...latestStatuses.values()].map(status => ({
        name: status.context,
        source: 'status' as const,
        state: statusState(status.state),
      })),
    ];
    const counts = emptyCounts();
    for (const unit of units) {
      counts.total++;
      counts[unit.state]++;
    }
    return {
      kind: 'ok',
      value: {
        state: aggregateChecks(counts),
        counts,
        units: units.slice(0, CHECKS_VERDICT_UNITS_CAP),
        head_sha: headSha,
      } satisfies ChecksVerdict,
    };
  } catch (error) {
    return error instanceof ApiError
      ? { kind: 'op_error', raw: error.error }
      : {
          kind: 'process_failure',
          detail: boundedSignal.aborted
            ? 'GitHub request timed out or was cancelled'
            : 'GitHub request failed or returned invalid JSON',
        };
  }
}
export function createGitHubPlugin(options: GitHubPluginOptions = {}): BuiltinPlugin {
  return {
    name: metadata.name,
    metadata: () => metadata,
    execOp: async (op, request, env, signal): Promise<RawOpOutcome> => {
      if (op === RESOLVE_OP) {
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
        const parsed = checksStateRequestSchema.safeParse(request);
        if (!parsed.success)
          return {
            kind: 'op_error',
            raw: { kind: 'invalid_request', detail: 'Invalid checks request' },
          };
        return checks(parsed.data, env, options, signal);
      }
      return { kind: 'op_error', raw: { kind: 'unsupported_op', op } };
    },
  };
}
