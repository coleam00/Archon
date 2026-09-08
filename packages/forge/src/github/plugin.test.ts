import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ForgeDispatcher } from '../dispatch/dispatcher';
import { createGitHubPlugin } from './plugin';
import { CHECKS, type ChecksState } from '../schemas';
import type { ChecksVerdict } from '../schemas';
import type { ForgeDispatchResult } from '../dispatch/dispatcher';
const sha = 'a'.repeat(40);
const ref = { repo: { host: 'github.com', path: 'owner/repo' }, number: 42 };
const run = (
  id = 1,
  status = 'completed',
  conclusion: string | null = 'success',
  suite = 1
): {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  check_suite: { id: number };
  app: { id: number };
} => ({
  id,
  name: 'build',
  head_sha: sha,
  status,
  conclusion,
  check_suite: { id: suite },
  app: { id: 1 },
});
const status = (
  id = 1,
  state = 'success',
  context = 'external'
): { id: number; state: string; context: string } => ({ id, context, state });
async function verdict(
  runs: unknown[],
  statuses: unknown[],
  options: { moved?: boolean; malformed?: boolean; http?: number; subprocess?: boolean } = {}
): Promise<{ result: ForgeDispatchResult<ChecksVerdict>; requests: string[] }> {
  const requests: string[] = [];
  let pulls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      expect(request.headers.get('Authorization')).toBe('Bearer fixture-secret');
      if (options.http) return new Response('fixture evidence', { status: options.http });
      if (url.pathname.endsWith('/pulls/42')) {
        pulls++;
        return Response.json({ head: { sha: options.moved && pulls > 1 ? 'b'.repeat(40) : sha } });
      }
      const page = Number(url.searchParams.get('page'));
      if (url.pathname.endsWith(`/commits/${sha}/check-runs`))
        return Response.json(
          options.malformed
            ? {}
            : { total_count: runs.length, check_runs: runs.slice((page - 1) * 100, page * 100) }
        );
      if (url.pathname.endsWith(`/commits/${sha}/statuses`))
        return Response.json(statuses.slice((page - 1) * 100, page * 100));
      return new Response('unexpected API route', { status: 500 });
    },
  });
  try {
    const subject = new ForgeDispatcher(
      [
        options.subprocess
          ? {
              source: 'github-fixture',
              command: process.execPath,
              args: [
                join(import.meta.dir, '../dispatch/fixtures/github-plugin.ts'),
                server.url.origin,
              ],
            }
          : createGitHubPlugin({ apiBase: server.url.origin }),
      ],
      {
        cwd: process.cwd(),
        env: { GH_TOKEN: 'fixture-secret' },
        discoverHome: async () => [],
        discoverPath: async () => [],
      }
    );
    return { result: await subject.checksState(ref), requests };
  } finally {
    await server.stop(true);
  }
}
describe('GitHub REST checks through the public dispatcher', () => {
  it('runs the GitHub implementation over real exec protocol for a valid status-only head', async () => {
    expect((await verdict([], [status()], { subprocess: true })).result).toMatchObject({
      kind: 'ok',
      value: { state: CHECKS.green },
    });
  });
  it('refuses a wrong-SHA API fixture over real exec protocol', async () => {
    expect(
      (await verdict([{ ...run(), head_sha: 'b'.repeat(40) }], [], { subprocess: true })).result
    ).toMatchObject({ kind: 'error', error: { kind: 'invalid_response' } });
  });
  const cases: [string, unknown[], unknown[], ChecksState][] = [
    ['zero units are none, never rollup pending', [], [], CHECKS.none],
    ['check runs alone can be green', [run()], [], CHECKS.green],
    ['external statuses alone are real CI', [], [status()], CHECKS.green],
    ['pending status overrides green runs', [run()], [status(1, 'pending')], CHECKS.pending],
    ['red status overrides green runs', [run()], [status(1, 'failure')], CHECKS.red],
    [
      'same-name push and PR suites both count',
      [run(), run(2, 'completed', 'failure', 2)],
      [],
      CHECKS.red,
    ],
    [
      'latest rerun within a suite wins',
      [run(1, 'completed', 'failure'), run(2)],
      [],
      CHECKS.green,
    ],
    ['latest status replaces its history', [], [status(1, 'failure'), status(2)], CHECKS.green],
    ['cancelled is red', [run(1, 'completed', 'cancelled')], [], CHECKS.red],
    ['action required is gated', [run(1, 'completed', 'action_required')], [], CHECKS.gated],
    ['waiting is gated', [run(1, 'waiting', null)], [], CHECKS.gated],
    ['new run state is unknown', [run(1, 'future_status', null)], [], CHECKS.unknown],
    ['new conclusion is unknown', [run(1, 'completed', 'future_conclusion')], [], CHECKS.unknown],
    ['new commit status is unknown', [], [status(1, 'warning')], CHECKS.unknown],
    ['skipped is non-blocking', [run(1, 'completed', 'skipped')], [], CHECKS.green],
  ];
  for (const [name, runs, statuses, state] of cases)
    it(name, async () => {
      const { result, requests } = await verdict(runs, statuses);
      expect(result).toMatchObject({ kind: 'ok', value: { state, head_sha: sha } });
      expect(requests.some(path => path.includes('/actions/') || path.endsWith('/status'))).toBe(
        false
      );
    });
  it('paginates both systems and keeps counts authoritative beyond the unit cap', async () => {
    const runs = Array.from({ length: 101 }, (_, i) => ({
      ...run(i + 1),
      name: `job${String(i)}`,
    }));
    const statuses = Array.from({ length: 101 }, (_, i) =>
      status(i + 1, i === 100 ? 'failure' : 'success', `context${String(i)}`)
    );
    const { result, requests } = await verdict(runs, statuses);
    expect(result).toMatchObject({
      kind: 'ok',
      value: { state: CHECKS.red, counts: { total: 202, red: 1 } },
    });
    if (result.kind === 'ok') expect(result.value.units).toHaveLength(100);
    expect(requests.filter(path => path.endsWith('page=2'))).toHaveLength(2);
  });
  it('rejects a check run on the wrong SHA', async () => {
    expect((await verdict([{ ...run(), head_sha: 'b'.repeat(40) }], [])).result).toMatchObject({
      kind: 'error',
      error: { kind: 'invalid_response' },
    });
  });
  it('refuses a head change during enumeration', async () => {
    expect((await verdict([run()], [], { moved: true })).result).toMatchObject({
      kind: 'error',
      error: { kind: 'verify_failed', expected: sha, observed: 'b'.repeat(40) },
    });
  });
  it('malformed enumeration cannot become none', async () => {
    expect((await verdict([], [], { malformed: true })).result).toMatchObject({
      kind: 'error',
      error: { kind: 'invalid_response' },
    });
  });
  it('preserves HTTP failure evidence', async () => {
    expect((await verdict([], [], { http: 403 })).result).toMatchObject({
      kind: 'error',
      error: { kind: 'forge_error', status: 403, evidence: 'fixture evidence' },
    });
  });
});
