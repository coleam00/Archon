import { expect } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';
import { ForgeDispatcher } from '../../dispatch/dispatcher';
import { checksVerdictSchema, type ChecksVerdict } from '../../schemas';
import { createGitHubPlugin } from '../plugin';

const sha = 'a'.repeat(40);
const ref = { repo: { host: 'github.com', path: 'owner/repo' }, number: 42 };
export const baseRef = 'release/queue';
export const run = {
  id: 1,
  name: 'build',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  check_suite: { id: 1 },
  app: { id: 7 },
};
export const legacy = {
  requiresStatusChecks: true,
  requiredStatusCheckContexts: ['build'],
  requiredStatusChecks: [{ context: 'build', app: { databaseId: 7 } }],
};
export const rule = {
  type: 'required_status_checks',
  ruleset_source_type: 'Organization',
  parameters: { required_status_checks: [{ context: 'build', integration_id: 7 }] },
};
interface Fixture {
  subprocess?: boolean;
  protection?: unknown;
  rules?: readonly unknown[];
  runs?: readonly unknown[];
  statuses?: readonly unknown[];
  policyHttp?: number;
  rulesHttp?: number;
  graphqlErrors?: boolean;
  movedBase?: boolean;
  wrongLegacyBase?: boolean;
}
export async function produce(options: Fixture = {}): Promise<{
  result: Awaited<ReturnType<ForgeDispatcher['checksState']>>;
  paths: string[];
}> {
  let pulls = 0;
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async request => {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      expect(request.headers.get('authorization')).toBe('Bearer fixture-secret');
      if (url.pathname === '/graphql') {
        const body = z
          .object({
            query: z.string(),
            variables: z.object({ owner: z.string(), name: z.string(), ref: z.string() }),
          })
          .parse(await request.json());
        expect(body.query).toContain('branchProtectionRule');
        expect(body.variables).toEqual({
          owner: 'owner',
          name: 'repo',
          ref: `refs/heads/${baseRef}`,
        });
        if (options.policyHttp)
          return new Response('fixture-secret inaccessible', { status: options.policyHttp });
        return Response.json({
          ...(options.graphqlErrors ? { errors: [{ message: 'fixture-secret forbidden' }] } : {}),
          data: {
            repository: {
              ref: {
                name: options.wrongLegacyBase ? 'main' : baseRef,
                branchProtectionRule: options.protection ?? null,
              },
            },
          },
        });
      }
      if (url.pathname.endsWith('/pulls/42')) {
        pulls++;
        return Response.json({
          head: { sha },
          base: { ref: options.movedBase && pulls > 1 ? 'other' : baseRef },
        });
      }
      if (url.pathname.endsWith('/check-runs')) {
        const runs = options.runs ?? [run];
        return Response.json({ total_count: runs.length, check_runs: runs });
      }
      if (url.pathname.endsWith('/statuses')) return Response.json(options.statuses ?? []);
      if (url.pathname === '/repos/owner/repo/rules/branches/release%2Fqueue') {
        if (options.rulesHttp)
          return new Response('fixture-secret inaccessible', { status: options.rulesHttp });
        const page = Number(url.searchParams.get('page'));
        return Response.json((options.rules ?? []).slice((page - 1) * 100, page * 100));
      }
      return new Response('unexpected route', { status: 500 });
    },
  });
  try {
    const dispatcher = new ForgeDispatcher(
      [
        options.subprocess
          ? {
              source: 'fixture:github',
              command: process.execPath,
              args: [
                join(import.meta.dir, '../../dispatch/fixtures/github-plugin.ts'),
                server.url.origin,
              ],
            }
          : createGitHubPlugin({ apiBase: server.url.origin }),
      ],
      {
        cwd: process.cwd(),
        env: { GH_TOKEN: 'fixture-secret' },
        discoverHome: async (): Promise<[]> => [],
        discoverPath: async (): Promise<[]> => [],
      }
    );
    return { result: await dispatcher.checksState(ref), paths };
  } finally {
    server.stop(true);
  }
}
export async function verdict(options: Fixture = {}): Promise<ChecksVerdict> {
  const { result } = await produce(options);
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
  return checksVerdictSchema.parse(result.value);
}
