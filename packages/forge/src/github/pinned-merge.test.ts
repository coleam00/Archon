import { beforeAll, afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { removeTempTree } from '@archon/paths/test-utils';
import { ForgeDispatcher } from '../dispatch/dispatcher';
import {
  execBoundedProcess,
  type ExecPluginOptions,
  type ExecPluginOutcome,
} from '../dispatch/exec';
import { createGitHubPlugin } from './plugin';
import { PINNED_MERGE_OP, type PinnedMergeRequest } from '../pinned-merge-schemas';
import type { ForgeOpAuditEvent } from '../schemas';

const exec = promisify(execFile);
const roots: string[] = [];
const track = (root: string): string => {
  roots.push(root);
  return root;
};
const token = 'private-token-that-must-not-leak';
const zero = '0'.repeat(40);
let checkout: string,
  base: string,
  head: string,
  candidate: string,
  ancestor: string,
  reversed: string;
async function git(args: string[], cwd = checkout): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}
beforeAll(async () => {
  checkout = await mkdtemp(join(tmpdir(), 'pinned merge graph '));
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.test']);
  await git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  await writeFile(join(checkout, 'original.txt'), 'original\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'ancestor']);
  ancestor = await git(['rev-parse', 'HEAD']);
  await writeFile(join(checkout, 'base.txt'), 'independently tested base change\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'base change']);
  base = await git(['rev-parse', 'HEAD']);
  await git(['checkout', '-q', '--detach', ancestor]);
  await writeFile(join(checkout, 'head.txt'), 'independently tested PR change\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'head change']);
  head = await git(['rev-parse', 'HEAD']);
  await git(['checkout', '-q', '--detach', base]);
  await git(['merge', '--no-ff', '-qm', 'tested composition', head]);
  candidate = await git(['rev-parse', 'HEAD']);
  reversed = await git([
    'commit-tree',
    await git(['rev-parse', 'HEAD^{tree}']),
    '-p',
    head,
    '-p',
    base,
    '-m',
    'wrong parent ordering',
  ]);
});
afterAll(async () => {
  await removeTempTree(checkout);
});
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) await removeTempTree(root);
});

const wireSchema = z.object({
  query: z.string(),
  variables: z.object({
    temporary: z.string().optional(),
    input: z
      .object({
        repositoryId: z.string(),
        refUpdates: z.array(
          z.object({
            name: z.string(),
            beforeOid: z.string(),
            afterOid: z.string(),
            force: z.boolean(),
          })
        ),
      })
      .optional(),
  }),
});
type Update = NonNullable<z.infer<typeof wireSchema>['variables']['input']>['refUpdates'][number];
async function fixture() {
  const bare = track(await mkdtemp(join(tmpdir(), 'pinned merge remote ')));
  await git(['init', '--bare', '-q', bare]);
  // The server knows both independent changes, but not the tested composition until upload.
  await git(['push', '-q', bare, `${base}:refs/heads/base`, `${head}:refs/heads/head`]);
  const request: PinnedMergeRequest = {
    ref: { repo: { host: 'github.com', path: 'owner/repo' }, number: 7 },
    expected_head_ref: 'refs/heads/head',
    expected_head_sha: head,
    expected_base_ref: 'refs/heads/base',
    expected_base_sha: base,
    candidate_sha: candidate,
    checkout,
  };
  const state = {
    fork: false,
    protection: false,
    merged: false,
    mergeCommit: candidate,
    loseResponse: false,
    readUnavailable: false,
    cleanupFailure: false,
    prHead: head,
    prBaseName: 'base',
    beforeMutation: async (): Promise<void> => {},
    afterUpload: async (): Promise<void> => {},
    afterMutation: async (): Promise<void> => {},
    mutations: [] as Update[][],
    uploads: [] as { args: string[]; options: ExecPluginOptions }[],
    writes: 0,
  };
  async function oid(ref: string): Promise<string | null> {
    try {
      return await git(['rev-parse', '--verify', ref], bare);
    } catch {
      return null;
    }
  }
  type Commit = { oid: string; parents: { nodes: { oid: string }[] } };
  const commits = new Map<string, Commit>();
  async function commit(sha: string): Promise<Commit | null> {
    const cached = commits.get(sha);
    if (cached) return cached;
    try {
      const raw = await git(['cat-file', 'commit', sha], bare);
      const value = {
        oid: sha,
        parents: {
          nodes: raw
            .split('\n\n', 1)[0]
            .split('\n')
            .filter(line => line.startsWith('parent '))
            .map(line => ({ oid: line.slice(7) })),
        },
      };
      commits.set(sha, value);
      return value;
    } catch {
      return null;
    }
  }
  async function serve(req: Request): Promise<Response> {
    expect(req.headers.get('authorization')).toBe(`Bearer ${token}`);
    const { query, variables } = wireSchema.parse(await req.json());
    if (query.startsWith('query')) {
      if (state.readUnavailable) return new Response('unavailable', { status: 503 });
      const refs = new Map(
        (
          await git(
            [
              'for-each-ref',
              '--format=%(refname) %(objectname)',
              'refs/heads/base',
              variables.temporary ?? 'refs/tags/missing',
            ],
            bare
          )
        )
          .split('\n')
          .map(line => {
            const [name, sha] = line.split(' ');
            return [name, sha];
          })
      );
      const b = refs.get('refs/heads/base'),
        t = refs.get(variables.temporary ?? '');
      return Response.json({
        data: {
          repository: {
            id: 'REPO',
            nameWithOwner: 'owner/repo',
            base: b ? { target: { oid: b } } : null,
            temporary: t ? { target: { oid: t } } : null,
            candidate: await commit(candidate),
            pullRequest: {
              number: 7,
              state: state.merged ? 'MERGED' : 'OPEN',
              headRefName: 'head',
              baseRefName: state.prBaseName,
              headRefOid: state.prHead,
              headRepository: {
                id: state.fork ? 'FORK' : 'REPO',
                nameWithOwner: state.fork ? 'other/repo' : 'owner/repo',
              },
              mergeCommit: state.merged ? await commit(state.mergeCommit) : null,
            },
          },
        },
      });
    }
    const input = variables.input!;
    expect(input.repositoryId).toBe('REPO');
    state.mutations.push(input.refUpdates);
    const publishing = input.refUpdates.some(ref => ref.name === 'refs/heads/base');
    if (publishing) await state.beforeMutation();
    if ((publishing && state.protection) || (!publishing && state.cleanupFailure))
      return Response.json({
        errors: [{ type: 'FORBIDDEN', message: `Protected ref refused ${token}` }],
      });
    // Simulate GitHub's documented updateRefs with Git's actual atomic ref transaction.
    // Omitting either beforeOid or either ref really changes the transaction's protection.
    for (const update of input.refUpdates) {
      expect(update.force).toBe(false);
      if (
        update.afterOid !== zero &&
        update.beforeOid !== zero &&
        update.afterOid !== update.beforeOid
      ) {
        try {
          await git(['merge-base', '--is-ancestor', update.beforeOid, update.afterOid], bare);
        } catch {
          return Response.json({
            errors: [{ type: 'UNPROCESSABLE', message: 'Non-fast-forward' }],
          });
        }
      }
    }
    const transaction = [
      'start',
      ...input.refUpdates.map(ref =>
        ref.afterOid === zero
          ? `delete ${ref.name} ${ref.beforeOid}`
          : `update ${ref.name} ${ref.afterOid} ${ref.beforeOid}`
      ),
      'prepare',
      'commit',
      '',
    ].join('\n');
    const command = Bun.which('git')!;
    const applied = await execBoundedProcess({ command, args: ['update-ref', '--stdin'] }, [], {
      env: process.env,
      cwd: bare,
      stdin: transaction,
    });
    if (applied.exitCode !== 0)
      return Response.json({ errors: [{ type: 'UNPROCESSABLE', message: 'CAS rejected' }] });
    state.writes++;
    if (publishing) {
      state.merged = true;
      await state.afterMutation();
    }
    if (publishing && state.loseResponse) return new Response('lost', { status: 502 });
    return Response.json({ data: { updateRefs: { clientMutationId: null } } });
  }
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: serve });
  servers.push(server);
  const apiBase = `http://127.0.0.1:${String(server.port)}`;
  const gitExec = async (
    args: string[],
    options: ExecPluginOptions
  ): Promise<ExecPluginOutcome> => {
    if (args[0] === 'push') state.uploads.push({ args, options });
    const mapped =
      args[0] === 'push'
        ? args.map(arg => (arg === 'https://github.com/owner/repo.git' ? bare : arg))
        : args;
    const result = await execBoundedProcess(
      { command: Bun.which('git')!, args: mapped },
      [],
      options
    );
    if (args[0] === 'push') await state.afterUpload();
    return result;
  };
  const audit: ForgeOpAuditEvent[] = [];
  const controller = new AbortController();
  function dispatcher(external = false, temporaryId?: () => string) {
    return new ForgeDispatcher(
      [
        external
          ? {
              source: 'fixture:github',
              command: process.execPath,
              args: [
                resolve(import.meta.dir, '../dispatch/fixtures/pinned-merge-plugin.ts'),
                apiBase,
                bare,
              ],
            }
          : createGitHubPlugin({ apiBase, gitExec, temporaryId }),
      ],
      {
        cwd: checkout,
        env: { ...process.env, GH_TOKEN: token },
        discoverHome: async () => [],
        discoverPath: async () => [],
        audit: event => {
          audit.push(event);
        },
        signal: controller.signal,
      }
    );
  }
  return { request, state, bare, oid, dispatcher, audit, controller, gitExec, apiBase };
}

describe('pinned merge through dispatcher and real git transport', () => {
  it('refuses plugins without the capability before invoking an operation', async () => {
    const f = await fixture();
    let invoked = false;
    const plugin = createGitHubPlugin();
    const dispatcher = new ForgeDispatcher(
      [
        {
          ...plugin,
          metadata: () => ({ ...plugin.metadata(), capabilities: [] }),
          execOp: async () => {
            invoked = true;
            throw new Error('must not execute');
          },
        },
      ],
      { cwd: checkout, env: {}, discoverHome: async () => [], discoverPath: async () => [] }
    );
    expect(await dispatcher.mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: { kind: 'unsupported_op', op: PINNED_MERGE_OP },
    });
    expect(invoked).toBe(false);
  });
  it('publishes the exact composition through the exec plugin and is idempotent', async () => {
    const f = await fixture();
    expect(await git(['show', `${candidate}:base.txt`])).toContain('base change');
    expect(await git(['show', `${candidate}:head.txt`])).toContain('PR change');
    const result = await f.dispatcher(true).mergePinned(f.request);
    expect(result).toMatchObject({
      kind: 'ok',
      value: {
        status: 'merged',
        candidate_sha: candidate,
        publication: 'applied',
        cleanup: 'removed',
      },
    });
    expect(await f.oid('refs/heads/base')).toBe(candidate);
    expect(f.state.mutations[0]).toEqual([
      { name: 'refs/heads/head', beforeOid: head, afterOid: head, force: false },
      { name: 'refs/heads/base', beforeOid: base, afterOid: candidate, force: false },
    ]);
    const count = f.state.writes;
    expect(await f.dispatcher(true).mergePinned(f.request)).toMatchObject({
      kind: 'ok',
      value: { status: 'already_merged' },
    });
    expect(f.state.writes).toBe(count);
    expect(f.audit).toHaveLength(2);
    expect(f.audit[0]).toMatchObject({
      op: PINNED_MERGE_OP,
      target: 'github.com/owner/repo#7',
      outcome: 'ok',
    });
  });
  for (const move of ['head', 'base', 'both'] as const) {
    it(`atomically refuses ${move} moving after the last read`, async () => {
      const f = await fixture();
      f.state.beforeMutation = async () => {
        if (move !== 'base') {
          await git(['update-ref', 'refs/heads/head', ancestor], f.bare);
          f.state.prHead = ancestor;
        }
        if (move !== 'head') await git(['update-ref', 'refs/heads/base', ancestor], f.bare);
      };
      const result = await f.dispatcher().mergePinned(f.request);
      expect(result).toMatchObject({ kind: 'error', error: { kind: 'verify_failed' } });
      expect(await f.oid('refs/heads/base')).toBe(move === 'head' ? base : ancestor);
      expect(await f.oid('refs/heads/head')).toBe(move === 'base' ? head : ancestor);
      expect(f.state.merged).toBe(false);
    });
  }
  for (const problem of [
    'stale head',
    'stale base',
    'wrong repository',
    'wrong parents',
    'wrong HEAD',
    'dirty',
    'fork',
  ] as const) {
    it(`refuses ${problem} before any mutation`, async () => {
      const f = await fixture();
      if (problem === 'stale head') f.state.prHead = ancestor;
      if (problem === 'stale base') await git(['update-ref', 'refs/heads/base', ancestor], f.bare);
      if (problem === 'wrong repository') f.request.ref.repo.path = 'wrong/repo';
      if (problem === 'wrong parents') {
        f.request.candidate_sha = reversed;
        await git(['checkout', '-q', '--detach', reversed]);
      }
      if (problem === 'wrong HEAD') await git(['checkout', '-q', '--detach', head]);
      if (problem === 'fork') f.state.fork = true;
      if (problem === 'dirty') await writeFile(join(checkout, 'untracked.txt'), 'not tested');
      try {
        expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
          kind: 'error',
          error: { kind: problem === 'fork' ? 'unsupported_op' : 'verify_failed' },
        });
        expect(f.state.uploads).toHaveLength(0);
        expect(f.state.mutations).toHaveLength(0);
      } finally {
        if (problem === 'dirty') await unlink(join(checkout, 'untracked.txt'));
        if (problem === 'wrong parents' || problem === 'wrong HEAD')
          await git(['checkout', '-q', '--detach', candidate]);
      }
    });
  }
  it('honors protection and never leaks credentials', async () => {
    const f = await fixture();
    f.state.protection = true;
    const result = await f.dispatcher().mergePinned(f.request);
    expect(result).toMatchObject({ kind: 'error', error: { kind: 'forge_error' } });
    expect(await f.oid('refs/heads/base')).toBe(base);
    const upload = f.state.uploads[0];
    expect(upload.args).toEqual([
      'push',
      '--porcelain',
      '--',
      'https://github.com/owner/repo.git',
      expect.stringMatching(new RegExp(`^${candidate}:refs/tags/archon-merge-`)),
    ]);
    expect(upload.options.env.GIT_CONFIG_VALUE_2).toContain('Authorization: Basic ');
    expect(
      JSON.stringify(result) + JSON.stringify(f.audit) + JSON.stringify(upload.args)
    ).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(
      Buffer.from(`x-access-token:${token}`).toString('base64')
    );
  });
  it('recovers a lost mutation response with reads and never merges twice', async () => {
    const f = await fixture();
    f.state.loseResponse = true;
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'ok',
      value: { status: 'merged' },
    });
    expect(f.state.mutations.filter(updates => updates.length === 2)).toHaveLength(1);
  });
  it('returns recovery evidence when read-back is unavailable', async () => {
    const f = await fixture();
    f.state.afterMutation = async () => {
      f.state.readUnavailable = true;
    };
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: {
        recovery: { publication: 'applied', cleanup: 'unknown', temporary_ref: expect.any(String) },
      },
    });
    expect(await f.oid('refs/heads/base')).toBe(candidate);
    f.state.readUnavailable = false;
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'ok',
      value: { status: 'already_merged' },
    });
  });
  it('preserves completed merge on cleanup failure', async () => {
    const f = await fixture();
    f.state.cleanupFailure = true;
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'ok',
      value: { status: 'merged', cleanup: 'unknown' },
    });
  });
  it('retains a temporary ref moved by another writer', async () => {
    const f = await fixture();
    f.state.afterMutation = async () => {
      const ref = f.state.uploads[0].args.at(-1)!.split(':').slice(1).join(':');
      await git(['update-ref', ref, head], f.bare);
    };
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'ok',
      value: { status: 'merged', cleanup: 'retained' },
    });
    expect(f.state.mutations).toHaveLength(1);
  });
  it('reports publication applied while PR merged read-back is still pending', async () => {
    const f = await fixture();
    f.state.afterMutation = async () => {
      f.state.merged = false;
    };
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: { kind: 'verify_failed', recovery: { publication: 'applied' } },
    });
    expect(await f.oid('refs/heads/base')).toBe(candidate);
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: { kind: 'verify_failed' },
    });
    expect(f.state.mutations.filter(updates => updates.length === 2)).toHaveLength(1);
  });
  it('never deletes a collided temporary ref', async () => {
    const f = await fixture();
    const id = 'abcdef12-3456-4789-8abc-abcdef123456';
    await git(['update-ref', `refs/tags/archon-merge-${id}`, head], f.bare);
    expect(await f.dispatcher(false, () => id).mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: { kind: 'verify_failed' },
    });
    expect(f.state.uploads).toHaveLength(0);
    expect(f.state.mutations).toHaveLength(0);
    expect(await f.oid(`refs/tags/archon-merge-${id}`)).toBe(head);
  });
  it('stops after cancellation during upload without attempting publication', async () => {
    const f = await fixture();
    f.state.afterUpload = async () => {
      f.controller.abort();
    };
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: { recovery: { publication: 'not_attempted' } },
    });
    expect(f.state.mutations.filter(updates => updates.length === 2)).toHaveLength(0);
    expect(await f.oid('refs/heads/base')).toBe(base);
  });
  it('reconciles cancellation during mutation without reporting a false unmerged result', async () => {
    const f = await fixture();
    f.state.afterMutation = async () => {
      f.controller.abort();
    };
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'ok',
      value: { publication: 'applied', status: 'merged' },
    });
  });
  it('retains the original pins when the exec plugin is cancelled after publication', async () => {
    const f = await fixture();
    f.state.afterMutation = async () => {
      f.controller.abort();
    };
    expect(await f.dispatcher(true).mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: {
        kind: 'verify_failed',
        recovery: {
          ref: f.request.ref,
          candidate_sha: candidate,
          expected_head_sha: head,
          expected_base_sha: base,
          publication: 'unknown',
          cleanup: 'unknown',
        },
      },
    });
    expect(await f.oid('refs/heads/base')).toBe(candidate);
    expect(f.state.mutations.filter(updates => updates.length === 2)).toHaveLength(1);
  });
  it('refuses a changed merge commit on retry', async () => {
    const f = await fixture();
    expect((await f.dispatcher().mergePinned(f.request)).kind).toBe('ok');
    f.state.mergeCommit = head;
    expect(await f.dispatcher().mergePinned(f.request)).toMatchObject({
      kind: 'error',
      error: { kind: 'verify_failed' },
    });
    expect(f.state.mutations.filter(updates => updates.length === 2)).toHaveLength(1);
  });
});
