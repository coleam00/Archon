/**
 * What every bench in this pack shares: the version record and its resolution, the
 * pack source snapshot, launching and waiting on ordinary runs through the `archon`
 * CLI, JSONL lines, and the operator's mark vocabulary.
 *
 * A bench is a script that launches ordinary top-level runs; the engine knows nothing
 * about it. It uses the `archon` on `PATH`, so pointing `PATH` at a development build
 * benches that build.
 *
 * A version pins what a sample ran: the pack at one commit and the model behind each
 * tier. Its record is `{label, pack_sha, prompt_sha, tiers, workflow, inputs}`, and a
 * label means one record for the life of an output directory: lines of one label are
 * compared as one version, so `resolveVersion` refuses a label that already names
 * another.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, gitOrThrow } from './git.ts';
import { isObject } from './typed.ts';

export const TIERS = ['small', 'medium', 'large'] as const;
export type Tier = (typeof TIERS)[number];

export interface TierBinding {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
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
  /** The run config layer holding only the version's tiers (`--config`). */
  readonly config: string;
}

/** The operator's marks: on a planted defect, and on a finding of an unplanted change. */
export const MARKS = {
  defect: ['right', 'wrong', 'partly'],
  finding: ['false_positive', 'real'],
} as const;

/** A label, case or variant id becomes a path segment and a JSONL key, never anything else. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export const SAMPLES_FILE = 'samples.jsonl';

/** What a bench measures: the workflow a version runs unless it names another, and its prompts. */
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
    if (effort !== undefined && typeof effort !== 'string') return refuse(`tier \`${tier}\` effort must be text`);
    pinned[tier] = effort === undefined ? { provider, model } : { provider, model, effort };
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
  for (const line of readLines(join(outDir, SAMPLES_FILE))) {
    if (isObject(line.version) && line.version.label === label && canonical(line.version) !== canonical(version)) {
      return refuse(`label ${label} already names another version in ${join(outDir, SAMPLES_FILE)}; choose a new label`);
    }
  }

  const config = join(outDir, 'versions', `${label}.config.yaml`);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, Bun.YAML.stringify({ tiers: version.tiers }, null, 2));
  return { version, source: snapshotSource(repoRoot, packSha, outDir), config };
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

/** One `archon ... --json` call: its parsed document, or a throw carrying what it said. */
async function archonJson(args: readonly string[]): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['archon', ...args], { stdout: 'pipe', stderr: 'pipe' });
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
  if (code !== 0 || !isObject(document) || document.ok === false) {
    const reason = isObject(document) && typeof document.error === 'string' ? document.error : stdout.trim();
    throw new Error(`archon ${args.slice(0, 2).join(' ')} exited ${code}: ${reason}`);
  }
  return document;
}

export interface Launch {
  readonly workflow: string;
  readonly cwd: string;
  readonly source: string;
  readonly config: string;
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
    '--config',
    run.config,
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

/** A provider's usage fact: a reported value, or the reason it is not one. */
export type Observation<T> =
  | { readonly source: 'provider'; readonly value: T }
  | { readonly source: 'unavailable'; readonly reason: string };

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * What a bench reads of an agent node's binding. The engine records every field as
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
  readonly state: string;
  readonly execution?: {
    readonly node?: { readonly kind: string };
    readonly binding?: unknown;
    readonly spend?: {
      readonly costUsd?: Observation<number>;
      readonly tokens?: Observation<TokenUsage>;
    };
  };
}

const textOrNone = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The model binding an agent node ran on; any other node has none. */
export function agentBinding(node: RunNode | undefined): NodeBinding | undefined {
  if (node?.execution?.node?.kind !== 'agent') return undefined;
  const { binding } = node.execution;
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

/** The part of `archon workflow get --json --verbose` a bench reads. */
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

/** Read a finished run's detail, refusing by name when a field the bench reads is absent. */
export async function getRun(runId: string): Promise<RunDetail> {
  const run = await archonJson(['workflow', 'get', runId, '--json', '--verbose']);
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
  const nodes = field('nodes');
  const completedAt = field('completed_at');
  return {
    id: text('id'),
    status: text('status'),
    output_root: text('output_root'),
    started_at: text('started_at'),
    completed_at: typeof completedAt === 'string' ? completedAt : null,
    base_branch: text('metadata.dispatch.base_branch'),
    aliases: isObject(aliases) ? aliases : missing('metadata.model_bindings.effective.aliases'),
    // The engine's node summaries cross a CLI boundary this pack cannot import types
    // over; each entry's identity is checked, and the bench reads the rest by name.
    nodes: Array.isArray(nodes) && nodes.every(node => isObject(node) && typeof node.nodeId === 'string')
      ? (nodes as RunNode[])
      : missing('nodes'),
  };
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

/** The newest line for each key: a later line replaces an earlier one with the same key. */
export function latestLines(
  file: string,
  key: (line: Record<string, unknown>) => string
): Map<string, Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const line of readLines(file)) latest.set(key(line), line);
  return latest;
}

/** JSON with object keys sorted, so two records compare by content. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isObject(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner
  );
}
