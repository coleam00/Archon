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
 *
 * A run whose launch named a `GH_CONFIG_DIR` acts as an agent that looks an issue up:
 * on `workflow wait` it sends gh's `issue view` query to that directory's
 * `http_unix_socket` and keeps the answer in `lookup-run-<n>.json`. Upstream of that
 * socket, `fetch` to the tracker answers each issue as it is now.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeIssue {
  readonly number: number;
  readonly labels: string[];
  readonly comments: number;
  /** Defaults to closed. */
  readonly state?: 'open' | 'closed';
  readonly author?: string;
  readonly createdAt?: string;
  /** Label history, oldest first, as the per-row read reports it. */
  readonly labelEvents?: readonly { createdAt: string; actor: string; label: string; removed?: true }[];
  /** Pull requests that reference the issue. */
  readonly refs?: readonly { url: string; merged: boolean; oid: string | null }[];
}

export interface FakeConfig {
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
  /** Every run's agent runs `gh issue view` on this issue. */
  readonly lookupIssue?: number;
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
  return nodes.flatMap(({ id, state, kind, binding }) => {
    if (kind === undefined) return [];
    const spend = kind === 'agent' && state !== 'skipped' ? { spend: { costUsd: { source: 'provider', value: 0.5 } } } : {};
    const data = { node: { id, kind }, binding: binding ?? {}, ...spend };
    return [{ step_name: id, event_type: state === 'skipped' ? 'node_skipped' : 'node_completed', data }];
  });
}

/** Look the configured issue up as gh's `issue view` does, through the socket the run's gh config names. */
async function lookUp(dir: string, runId: string, config: FakeConfig): Promise<void> {
  const ghConfig = join(dir, `ghconfig-${runId}`);
  if (config.lookupIssue === undefined || !existsSync(ghConfig)) return;
  const settings = Bun.YAML.parse(readFileSync(join(readFileSync(ghConfig, 'utf8'), 'config.yml'), 'utf8')) as { http_unix_socket: string };
  const [owner, repo] = config.repo.path.split('/');
  const response = await fetch('http://api.github.com/graphql', {
    unix: settings.http_unix_socket,
    method: 'POST',
    headers: { host: 'api.github.com', 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'query IssueByNumber($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue: issueOrPullRequest(number: $number) { __typename ... on Issue { id title body state stateReason closedAt url labels(first: 100) { nodes { name } totalCount } comments(first: 100) { nodes { body } totalCount } } } } }',
      variables: { owner, repo, number: config.lookupIssue },
    }),
  });
  writeFileSync(join(dir, `lookup-${runId}.json`), await response.text());
}

/** The tracker as it is now, as the lookup server forwards to it. */
function upstream(dir: string, url: string, body: string | undefined): Response | undefined {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as FakeConfig;
  const now = (number: number) => {
    const issue = config.issues.find(entry => entry.number === number);
    if (issue === undefined) return undefined;
    return {
      id: `I_${String(number)}`,
      number,
      title: `Issue ${String(number)}`,
      body: 'body',
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: '2026-10-01T00:00:00Z',
      url: `https://${config.repo.host}/${config.repo.path}/issues/${String(number)}`,
      labels: { nodes: issue.labels.map(name => ({ name })), totalCount: issue.labels.length },
      comments: { nodes: [{ body: 'Fixed by the merged pull request.' }], totalCount: 1 },
    };
  };
  const { pathname } = new URL(url);
  if (pathname === '/graphql') {
    const request = JSON.parse(body ?? '{}') as { variables?: { number?: number } };
    return Response.json({ data: { repository: { issue: now(Number(request.variables?.number)) ?? null } } });
  }
  const rest = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(pathname);
  return rest === null ? undefined : Response.json(now(Number(rest[1])) ?? {}, { status: now(Number(rest[1])) === undefined ? 404 : 200 });
}

function answer(dir: string, args: readonly string[], env?: Record<string, string | undefined>): string {
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
    if (env?.GH_CONFIG_DIR !== undefined) writeFileSync(join(dir, `ghconfig-run-${n}`), env.GH_CONFIG_DIR);
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
      const triage = { verdict: { contract: 'READY', route: 'plan' }, pull_request: null, type: field, size: { value: 'm', reason: 'r' }, complexity: { value: 'low', reason: 'r' }, importance: { value: 'low', reason: 'r' }, urgency: { value: 'none', reason: 'r' }, run_id: `run-${n}` };
      writeFileSync(work, JSON.stringify({ triage }));
    } else if (given.mode === 'live' && !existsSync(work)) {
      writeFileSync(work, JSON.stringify({ triage: { verdict: { contract: 'READY', route: 'plan' }, run_id: 'an-earlier-run' } }));
    }
    let transcriptPath: string | null = null;
    if (config.unreadableTranscript === true) transcriptPath = dir;
    else if (config.noTranscript !== true) {
      transcriptPath = join(dir, `transcript-run-${n}.jsonl`);
      const lookup = config.lookupIssue === undefined ? '' : `${JSON.stringify({ type: 'provider_event', step: intake ? 'triage__triage' : 'triage', event: { type: 'tool_call', toolCallId: 'look', name: 'Bash', rawInput: { command: `gh issue view ${String(config.lookupIssue)} --repo ${config.repo.path} --json title,body,state,labels,comments` } } })}\n`;
      writeFileSync(transcriptPath, lookup);
    }
    const nodes: FakeNode[] = intake
      ? [
          { id: 'facts', state: 'completed', kind: 'exec' },
          agent('triage__triage', triageRan ? 'completed' : 'skipped', bound),
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
  if (args.includes('graphql') && args.some(arg => arg.includes('CROSS_REFERENCED_EVENT'))) {
    const number = Number(args.find(arg => arg.startsWith('number='))?.slice('number='.length));
    const issue = config.issues.find(entry => entry.number === number);
    if (issue === undefined) throw new Error(`fake gh: no issue ${String(number)}`);
    const event = (entry: NonNullable<FakeIssue['labelEvents']>[number]) => ({
      __typename: entry.removed === true ? 'UnlabeledEvent' : 'LabeledEvent',
      createdAt: entry.createdAt,
      actor: { login: entry.actor },
      label: { name: entry.label },
    });
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            id: `I_${String(number)}`,
            url: `https://${config.repo.host}/${config.repo.path}/issues/${String(number)}`,
            createdAt: issue.createdAt ?? '2026-01-01T00:00:00Z',
            author: { login: issue.author ?? 'someone' },
            labelEvents: { nodes: (issue.labelEvents ?? []).map(event) },
            refs: {
              pageInfo: { hasNextPage: false },
              nodes: (issue.refs ?? []).map(ref => ({ source: { url: ref.url, merged: ref.merged, mergeCommit: ref.oid === null ? null : { oid: ref.oid } } })),
            },
          },
        },
      },
    });
  }
  if (args.includes('graphql')) {
    const q = args.find(arg => arg.startsWith('q='));
    if (q === undefined) {
      // An issue's history: never edited or renamed, so its creation text is its current text.
      return JSON.stringify({ data: { repository: { issue: { createdAt: 'x', userContentEdits: { totalCount: 0, nodes: [] }, timelineItems: { nodes: [] } } } } });
    }
    const hits = Object.entries(config.searches ?? {}).find(([fragment]) => q.includes(fragment))?.[1] ?? [];
    const nodes = hits.map(number => {
      const issue = config.issues.find(entry => entry.number === number);
      return { number, author: { login: issue?.author ?? 'someone' }, labels: { nodes: (issue?.labels ?? []).map(name => ({ name })) }, timelineItems: { nodes: [] } };
    });
    return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
  }
  const endpoint = args.find(arg => arg.startsWith('repos/')) ?? '';
  const number = Number(endpoint.split('/').pop());
  const issue = config.issues.find(entry => entry.number === number);
  if (args[0] !== 'api' || issue === undefined) throw new Error(`fake gh: unexpected call ${args.join(' ')}`);
  return JSON.stringify({
    number,
    title: `Issue ${String(number)}`,
    body: 'body',
    state: issue.state ?? 'closed',
    html_url: `https://${config.repo.host}/${config.repo.path}/issues/${String(number)}`,
    user: { login: issue.author ?? 'someone' },
    comments: issue.comments,
    labels: issue.labels.map(name => ({ name })),
  });
}

export function install(dir: string): void {
  const spawn = Bun.spawn;
  const spawnSync = Bun.spawnSync;
  const realFetch = globalThis.fetch;
  const fake = (cmd: string[], options?: Parameters<typeof spawn>[1]) => {
    if (cmd[0] !== 'archon') return spawn(cmd, options);
    const args = cmd.slice(1);
    // A wait answers only after the run's lookup, which the bench's own server answers,
    // so its output comes from an async producer that leaves the event loop free.
    const produce = async (): Promise<string> => {
      if (args[0] === 'workflow' && args[1] === 'wait') await lookUp(dir, args[2], JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as FakeConfig);
      return answer(dir, args, options?.env);
    };
    const stdout = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(await produce()));
        controller.close();
      },
    });
    return { stdout, stderr: new Response('').body, exited: Promise.resolve(0) };
  };
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit & { unix?: string }): Promise<Response> => {
    if (init?.unix !== undefined) return realFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    const answered = upstream(dir, url, body);
    if (answered === undefined) throw new Error(`fake fetch: unexpected request ${url}`);
    return answered;
  };
  const fakeSync = (cmd: string[], options?: Parameters<typeof spawnSync>[1]) => {
    if (cmd[0] !== 'gh') return spawnSync(cmd, options);
    return { exitCode: 0, stdout: Buffer.from(ghAnswer(dir, cmd.slice(1))), stderr: Buffer.from('') };
  };
  Object.assign(Bun, { spawn: fake, spawnSync: fakeSync });
  Object.assign(globalThis, { fetch: fakeFetch });
}
