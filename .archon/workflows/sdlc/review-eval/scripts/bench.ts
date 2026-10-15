/**
 * The review-lens bench: plants known defects into real merged changes and runs the
 * shipped review on each, one ordinary run per sample.
 *
 *   bench.ts prepare --set <set.json> --out <dir> [--batch <case>]
 *   bench.ts run --set <set.json> --batch <case> --version <v.yaml>... --out <dir>
 *                [--samples N] [--variant <id>...]
 *
 * Every sample reviews a sealed, history-less clone: a parentless snapshot of the
 * case base as `origin/<base_branch>`, and one commit on top holding the variant. No
 * later history, no sibling variant, no forge remote and no set file reaches the
 * checkout, so a lens can find the defect only by reading the change. Variant commits
 * carry a fixed identity and the case date, so their SHAs are the same on every machine.
 *
 * Versions run in parallel; inside a version, samples run one after another in one
 * checkout path, so Archon registers each (version, case) once as a project named
 * `eval-<label>/<case>` after its origin. A hold file beside the checkout names the
 * run working in it, so no later sample, retry or second bench replaces a checkout a
 * run may still be using.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  SAMPLES_FILE,
  TIERS,
  type ResolvedVersion,
  type RunDetail,
  type RunNode,
  type Spend,
  agentBinding,
  appendLine,
  artifactsOf,
  getRun,
  isId,
  launch,
  readLines,
  resolveVersion,
  spendOf,
  waitRun,
} from '../../.shared/bench.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { REVIEW_LENSES } from '../../.shared/review-policy.ts';
import { isObject } from '../../.shared/typed.ts';

export const LENSES = [...REVIEW_LENSES, 'simplify'] as const;
export type Lens = (typeof LENSES)[number];

/** Each defect class and the lenses whose charter owns it. */
export const DEFECT_OWNERS = {
  doubly_owned: ['seams'],
  reimplemented_primitive: ['simplify'],
  wrong_behaviour: ['code'],
  swallowed_error: ['errors'],
  weak_test: ['tests'],
  // Shipped documentation belongs to docs; a code comment to code.
  false_claim: ['docs', 'code'],
} as const satisfies Record<string, readonly Lens[]>;
export type DefectClass = keyof typeof DEFECT_OWNERS;

/** What a version runs by default, and the pack directories whose prompts it pins. */
const SUBJECT = {
  workflow: 'archon-review-eval',
  promptDirs: ['.archon/workflows/sdlc/review', '.archon/workflows/sdlc/simplify'],
};

/** The unplanted change: every case has it, and no declared variant may take its id. */
export const CLEAN = 'clean';

/** Variants are authored as if by one developer; the identity says nothing about the bench. */
const VARIANT_AUTHOR = { name: 'Developer', email: 'developer@example.com' };

export interface Defect {
  readonly id: string;
  readonly class: DefectClass;
  readonly owner: Lens;
  readonly claim: string;
  readonly location: string;
}

export interface Variant {
  readonly id: string;
  readonly defects: readonly Defect[];
  /** A commit whose tree is the variant, or a patch (absolute path) applied to the clean tree. */
  readonly tree?: string;
  readonly patch?: string;
}

export interface Case {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly branch: string;
  readonly base_branch: string;
  readonly base: string;
  readonly clean: string;
  readonly date: string;
  /** Absolute path of the work order file. */
  readonly work_order: string;
  readonly known_defects: readonly { readonly id: string; readonly claim: string }[];
  readonly variants: readonly Variant[];
}

/** A case date carries its zone: read in the local one, variant SHAs would differ by machine. */
const ZONED_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface BenchSet {
  /** Absolute path of the set file. */
  readonly path: string;
  readonly cases: readonly Case[];
}

/** Read and validate a set file, naming every problem at once. */
export function loadSet(path: string): BenchSet {
  const setPath = resolve(path);
  const setDir = dirname(setPath);
  const raw: unknown = JSON.parse(readFileSync(setPath, 'utf8'));
  const problems: string[] = [];
  if (!isObject(raw) || raw.bench !== 'review-lenses' || !Array.isArray(raw.cases)) {
    throw new Error(`${setPath}: not a review-lenses set (needs "bench": "review-lenses" and "cases")`);
  }
  const caseIds = new Set<string>();
  const cases: Case[] = [];
  for (const [index, entry] of raw.cases.entries()) {
    const where = `cases[${index}]`;
    if (!isObject(entry)) {
      problems.push(`${where} is not an object`);
      continue;
    }
    const { id, source, title, branch, base_branch: baseBranch, base, clean, date, work_order: workOrder } = entry;
    const texts = { source, title, branch, base_branch: baseBranch, base, clean, date, work_order: workOrder };
    const missing = Object.entries(texts)
      .filter(([, value]) => typeof value !== 'string' || value === '')
      .map(([name]) => name);
    if (!isId(id)) problems.push(`${where}: id must be letters, digits, \`.\`, \`_\` or \`-\``);
    if (missing.length > 0) problems.push(`${where}: ${missing.join(', ')} must be non-empty text`);
    if (!isId(id) || missing.length > 0) continue;
    const name = `case ${id}`;
    if (caseIds.has(id)) problems.push(`${name}: duplicate case id`);
    caseIds.add(id);
    if (branch === baseBranch) problems.push(`${name}: branch and base_branch must differ`);
    if (Number.isNaN(Date.parse(date as string)) || !ZONED_DATE.test(date as string)) {
      problems.push(`${name}: date ${String(date)} is not an ISO 8601 date ending in Z or ±hh:mm`);
    }
    const workOrderPath = resolve(setDir, workOrder as string);
    if (!existsSync(workOrderPath)) problems.push(`${name}: work order ${workOrderPath} does not exist`);

    const ids = new Set<string>();
    const claim = (itemId: unknown, where: string): itemId is string => {
      if (!isId(itemId)) {
        problems.push(`${name}: ${where} id must be letters, digits, \`.\`, \`_\` or \`-\``);
        return false;
      }
      if (ids.has(itemId)) problems.push(`${name}: duplicate id ${itemId}`);
      ids.add(itemId);
      return true;
    };
    const known: { id: string; claim: string }[] = [];
    for (const record of Array.isArray(entry.known_defects) ? entry.known_defects : []) {
      if (!isObject(record) || !claim(record.id, 'known defect')) continue;
      if (typeof record.claim !== 'string' || record.claim === '') problems.push(`${name}: known defect ${record.id} has no claim`);
      else known.push({ id: record.id, claim: record.claim });
    }
    const variants: Variant[] = [];
    const variantIds = new Set<string>([CLEAN]);
    for (const variant of Array.isArray(entry.variants) ? entry.variants : []) {
      if (!isObject(variant) || !isId(variant.id)) {
        problems.push(`${name}: a variant has no valid id`);
        continue;
      }
      const vName = `${name} variant ${variant.id}`;
      if (variantIds.has(variant.id)) problems.push(`${vName}: duplicate variant id`);
      variantIds.add(variant.id);
      const hasTree = typeof variant.tree === 'string' && variant.tree !== '';
      const hasPatch = typeof variant.patch === 'string' && variant.patch !== '';
      if (hasTree === hasPatch) problems.push(`${vName}: needs exactly one of tree and patch`);
      const patch = hasPatch ? resolve(setDir, variant.patch as string) : undefined;
      if (patch !== undefined && !existsSync(patch)) problems.push(`${vName}: patch ${patch} does not exist`);
      const defects: Defect[] = [];
      for (const defect of Array.isArray(variant.defects) ? variant.defects : []) {
        if (!isObject(defect) || !claim(defect.id, 'defect')) continue;
        const dName = `${vName} defect ${defect.id}`;
        if (typeof defect.class !== 'string' || !Object.hasOwn(DEFECT_OWNERS, defect.class)) {
          problems.push(`${dName}: unknown class ${String(defect.class)}`);
          continue;
        }
        const owners: readonly Lens[] = DEFECT_OWNERS[defect.class as DefectClass];
        if (!owners.includes(defect.owner as Lens)) {
          problems.push(`${dName}: owner must be one of ${owners.join(', ')} for ${defect.class}`);
          continue;
        }
        if (typeof defect.claim !== 'string' || defect.claim === '' || typeof defect.location !== 'string' || defect.location === '') {
          problems.push(`${dName}: needs a claim and a location`);
          continue;
        }
        defects.push({
          id: defect.id,
          class: defect.class as DefectClass,
          owner: defect.owner as Lens,
          claim: defect.claim,
          location: defect.location,
        });
      }
      if (defects.length === 0) problems.push(`${vName}: has no defect`);
      variants.push({
        id: variant.id,
        defects,
        ...(hasTree ? { tree: variant.tree as string } : {}),
        ...(patch !== undefined ? { patch } : {}),
      });
    }
    cases.push({
      id,
      source: source as string,
      title: title as string,
      branch: branch as string,
      base_branch: baseBranch as string,
      base: base as string,
      clean: clean as string,
      date: date as string,
      work_order: workOrderPath,
      known_defects: known,
      variants,
    });
  }
  if (problems.length > 0) throw new Error(`${setPath}:\n  ${problems.join('\n  ')}`);
  return { path: setPath, cases };
}

export interface PreparedCase {
  readonly store: string;
  /** The parentless snapshot of the base, on `refs/heads/<base_branch>`. */
  readonly snapshot: string;
  /** Variant id, `clean` included, to its commit, on `refs/variants/<id>`. */
  readonly variants: ReadonlyMap<string, string>;
}

function storeGit(store: string, env: Record<string, string>, ...args: string[]): string {
  return storeGitInput(store, env, undefined, ...args);
}

function storeGitInput(store: string, env: Record<string, string>, input: string | undefined, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', store, ...args], {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

/**
 * Build the case's sealed store under `<out>/cases/<case>/store.git`, borrowing the
 * project repository's objects through git alternates. Both trees drop the
 * directory holding the set file, so its defect answers never reach a checkout.
 */
export function prepareCase(set: BenchSet, bench: Case, repoRoot: string, outDir: string): PreparedCase {
  const refuse = (reason: string): never => {
    throw new Error(`case ${bench.id}: ${reason}`);
  };
  const pull = /#(\d+)$/.exec(bench.source)?.[1];
  const fetchHint = pull === undefined ? 'fetch the commit that holds it' : `fetch refs/pull/${pull}/head`;
  const commitOf = (ref: string, role: string): string => {
    const found = Bun.spawnSync(['git', '-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdout: 'pipe',
    });
    return found.exitCode === 0 ? found.stdout.toString().trim() : refuse(`${role} ${ref} is not in ${repoRoot}; ${fetchHint}`);
  };
  const base = commitOf(bench.base, 'base');
  const clean = commitOf(bench.clean, 'clean');
  const trees = new Map(bench.variants.flatMap(v => (v.tree === undefined ? [] : [[v.id, commitOf(v.tree, `variant ${v.id} tree`)]])));

  const store = join(outDir, 'cases', bench.id, 'store.git');
  if (!existsSync(store)) {
    mkdirSync(store, { recursive: true });
    gitOrThrow('init', '-q', '--bare', store);
    const objects = gitOrThrow('-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    writeFileSync(join(store, 'objects', 'info', 'alternates'), `${join(objects, 'objects')}\n`);
  }
  const index = join(outDir, 'cases', bench.id, `index.${process.pid}`);
  const indexed = { GIT_INDEX_FILE: index };
  const setDir = relative(realpathSync(repoRoot), realpathSync(dirname(set.path))).split(sep).join('/');
  if (setDir === '') refuse(`the set file ${set.path} must live in its own directory, not at the repository root`);
  // A set outside the repository is in no tree, so there is nothing to drop.
  const setInRepo = !setDir.startsWith('..') && !isAbsolute(setDir);
  const treeOf = (commit: string, patch?: string): string => {
    storeGit(store, indexed, 'read-tree', commit);
    if (setInRepo) storeGit(store, indexed, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', setDir);
    if (patch !== undefined) {
      try {
        storeGit(store, indexed, 'apply', '--cached', patch);
      } catch (error) {
        refuse(`patch ${patch} does not apply to clean ${clean}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return storeGit(store, indexed, 'write-tree');
  };
  const commit = (tree: string, message: string, identity: Record<string, string>, parent?: string): string =>
    storeGit(store, identity, 'commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', message);

  try {
    const [name, email, authorDate, committerName, committerEmail, committerDate, subject] = gitOrThrow(
      '-C',
      repoRoot,
      'log',
      '-1',
      '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s',
      base
    ).split('\0');
    const snapshot = commit(treeOf(base), subject, {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: committerEmail,
      GIT_COMMITTER_DATE: committerDate,
    });
    const refs = [`update refs/heads/${bench.base_branch} ${snapshot}`];

    const fixed = {
      GIT_AUTHOR_NAME: VARIANT_AUTHOR.name,
      GIT_AUTHOR_EMAIL: VARIANT_AUTHOR.email,
      GIT_AUTHOR_DATE: bench.date,
      GIT_COMMITTER_NAME: VARIANT_AUTHOR.name,
      GIT_COMMITTER_EMAIL: VARIANT_AUTHOR.email,
      GIT_COMMITTER_DATE: bench.date,
    };
    const cleanTree = treeOf(clean);
    const variants = new Map<string, string>();
    const record = (id: string, tree: string): void => {
      const sha = commit(tree, bench.title, fixed, snapshot);
      refs.push(`update refs/variants/${id} ${sha}`);
      variants.set(id, sha);
    };
    record(CLEAN, cleanTree);
    for (const variant of bench.variants) {
      const tree = treeOf(trees.get(variant.id) ?? clean, variant.patch);
      if (tree === cleanTree) refuse(`variant ${variant.id} changes nothing in the clean tree`);
      record(variant.id, tree);
    }
    storeGitInput(store, {}, `${refs.join('\n')}\n`, 'update-ref', '--stdin');
    return { store, snapshot, variants };
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * The (version, case) origin: a bare repository holding only the snapshot base branch.
 * An origin left by an earlier prepare of another base is rebuilt at the same path,
 * so the project Archon registered for it stays the same.
 */
export function ensureOrigin(prepared: PreparedCase, bench: Case, label: string, outDir: string): string {
  const origin = join(outDir, 'origins', `eval-${label}`, `${bench.id}.git`);
  const current = existsSync(origin)
    ? Bun.spawnSync(['git', '-C', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${bench.base_branch}`], { stdout: 'pipe' })
        .stdout.toString()
        .trim()
    : '';
  if (current !== prepared.snapshot) {
    rmSync(origin, { recursive: true, force: true });
    mkdirSync(dirname(origin), { recursive: true });
    gitOrThrow('clone', '-q', '--bare', '--no-local', '--single-branch', '--branch', bench.base_branch, prepared.store, origin);
    gitOrThrow('-C', origin, 'remote', 'remove', 'origin');
  }
  return origin;
}

/** A fresh clone of the origin at `checkout`, on the case branch at one variant's commit. */
export function cloneSample(prepared: PreparedCase, bench: Case, variant: string, origin: string, checkout: string): void {
  rmSync(checkout, { recursive: true, force: true });
  mkdirSync(dirname(checkout), { recursive: true });
  gitOrThrow('clone', '-q', '--no-local', origin, checkout);
  gitOrThrow('-C', checkout, 'fetch', '-q', '--no-tags', prepared.store, `refs/variants/${variant}:refs/heads/${bench.branch}`);
  gitOrThrow('-C', checkout, 'checkout', '-q', bench.branch);
  // FETCH_HEAD and the reflogs name the store and `refs/variants/<id>`, and through
  // them the bench's output directory and which variant this is.
  rmSync(join(checkout, '.git', 'FETCH_HEAD'), { force: true });
  rmSync(join(checkout, '.git', 'logs'), { recursive: true, force: true });
}

export interface Check {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const check = (problems: readonly string[]): Check => ({ ok: problems.length === 0, problems });

/** H1 before launch: the checkout's only remote is its local origin, and HEAD is the variant. */
function sealedBefore(checkout: string, origin: string, expected: string): string[] {
  const problems: string[] = [];
  const remotes = gitOrThrow('-C', checkout, 'remote').split('\n');
  if (remotes.length !== 1 || remotes[0] !== 'origin') problems.push(`remotes are ${remotes.join(', ')}, not only origin`);
  else if (realpathSync(gitOrThrow('-C', checkout, 'remote', 'get-url', 'origin')) !== realpathSync(origin)) {
    problems.push('origin is not the local origin');
  }
  const head = gitOrThrow('-C', checkout, 'rev-parse', 'HEAD');
  if (head !== expected) problems.push(`HEAD is ${head}, not the variant ${expected}`);
  return problems;
}

/** A lens is the node whose id, after its last `__`, is the lens name. */
function lensNode(run: RunDetail, lens: string): RunNode | undefined {
  const matches = run.nodes.filter(node => node.nodeId.split('__').pop() === lens);
  return matches.length === 1 ? matches[0] : undefined;
}

/** H2: the run's tiers are the version's, and every lens ran on the tier it names. */
function versionTruth(run: RunDetail, resolved: ResolvedVersion, lenses: readonly string[]): string[] {
  const problems: string[] = [];
  const { tiers } = resolved.version;
  for (const tier of TIERS) {
    const actual = run.aliases[tier];
    const pinned: Record<string, string | undefined> = { ...tiers[tier] };
    for (const [key, value] of Object.entries(pinned)) {
      if (!isObject(actual) || actual[key] !== value) {
        problems.push(`tier ${tier} ${key} is ${isObject(actual) ? String(actual[key]) : 'absent'}, not ${value}`);
      }
    }
  }
  for (const lens of lenses) {
    const binding = agentBinding(lensNode(run, lens));
    if (binding === undefined) {
      problems.push(`lens ${lens} has no single agent node`);
      continue;
    }
    const tier = TIERS.find(name => name === binding.tier);
    if (tier === undefined) {
      problems.push(`lens ${lens} ran on no tier`);
      continue;
    }
    if (binding.provider === undefined || binding.requested === undefined) {
      problems.push(`lens ${lens} has no provider binding`);
    } else if (binding.provider !== tiers[tier].provider || binding.requested !== tiers[tier].model) {
      problems.push(`lens ${lens} ran ${binding.provider}/${binding.requested}, not ${tier}'s ${tiers[tier].provider}/${tiers[tier].model}`);
    }
  }
  return problems;
}

/**
 * A completed run can still hold a failed node: `review-complete` joins the lenses
 * with `all_done`, so a crashed lens leaves a hole the run's status does not show.
 */
function completedProblems(run: RunDetail): string[] {
  const problems = run.status === 'completed' ? [] : [`the run is ${run.status}`];
  for (const node of run.nodes) if (node.state === 'failed') problems.push(`node ${node.nodeId} failed`);
  return problems;
}

export interface HardChecks {
  readonly checks: { readonly completed: Check; readonly output: Check; readonly sealed: Check; readonly version: Check };
  readonly passed: boolean;
}

/**
 * Whether a finished sample counts: the run completed with no failed node, every lens
 * the route selected left its file, the review left its `findings.json`, the run diffed
 * against the case's base branch (the rest of the seal is checked before launch), and
 * every lens ran on the version's tiers.
 */
export function hardChecks(
  run: RunDetail,
  resolved: ResolvedVersion,
  item: ReviewItem,
  bench: Pick<Case, 'base_branch'>
): HardChecks {
  const output: string[] = [];
  if (item.lenses.length === 0) output.push('the run left no lens file');
  for (const lens of LENSES) {
    const node = lensNode(run, lens);
    // A lens the route did not select is skipped; every other one owes its file.
    if (node?.kind === 'agent' && node.state !== 'skipped' && !item.lenses.includes(lens)) {
      output.push(`lens ${lens} ran but left no ${lens === 'simplify' ? 'shape.md' : `review/${lens}.md`}`);
    }
  }
  if (!item.findings) output.push('the run left no review/findings.json');
  const checks = {
    completed: check(completedProblems(run)),
    output: check(output),
    sealed: check(run.base_branch === bench.base_branch ? [] : [`the run's base branch is ${run.base_branch}, not ${bench.base_branch}`]),
    version: check(versionTruth(run, resolved, item.lenses)),
  };
  return { checks, passed: Object.values(checks).every(entry => entry.ok) };
}

/** Round copies (`code-round-1.md`) are history of a lens file, not another lens. */
const NOT_A_LENS = /^(scope|report.*|.+-round-\d+)\.md$/;

export interface ReviewItem {
  readonly lenses: readonly string[];
  /** Whether the review wrote its machine-readable `review/findings.json`. */
  readonly findings: boolean;
}

/**
 * Copy the sample's review output to `<out>/items/<run_id>/` and name its lenses:
 * any `review/<name>.md` the review does not declare as its own, and `shape.md` as
 * simplify. Reading files rather than a lens list lets one collector read every
 * pack shape a version can pin.
 */
export function collectItem(run: RunDetail, itemDir: string): ReviewItem {
  const artifacts = artifactsOf(run);
  mkdirSync(itemDir, { recursive: true });
  const lenses: string[] = [];
  if (existsSync(join(artifacts, 'review'))) {
    cpSync(join(artifacts, 'review'), join(itemDir, 'review'), { recursive: true });
    for (const file of readdirSync(join(itemDir, 'review'))) {
      if (file.endsWith('.md') && !NOT_A_LENS.test(file)) lenses.push(file.slice(0, -'.md'.length));
    }
  }
  if (existsSync(join(artifacts, 'shape.md'))) {
    cpSync(join(artifacts, 'shape.md'), join(itemDir, 'shape.md'));
    lenses.push('simplify');
  }
  return { lenses: lenses.sort(), findings: existsSync(join(itemDir, 'review', 'findings.json')) };
}

function lensRecord(run: RunDetail, lens: string): Record<string, unknown> {
  const node = lensNode(run, lens);
  const binding = agentBinding(node);
  return {
    node: node?.nodeId ?? null,
    tier: binding?.tier ?? null,
    provider: binding?.provider ?? null,
    model: binding?.requested ?? null,
    resolved_model: binding?.resolved ?? null,
    attempts: node?.attempts.length ?? 0,
    ...spendOf(node?.attempts ?? []),
  };
}

/** The run's total spend over every attempt of every agent node. */
export function runCost(run: RunDetail): Spend {
  return spendOf(run.nodes.flatMap(node => (node.kind === 'agent' ? node.attempts : [])));
}

/** The neutral trigger: a review of a branch with no pull request, and nothing more. */
export function reviewMessage(bench: Case): string {
  return `Review this branch's change against its merge-base with ${bench.base_branch}. It has no pull request; declare pr as null.`;
}

interface RunOptions {
  readonly bench: Case;
  readonly prepared: PreparedCase;
  readonly variants: readonly string[];
  readonly samples: number;
  readonly outDir: string;
}

/**
 * Take the checkout for one sample, or refuse while another run may be using it. The
 * hold is released only once the run it names is known to have finished; until then
 * only the operator, who can see that run, can release it.
 */
function holdCheckout(hold: string, checkout: string): void {
  mkdirSync(dirname(hold), { recursive: true });
  try {
    writeFileSync(hold, '', { flag: 'wx' });
  } catch (error) {
    if (!(isObject(error) && error.code === 'EEXIST')) throw error;
    const owner = readFileSync(hold, 'utf8').trim();
    throw new Error(
      `${checkout} is held by ${owner === '' ? 'a bench that has not launched its run' : `run ${owner}`}; ` +
        `once that is finished (archon workflow get ${owner || '<run-id>'}), delete ${hold} and run again`
    );
  }
}

async function runVersion(options: RunOptions, resolved: ResolvedVersion): Promise<void> {
  const { bench, prepared, outDir } = options;
  const { version } = resolved;
  const samplesFile = join(outDir, SAMPLES_FILE);
  const origin = ensureOrigin(prepared, bench, version.label, outDir);
  const checkout = join(outDir, 'checkouts', `eval-${version.label}`, bench.id);
  const hold = `${checkout}.run`;
  const workOrder = readFileSync(bench.work_order, 'utf8');
  for (const variant of options.variants) {
    const expected = prepared.variants.get(variant) as string;
    const taken = readLines(samplesFile)
      .filter(line => isObject(line.version) && line.version.label === version.label && line.case === bench.id && line.variant === variant)
      .map(line => (typeof line.sample === 'number' ? line.sample : 0));
    const first = Math.max(0, ...taken) + 1;
    for (let sample = first; sample < first + options.samples; sample++) {
      holdCheckout(hold, checkout);
      let runId: string;
      try {
        cloneSample(prepared, bench, variant, origin, checkout);
        const sealed = sealedBefore(checkout, origin, expected);
        if (sealed.length > 0) throw new Error(`${version.label} ${bench.id}/${variant}: not sealed: ${sealed.join('; ')}`);
        runId = await launch({
          workflow: version.workflow,
          cwd: checkout,
          source: resolved.source,
          config: resolved.config,
          inputs: { ...version.inputs, work_order: workOrder },
          message: reviewMessage(bench),
        });
      } catch (error) {
        // The launch was refused, so no run holds the checkout.
        rmSync(hold, { force: true });
        throw error;
      }
      writeFileSync(hold, runId);
      const name = `${version.label} ${bench.id}/${variant} #${sample}`;
      console.log(`${name}: run ${runId}`);
      const identity = { case: bench.id, variant, sample, run_id: runId, version };
      const fail = (error: unknown, run?: RunDetail): string => {
        const reason = error instanceof Error ? error.message : String(error);
        appendLine(samplesFile, { ...identity, ...(run === undefined ? {} : runCost(run)), error: reason, passed: false });
        return reason;
      };
      // A run that did not finish may still be working in the checkout the next sample
      // would replace, so the version stops here.
      try {
        await waitRun(runId);
      } catch (error) {
        throw new Error(`${name}: run ${runId} may still be running in ${checkout}: ${fail(error)}`);
      }
      rmSync(hold);
      // The run is paid for: whatever fails from here, its line is written and the batch goes on.
      let fetched: RunDetail | undefined;
      try {
        const run = await getRun(runId);
        fetched = run;
        const itemDir = join(outDir, 'items', runId);
        const item = collectItem(run, itemDir);
        const { checks, passed } = hardChecks(run, resolved, item, bench);
        appendLine(samplesFile, {
          ...identity,
          status: run.status,
          lenses: Object.fromEntries(item.lenses.map(lens => [lens, lensRecord(run, lens)])),
          checks,
          passed,
          ...runCost(run),
          duration_ms: run.completed_at === null ? null : Date.parse(run.completed_at) - Date.parse(run.started_at),
          item: relative(outDir, itemDir),
        });
        console.log(`${name}: ${run.status}, lenses ${item.lenses.join(', ') || 'none'}, hard checks ${passed ? 'passed' : 'FAILED'}`);
      } catch (error) {
        console.error(`${name}: not recorded: ${fail(error, fetched)}`);
        process.exitCode = 1;
      }
    }
  }
}

function repositoryRoot(): string {
  return gitOrThrow('rev-parse', '--show-toplevel');
}

function caseOf(set: BenchSet, id: string): Case {
  const bench = set.cases.find(entry => entry.id === id);
  if (bench === undefined) throw new Error(`no case ${id} in ${set.path}`);
  return bench;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      set: { type: 'string' },
      out: { type: 'string' },
      batch: { type: 'string' },
      version: { type: 'string', multiple: true },
      variant: { type: 'string', multiple: true },
      samples: { type: 'string', default: '1' },
    },
    strict: true,
  });
  if (values.set === undefined || values.out === undefined) throw new Error('--set and --out are required');
  const repoRoot = repositoryRoot();
  const outDir = resolve(values.out);
  const set = loadSet(values.set);

  if (command === 'prepare') {
    const cases = values.batch === undefined ? set.cases : [caseOf(set, values.batch)];
    for (const bench of cases) {
      const prepared = prepareCase(set, bench, repoRoot, outDir);
      for (const [id, sha] of prepared.variants) console.log(`${bench.id}/${id} ${sha}`);
    }
    return;
  }
  if (command !== 'run') throw new Error('usage: bench.ts prepare|run --set <set.json> --out <dir> ...');

  if (values.batch === undefined) throw new Error('run needs --batch <case>');
  const versionFiles = values.version ?? [];
  if (versionFiles.length === 0) throw new Error('run needs at least one --version <file>');
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer');
  const bench = caseOf(set, values.batch);
  const prepared = prepareCase(set, bench, repoRoot, outDir);
  const variants = values.variant ?? [...prepared.variants.keys()];
  const unknown = variants.filter(id => !prepared.variants.has(id));
  if (unknown.length > 0) throw new Error(`case ${bench.id} has no variant ${unknown.join(', ')}`);

  const resolved = versionFiles.map(file => resolveVersion(file, repoRoot, outDir, SUBJECT));
  const labels = resolved.map(entry => entry.version.label);
  const repeated = labels.find((label, index) => labels.indexOf(label) !== index);
  if (repeated !== undefined) throw new Error(`two versions are labelled ${repeated}`);

  const options: RunOptions = { bench, prepared, variants, samples, outDir };
  const results = await Promise.allSettled(resolved.map(entry => runVersion(options, entry)));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`bench: version ${labels[index]} stopped: ${reason}`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
