import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginDiscoveryError, type PluginDiscovery } from '@archon/forge/discovery';
import type { dispatchForge } from '@archon/forge/dispatch';
import type { ForgeRequest } from '@archon/forge/operations';
import { trackTempRoots } from '@archon/paths/test-utils';
import { changeMergeState, forgeHostDiscoveryOnce, prRefFromAudits } from './forge-host';

const URL10 = 'https://github.com/coleam00/archon-factory-console/pull/10';
const byUrl = (rows: unknown[]) => ({ kind: 'url' as const, url: URL10, audits: rows });
const repo = { host: 'github.com', path: 'coleam00/archon-factory-console' };
const prRecord = {
  repo,
  number: 10,
  schemaVersion: 1,
  url: URL10,
  head: 'archon/task-wirasm-archon-software-factory-deliver-c90ebf41',
  base: 'main',
  is_draft: false,
  state: 'open',
  head_repo: repo,
  head_revision: '387d6145b0d60ddb2c962876a9996a1819d0aff3',
  base_revision: 'bb2a8df9936022499b9ca13598d1079da8d2cb28',
  maintainer_can_modify: false,
} as const;

// Two audit rows a deliver run recorded (live factory, run c90ebf41), as stored.
const audits: unknown[] = [
  {
    integration: 'forge',
    operationId: 'ef5e0efa-c82c-43e4-a820-ff9e80e88179',
    operation: 'pr.reviews',
    target: { repo, number: 10 },
    plugin: { name: 'github', version: '1' },
    result: {
      operationId: 'ef5e0efa-c82c-43e4-a820-ff9e80e88179',
      ok: true,
      result: { op: 'pr.reviews', value: { ref: { repo, number: 10 }, items: [] } },
    },
    retries: 0,
    durationMs: 906,
  },
  {
    integration: 'forge',
    operationId: 'cbadda58-6130-432f-8e56-f403919c776e',
    operation: 'pr.ready',
    target: { repo, number: 10 },
    plugin: { name: 'github', version: '1' },
    result: {
      operationId: 'cbadda58-6130-432f-8e56-f403919c776e',
      ok: true,
      result: {
        op: 'pr.ready',
        value: {
          target: { repo, number: 10 },
          outcome: 'applied',
          changed: true,
          pr: prRecord,
        },
      },
    },
    retries: 0,
    durationMs: 2092,
  },
];

// The dispatch is replaced in these tests, so the plugins it would run through do not matter.
const none: PluginDiscovery = {
  plugins: [],
  unavailable: [],
  byHost: new Map(),
  hostConfig: new Map(),
  pluginTokenEnv: new Map(),
};
const noPlugins = async (): Promise<PluginDiscovery> => none;

type Dispatch = typeof dispatchForge;
type Dispatched = Awaited<ReturnType<Dispatch>>;

function answering(response: Dispatched['response']): {
  dispatch: Dispatch;
  asked: ForgeRequest[];
} {
  const asked: ForgeRequest[] = [];
  const dispatch: Dispatch = async request => {
    asked.push(request);
    return { response, plugin: null, audit: {} as Dispatched['audit'] };
  };
  return { dispatch, asked };
}

const viewed = (state: 'open' | 'closed' | 'merged', mergedAt: string | null) =>
  ({
    operationId: 'op',
    ok: true,
    result: {
      op: 'pr.view',
      value: {
        pr: { ...prRecord, state },
        title: 't',
        body: 'b',
        author: null,
        timestamps: {
          created_at: '2026-11-16T23:40:00Z',
          updated_at: '2026-11-17T01:00:00Z',
          merged_at: mergedAt,
          closed_at: mergedAt,
        },
      },
    },
  }) as unknown as Dispatched['response'];

/** The options a lookup takes, with `dispatch` standing in for the forge. */
const via = (dispatch: Dispatch, discovery = noPlugins) => ({ discovery, env: {}, dispatch });

describe('the merge state of a change', () => {
  test('finds the pull request in the audit rows that carry its record', () => {
    expect(prRefFromAudits(URL10, audits)).toEqual({ repo, number: 10 });
    expect(prRefFromAudits(`${URL10}1`, audits)).toBeNull();
    expect(prRefFromAudits(URL10, [{ not: 'an audit row' }])).toBeNull();
  });
  const noBranches = async (): Promise<string[]> => {
    throw new Error('branches are read only when no audit row names the change');
  };

  test.each([
    ['merged', '2026-11-17T01:00:00Z', true],
    ['open', null, false],
    ['closed', null, false],
  ] as const)('a %s pull request, asked by number with pr.view', async (state, at, merged) => {
    const { dispatch, asked } = answering(viewed(state, at));
    expect(await changeMergeState(byUrl(audits), noBranches, via(dispatch))).toEqual({
      url: URL10,
      merged,
      mergedAt: at,
      number: 10,
    });
    expect(asked).toEqual([
      {
        op: 'pr.view',
        operationId: expect.any(String),
        selector: { kind: 'number', ref: { repo, number: 10 } },
      },
    ]);
  });
});

const refused = {
  operationId: 'op',
  ok: false,
  error: { kind: 'no_credential', message: 'none configured' },
} as unknown as Dispatched['response'];
const resolved = {
  operationId: 'op',
  ok: true,
  result: {
    op: 'resolve',
    value: {
      kind: 'resolved',
      forge: 'github',
      repo,
      plugin: { name: 'github', version: '1' },
      subject: { kind: 'pr', number: 10 },
    },
  },
} as unknown as Dispatched['response'];
const noPr = { operationId: 'op', ok: true, result: { op: 'pr.view', value: null } };

/** A forge that resolves any remote to `repo` and has the pull request `heads` names on each head. */
function forgeWith(heads: Record<string, Dispatched['response'] | null>) {
  const asked: ForgeRequest[] = [];
  const dispatch: Dispatch = async request => {
    asked.push(request);
    const response =
      request.op === 'resolve'
        ? resolved
        : request.op === 'pr.view' && request.selector.kind === 'head'
          ? (heads[request.selector.head] ?? (noPr as unknown as Dispatched['response']))
          : refused;
    return { response, plugin: null, audit: {} as Dispatched['audit'] };
  };
  const walked = () =>
    asked.flatMap(r => (r.op === 'pr.view' && r.selector.kind === 'head' ? [r.selector.head] : []));
  return { dispatch, asked, walked };
}

/** A merged pull request on another head, at another URL (#9). */
const other = (() => {
  const view = viewed('merged', '2026-11-16T00:00:00Z') as unknown as {
    result: { value: { pr: Record<string, unknown> } };
  };
  view.result.value.pr = { ...view.result.value.pr, number: 9, url: `${URL10.slice(0, -2)}9` };
  return view as unknown as Dispatched['response'];
})();

describe('when the forge cannot say, or no audit row names the change', () => {
  test('a forge failure or a throw is unknown, with why', async () => {
    const throwing: Dispatch = async () => {
      throw new Error('spawn failed');
    };
    for (const [dispatch, reason] of [
      [answering(refused).dispatch, 'no_credential: none configured'],
      [throwing, 'spawn failed'],
    ] as const) {
      expect(await changeMergeState(byUrl(audits), async () => [], via(dispatch))).toMatchObject({
        merged: 'unknown',
        number: null,
        reason,
      });
    }
  });

  test('walks the run branches newest first, past none and another URL, to the change', async () => {
    const forge = forgeWith({
      newest: null,
      middle: other,
      oldest: viewed('merged', '2026-11-17T01:00:00Z'),
    });
    const branches = async () => ['newest', 'middle', 'oldest'];
    expect(await changeMergeState(byUrl([]), branches, via(forge.dispatch))).toEqual({
      url: URL10,
      merged: true,
      mergedAt: '2026-11-17T01:00:00Z',
      number: 10,
    });
    expect(forge.asked[0]).toMatchObject({ op: 'resolve', remote: URL10, web: true });
    expect(forge.walked()).toEqual(['newest', 'middle', 'oldest']);
  });

  test("a run that named no URL resolves the project's remote and takes the first pull request", async () => {
    const REMOTE = 'https://github.com/coleam00/archon-factory-console.git';
    const forge = forgeWith({ newest: null, middle: other });
    const branches = async () => ['newest', 'middle'];
    const state = await changeMergeState(
      { kind: 'branch', remote: REMOTE },
      branches,
      via(forge.dispatch)
    );
    expect(state).toMatchObject({ merged: true, number: 9 });
    expect(forge.asked[0]).toMatchObject({ op: 'resolve', remote: REMOTE });
  });
});

describe('forge plugins for the merge lookups', () => {
  const track = trackTempRoots();
  // A home with no config file: discovery reads nothing of the operator's.
  const home = async (): Promise<string> =>
    track(await mkdtemp(join(tmpdir(), 'archon-forge-host-')));
  // The audit rows name the pull request, so no branch is read.
  const noBranches = async (): Promise<string[]> => [];

  test('a failed discovery, or one that left a plugin unavailable, is discovered again', async () => {
    const answers: (() => PluginDiscovery)[] = [
      () => {
        throw new Error('handshake timed out');
      },
      () => ({ ...none, unavailable: [new PluginDiscoveryError('process_failed', 'gone')] }),
      () => none,
    ];
    let discovered = 0;
    const discovery = forgeHostDiscoveryOnce(await home(), {}, async () => {
      const answer = answers[discovered] ?? (() => none);
      discovered += 1;
      return answer();
    });
    const { dispatch } = answering(viewed('merged', '2026-11-17T01:00:00Z'));
    const lookup = () => changeMergeState(byUrl(audits), noBranches, via(dispatch, discovery));
    expect((await lookup()).merged).toBe('unknown');
    await lookup();
    await lookup();
    await lookup();
    expect(discovered).toBe(3);
  });
});
