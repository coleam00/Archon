/**
 * A fake `archon` and `gh` for the intake bench's own process.
 *
 * The bench reaches `archon` through `Bun.spawn` and `gh` through `Bun.spawnSync`.
 * `install` answers both inside the bench process, loaded through a generated
 * `--preload`, so no stub executable has to be found on `PATH`. Every other command,
 * git included, runs for real.
 *
 * Its state is a directory. `config.json` holds the scenario: the baseline binding a
 * dry run resolves, the tracker's issues and searches, whether a launched run writes a
 * label to its issue, and whether an outside row's triage agent runs anyway. Each
 * launch's arguments land in `argv-<n>.json`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Closure } from '../../workflows/sdlc/.shared/close';

export interface FakeIssue {
  readonly number: number;
  readonly repo?: { host: string; path: string };
  readonly title?: string;
  readonly url?: string;
  readonly body?: string;
  readonly creation?: { title: string; body: string } | null;
  readonly labels: string[];
  readonly comments: number;
  readonly commentBodies?: readonly { id: string; body: string }[];
  /** Defaults to closed. */
  readonly state?: 'open' | 'closed';
  readonly author?: string;
  /** Pull requests that reference the issue. */
  readonly refs?: readonly { connected?: boolean; url: string; merged: boolean; oid: string | null }[];
}

export interface FakeConfig {
  readonly unavailableRepos?: readonly string[];
  readonly declaredClosure?: Closure;
  readonly recordedContract?: 'NO_ACTION' | 'READY';
  readonly posted?: readonly { number: number; body: string }[];
  /** What the triage tier resolves to with no config layer; null resolves nothing. */
  readonly baseline: { provider: string; model: string; effort?: string } | null;
  readonly repo: { host: string; path: string };
  readonly issues: FakeIssue[];
  /** A launched run adds this label to the issue it judges, as a broken eval would. */
  readonly writeLabel?: string;
  /** An outside row's included triage agent runs, as a broken trust boundary would. */
  readonly outsideAgentRuns?: boolean;
  /** archon-triage's agent node records no execution, so no binding. */
  readonly unboundTriage?: boolean;
  /** archon-triage's agent node ran on this binding, whatever the launch pinned. */
  readonly triageRanAs?: { provider: string; model: string };
  /** A launched run comments on its issue and revises a state document, as a broken eval would. */
  readonly commentAndRecord?: boolean;
  /** After a launched run, every issue read fails, as a lost tracker would. */
  readonly issueReadsFailAfterRun?: boolean;
  /** A run's transcript path names a directory, so reading it fails. */
  readonly unreadableTranscript?: boolean;
  /** A run records no transcript. */
  readonly noTranscript?: boolean;
  /** Intake takes this path on a trust: auto row, so triage does not run. */
  readonly autoPath?: 'quiet' | 'closed';
  /** The project key `archon state list` names. */
  readonly projectKey: string;
  /** Every launched run ends with this status, as a run another run's checkout lock cancelled would. */
  readonly runStatus?: 'cancelled' | 'failed';
  /** Every launched run fails before any node starts, as a refused provider credential does. */
  readonly launchFails?: true;
  /** Issue numbers a tracker search answers, by a fragment of its query. */
  readonly searches?: Record<string, number[]>;
}

const verdict = {
  contract: 'BLOCKED',
  route: 'no_action',
  pull_request: null,
  ready: false,
  type: { value: 'feature', reason: 'r' },
  size: { value: 's', reason: 'r' },
  complexity: { value: 'low', reason: 'r' },
  importance: { value: 'low', reason: 'r' },
  urgency: { value: 'none', reason: 'r' },
  labels: ['archon-blocked'],
  published: false,
  proposed_edits: { title: '', body: '' },
  blocked_reason: 'A maintainer decides.',
  blocked_by: ['https://github.com/o/r/issues/1'],
  summary: 'Blocked on a maintainer.',
  report: { type: 'archon_artifact', run_id: 'x', path: 'triage.md' },
};

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function inputs(args: readonly string[]): Record<string, string> {
  const found: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== '--input') return;
    const value = args[index + 1];
    found[value.slice(0, value.indexOf('='))] = value.slice(value.indexOf('=') + 1);
  });
  return found;
}

function binding(args: readonly string[], config: FakeConfig): FakeConfig['baseline'] {
  const layer = option(args, '--config');
  if (layer === undefined) return config.baseline;
  const parsed = Bun.YAML.parse(readFileSync(layer, 'utf8')) as { tiers: { medium: FakeConfig['baseline'] } };
  return parsed.tiers.medium;
}

interface FakeNode {
  readonly id: string;
  readonly state: string;
  /** Absent for a node that recorded no execution row. */
  readonly kind?: string;
  readonly binding?: unknown;
  readonly structuredOutput?: unknown;
}

function agent(id: string, state: string, bound: FakeConfig['baseline']): FakeNode {
  // The engine records a skipped agent node with an empty binding.
  const binding =
    state === 'skipped'
      ? {}
      : { provider: bound?.provider, tier: 'medium', model: { requested: bound?.model, resolved: { source: 'unavailable', reason: 'not_reported' } } };
  return { id, state, kind: 'agent', binding };
}

/** Each node's execution row, as `workflow get --events` lists them. */
function events(nodes: readonly FakeNode[]) {
  return nodes.flatMap(({ id, state, kind, binding, structuredOutput }) => {
    if (kind === undefined) return [];
    const spend = kind === 'agent' && state !== 'skipped' ? { spend: { costUsd: { source: 'provider', value: 0.5 } } } : {};
    const data = { node: { id, kind }, binding: binding ?? {}, structured_output: structuredOutput, ...spend };
    return [{ step_name: id, event_type: state === 'skipped' ? 'node_skipped' : 'node_completed', data }];
  });
}

function answer(dir: string, args: readonly string[]): string {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as FakeConfig;
  const save = (): void => writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  if (args[0] === 'state' && args[1] === 'list') {
    const runs = existsSync(join(dir, 'count')) ? Number(readFileSync(join(dir, 'count'), 'utf8')) : 0;
    const documents = config.commentAndRecord === true ? [{ name: 'work/12', revision: runs + 1 }] : [];
    return JSON.stringify({ scope: { kind: 'project', key: config.projectKey }, documents });
  }
  if (args[0] === 'state' && args[1] === 'get') {
    const work = join(dir, `${args[2].replace('/', '-')}.json`);
    return JSON.stringify({ name: args[2], revision: 2, value: { facts: existsSync(work) ? JSON.parse(readFileSync(work, 'utf8')) : {} } });
  }
  if (args[0] !== 'workflow') throw new Error(`fake archon: unexpected command ${args.join(' ')}`);
  if (args[1] === 'run' && args.includes('--dry-run')) {
    const resolved = binding(args, config);
    return JSON.stringify({ trace: [{ nodeId: 'triage', ...(resolved === null ? {} : { resolution: resolved }) }] });
  }
  if (args[1] === 'run') {
    const count = join(dir, 'count');
    const n = (existsSync(count) ? Number(readFileSync(count, 'utf8')) : 0) + 1;
    writeFileSync(count, String(n));
    writeFileSync(join(dir, `argv-${n}.json`), JSON.stringify(args));
    const given = inputs(args);
    if (config.issueReadsFailAfterRun === true) {
      config.issues.length = 0;
      save();
    }
    if (config.commentAndRecord === true && given.number !== undefined) {
      const judged = config.issues.find(issue => issue.number === Number(given.number));
      if (judged !== undefined) config.issues[config.issues.indexOf(judged)] = { ...judged, comments: judged.comments + 1 };
      save();
    }
    if (config.writeLabel !== undefined && given.number !== undefined) {
      config.issues.find(issue => issue.number === Number(given.number))?.labels.push(config.writeLabel);
      save();
    }
    if (given.number === '101') {
      for (const post of config.posted ?? []) {
        const index = config.issues.findIndex(issue => issue.number === post.number);
        const issue = config.issues[index];
        config.issues[index] = { ...issue, comments: issue.comments + 1, commentBodies: [...(issue.commentBodies ?? Array.from({ length: issue.comments }, (_, i) => ({ id: `old-${i}`, body: 'Old comment' }))), { id: `post-${n}-${issue.comments}`, body: post.body }] };
      }
      save();
    }
    const bound = binding(args, config);
    const intake = args[2] === 'archon-intake';
    const outside = given.trust === 'outside';
    const path = outside ? 'outside' : (config.autoPath ?? 'triage');
    const triageRan = !intake || path === 'triage' || (outside && config.outsideAgentRuns === true);
    // A live intake run that triages records its verdict on the item's work document;
    // one that does not leaves an earlier run's there.
    const work = join(dir, `work-${given.number}.json`);
    if (given.mode === 'live' && path === 'triage') {
      const field = { value: 'bug', reason: 'r' };
      const contract = config.recordedContract ?? (config.declaredClosure ? 'NO_ACTION' : 'READY');
      const triage = { verdict: { contract, route: contract === 'NO_ACTION' ? null : 'plan' }, pull_request: null, type: field, size: { value: 'm', reason: 'r' }, complexity: { value: 'low', reason: 'r' }, importance: { value: 'low', reason: 'r' }, urgency: { value: 'none', reason: 'r' }, run_id: `run-${n}` };
      writeFileSync(work, JSON.stringify({ triage }));
    } else if (given.mode === 'live' && !existsSync(work)) {
      writeFileSync(work, JSON.stringify({ triage: { verdict: { contract: 'READY', route: 'plan' }, run_id: 'an-earlier-run' } }));
    }
    let transcriptPath: string | null = null;
    if (config.unreadableTranscript === true) transcriptPath = dir;
    else if (config.noTranscript !== true) {
      transcriptPath = join(dir, `transcript-run-${n}.jsonl`);
      writeFileSync(transcriptPath, '');
    }
    const nodes: FakeNode[] = intake
      ? [
          { id: 'facts', state: 'completed', kind: 'exec' },
          agent('triage__triage', triageRan ? 'completed' : 'skipped', bound),
          { id: 'triage__verdict', state: triageRan ? 'completed' : 'skipped', kind: 'exec', structuredOutput: { contract: config.declaredClosure ? 'NO_ACTION' : 'READY', closure: config.declaredClosure ?? null } },
          { id: 'outcome', state: 'completed', kind: 'exec' },
        ]
      : [config.unboundTriage === true ? { id: 'triage', state: 'completed' } : agent('triage', 'completed', config.triageRanAs ?? bound)];
    const detail = {
      id: `run-${n}`,
      status: config.runStatus ?? 'completed',
      output_root: join(dir, 'root'),
      started_at: '2026-10-15T10:00:00Z',
      completed_at: '2026-10-15T10:01:00Z',
      transcript_path: transcriptPath,
      metadata: { dispatch: { base_branch: 'main' }, model_bindings: { effective: { aliases: {} } } },
      terminal_record: {
        nodes: nodes.map(node => ({ node_id: node.id, state: node.state })),
        returns: {
          availability: 'available',
          node_id: intake ? 'outcome' : 'verdict',
          value: intake
            ? { path, item: Number(given.number), evaluation: given.mode === 'live' ? null : { triage: path === 'triage' ? verdict : null } }
            : verdict,
        },
      },
      events: events(nodes),
    };
    const failedLaunch = { id: detail.id, status: 'failed', output_root: null, started_at: detail.started_at, metadata: detail.metadata, terminal_record: { nodes: [], returns: { availability: 'unavailable', reason: 'graph_unavailable' } }, events: [] };
    writeFileSync(join(dir, `detail-run-${n}.json`), JSON.stringify(config.launchFails === true ? failedLaunch : detail));
    return JSON.stringify({ runId: `run-${n}` });
  }
  if (args[1] === 'wait') return JSON.stringify({ attention: { kind: 'terminal', status: config.launchFails === true ? 'failed' : (config.runStatus ?? 'completed') } });
  if (args[1] === 'get') return readFileSync(join(dir, `detail-${args[2]}.json`), 'utf8');
  throw new Error(`fake archon: unexpected command ${args.join(' ')}`);
}

function ghAnswer(dir: string, args: readonly string[]): string {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as FakeConfig;
  const host = option(args, '--hostname') ?? config.repo.host;
  const repoPath = args.includes('graphql')
    ? (args.some(arg => arg.startsWith('q=')) ? config.repo.path : `${args.find(arg => arg.startsWith('owner='))?.slice(6)}/${args.find(arg => arg.startsWith('name='))?.slice(5)}`)
    : (args.find(arg => arg.startsWith('repos/')) ?? '').split('/').slice(1, 3).join('/');
  if (config.unavailableRepos?.includes(`${host}/${repoPath}`)) throw new Error(`fake gh: repository ${host}/${repoPath} is unavailable`);
  const inRepo = config.issues.filter(issue => (issue.repo?.host ?? config.repo.host).toLowerCase() === host.toLowerCase() && (issue.repo?.path ?? config.repo.path).toLowerCase() === repoPath.toLowerCase());
  if (args.includes('graphql') && args.some(arg => arg.includes('CROSS_REFERENCED_EVENT'))) {
    const number = Number(args.find(arg => arg.startsWith('number='))?.slice('number='.length));
    const issue = inRepo.find(entry => entry.number === number);
    if (issue === undefined) throw new Error(`fake gh: no issue ${String(number)}`);
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            refs: {
              pageInfo: { hasNextPage: (issue.refs ?? []).length > 100 },
              nodes: (issue.refs ?? []).slice(0, 100).map(ref => ({ [ref.connected ? 'subject' : 'source']: { __typename: 'PullRequest', url: ref.url, merged: ref.merged, mergeCommit: ref.oid === null ? null : { oid: ref.oid } } })),
            },
          },
        },
      },
    });
  }
  if (args.includes('graphql')) {
    const q = args.find(arg => arg.startsWith('q='));
    if (q === undefined) {
      const number = Number(args.find(arg => arg.startsWith('number='))?.slice('number='.length));
      const issue = inRepo.find(entry => entry.number === number);
      const creation = issue?.creation;
      return JSON.stringify({ data: { repository: { issue: { createdAt: 'x', userContentEdits: { totalCount: creation === undefined ? 0 : 1, nodes: creation ? [{ editedAt: 'x', diff: creation.body }] : [] }, timelineItems: { nodes: creation ? [{ previousTitle: creation.title }] : [] } } } } });
    }
    const hits = Object.entries(config.searches ?? {}).find(([fragment]) => q.includes(fragment))?.[1] ?? [];
    const nodes = hits.map(number => {
      const issue = inRepo.find(entry => entry.number === number);
      return { number, author: { login: issue?.author ?? 'someone' }, labels: { nodes: (issue?.labels ?? []).map(name => ({ name })) }, timelineItems: { nodes: [] } };
    });
    return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
  }
  const endpoint = args.find(arg => arg.startsWith('repos/')) ?? '';
  if (args.includes('POST') && endpoint.endsWith('/issues')) {
    const file = join(dir, 'created.json');
    const created: { endpoint: string; title: string; body: string; number: number }[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const issue = { endpoint, title: args.find(arg => arg.startsWith('title='))?.slice(6) ?? '', body: args.find(arg => arg.startsWith('body='))?.slice(5) ?? '', number: 200 + created.length };
    created.push(issue);
    writeFileSync(file, JSON.stringify(created));
    return JSON.stringify(issue);
  }
  const repo = endpoint.split('/').slice(1, 3).join('/');
  if (endpoint.includes('/issues?')) {
    const page = Number(new URL(`https://fake/${endpoint}`).searchParams.get('page'));
    return JSON.stringify(inRepo.slice((page - 1) * 100, page * 100).map(issue => ({
      ...issue, title: issue.title ?? `Issue ${String(issue.number)}`, body: issue.body ?? 'body',
      state: issue.state ?? 'closed', labels: issue.labels.map(name => ({ name })),
    })));
  }
  if (endpoint.includes('/issues/comments?')) {
    const page = Number(new URL(`https://fake/${endpoint}`).searchParams.get('page'));
    const comments = inRepo.flatMap(issue => (issue.commentBodies ?? Array.from({ length: issue.comments }, (_, i) => ({ id: `old-${i}`, body: 'Old comment' }))).map(comment => ({
      ...comment, issue_url: `https://${config.repo.host}/repos/${repo}/issues/${issue.number}`,
    })));
    return JSON.stringify(comments.slice((page - 1) * 100, page * 100));
  }
  if (endpoint.includes('/comments?')) {
    const number = Number(endpoint.split('/')[4]);
    const issue = inRepo.find(entry => entry.number === number);
    if (!issue) throw new Error(`fake gh: no comments for ${number}`);
    const comments = issue.commentBodies ?? Array.from({ length: issue.comments }, (_, i) => ({ id: `old-${i}`, body: 'Old comment' }));
    const page = Number(new URL(`https://fake/${endpoint}`).searchParams.get('page'));
    return JSON.stringify(comments.slice((page - 1) * 100, page * 100).map(comment => ({ ...comment, html_url: 'https://fake/comment' })));
  }
  const number = Number(endpoint.split('/').pop());
  const issue = inRepo.find(entry => entry.number === number);
  if (args[0] !== 'api' || issue === undefined) throw new Error(`fake gh: unexpected call ${args.join(' ')}`);
  return JSON.stringify({
    number,
    title: issue.title ?? `Issue ${String(number)}`,
    body: issue.body ?? 'body',
    state: issue.state ?? 'closed',
    html_url: issue.url ?? `https://${config.repo.host}/${endpoint.slice('repos/'.length)}`,
    user: { login: issue.author ?? 'someone' },
    comments: issue.comments,
    labels: issue.labels.map(name => ({ name })),
  });
}

export function install(dir: string): void {
  const spawn = Bun.spawn;
  const spawnSync = Bun.spawnSync;
  const fake = (cmd: string[], options?: Parameters<typeof spawn>[1]) => {
    if (cmd[0] !== 'archon') return spawn(cmd, options);
    return { stdout: new Response(answer(dir, cmd.slice(1))).body, stderr: new Response('').body, exited: Promise.resolve(0) };
  };
  const fakeSync = (cmd: string[], options?: Parameters<typeof spawnSync>[1]) => {
    if (cmd[0] !== 'gh') return spawnSync(cmd, options);
    return { exitCode: 0, stdout: Buffer.from(ghAnswer(dir, cmd.slice(1))), stderr: Buffer.from('') };
  };
  Object.assign(Bun, { spawn: fake, spawnSync: fakeSync });
}
