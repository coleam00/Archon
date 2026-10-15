/**
 * What every bench in this pack shares: the pack source snapshot, launching and
 * waiting on ordinary runs through the `archon` CLI, reading a finished run, and
 * JSONL lines.
 *
 * A bench is a script that launches ordinary top-level runs; the engine knows nothing
 * about it. It uses the `archon` on `PATH`, so pointing `PATH` at a development build
 * benches that build.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isObject } from './typed.ts';

/** A label, row or batch id becomes a path segment and a JSONL key, never anything else. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
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
  /** The run's JSONL transcript; null when its storage can no longer be resolved. */
  readonly transcript_path: string | null;
  /** The terminal record's `returns`: the value the workflow declared, or why there is none. */
  readonly returns: Readonly<Record<string, unknown>>;
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
  const returns = field('terminal_record.returns');
  const nodes = field('nodes');
  const completedAt = field('completed_at');
  const transcript = field('transcript_path');
  return {
    id: text('id'),
    status: text('status'),
    output_root: text('output_root'),
    started_at: text('started_at'),
    completed_at: typeof completedAt === 'string' ? completedAt : null,
    transcript_path: typeof transcript === 'string' ? transcript : null,
    returns: isObject(returns) ? returns : missing('terminal_record.returns'),
    // The engine's node summaries cross a CLI boundary this pack cannot import types
    // over; each entry's identity is checked, and the bench reads the rest by name.
    nodes: Array.isArray(nodes) && nodes.every(node => isObject(node) && typeof node.nodeId === 'string')
      ? (nodes as RunNode[])
      : missing('nodes'),
  };
}

/**
 * The run's `returns:` value. A value too large for the record was spilled to a file,
 * which is read back; an unavailable one throws with the engine's reason.
 */
export function returnedValue(run: RunDetail): unknown {
  const { returns } = run;
  if (returns.availability === 'available') return returns.value;
  if (returns.availability === 'truncated' && typeof returns.spill_path === 'string') {
    return JSON.parse(readFileSync(returns.spill_path, 'utf8'));
  }
  throw new Error(`run ${run.id} returned no value: ${JSON.stringify(returns)}`);
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
