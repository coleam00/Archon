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

export interface FakeIssue {
  readonly number: number;
  readonly labels: string[];
  readonly comments: number;
  /** Defaults to closed. */
  readonly state?: 'open' | 'closed';
  readonly author?: string;
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
  /** After a launched run, every issue read fails, as a lost tracker would. */
  readonly issueReadsFailAfterRun?: boolean;
  /** A run's transcript path names a directory, so reading it fails. */
  readonly unreadableTranscript?: boolean;
  /** The project key `archon state list` names. */
  readonly projectKey: string;
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

function agent(nodeId: string, state: string, bound: FakeConfig['baseline']) {
  return {
    nodeId,
    state,
    execution: {
      node: { kind: 'agent' },
      // The engine records a skipped agent node with an empty binding.
      binding:
        state === 'skipped'
          ? {}
          : { provider: bound?.provider, tier: 'medium', model: { requested: bound?.model, resolved: { source: 'unavailable', reason: 'not_reported' } } },
      spend: { costUsd: { source: 'provider', value: 0.5 } },
    },
  };
}

function answer(dir: string, args: readonly string[]): string {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as FakeConfig;
  const save = (): void => writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  if (args[0] === 'state' && args[1] === 'list') {
    return JSON.stringify({ scope: { kind: 'project', key: config.projectKey }, documents: [] });
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
    if (config.writeLabel !== undefined && given.number !== undefined) {
      config.issues.find(issue => issue.number === Number(given.number))?.labels.push(config.writeLabel);
      save();
    }
    const bound = binding(args, config);
    const intake = args[2] === 'archon-intake';
    const outside = given.trust === 'outside';
    const triageRan = !intake || !outside || config.outsideAgentRuns === true;
    // A live intake run that triages records its verdict on the item's work document;
    // one that does not leaves an earlier run's there.
    const work = join(dir, `work-${given.number}.json`);
    if (given.mode === 'live' && !outside) {
      const field = { value: 'bug', reason: 'r' };
      const triage = { verdict: { contract: 'READY', route: 'plan' }, pull_request: null, type: field, size: { value: 'm', reason: 'r' }, complexity: { value: 'low', reason: 'r' }, importance: { value: 'low', reason: 'r' }, urgency: { value: 'none', reason: 'r' }, run_id: `run-${n}` };
      writeFileSync(work, JSON.stringify({ triage }));
    } else if (given.mode === 'live' && !existsSync(work)) {
      writeFileSync(work, JSON.stringify({ triage: { verdict: { contract: 'READY', route: 'plan' }, run_id: 'an-earlier-run' } }));
    }
    const detail = {
      id: `run-${n}`,
      status: 'completed',
      output_root: join(dir, 'root'),
      started_at: '2026-10-15T10:00:00Z',
      completed_at: '2026-10-15T10:01:00Z',
      transcript_path: config.unreadableTranscript === true ? dir : null,
      terminal_record: {
        returns: {
          availability: 'available',
          node_id: intake ? 'outcome' : 'verdict',
          value: intake
            ? { path: outside ? 'outside' : 'triage', item: Number(given.number), evaluation: given.mode === 'live' ? null : { triage: outside ? null : verdict } }
            : verdict,
        },
      },
      nodes: intake
        ? [
            { nodeId: 'facts', state: 'completed', execution: { node: { kind: 'exec' } } },
            agent('triage__triage', triageRan ? 'completed' : 'skipped', bound),
            { nodeId: 'outcome', state: 'completed', execution: { node: { kind: 'exec' } } },
          ]
        : [config.unboundTriage === true ? { nodeId: 'triage', state: 'completed' } : agent('triage', 'completed', config.triageRanAs ?? bound)],
    };
    writeFileSync(join(dir, `detail-run-${n}.json`), JSON.stringify(detail));
    return JSON.stringify({ runId: `run-${n}` });
  }
  if (args[1] === 'wait') return JSON.stringify({ attention: { kind: 'terminal', status: 'completed' } });
  if (args[1] === 'get') return readFileSync(join(dir, `detail-${args[2]}.json`), 'utf8');
  throw new Error(`fake archon: unexpected command ${args.join(' ')}`);
}

function ghAnswer(dir: string, args: readonly string[]): string {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as FakeConfig;
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
