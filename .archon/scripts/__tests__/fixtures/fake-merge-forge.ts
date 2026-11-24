/**
 * The forge operations the merge queue's gate and merge read, answered from one pull
 * request's merge facts. Installed after the stateful fake forge (./fake-forge.ts) by a
 * merge-queue test preload; every operation it does not answer reaches that fake. It
 * logs every `forge` call it sees, answered or passed on.
 * Answers are typed by `ForgeOperations`, as the stateful fake's are.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import type { ForgeFailure, ForgeOperations } from 'archon:script';

type Op = keyof ForgeOperations;
type Request<O extends Op> = ForgeOperations[O]['request'];
type Result<O extends Op> = ForgeOperations[O]['result'];
type Unit = Result<'checks.state'>['units'][number];
type CheckState = Unit['state'];

/** The pull request the forge reports, and what a merge does to it. */
export interface FakePr {
  readonly state?: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly headRefOid?: string;
  /** CI at the head; `unknown` is a forge unit state that is neither green nor pending. */
  readonly checks?: 'green' | 'pending' | 'red' | 'unknown';
  readonly threads?: number;
  /** The default branch's head as the pull request's merge state reports it. */
  readonly baseRevision?: string;
  /** The merge is accepted and the pull request stays open, as when the forge queues merges. */
  readonly queuesMerge?: boolean;
  /** The merge is applied but names no landed commit, which the contract allows. */
  readonly landsNoCommit?: boolean;
  /** Commits of the default branch the head lacks. */
  readonly behind?: number;
  /** The head conflicts with the default branch. */
  readonly conflicts?: boolean;
  /** CI on the default branch's head; green when unset. */
  readonly baseChecks?: 'green' | 'red' | 'pending';
  readonly baseUnreadable?: boolean;
  /** The head `pr.merge-state` reports, when it answers about another commit than `pr.view`. */
  readonly mergeStateHead?: string;
  /** The revision `checks.state` reports, when it answers about another commit than `pr.view`. */
  readonly checksRevision?: string;
  /** The paths `pr.files` reports the pull request changes. */
  readonly files?: readonly string[];
  /** The revision `pr.files` reports, when the head moved between the gate's reads. */
  readonly filesRevision?: string;
}

export interface MergeForgeSetup {
  /** The fake archon command whose `forge` calls this answers. */
  readonly command: string;
  /** Each answered call is logged here: `forge <op>`, plus `snapshot` for each `pr.view`. */
  readonly log: string;
  readonly head: string;
  /** The default branch's head. */
  readonly base: string;
  /** A pull request URL without its number. */
  readonly prUrlPrefix: string;
}

const MERGE_COMMIT = '3333333333333333333333333333333333333333';

/** One check unit in `state`, and the summary a forge gives a list of them. */
function checks(state: CheckState) {
  const units: Unit[] = [
    {
      unit: { kind: 'check', id: '1', name: 'test' },
      nativeState: state,
      phase: state === 'pending' ? 'pending' : 'completed',
      nativeResult: null,
      result: state === 'green' ? 'success' : state === 'red' ? 'failure' : null,
      state,
    },
  ];
  const counts = { total: 1, green: 0, red: 0, pending: 0, gated: 0, unknown: 0, [state]: 1 };
  return { units, summary: { state, counts } };
}

export function installMergeForge(seed: FakePr, setup: MergeForgeSetup): void {
  const pr: { state: NonNullable<FakePr['state']>; headRefOid: string; checks: CheckState; threads: number } = {
    state: seed.state ?? 'OPEN',
    headRefOid: seed.headRefOid ?? setup.head,
    checks: seed.checks ?? 'green',
    threads: seed.threads ?? 0,
  };
  let mergeCommit: string | null = null;
  const prState = () => (pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed');
  const failure = (message: string, mutation?: ForgeFailure['mutation']): ForgeFailure => ({
    operationId: 'op',
    ok: false,
    error: { kind: 'forge_error', message },
    ...(mutation === undefined ? {} : { mutation }),
  });
  type Answer<O extends Op> = { readonly ok: true; readonly value: Result<O> } | ForgeFailure;
  const done = <O extends Op>(value: Result<O>): Answer<O> => ({ ok: true, value });

  const handlers: { readonly [O in Op]?: (request: Request<O>) => Answer<O> } = {
    'checks.commit': request =>
      seed.baseUnreadable
        ? failure('HTTP 502 reading base')
        : done({ repo: request.repo, branch: 'dev', revision: setup.base, ...checks(seed.baseChecks ?? 'green') }),
    'pr.merge': request => {
      const { ref } = request;
      if (request.conditions.head !== pr.headRefOid) {
        return failure('Head branch was modified', { op: 'pr.merge', target: ref, outcome: 'refused' });
      }
      if (seed.queuesMerge) {
        return failure('the pull request reads back open', {
          op: 'pr.merge',
          target: ref,
          outcome: 'verification_failed',
          leaveBehind: 'a queued merge',
        });
      }
      pr.state = 'MERGED';
      mergeCommit = MERGE_COMMIT;
      return done({
        target: ref,
        outcome: 'applied',
        changed: true,
        pr: view(ref).pr,
        method: request.method,
        conditions: request.conditions,
        enforcedConditions: ['head'],
        landed: { commit: seed.landsNoCommit ? null : mergeCommit, tree: null, parents: null },
      });
    },
    'pr.view': ({ selector }) => {
      if (selector.kind !== 'number') return done(null);
      appendFileSync(setup.log, 'snapshot\n');
      return done(view(selector.ref));
    },
    'pr.merge-state': ({ ref }) =>
      done({
        ref,
        head_revision: seed.mergeStateHead ?? pr.headRefOid,
        base_branch: 'dev',
        base_revision: seed.baseRevision ?? setup.base,
        behind: seed.behind ?? 0,
        mergeable: seed.conflicts ? 'conflict' : 'clean',
        merge_commit: prState() === 'merged' ? mergeCommit : null,
      }),
    'checks.state': ({ ref }) =>
      done({ ref, revision: seed.checksRevision ?? pr.headRefOid, required: null, ...checks(pr.checks) }),
    'pr.files': ({ ref }) =>
      done({
        ref,
        head_revision: seed.filesRevision ?? pr.headRefOid,
        files: (seed.files ?? []).map(path => ({ path, previous_path: null, status: 'modified', patch: null })),
      }),
    'pr.threads': ({ ref }) =>
      done({
        ref,
        threads: Array.from({ length: pr.threads }, (_, index) => ({
          id: `thread-${String(index)}`,
          resolved: false,
          outdated: false,
          path: null,
          line: null,
          comments: [{ id: `c-${String(index)}`, author: null, body: 'A thread', url: 'thread' }],
        })),
      }),
  };

  function view(ref: Request<'pr.merge'>['ref']): NonNullable<Result<'pr.view'>> {
    return {
      title: 'Fix the thing',
      body: '',
      pr: {
        schemaVersion: 1,
        repo: ref.repo,
        number: ref.number,
        url: setup.prUrlPrefix + String(ref.number),
        head: 'feature',
        base: 'dev',
        is_draft: false,
        state: prState(),
        head_repo: ref.repo,
        head_revision: pr.headRefOid,
        base_revision: null,
        maintainer_can_modify: null,
      },
    };
  }

  const delegate = Bun.spawnSync.bind(Bun);
  Object.defineProperty(Bun, 'spawnSync', {
    value: (argv: string[], settings?: unknown) => {
      const passOn = () => (delegate as (argv: string[], settings?: unknown) => unknown)(argv, settings);
      if (argv[1] !== setup.command || argv[2] !== 'forge') return passOn();
      const op = argv[3] ?? '';
      const request = JSON.parse(readFileSync(argv[argv.indexOf('--data-file') + 1] ?? '', 'utf8')) as {
        method?: string;
        conditions?: { head?: string };
      };
      appendFileSync(setup.log, `forge ${op}${op === 'pr.merge' ? ` ${request.method} ${request.conditions?.head}` : ''}\n`);
      const handler = (handlers as Readonly<Record<string, ((request: unknown) => Answer<Op>) | undefined>>)[op];
      // Issue reads and writes, and resolving a URL, go to the stateful fake forge.
      if (handler === undefined) return passOn();
      const answer = handler(request);
      const response = answer.ok ? { operationId: 'op', ok: true, result: { op, value: answer.value } } : answer;
      return { exitCode: answer.ok ? 0 : 1, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.from('') };
    },
  });
}
