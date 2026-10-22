/**
 * The review-lens bench's run plumbing: the version record and its resolution, the
 * pack source snapshot, launching and waiting on ordinary runs through the `archon`
 * CLI, reading a finished run, JSONL lines, and the operator's marks.
 *
 * The bench launches ordinary top-level runs; the engine knows nothing about it. It
 * uses the `archon` on `PATH`, so pointing `PATH` at a development build benches that
 * build.
 *
 * A version pins what a sample ran: the pack at one commit and the model behind each
 * tier. Its record is `{label, pack_sha, prompt_sha, tiers, workflow, inputs}`. A label
 * means one record for the life of an output directory: lines of one label are
 * compared as one version, so `relabelRefusal` names a label that already names another.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, gitOrThrow } from '../../.shared/git.ts';
import { isObject } from '../../.shared/typed.ts';

export const TIERS = ['small', 'medium', 'large'] as const;
export type Tier = (typeof TIERS)[number];

/** The effort levels the engine accepts on a tier; its conformance test holds them equal. */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface TierBinding {
  readonly provider: string;
  readonly model: string;
  readonly effort?: Effort;
}

export interface Version {
  readonly label: string;
  /** The full commit the pack source is read from. */
  readonly pack_sha: string;
  /** Path to blob SHA of every prompt the bench measures, at `pack_sha`. */
  readonly prompt_sha: Readonly<Record<string, string>>;
  readonly tiers: Readonly<Record<Tier, TierBinding>>;
  readonly workflow: string;
  readonly inputs: Readonly<Record<string, string>>;
}

export interface ResolvedVersion {
  readonly version: Version;
  /** The extracted `.archon` snapshot a run reads its workflow from (`--workflow-source`). */
  readonly source: string;
  /** The run config layer holding only the tiers the version pins (`--config`). */
  readonly config: string;
}

/** A label, case, variant, row or batch id becomes a path segment and a JSONL key, never anything else. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export const SAMPLES_FILE = 'samples.jsonl';

/** What the bench measures: the workflow a version runs unless it names another, and its prompts. */
export interface BenchSubject {
  readonly workflow: string;
  /** Pack directories, from the repository root, whose `commands/*.md` a version pins. */
  readonly promptDirs: readonly string[];
}

/** Read a version file and pin it, or refuse before anything runs. */
export function resolveVersion(
  file: string,
  repoRoot: string,
  outDir: string,
  subject: BenchSubject
): ResolvedVersion {
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
  const { label, pack_sha: packRef, tiers, workflow = subject.workflow, inputs = {} } = raw;
  if (!isId(label)) return refuse('`label` must be letters, digits, `.`, `_` or `-`');
  if (typeof packRef !== 'string' || packRef === '') return refuse('`pack_sha` is missing');
  if (typeof workflow !== 'string' || workflow === '') return refuse('`workflow` must be a name');
  if (!isObject(inputs) || !Object.values(inputs).every(value => typeof value === 'string')) {
    return refuse('`inputs` must map names to strings');
  }
  if (!isObject(tiers)) return refuse('`tiers` is missing');
  const pinned: Partial<Record<Tier, TierBinding>> = {};
  for (const tier of TIERS) {
    const binding = tiers[tier];
    if (!isObject(binding)) return refuse(`tier \`${tier}\` is missing`);
    const { provider, model, effort } = binding;
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return refuse(`tier \`${tier}\` needs a provider and a model`);
    }
    if (effort === undefined) {
      pinned[tier] = { provider, model };
      continue;
    }
    const level = EFFORTS.find(name => name === effort);
    if (level === undefined) return refuse(`tier \`${tier}\` effort must be one of ${EFFORTS.join(', ')}`);
    pinned[tier] = { provider, model, effort: level };
  }

  const commit = git('-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${packRef}^{commit}`);
  if (commit.code !== 0) return refuse(`pack_sha ${packRef} is not a commit in ${repoRoot}`);
  const packSha = commit.stdout;
  const workflowFiles = gitOrThrow('-C', repoRoot, 'ls-tree', '-r', '--name-only', packSha, '--', '.archon/workflows')
    .split('\n')
    .filter(path => path.endsWith(`/${workflow}.yaml`) || path.endsWith(`/${workflow}.yml`));
  if (workflowFiles.length === 0) return refuse(`workflow ${workflow} does not exist at ${packSha}`);

  const version: Version = {
    label,
    pack_sha: packSha,
    prompt_sha: promptShas(repoRoot, packSha, subject.promptDirs),
    tiers: pinned as Record<Tier, TierBinding>,
    workflow,
    inputs: inputs as Record<string, string>,
  };
  const relabel = relabelRefusal(outDir, version);
  if (relabel !== undefined) return refuse(relabel);

  const config = join(outDir, 'versions', `${label}.config.yaml`);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, Bun.YAML.stringify({ tiers: version.tiers }, null, 2));
  return { version, source: snapshotSource(repoRoot, packSha, outDir), config };
}

/** Why `version`'s label cannot be used in `outDir`, when its samples already pin it to another record. */
export function relabelRefusal(outDir: string, version: { readonly label: string }): string | undefined {
  const samples = join(outDir, SAMPLES_FILE);
  for (const line of readLines(samples)) {
    if (isObject(line.version) && line.version.label === version.label && canonical(line.version) !== canonical(version)) {
      return `label ${version.label} already names another version in ${samples}; choose a new label`;
    }
  }
  return undefined;
}

function promptShas(repoRoot: string, sha: string, dirs: readonly string[]): Record<string, string> {
  if (dirs.length === 0) return {};
  const shas: Record<string, string> = {};
  for (const line of gitOrThrow('-C', repoRoot, 'ls-tree', '-r', sha, '--', ...dirs).split('\n')) {
    // `<mode> blob <sha>\t<path>`
    const [meta, path] = line.split('\t');
    if (path === undefined || !/\/commands\/[^/]+\.md$/.test(path)) continue;
    shas[path] = meta.split(' ')[2];
  }
  return shas;
}

/**
 * The pack source at `sha`, extracted once to `<outDir>/sources/<sha>/`.
 *
 * Extraction lands in a sibling directory first, so a bench that stopped midway, or
 * a version resolving the same commit in parallel, never leaves a partial source
 * that a later run would read as whole.
 */
export function snapshotSource(repoRoot: string, sha: string, outDir: string): string {
  const target = join(outDir, 'sources', sha);
  if (existsSync(target)) return target;
  const staging = `${target}.${process.pid}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = Bun.spawnSync(['git', '-C', repoRoot, 'archive', '--format=tar', sha, '.archon'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (archive.exitCode !== 0) throw new Error(`git archive ${sha} .archon failed: ${archive.stderr.toString().trim()}`);
  const extract = Bun.spawnSync(['tar', '-x', '-C', staging], { stdin: archive.stdout, stderr: 'pipe' });
  if (extract.exitCode !== 0) throw new Error(`extracting ${sha} failed: ${extract.stderr.toString().trim()}`);
  if (existsSync(target)) rmSync(staging, { recursive: true, force: true });
  else renameSync(staging, target);
  return target;
}

/** An `archon ... --json` call that answered `ok: false`: it refused, and no run it started is left working. */
export class ArchonRefused extends Error {}

/** One `archon ... --json` call in `cwd`: its parsed document, or a throw carrying what it said. */
export async function archonJson(args: readonly string[], cwd?: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['archon', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw new Error(`archon ${args.slice(0, 2).join(' ')} exited ${code} without JSON: ${(stdout || stderr).trim()}`);
  }
  if (isObject(document) && document.ok === false) {
    const reason = typeof document.error === 'string' ? document.error : stdout.trim();
    throw new ArchonRefused(`archon ${args.slice(0, 2).join(' ')} refused: ${reason}`);
  }
  if (code !== 0 || !isObject(document)) {
    const reason = isObject(document) && typeof document.error === 'string' ? document.error : stdout.trim();
    throw new Error(`archon ${args.slice(0, 2).join(' ')} exited ${code}: ${reason}`);
  }
  return document;
}

export interface Launch {
  readonly workflow: string;
  readonly cwd: string;
  readonly source: string;
  /** A run config layer (`--config`); without one the run reads the checkout's own config. */
  readonly config?: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly message: string;
  /** `--model` rebindings, such as a judge's `large=<spec>`. */
  readonly model?: Readonly<Record<string, string>>;
}

/** Start one detached run in `cwd` itself, with no worktree, and return its id. */
export async function launch(run: Launch): Promise<string> {
  const args = [
    'workflow',
    'run',
    run.workflow,
    '--cwd',
    run.cwd,
    '--no-worktree',
    '--workflow-source',
    run.source,
    ...(run.config === undefined ? [] : ['--config', run.config]),
    ...Object.entries(run.inputs).flatMap(([name, value]) => ['--input', `${name}=${value}`]),
    ...Object.entries(run.model ?? {}).flatMap(([name, spec]) => ['--model', `${name}=${spec}`]),
    '--detach',
    '--json',
    run.message,
  ];
  const ack = await archonJson(args);
  if (typeof ack.runId !== 'string' || ack.runId === '') {
    throw new Error(`archon workflow run ${run.workflow} acknowledged no runId`);
  }
  return ack.runId;
}

export type TerminalStatus = 'completed' | 'failed' | 'cancelled';

/**
 * Wait, with no timeout, until the run finishes. A bench run has no gate and no one
 * to answer it, so any other attention is a broken sample and refuses.
 */
export async function waitRun(runId: string): Promise<TerminalStatus> {
  const result = await archonJson(['workflow', 'wait', runId, '--json']);
  const attention = result.attention;
  if (isObject(attention) && attention.kind === 'terminal') {
    const status = attention.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  }
  throw new Error(`run ${runId} stopped without finishing: ${JSON.stringify(result)}`);
}

/** What a finished run's `returns:` node produced, including a value spilled to a file. */
export async function getReturns(runId: string): Promise<unknown> {
  const run = await archonJson(['workflow', 'get', runId, '--json']);
  const record = run.terminal_record;
  return returnedValue(runId, isObject(record) && isObject(record.returns) ? record.returns : null);
}

/** A provider's usage fact: a reported value, or the reason it is not one. */
export type Observation<T> =
  | { readonly source: 'provider'; readonly value: T }
  | { readonly source: 'unavailable'; readonly reason: string };

/** A reported cost is `partial` when the attempt made provider calls whose cost was not all reported. */
export type CostObservation =
  | { readonly source: 'provider'; readonly value: number; readonly partial?: true }
  | { readonly source: 'unavailable'; readonly reason: string };

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** What one finished attempt of an agent node reported spending. */
export interface AttemptSpend {
  readonly costUsd?: CostObservation;
  readonly tokens?: Observation<TokenUsage>;
}

/**
 * What the bench reads of an agent node's binding. The engine records every field as
 * optional (an agent node can run with no provider bound), so each is checked here.
 */
export interface NodeBinding {
  readonly provider?: string;
  readonly tier?: string;
  /** The model the tier asked for. */
  readonly requested?: string;
  /** The model the provider reported it ran, when it reported one. */
  readonly resolved?: string;
}

export interface RunNode {
  readonly nodeId: string;
  /** The node's state in the run's terminal record. */
  readonly state: string;
  /** The node's kind and binding as its latest execution row records them. */
  readonly kind?: string;
  readonly binding?: unknown;
  /** Each finished attempt's own spend, oldest first: a retried node has one per attempt. */
  readonly attempts: readonly AttemptSpend[];
}

const textOrNone = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The model binding an agent node ran on; any other node has none. */
export function agentBinding(node: RunNode | undefined): NodeBinding | undefined {
  if (node?.kind !== 'agent') return undefined;
  const { binding } = node;
  if (!isObject(binding)) return {};
  const model = isObject(binding.model) ? binding.model : {};
  const resolved = isObject(model.resolved) && model.resolved.source === 'provider' ? model.resolved.value : undefined;
  return {
    provider: textOrNone(binding.provider),
    tier: textOrNone(binding.tier),
    requested: textOrNone(model.requested),
    resolved: textOrNone(resolved),
  };
}

/**
 * Attempts' spend summed. A cost or token count is null when any attempt's is
 * unknown; `not_applicable` is an attempt that made no provider call, a known zero.
 * `cost_partial` marks a cost that is only a floor.
 */
export interface Spend {
  readonly cost_usd: number | null;
  readonly cost_partial: boolean;
  readonly tokens: { readonly input: number; readonly output: number } | null;
}

export function spendOf(attempts: readonly AttemptSpend[]): Spend {
  let cost: number | null = 0;
  let partial = false;
  let tokens: { input: number; output: number } | null = { input: 0, output: 0 };
  for (const { costUsd, tokens: used } of attempts) {
    if (costUsd?.source === 'provider' && Number.isFinite(costUsd.value) && costUsd.value >= 0) {
      if (cost !== null) cost += costUsd.value;
      partial ||= costUsd.partial === true;
    } else if (!(costUsd?.source === 'unavailable' && costUsd.reason === 'not_applicable')) {
      cost = null;
    }
    if (used?.source === 'provider') {
      if (tokens !== null) tokens = { input: tokens.input + used.value.input, output: tokens.output + used.value.output };
    } else if (!(used?.source === 'unavailable' && used.reason === 'not_applicable')) {
      tokens = null;
    }
  }
  return { cost_usd: cost, cost_partial: cost !== null && partial, tokens };
}

/** The part of `archon workflow get --json --verbose --events` the bench reads. */
export interface RunDetail {
  readonly id: string;
  readonly status: string;
  readonly output_root: string;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly base_branch: string;
  readonly aliases: Readonly<Record<string, unknown>>;
  readonly nodes: readonly RunNode[];
}

/**
 * Whether an event row's spend is its node's own, as the engine's `nodeCostScope` reads
 * it: a roll-up row restates spend its scope's own rows already carry, and a row written
 * before `accounting` existed marks a roll-up only with `aggregate: true`.
 */
export function reportsOwnSpend(data: Readonly<Record<string, unknown>>): boolean {
  if (typeof data.accounting === 'string') return data.accounting === 'node';
  return data.aggregate !== true;
}

const EXECUTION_ROWS = new Set(['node_started', 'node_completed', 'node_failed', 'node_skipped']);
const ATTEMPT_ROWS = new Set(['node_completed', 'node_failed']);

/**
 * Read a finished run's detail, refusing by name when a field the bench reads is absent.
 *
 * Node states come from the run's terminal record. Spend comes from the event rows,
 * because each attempt writes its own terminal row with only that attempt's usage,
 * while a node summary keeps only the last attempt's.
 */
export async function getRun(runId: string): Promise<RunDetail> {
  const run = await archonJson(['workflow', 'get', runId, '--json', '--verbose', '--events']);
  const missing = (field: string): never => {
    throw new Error(`archon workflow get ${runId}: the field \`${field}\` is missing`);
  };
  const field = (path: string): unknown => {
    let value: unknown = run;
    for (const key of path.split('.')) value = isObject(value) ? value[key] : undefined;
    return value;
  };
  const text = (path: string): string => {
    const value = field(path);
    return typeof value === 'string' ? value : missing(path);
  };
  const aliases = field('metadata.model_bindings.effective.aliases');
  const completedAt = field('completed_at');
  const states = field('terminal_record.nodes');
  const events = field('events');
  if (!Array.isArray(states) || !states.every(node => isObject(node) && typeof node.node_id === 'string' && typeof node.state === 'string')) {
    return missing('terminal_record.nodes');
  }
  if (!Array.isArray(events)) return missing('events');

  const executions = new Map<string, { kind?: string; binding?: unknown; readonly attempts: AttemptSpend[] }>();
  for (const event of events) {
    if (!isObject(event) || typeof event.step_name !== 'string' || !EXECUTION_ROWS.has(String(event.event_type))) continue;
    // SQLite returns the row's data as JSON text, PostgreSQL as an object.
    const data: unknown = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (!isObject(data) || !isObject(data.node)) continue;
    const execution = executions.get(event.step_name) ?? { attempts: [] };
    executions.set(event.step_name, execution);
    execution.kind = textOrNone(data.node.kind);
    execution.binding = data.binding;
    if (ATTEMPT_ROWS.has(String(event.event_type)) && reportsOwnSpend(data)) {
      const spend = isObject(data.spend) ? data.spend : {};
      execution.attempts.push({ costUsd: spend.costUsd as CostObservation | undefined, tokens: spend.tokens as Observation<TokenUsage> | undefined });
    }
  }

  return {
    id: text('id'),
    status: text('status'),
    output_root: text('output_root'),
    started_at: text('started_at'),
    completed_at: typeof completedAt === 'string' ? completedAt : null,
    base_branch: text('metadata.dispatch.base_branch'),
    aliases: isObject(aliases) ? aliases : missing('metadata.model_bindings.effective.aliases'),
    nodes: states.map(node => {
      const nodeId = node.node_id as string;
      const execution = executions.get(nodeId);
      return { nodeId, state: node.state as string, kind: execution?.kind, binding: execution?.binding, attempts: execution?.attempts ?? [] };
    }),
  };
}

/**
 * The run's `returns:` value, read from its terminal record's `returns`. A value too
 * large for the record was spilled to a file, which is read back; an unavailable one
 * throws with the engine's reason.
 */
function returnedValue(runId: string, returns: Readonly<Record<string, unknown>> | null): unknown {
  if (returns === null) throw new Error(`archon workflow get ${runId}: the field \`terminal_record.returns\` is missing`);
  if (returns.availability === 'available') return returns.value;
  if (returns.availability === 'truncated' && typeof returns.spill_path === 'string') {
    return JSON.parse(readFileSync(returns.spill_path, 'utf8'));
  }
  throw new Error(`run ${runId} returned no value: ${JSON.stringify(returns)}`);
}

/** The run's artifact directory, as the engine lays it out under the run's output root. */
export function artifactsOf(run: RunDetail): string {
  return join(run.output_root, 'artifacts', 'runs', run.id);
}

export function appendLine(file: string, line: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/** Every line of a JSONL file, oldest first; an absent file has none. */
export function readLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) throw new Error(`${file}:${index + 1} is not a JSON object`);
      return value;
    });
}

/** The newest line for each key, in the order each key first appeared; a line with no key is skipped. */
export function latestLines(
  file: string,
  key: (line: Record<string, unknown>) => string | undefined
): Map<string, Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const line of readLines(file)) {
    const name = key(line);
    if (name !== undefined) latest.set(name, line);
  }
  return latest;
}

/**
 * The operator's marks. On a judged defect a mark says whether the judge was right; on
 * a finding no planted or known defect accounts for, whether it is a real problem. An
 * unmarked entry is null.
 */
export const MARKS = {
  defect: ['right', 'wrong', 'partly'],
  finding: ['false_positive', 'real'],
} as const;
export type DefectMark = (typeof MARKS.defect)[number];
export type FindingMark = (typeof MARKS.finding)[number];

/** JSON with object keys sorted, so two records compare by content. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isObject(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner
  );
}
