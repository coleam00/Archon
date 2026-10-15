/**
 * The intake bench runner: every version on the same batch of five rows, one ordinary
 * run per (version, row), one JSONL line per run.
 *
 * A version is one model on triage's tier, the only tier intake's agent node uses, so
 * versions differ in nothing else. The baseline is whatever that tier resolves to in
 * the checkout's own configuration today; every version, the baseline included, runs
 * with a config layer pinning that tier, so a config edit mid-bench cannot move it.
 *
 * Eval batches read the set's own repository and must write nothing to it: its batch
 * issues and its state documents are read before and after, and any difference fails
 * the batch. An eval run's `gh` lookups of a batch issue answer as the issue was at
 * creation (./lookups.ts). Live batches run intake for real, but only on scratch
 * repositories that hold copies of the batch's issues, one repository per version.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import {
  type NodeBinding,
  type ResolvedVersion,
  type RunDetail,
  type RunNode,
  SAMPLES_FILE,
  TIERS,
  type Tier,
  agentBinding,
  appendLine,
  archonJson,
  artifactsOf,
  canonical,
  getRun,
  isId,
  launch,
  relabelRefusal,
  returnedValue,
  snapshotSource,
  spendOf,
  waitRun,
} from '../../../.shared/bench.ts';
import type { Closure } from '../../../.shared/close.ts';
import { sameRepo, type QualifiedPr } from '../../../.shared/forge.ts';
import { git, gitOrThrow } from '../../../.shared/git.ts';
import type { Contract, Route } from '../../../.shared/labels.ts';
import { remoteFor, urlRepo } from '../../../.shared/remote.ts';
import { isObject } from '../../../.shared/typed.ts';
import { INTAKE_PATHS } from '../../../.shared/workitem.ts';
import { type CreationView, type LabelEvent, type LookupServer, creationLabels, serveLookups } from './lookups.ts';
import { type BenchSet, type BenchWorkflow, type Row, WORKFLOWS } from './set.ts';

type Repo = QualifiedPr['repo'];
type IntakePath = (typeof INTAKE_PATHS)[number];

export const CHECKS_FILE = 'checks.jsonl';

/** What one version pins. Versions differ only in `provider` and `model`. */
export interface Version {
  readonly label: string;
  /** The full commit the pack source is read from. */
  readonly pack_sha: string;
  /** Blob SHA of the triage prompt at `pack_sha`; there is no other agent prompt on intake's path. */
  readonly prompt_sha: { readonly triage: string };
  readonly provider: string;
  readonly model: string;
  /** The tier archon-triage declares, which the version's config layer pins. */
  readonly tier: Tier;
  readonly effort?: string;
}

interface Binding {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

/** The message every run starts with; the target, not the message, carries the issue. */
export const BENCH_MESSAGE = 'Triage the target.';

/**
 * The stand-ins a dry run of archon-triage reads to reach its agent node: the pack's
 * own fixture of a completed triage at the version's commit, its policy and verdict
 * scripts run for real. The fixture moves with the pack's schemas, so a version at
 * any commit is resolved against stand-ins that commit accepts.
 */
export function bindingStubs(source: string, workflowPath: string): Record<string, unknown> {
  const file = join(source, dirname(workflowPath), 'fixtures', 'deliver.stubs.yaml');
  if (!existsSync(file)) throw new Error(`${relative(source, file)} does not exist, so the triage node's binding cannot be resolved`);
  const fixture: unknown = Bun.YAML.parse(readFileSync(file, 'utf8'));
  if (!isObject(fixture)) throw new Error(`${relative(source, file)} is not a mapping`);
  const { fixture: _expected, 'exec-code': _execCode, ...stubs } = fixture;
  return stubs;
}

/** The binding archon-triage's agent node resolves to in `cwd`, with an optional config layer. */
async function dryRunBinding(cwd: string, source: string, stubs: string, config?: string): Promise<Binding> {
  const trace = await archonJson(
    [
      'workflow',
      'run',
      WORKFLOWS.triage,
      '--cwd',
      cwd,
      '--workflow-source',
      source,
      ...(config === undefined ? [] : ['--config', config]),
      '--dry-run',
      '--exec-code',
      '--stubs',
      stubs,
      '--json',
      '--input',
      'target=resolve',
    ],
    cwd
  );
  const node = Array.isArray(trace.trace) ? trace.trace.find(entry => isObject(entry) && entry.nodeId === 'triage') : undefined;
  const resolution = isObject(node) && isObject(node.resolution) ? node.resolution : {};
  const { provider, model, effort } = resolution;
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    throw new Error(`the triage node resolved no provider and model in ${cwd}: ${JSON.stringify(resolution)}`);
  }
  return typeof effort === 'string' ? { provider, model, effort } : { provider, model };
}

/** The one tracked file at `sha` under `.archon/workflows` whose path ends with `suffix`. */
function packFile(repoRoot: string, sha: string, suffix: string): string {
  const paths = gitOrThrow('-C', repoRoot, 'ls-tree', '-r', '--name-only', sha, '--', '.archon/workflows')
    .split('\n')
    .filter(path => path.endsWith(suffix));
  if (paths.length !== 1) throw new Error(`expected one ${suffix} at ${sha}, found ${String(paths.length)}`);
  return paths[0];
}

/**
 * Read a version file (`{label, pack_sha}`, plus `provider` and `model` for anything
 * but the baseline) and pin it, or refuse before anything runs. A label means one
 * record for the life of an output directory, so a label already recorded with
 * another version is refused.
 */
export async function resolveVersion(file: string, repoRoot: string, checkout: string, outDir: string): Promise<ResolvedVersion<Version>> {
  const refuse = (reason: string): never => {
    throw new Error(`version ${file}: ${reason}`);
  };
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse(`cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isObject(raw)) return refuse('is not a mapping');
  const { label, pack_sha: packRef, provider, model } = raw;
  if (!isId(label)) return refuse('`label` must be letters, digits, `.`, `_` or `-`');
  if (typeof packRef !== 'string' || packRef === '') return refuse('`pack_sha` is missing');
  if ((provider === undefined) !== (model === undefined)) return refuse('name both `provider` and `model`, or neither for the baseline');
  if (provider !== undefined && (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '')) {
    return refuse('`provider` and `model` must be names');
  }

  const commit = git('-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${packRef}^{commit}`);
  if (commit.code !== 0) return refuse(`pack_sha ${packRef} is not a commit in ${repoRoot}`);
  const packSha = commit.stdout;
  const workflowPath = packFile(repoRoot, packSha, `/${WORKFLOWS.triage}.yaml`);
  const declared: unknown = Bun.YAML.parse(gitOrThrow('-C', repoRoot, 'show', `${packSha}:${workflowPath}`));
  const tier = isObject(declared) ? declared.model : undefined;
  if (!TIERS.includes(tier as Tier)) return refuse(`${workflowPath} at ${packSha} names no tier as its model`);
  const promptPath = `${workflowPath.slice(0, workflowPath.lastIndexOf('/'))}/commands/triage.md`;
  const prompt = git('-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${packSha}:${promptPath}`);
  if (prompt.code !== 0) return refuse(`${promptPath} does not exist at ${packSha}`);

  const source = snapshotSource(repoRoot, packSha, outDir);
  mkdirSync(join(outDir, 'versions'), { recursive: true });
  const stubs = join(outDir, 'versions', `${label}.stubs.yaml`);
  writeFileSync(stubs, Bun.YAML.stringify(bindingStubs(source, workflowPath), null, 2));
  const baseline = await dryRunBinding(checkout, source, stubs);
  // Only the model moves; the baseline's effort stays, so effort is not a second variable.
  const wanted: Binding =
    typeof provider === 'string' && typeof model === 'string'
      ? { provider, model, ...(baseline.effort === undefined ? {} : { effort: baseline.effort }) }
      : baseline;
  const config = join(outDir, 'versions', `${label}.config.yaml`);
  writeFileSync(config, Bun.YAML.stringify({ tiers: { [tier as Tier]: wanted } }, null, 2));
  const pinned = await dryRunBinding(checkout, source, stubs, config);
  if (canonical(pinned) !== canonical(wanted)) {
    return refuse(`the pinned tier resolved to ${JSON.stringify(pinned)}, not ${JSON.stringify(wanted)}`);
  }

  const version: Version = {
    label,
    pack_sha: packSha,
    prompt_sha: { triage: prompt.stdout },
    ...wanted,
    tier: tier as Tier,
  };
  const relabel = relabelRefusal(outDir, version);
  if (relabel !== undefined) return refuse(relabel);
  return { version, source, config };
}

/**
 * One eval run's checkout of the set's repository at `base`: a worktree of the
 * operator's checkout, so Archon resolves it to the project already registered there
 * and triage reads the code and the tracker as a run in the operator's checkout
 * would. Each run gets its own, because Archon lets one run at a time hold a
 * checkout, and no run touches the operator's checkout.
 */
export function evalCheckout(repoRoot: string, repo: Repo, base: string, path: string): string {
  if (!existsSync(path)) {
    // Refuses an operator checkout with no remote for the set's repository.
    remoteFor(repo);
    mkdirSync(dirname(path), { recursive: true });
    gitOrThrow('-C', repoRoot, 'worktree', 'add', '--quiet', '--detach', path, base);
    return path;
  }
  if (gitOrThrow('-C', path, 'status', '--porcelain') !== '') {
    throw new Error(`${path} has changes a run left behind; inspect it, then remove it to start clean`);
  }
  gitOrThrow('-C', path, 'checkout', '--quiet', '--detach', base);
  return path;
}

// --- live scratch repositories ---------------------------------------------------

export interface Scratch {
  readonly repo: Repo;
  readonly checkout: string;
}

/** The operator's scratch repository for each version label, from the live file. */
export function loadLive(file: string, set: BenchSet): Map<string, Scratch> {
  const raw: unknown = Bun.YAML.parse(readFileSync(file, 'utf8'));
  const refuse = (reason: string): never => {
    throw new Error(`live ${file}: ${reason}`);
  };
  if (!isObject(raw)) return refuse('must map version labels to {repo: {host, path}, checkout}');
  const live = new Map<string, Scratch>();
  for (const [label, entry] of Object.entries(raw)) {
    const repo = isObject(entry) && isObject(entry.repo) ? entry.repo : undefined;
    if (!isObject(entry) || typeof repo?.host !== 'string' || typeof repo.path !== 'string' || typeof entry.checkout !== 'string') {
      return refuse(`${label} needs repo: {host, path} and checkout`);
    }
    const scratch = { repo: { host: repo.host, path: repo.path }, checkout: entry.checkout };
    if (sameRepo(scratch.repo, set.repo)) return refuse(`${label}'s scratch repository is the set's own repository`);
    for (const [other, taken] of live) {
      if (sameRepo(taken.repo, scratch.repo)) return refuse(`${label} and ${other} share ${repo.path}; each version needs its own`);
    }
    live.set(label, scratch);
  }
  return live;
}

/** Refuse a scratch checkout that is not of its repository, or not at `base`. */
export function checkScratch(label: string, scratch: Scratch, base: string): void {
  const listed = git('-C', scratch.checkout, 'config', '--get-regexp', '^remote\\..*\\.url$');
  const names = listed.stdout.split('\n').map(line => urlRepo(line.slice(line.indexOf(' ') + 1)));
  if (!names.some(named => named !== undefined && sameRepo(named, scratch.repo))) {
    throw new Error(`${label}: ${scratch.checkout} has no remote for ${scratch.repo.path}`);
  }
  const head = git('-C', scratch.checkout, 'rev-parse', 'HEAD').stdout;
  if (head !== base) throw new Error(`${label}: ${scratch.checkout} is at ${head}, not the batch base ${base}`);
}

function copiesFile(outDir: string, label: string): string {
  return join(outDir, 'live', `${label}.json`);
}

/** Row id to issue number of its copy in the version's scratch repository. */
export function readCopies(outDir: string, label: string, repo: Repo): Record<string, number> {
  const file = copiesFile(outDir, label);
  if (!existsSync(file)) return {};
  const copies: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(copies) || !isObject(copies.repo) || !isObject(copies.copies)) throw new Error(`${file} is not a copy map`);
  if (!sameRepo(copies.repo as Repo, repo)) throw new Error(`${file} maps copies in ${String(copies.repo.path)}, not ${repo.path}`);
  return copies.copies as Record<string, number>;
}

/** Open a copy of every batch row in the scratch repository that has none yet. */
export function copyRows(outDir: string, label: string, scratch: Scratch, rows: readonly Row[]): Record<string, number> {
  const copies = readCopies(outDir, label, scratch.repo);
  for (const row of rows) {
    if (copies[row.id] !== undefined) continue;
    const result = Bun.spawnSync(
      ['gh', 'api', '--hostname', scratch.repo.host, '-X', 'POST', `repos/${scratch.repo.path}/issues`, '-f', `title=${row.title}`, '-f', `body=${row.body}`],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    if (result.exitCode !== 0) throw new Error(`copying row ${row.id} to ${scratch.repo.path} failed: ${result.stderr.toString().trim()}`);
    const created: unknown = JSON.parse(result.stdout.toString());
    if (!isObject(created) || typeof created.number !== 'number') throw new Error(`copying row ${row.id} returned no issue number`);
    copies[row.id] = created.number;
    mkdirSync(join(outDir, 'live'), { recursive: true });
    writeFileSync(copiesFile(outDir, label), `${JSON.stringify({ repo: scratch.repo, copies }, null, 2)}\n`);
  }
  return copies;
}

// --- what a batch must not write ---------------------------------------------------

export interface IssueFacts {
  readonly labels: readonly string[];
  readonly state: string;
  readonly title: string;
  readonly body_digest: string;
  readonly comments: number;
}

export interface Snapshot {
  /** `host/path#number` to the issue's facts. */
  readonly issues: Readonly<Record<string, IssueFacts>>;
  /** Project key to each state document's latest revision, -1 for a deleted one. */
  readonly state: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export function issueKey(repo: Repo, number: number): string {
  return `${repo.host}/${repo.path}#${String(number)}`;
}

function readIssueFacts(repo: Repo, number: number): IssueFacts {
  const result = Bun.spawnSync(['gh', 'api', '--hostname', repo.host, `repos/${repo.path}/issues/${String(number)}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`reading ${issueKey(repo, number)} failed: ${result.stderr.toString().trim()}`);
  const issue: unknown = JSON.parse(result.stdout.toString());
  if (!isObject(issue) || typeof issue.title !== 'string' || typeof issue.state !== 'string' || typeof issue.comments !== 'number') {
    throw new Error(`${issueKey(repo, number)} answered without its facts`);
  }
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return {
    labels: labels.flatMap(label => (isObject(label) && typeof label.name === 'string' ? [label.name] : [])).sort(),
    state: issue.state,
    title: issue.title,
    body_digest: createHash('sha256').update(typeof issue.body === 'string' ? issue.body : '').digest('hex'),
    comments: issue.comments,
  };
}

async function readState(cwd: string): Promise<[string, Record<string, number>]> {
  const listed = await archonJson(['state', 'list'], cwd);
  const scope = isObject(listed.scope) ? listed.scope : {};
  if (scope.kind !== 'project' || typeof scope.key !== 'string' || !Array.isArray(listed.documents)) {
    throw new Error(`archon state list in ${cwd} named no project scope`);
  }
  const documents: Record<string, number> = {};
  for (const document of listed.documents) {
    if (!isObject(document) || typeof document.name !== 'string' || typeof document.revision !== 'number') {
      throw new Error(`archon state list in ${cwd} listed a document without a name and revision`);
    }
    documents[document.name] = document.deleted === true ? -1 : document.revision;
  }
  return [scope.key, documents];
}

export async function snapshot(issues: readonly { repo: Repo; number: number }[], stateDirs: readonly string[]): Promise<Snapshot> {
  const facts: Record<string, IssueFacts> = {};
  for (const { repo, number } of issues) facts[issueKey(repo, number)] = readIssueFacts(repo, number);
  const state: Record<string, Record<string, number>> = {};
  for (const dir of stateDirs) {
    const [key, documents] = await readState(dir);
    state[key] = documents;
  }
  return { issues: facts, state };
}

/** Every difference between two snapshots, each named. */
export function snapshotChanges(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const [key, was] of Object.entries(before.issues)) {
    const now = after.issues[key];
    if (now === undefined) continue;
    for (const field of ['labels', 'state', 'title', 'body_digest', 'comments'] as const) {
      if (canonical(was[field]) !== canonical(now[field])) {
        changes.push(`${key}: ${field} changed from ${JSON.stringify(was[field])} to ${JSON.stringify(now[field])}`);
      }
    }
  }
  for (const [project, documents] of Object.entries(after.state)) {
    const earlier = before.state[project] ?? {};
    for (const [name, revision] of Object.entries(documents)) {
      if (earlier[name] !== revision) changes.push(`state ${project}/${name}: revision ${String(earlier[name] ?? 'none')} became ${String(revision)}`);
    }
  }
  return changes;
}

/** Comments added to any snapshotted issue: the bench's posted-text check. */
export function postedComments(before: Snapshot, after: Snapshot): string[] {
  return Object.entries(before.issues).flatMap(([key, was]) => {
    const now = after.issues[key];
    return now !== undefined && now.comments > was.comments ? [`${key}: ${String(now.comments - was.comments)} comment(s) posted`] : [];
  });
}

// --- what a batch issue was at creation ---------------------------------------------

const BATCH_ISSUE_QUERY = [
  'query($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) { issue(number: $number) {',
  'id url createdAt author { login }',
  'labelEvents: timelineItems(first: 20, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) { pageInfo { hasNextPage } nodes {',
  '__typename',
  '... on LabeledEvent { createdAt actor { login } label { name } }',
  '... on UnlabeledEvent { createdAt actor { login } label { name } } } }',
  'refs: timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) { pageInfo { hasNextPage } nodes {',
  '... on CrossReferencedEvent { source { ... on PullRequest { url merged mergeCommit { oid } } } }',
  '... on ConnectedEvent { subject { ... on PullRequest { url merged mergeCommit { oid } } } } } }',
  '} } }',
].join(' ');

export interface BatchIssue {
  readonly view: CreationView;
  /** Merged pull requests whose merge commit is in the batch base and that reference the issue. */
  readonly merged_on_base: readonly string[];
}

/**
 * One batch row's issue as it was opened, and the merged pull requests on the base
 * that reference it. A reference is evidence the issue is fixed on the base, not
 * proof: merges to a working branch close nothing, and a fix may say only `Refs`.
 */
export function readBatchIssue(repo: Repo, row: Row, repoRoot: string, base: string): BatchIssue {
  const where = issueKey(repo, row.number);
  const slash = repo.path.indexOf('/');
  const result = Bun.spawnSync(
    [
      'gh',
      'api',
      'graphql',
      '--hostname',
      repo.host,
      '-f',
      `query=${BATCH_ISSUE_QUERY}`,
      '-f',
      `owner=${repo.path.slice(0, slash)}`,
      '-f',
      `name=${repo.path.slice(slash + 1)}`,
      '-F',
      `number=${String(row.number)}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(`reading ${where} at creation failed: ${result.stderr.toString().trim()}`);
  const answer: unknown = JSON.parse(result.stdout.toString());
  if (isObject(answer) && 'errors' in answer && (!Array.isArray(answer.errors) || answer.errors.length > 0)) {
    throw new Error(`${where} GraphQL read failed: ${JSON.stringify(answer.errors)}`);
  }
  const data = isObject(answer) && isObject(answer.data) ? answer.data : {};
  const issue = isObject(data.repository) && isObject(data.repository.issue) ? data.repository.issue : {};
  const { id, url, createdAt, author, labelEvents, refs } = issue;
  if (typeof id !== 'string' || typeof url !== 'string' || typeof createdAt !== 'string') {
    throw new Error(`${where} answered without its id, url and creation time`);
  }
  if (isObject(labelEvents) && isObject(labelEvents.pageInfo) && labelEvents.pageInfo.hasNextPage === true) {
    throw new Error(`${where} has more than 20 label events; the bench reads only the first page`);
  }
  if (isObject(refs) && isObject(refs.pageInfo) && refs.pageInfo.hasNextPage === true) {
    throw new Error(`${where} has more than 100 cross-references; the bench reads only the first page`);
  }
  const nodes = (name: string, connection: unknown): unknown[] => {
    if (!isObject(connection) || !Array.isArray(connection.nodes) || !isObject(connection.pageInfo) || typeof connection.pageInfo.hasNextPage !== 'boolean') {
      throw new Error(`${where} answered with incomplete ${name} history`);
    }
    return connection.nodes;
  };
  const events = nodes('labelEvents', labelEvents).flatMap((event): LabelEvent[] => {
    if (!isObject(event) || typeof event.createdAt !== 'string' || !isObject(event.label) || typeof event.label.name !== 'string') return [];
    const actor = isObject(event.actor) && typeof event.actor.login === 'string' ? event.actor.login : null;
    return [{ createdAt: event.createdAt, actor, label: event.label.name, removed: event.__typename === 'UnlabeledEvent' }];
  });
  const login = isObject(author) && typeof author.login === 'string' ? author.login : null;
  const merged = new Set<string>();
  for (const node of nodes('refs', refs)) {
    const pr = isObject(node) ? (isObject(node.source) ? node.source : node.subject) : undefined;
    if (!isObject(pr) || pr.merged !== true || typeof pr.url !== 'string' || !isObject(pr.mergeCommit)) continue;
    const oid = pr.mergeCommit.oid;
    if (typeof oid !== 'string') continue;
    // A merge commit this clone lacks (a fork's or another repository's) cannot be in the base, which resolves here.
    if (git('-C', repoRoot, 'cat-file', '-e', `${oid}^{commit}`).code !== 0) continue;
    // 1 is "not an ancestor"; anything else leaves the answer unknown.
    const ancestry = git('-C', repoRoot, 'merge-base', '--is-ancestor', oid, base);
    if (ancestry.code !== 0 && ancestry.code !== 1) throw new Error(`${where}: is ${pr.url} on the base? git merge-base failed: ${ancestry.stderr}`);
    if (ancestry.code === 0) merged.add(pr.url);
  }
  return {
    view: {
      number: row.number,
      id,
      url,
      title: row.title,
      body: row.body,
      labels: creationLabels(login, createdAt, events),
      created_at: createdAt,
    },
    merged_on_base: [...merged],
  };
}

// --- one run, one line --------------------------------------------------------------

/** Triage's judgement, as every bench path reports it. A field the path cannot see is absent. */
export interface Verdict {
  readonly contract: Contract;
  readonly route: Route | null;
  readonly pull_request: number | null;
  readonly type: Field;
  readonly size: Field;
  readonly complexity: Field;
  readonly importance: Field;
  readonly urgency: Field;
  readonly labels?: readonly string[];
  readonly summary?: string;
  readonly proposed_edits?: { readonly title: string; readonly body: string } | null;
  readonly blocked_reason?: string | null;
  readonly blocked_by?: readonly string[];
  /** What a close proposal links to: the issue it duplicates or the change that delivered it. */
  readonly closure?: Closure | null;
}

interface Field {
  readonly value: string;
  readonly reason: string;
}

export interface Line {
  readonly at: string;
  readonly batch: number;
  /** One `run` invocation over the batch; its hard checks are recorded under the same id. */
  readonly batch_run: string;
  readonly mode: 'eval' | 'live';
  readonly base: string;
  readonly row: string;
  readonly number: number;
  readonly group: Row['group'];
  readonly workflow: BenchWorkflow;
  readonly trust: Row['trust'];
  readonly version: Version;
  readonly run_id: string | null;
  readonly status: string;
  /** The run completed on its version and its verdict was read. */
  readonly passed: boolean;
  readonly problems: readonly string[];
  /** Intake's path for the row; null for a triage run. */
  readonly path: IntakePath | null;
  /** Agent nodes that ran, and nodes whose kind the run did not record. */
  readonly agent_nodes: readonly string[];
  readonly binding: NodeBinding | null;
  readonly verdict: Verdict | null;
  readonly cost_usd: number | null;
  readonly duration_ms: number | null;
  /** Lookups of the judged issue that the creation-time answer did not cover. */
  readonly leak: readonly string[];
  /** Lookups of the judged issue that the creation-time answer covered; absent on older lines. */
  readonly answered_at_creation?: readonly string[];
  /** Merged pull requests on the batch base that reference the row's issue; absent on older lines. */
  readonly merged_on_base?: readonly string[];
  /** The run's triage report, copied under the output directory. */
  readonly report: string | null;
}

/** The agent node that judges the row: archon-triage's own, or the one intake includes. */
export function triageNodeId(workflow: BenchWorkflow): string {
  return workflow === 'intake' ? 'triage__triage' : 'triage';
}

const ran = (node: RunNode): boolean => node.state !== 'skipped' && node.state !== 'pending';

/** Nodes that ran an agent; a node that ran without recording its kind cannot be cleared. */
export function agentNodesRan(nodes: readonly RunNode[]): string[] {
  return nodes
    .filter(ran)
    .filter(node => node.kind === undefined || node.kind === 'agent')
    .map(node => node.nodeId);
}

/** Total cost of every attempt of each agent node that ran; null when any of them is unknown. */
export function runCost(nodes: readonly RunNode[]): number | null {
  return spendOf(nodes.filter(node => node.kind === 'agent' && node.state !== 'skipped').flatMap(node => node.attempts)).cost_usd;
}

/**
 * The machine tokens by which a lookup names one issue: its URL, its REST path, and
 * `n` or `#n` as an argument of `gh issue view`, before or after its flags and up to
 * the next command, the end of a command substitution or a redirect. A flag value may
 * hold parentheses (`--jq '(.body)'`), so `$(gh issue view 41) 4` also matches; that
 * false positive is rare and errs toward reporting. A match is a lookup of the issue;
 * one the creation-time answer did not cover is a leak, a reporting flag that moves
 * the row out of the accuracy numbers. Neither changes how a run is launched or retried.
 */
export function issueTokens(repo: Repo, number: number): RegExp[] {
  const path = repo.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const host = repo.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const n = String(number);
  return [
    new RegExp(`${host}/${path}/issues/${n}(?!\\d)`, 'i'),
    new RegExp(`repos/${path}/issues/${n}(?!\\d)`, 'i'),
    new RegExp(`issue view(?:[ \\t]+[^\\s;&|<>\`]+)*?[ \\t]+['"]?#?${n}(?![^\\s'"\`;&|()<>])`),
  ];
}

const HEREDOC = /(?<!<)<<(?!<)-?[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\([A-Za-z_]\w*))/;
/** `cat > file`, `cat <<EOF > file` or `tee file`, once the here-document operator is cut out. */
const WRITES_FILE = /^(?:cat\s*>>?\s*[^\s;&|<>]+|tee(?:\s+-a)?\s+[^\s;&|<>]+(?:\s*>\s*\/dev\/null)?)$/;

/**
 * Quoted cat/tee heredocs are inert unless an enclosing shell expands their
 * substitutions first. Unquoted heredocs expand even when writing a report.
 */
function withoutWrittenHeredocs(command: string): string {
  const kept: string[] = [];
  let terminator: string | undefined;
  let offset = 0;
  for (const line of command.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    const opened = HEREDOC.exec(line);
    if (opened !== null) {
      const segment = line.slice(0, opened.index).split(/&&|\|\||[;|(]/).pop() ?? '';
      const writer = `${segment} ${line.slice(opened.index + opened[0].length)}`.trim().replace(/\s+/g, ' ');
      let quote: string | undefined;
      const prefix = command.slice(0, start + opened.index);
      for (let i = 0; i < prefix.length; i++) {
        const char = prefix[i];
        if (char === '\\' && quote !== "'") i++;
        else if (char === quote) quote = undefined;
        else if (quote === undefined && (char === "'" || char === '"')) quote = char;
      }
      const outerExpansion = quote === '"' && /\$\(|`/.test(command.slice(prefix.length));
      if (WRITES_FILE.test(writer) && !outerExpansion) terminator = opened[1] ?? opened[2] ?? opened[3];
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * What a recorded provider event looked up: the command it ran, the URL it fetched or
 * the query it searched. A tool call carries these as its input; Codex records a
 * shell command it runs through unified exec as a `command_execution` subtask, whose
 * start and end both name it. A file write is no lookup, though the report it writes
 * may cite the issue, and neither is a quoted here-document written to a file.
 */
function lookupOf(event: Record<string, unknown>): { id: string; text: string } | undefined {
  if (event.type === 'tool_call' && isObject(event.rawInput)) {
    const { command, url, query } = event.rawInput;
    const text = [typeof command === 'string' ? withoutWrittenHeredocs(command) : command, url, query].filter(value => typeof value === 'string').join('\n');
    return text === '' ? undefined : { id: String(event.toolCallId), text };
  }
  if (event.type === 'subtask' && event.taskType === 'command_execution' && typeof event.description === 'string') {
    return { id: String(event.taskId), text: withoutWrittenHeredocs(event.description) };
  }
  return undefined;
}

/** Each lookup in a run's transcript that names the issue, once, by what it ran. */
export function findLookups(transcript: string, tokens: readonly RegExp[]): string[] {
  const lookups = new Map<string, string>();
  for (const text of transcript.split('\n')) {
    if (text.trim() === '') continue;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObject(line) || line.type !== 'provider_event' || !isObject(line.event)) continue;
    const lookup = lookupOf(line.event);
    if (lookup !== undefined && tokens.some(token => token.test(lookup.text))) lookups.set(lookup.id, `${String(line.step)}: ${lookup.text}`);
  }
  return [...lookups.values()];
}

/** Only one gh command can be accounted for by the lookup socket. */
function singleGhLookup(lookup: string): boolean {
  let command = lookup.slice(lookup.indexOf(': ') + 2);
  const wrapped = /^(?:\S*sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/.exec(command);
  if (wrapped !== null) {
    command = wrapped[2];
    if (wrapped[1] === '"') {
      let unquoted = '';
      for (let i = 0; i < command.length; i++) {
        const char = command[i];
        const next = command[i + 1];
        if (char === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
          if (next !== '\n') unquoted += next;
          i++;
        } else {
          if (char === '$' || char === '`') return false;
          unquoted += char;
        }
      }
      command = unquoted;
    }
  }
  if (!/^gh\s+(?:issue\s+view|api)\s+/.test(command)) return false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'" && quote !== '"') quote = quote === "'" ? undefined : "'";
    else if (char === '"' && quote !== "'") quote = quote === '"' ? undefined : '"';
    else if (char === '\\' && quote !== "'") i++;
    else if (quote !== "'" && (char === '`' || char === '$')) return false;
    else if (quote === undefined && /[;&|\n()]/.test(char)) return false;
  }
  return quote === undefined;
}

/**
 * Split a run's lookups of the judged issue into those the creation-time answer
 * covered and the leaks. A `gh issue view` or `gh api` lookup is covered when the
 * run's lookup server answered the row's issue at creation at least once; a URL
 * fetch, curl or search never is. Compound commands remain flagged because the
 * socket cannot account for their other reads. The server cannot tell which gh call
 * a request came from, so it reports each request that named the issue and went out
 * live itself, and each is a leak whatever the transcript shows.
 */
export function splitLookups(
  lookups: readonly string[],
  answeredRowIssue: boolean,
  answeredLive: readonly string[]
): { answered: string[]; leak: string[] } {
  const answered = answeredRowIssue ? lookups.filter(lookup => singleGhLookup(lookup)) : [];
  return {
    answered,
    leak: [...lookups.filter(lookup => !answered.includes(lookup)), ...answeredLive.map(request => `lookup server: ${request} was answered live`)],
  };
}

const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Normalise a triage verdict as archon-triage returns it and intake's evaluation carries it. */
export function toVerdict(value: unknown): Verdict {
  if (!isObject(value) || typeof value.contract !== 'string') throw new Error('the verdict names no contract');
  const edits = isObject(value.proposed_edits) && nonEmpty(value.proposed_edits.title) !== null ? value.proposed_edits : null;
  return {
    contract: value.contract as Contract,
    route: value.route === 'no_action' || typeof value.route !== 'string' ? null : (value.route as Route),
    pull_request: typeof value.pull_request === 'number' ? value.pull_request : null,
    type: value.type as Field,
    size: value.size as Field,
    complexity: value.complexity as Field,
    importance: value.importance as Field,
    urgency: value.urgency as Field,
    labels: Array.isArray(value.labels) ? (value.labels as string[]) : [],
    summary: typeof value.summary === 'string' ? value.summary : '',
    proposed_edits: edits === null ? null : { title: String(edits.title), body: String(edits.body) },
    blocked_reason: nonEmpty(value.blocked_reason),
    blocked_by: Array.isArray(value.blocked_by) ? (value.blocked_by as string[]) : [],
    closure: isObject(value.closure) ? (value.closure as unknown as Closure) : null,
  };
}

/**
 * A live item's verdict, as intake recorded it on the item's work document. The
 * document keeps an earlier run's triage when this run took another path, so only a
 * verdict this run recorded counts.
 */
export function liveVerdict(document: unknown, runId: string): Verdict | null {
  const facts = isObject(document) && isObject(document.facts) ? document.facts.triage : undefined;
  if (!isObject(facts) || !isObject(facts.verdict) || facts.run_id !== runId) return null;
  const { verdict } = facts;
  return {
    contract: verdict.contract as Contract,
    route: typeof verdict.route === 'string' ? (verdict.route as Route) : null,
    pull_request: typeof facts.pull_request === 'number' ? facts.pull_request : null,
    type: facts.type as Field,
    size: facts.size as Field,
    complexity: facts.complexity as Field,
    importance: facts.importance as Field,
    urgency: facts.urgency as Field,
  };
}

/** The workflow a row's run launches: a live run is always intake on the row's copy. */
function workflowOf(run: RowRun): BenchWorkflow {
  return run.live === undefined ? run.row.workflow : 'intake';
}

export interface RowRun {
  readonly row: Row;
  readonly resolved: ResolvedVersion<Version>;
  /** Where the run executes: the eval checkout, or the version's scratch checkout. */
  readonly cwd: string;
  /** The scratch repository and the row's copy number there; absent in eval. */
  readonly live?: { readonly repo: Repo; readonly number: number };
}

export interface BatchContext {
  readonly set: BenchSet;
  readonly batch: number;
  readonly batchRun: string;
  readonly base: string;
  readonly outDir: string;
  /** Each batch issue as it was at creation, by number: what an eval run's lookups answer with. */
  readonly views: ReadonlyMap<number, CreationView>;
  /** Why a batch issue could not be read, by number; its rows do not run. */
  readonly unread: ReadonlyMap<number, string>;
  /** Merged pull requests on the base that reference each row's issue, by row id. */
  readonly mergedOnBase: ReadonlyMap<string, readonly string[]>;
}

function inputsFor(run: RowRun, set: BenchSet): Record<string, string> {
  const { row, live } = run;
  if (live !== undefined) {
    return {
      repo_host: live.repo.host,
      repo_path: live.repo.path,
      number: String(live.number),
      kind: 'issue',
      action: 'opened',
      mode: 'live',
      trust: row.trust,
    };
  }
  if (row.workflow === 'triage') return { target: `# ${row.title}\n\n${row.body}`, publish: 'false' };
  return { repo_host: set.repo.host, repo_path: set.repo.path, number: String(row.number), mode: 'eval', trust: row.trust };
}

/** What a finished run decided, read from where its path records it. */
async function readDecision(run: RowRun, detail: RunDetail): Promise<{ path: IntakePath | null; verdict: Verdict | null }> {
  const returned = returnedValue(detail);
  if (workflowOf(run) === 'triage') return { path: null, verdict: toVerdict(returned) };
  const path = isObject(returned) ? INTAKE_PATHS.find(known => known === returned.path) : undefined;
  if (!isObject(returned) || path === undefined) throw new Error('intake returned no known path');
  if (run.live !== undefined) {
    if (returned.item !== run.live.number) {
      throw new Error(`intake claimed issue ${String(returned.item)}, not the row's copy ${String(run.live.number)}`);
    }
    const document = await archonJson(['state', 'get', `work/${String(run.live.number)}`], run.cwd);
    return { path, verdict: liveVerdict(document.value, detail.id) };
  }
  const evaluation = isObject(returned.evaluation) ? returned.evaluation : undefined;
  if (evaluation === undefined) throw new Error('eval intake returned no evaluation');
  return { path, verdict: evaluation.triage === null ? null : toVerdict(evaluation.triage) };
}

/** Launch one row on one version, wait for it, and record its line, whatever happened. */
export async function runRow(run: RowRun, context: BatchContext): Promise<Line> {
  const { row, resolved } = run;
  const { version } = resolved;
  const workflow = workflowOf(run);
  const problems: string[] = [];
  const fail = (error: unknown): void => {
    problems.push(error instanceof Error ? error.message : String(error));
  };
  let runId: string | null = null;
  let status = 'not_started';
  let detail: RunDetail | undefined;
  let decided: { path: IntakePath | null; verdict: Verdict | null } = { path: null, verdict: null };
  let lookups: LookupServer | undefined;
  try {
    const unread = context.unread.get(row.number);
    if (unread !== undefined) throw new Error(unread);
    // Live runs judge scratch copies, which hold no outcome to hide.
    if (run.live === undefined) lookups = serveLookups(context.set.repo, context.views);
    runId = await launch({
      workflow: WORKFLOWS[workflow],
      cwd: run.cwd,
      source: resolved.source,
      config: resolved.config,
      inputs: inputsFor(run, context.set),
      message: BENCH_MESSAGE,
      env: lookups?.env,
    });
    status = await waitRun(runId);
    detail = await getRun(runId);
    if (status !== 'completed') problems.push(`the run is ${status}`);
    else {
      decided = await readDecision(run, detail);
      // Every trust: auto row reaches triage; without a verdict there is nothing to score.
      if (row.trust === 'auto' && decided.verdict === null) problems.push(`intake took the ${String(decided.path)} path, so triage judged nothing`);
    }
  } catch (error) {
    fail(error);
    if (runId !== null && status === 'not_started') status = 'unknown';
  } finally {
    try {
      lookups?.stop();
    } catch (error) {
      fail(error);
    }
    problems.push(...(lookups?.problems ?? []));
  }

  const nodes = detail?.nodes ?? [];
  // A skipped agent node records an empty binding; only a judge that ran has a model to prove.
  const judge = nodes.find(node => node.nodeId === triageNodeId(workflow) && ran(node));
  const binding = agentBinding(judge) ?? null;
  if (binding?.provider !== undefined && binding.requested !== undefined) {
    if (binding.provider !== version.provider || binding.requested !== version.model) {
      problems.push(`triage ran ${binding.provider}/${binding.requested}, not ${version.provider}/${version.model}`);
    }
  } else if (decided.verdict !== null) {
    problems.push(`${triageNodeId(workflow)} recorded no model binding, so its version is unproven`);
  }
  let lookedUp: string[] = [];
  let report: string | null = null;
  try {
    if (detail?.transcript_path != null && existsSync(detail.transcript_path)) {
      const tokens = [
        ...issueTokens(context.set.repo, row.number),
        ...(run.live === undefined ? [] : issueTokens(run.live.repo, run.live.number)),
      ];
      lookedUp = findLookups(readFileSync(detail.transcript_path, 'utf8'), tokens);
    } else if (decided.verdict !== null) {
      problems.push('the transcript is unavailable, so the leak check was not performed');
    }
    if (detail !== undefined && existsSync(join(artifactsOf(detail), 'triage.md'))) {
      const target = join(context.outDir, 'items', detail.id, 'triage.md');
      mkdirSync(join(context.outDir, 'items', detail.id), { recursive: true });
      copyFileSync(join(artifactsOf(detail), 'triage.md'), target);
      report = relative(context.outDir, target);
    }
  } catch (error) {
    fail(error);
  }
  const { answered, leak } = splitLookups(lookedUp, (lookups?.answered(row.number) ?? 0) > 0, lookups?.answeredLive(row.number) ?? []);
  const ended = detail?.completed_at == null ? NaN : Date.parse(detail.completed_at) - Date.parse(detail.started_at);

  const line: Line = {
    at: new Date().toISOString(),
    batch: context.batch,
    batch_run: context.batchRun,
    mode: run.live === undefined ? 'eval' : 'live',
    base: context.base,
    row: row.id,
    number: row.number,
    group: row.group,
    workflow,
    trust: row.trust,
    version,
    run_id: runId,
    status,
    passed: status === 'completed' && problems.length === 0,
    problems,
    path: decided.path,
    agent_nodes: agentNodesRan(nodes),
    binding,
    verdict: decided.verdict,
    cost_usd: detail === undefined ? null : runCost(nodes),
    duration_ms: Number.isFinite(ended) ? ended : null,
    leak,
    answered_at_creation: answered,
    merged_on_base: context.mergedOnBase.get(row.id) ?? [],
    report,
  };
  appendLine(join(context.outDir, SAMPLES_FILE), line);
  return line;
}

// --- the batch's hard checks ----------------------------------------------------------

export interface Check {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface BatchChecks {
  readonly at: string;
  readonly batch: number;
  readonly batch_run: string;
  readonly mode: 'eval' | 'live';
  readonly labels: readonly string[];
  readonly checks: {
    /** The set's repository and its state documents are as they were before the batch. */
    readonly writes: Check;
    /** No `trust: outside` row ran an agent node, and each took intake's outside path. */
    readonly outside_agent: Check;
    /** No comment was posted on any batch issue or copy; intake builds none. */
    readonly posted_text: Check;
    /** Every run completed, or failed after an agent ran, and was read, so the after-read came after its last write. */
    readonly finished: Check;
  };
  readonly passed: boolean;
}

export type CheckName = keyof BatchChecks['checks'];

const check = (problems: readonly string[]): Check => ({ ok: problems.length === 0, problems });

export function batchChecks(
  context: BatchContext,
  mode: 'eval' | 'live',
  labels: readonly string[],
  lines: readonly Line[],
  writes: readonly string[],
  posted: readonly string[]
): BatchChecks {
  const outside = lines
    .filter(line => line.trust === 'outside')
    .flatMap(line => [
      ...line.agent_nodes.map(node => `${line.version.label} ${line.row}: ${node} ran`),
      ...(line.status === 'completed' && line.path !== 'outside' ? [`${line.version.label} ${line.row}: intake took the ${String(line.path)} path`] : []),
    ]);
  // A run that failed after an agent ran is the version's own result and counts against
  // its bars. A cancelled or unread run, or one that failed before any agent ran (a
  // refused credential at launch), says nothing about the version, so the batch cannot
  // be evaluated.
  const ownResult = (line: Line): boolean => line.status === 'completed' || (line.status === 'failed' && line.agent_nodes.length > 0);
  const finished = lines
    .filter(line => !ownResult(line))
    .map(line => `${line.version.label} ${line.row}: ${line.problems.join('; ')}`);
  const checks = { writes: check(writes), outside_agent: check(outside), posted_text: check(posted), finished: check(finished) };
  return {
    at: new Date().toISOString(),
    batch: context.batch,
    batch_run: context.batchRun,
    mode,
    labels,
    checks,
    passed: Object.values(checks).every(entry => entry.ok),
  };
}

/** Run `tasks` with at most `limit` in flight; no limit runs them all at once. */
export async function pooled<T>(tasks: readonly (() => Promise<T>)[], limit: number | undefined): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit ?? tasks.length, tasks.length) }, worker));
  return results;
}

export interface BatchOptions {
  readonly set: BenchSet;
  readonly rows: readonly Row[];
  readonly batch: number;
  readonly base: string;
  readonly outDir: string;
  readonly repoRoot: string;
  /** Each version and the checkout a row runs in: the row's own in eval, the version's scratch checkout live. */
  readonly versions: readonly { readonly resolved: ResolvedVersion<Version>; readonly checkout: (row: Row) => string }[];
  /** Present for a live batch: each label's scratch repository and its copies of the rows. */
  readonly live?: ReadonlyMap<string, { readonly scratch: Scratch; readonly copies: Readonly<Record<string, number>> }>;
  readonly concurrency?: number;
}

/**
 * Run every version over the batch and record its hard checks. Eval runs share one
 * pool; a live version's runs go one after another, because each live intake run
 * claims whichever waiting item its scratch project ranks first.
 */
export async function runBatch(options: BatchOptions): Promise<{ lines: Line[]; checks: BatchChecks }> {
  const { set, rows, outDir, live } = options;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const issues = new Map<number, BatchIssue>();
  const unread = new Map<number, string>();
  for (const row of rows) {
    if (issues.has(row.number) || unread.has(row.number)) continue;
    try {
      issues.set(row.number, readBatchIssue(set.repo, row, options.repoRoot, options.base));
    } catch (error) {
      unread.set(row.number, error instanceof Error ? error.message : String(error));
    }
  }
  const context: BatchContext = {
    set,
    batch: options.batch,
    batchRun: `${String(options.batch)}-${stamp}`,
    base: options.base,
    outDir,
    views: new Map([...issues].map(([number, issue]) => [number, issue.view])),
    unread,
    mergedOnBase: new Map(rows.map(row => [row.id, issues.get(row.number)?.merged_on_base ?? []])),
  };
  const runs = options.versions.map(({ resolved, checkout }) =>
    rows.map((row): RowRun => {
      const cwd = checkout(row);
      const scratch = live?.get(resolved.version.label);
      if (scratch === undefined) return { row, resolved, cwd };
      const number = scratch.copies[row.id];
      if (number === undefined) throw new Error(`${resolved.version.label}: row ${row.id} has no copy; run copy first`);
      return { row, resolved, cwd, live: { repo: scratch.scratch.repo, number } };
    })
  );
  const watched = [
    ...rows.map(row => ({ repo: set.repo, number: row.number })),
    ...runs.flat().flatMap(run => (run.live === undefined ? [] : [run.live])),
  ];
  // The state documents of the set's project, from the operator's checkout and from
  // each eval checkout; a live batch writes its scratch projects by design.
  const stateDirs = [options.repoRoot, ...(live === undefined ? runs.flat().map(run => run.cwd) : [])];
  const before = await snapshot(watched, stateDirs);

  const lines =
    live === undefined
      ? await pooled(runs.flat().map(run => () => runRow(run, context)), options.concurrency)
      : (await Promise.all(runs.map(async versionRuns => {
          const done: Line[] = [];
          for (const run of versionRuns) done.push(await runRow(run, context));
          return done;
        }))).flat();

  const setKeys = new Set(rows.map(row => issueKey(set.repo, row.number)));
  const onSet = (snap: Snapshot): Snapshot => ({
    issues: Object.fromEntries(Object.entries(snap.issues).filter(([key]) => setKeys.has(key))),
    state: snap.state,
  });
  let writes: string[];
  let posted: string[];
  try {
    const after = await snapshot(watched, stateDirs);
    writes = snapshotChanges(onSet(before), onSet(after));
    posted = postedComments(before, after);
  } catch (error) {
    const unproven = `the after-read failed, so the batch is unproven: ${error instanceof Error ? error.message : String(error)}`;
    writes = [unproven];
    posted = [unproven];
  }
  const checks = batchChecks(
    context,
    live === undefined ? 'eval' : 'live',
    options.versions.map(version => version.resolved.version.label),
    lines,
    writes,
    posted
  );
  appendLine(join(outDir, CHECKS_FILE), checks);
  return { lines, checks };
}
