/**
 * `bun run check:factory-view <pack dir> [--view <file>] [--repo <owner/name>]`: checks a pack's
 * factory view (`<pack dir>/.shared/factory-view.json`, or `--view`) against the pack's graph,
 * with `servedFactoryView`, the read `GET /api/packs/{pack}/view` serves from. It prints each
 * problem as `path: [kind] message` and exits 1 on any: every problem is an error, because a
 * console draws around it rather than refusing the file, so only this check makes it fail.
 *
 * `<pack dir>` is any pack tree holding `archon-plugin.json`. An installed one, at
 * `<home>/plugins/packs/<owner>/<name>/<commit>`, names its `owner/name` and commit by its path.
 * Any other tree needs `--repo <owner/name>`; its commit is the tree's own HEAD when the tree is
 * the top of a git checkout, and otherwise unknown, which the output says (the graph does not
 * depend on it). The tree is copied into a throwaway home,
 * laid out as `archon plugin add` lays out an install, and its graph is
 * `archon pack graph <owner.name> --json` there (core `readPackGraph`, the read the graph route
 * answers from). The tree itself is only read, and no live home is touched.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getPluginsPath } from '@archon/paths';
import { workflowPackReceiptSchema } from '../packages/plugin-manifest/src/index';
import { packTreePath, receiptPath } from '../packages/plugin-manifest/src/store';
import { FACTORY_VIEW_PATH } from '../packages/workflows/src/factory-view-check';
import { servedFactoryView } from '../packages/workflows/src/factory-view-read';
import { type PackGraph, packGraphSchema } from '../packages/workflows/src/pack-graph';
import type { FactoryViewProblem } from '../packages/workflows/src/schemas/factory-view';

const root = resolve(import.meta.dir, '..');
const USAGE = 'Usage: bun run check:factory-view <pack dir> [--view <file>] [--repo <owner/name>]';

/** A commit for a tree whose commit cannot be known: an install receipt needs one. */
export const UNKNOWN_COMMIT = '0'.repeat(40);

/** The pack a tree is: its GitHub `owner/name`, the commit it is at, and how that is known. */
export interface PackIdentity {
  repo: string;
  commit: string;
  /** Where `commit` came from: the install path, the checkout's HEAD, or nowhere. */
  from: 'install' | 'checkout' | 'unknown';
}

/** The tree's HEAD when `dir` is the top of a git checkout (not a folder inside another). */
function checkoutHead(dir: string): string | undefined {
  const git = (...args: string[]): string | undefined => {
    const run = Bun.spawnSync(['git', '-C', dir, ...args], { stderr: 'ignore' });
    return run.exitCode === 0 ? run.stdout.toString().trim() : undefined;
  };
  const top = git('rev-parse', '--show-toplevel');
  if (top === undefined || resolve(top) !== resolve(dir)) return undefined;
  const head = git('rev-parse', 'HEAD');
  return head !== undefined && /^[0-9a-f]{40}$/.test(head) ? head : undefined;
}

/**
 * `owner/name` and commit from a tree installed at `.../packs/<owner>/<name>/<commit>`; for any
 * other tree, `repo` at the tree's HEAD or at `UNKNOWN_COMMIT`; an error when nothing names it.
 */
export function packIdentity(dir: string, repo?: string): PackIdentity | { error: string } {
  const commit = basename(dir);
  const name = basename(dirname(dir));
  const owner = basename(dirname(dirname(dir)));
  const installed =
    basename(dirname(dirname(dirname(dir)))) === 'packs' && /^[0-9a-f]{40}$/.test(commit);
  if (repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    return { error: `--repo ${repo}: expected owner/name` };
  if (installed && (repo === undefined || repo === `${owner}/${name}`))
    return { repo: `${owner}/${name}`, commit, from: 'install' };
  if (repo === undefined)
    return {
      error: `${dir} is not at packs/<owner>/<name>/<commit>; name the pack with --repo <owner/name>`,
    };
  const head = checkoutHead(dir);
  return head === undefined
    ? { repo, commit: UNKNOWN_COMMIT, from: 'unknown' }
    : { repo, commit: head, from: 'checkout' };
}

/**
 * Why `dir` is not the pack `repo` names, before its graph is read: the folder is missing, holds
 * no `archon-plugin.json`, or that manifest's `name` is not `repo`'s name half (a pack is found by
 * that name, so any owner works but the name must match). Undefined when it is the pack.
 */
export function packFolderProblem(dir: string, repo: string): string | undefined {
  if (!existsSync(dir)) return `${dir} does not exist`;
  const manifestPath = join(dir, 'archon-plugin.json');
  if (!existsSync(manifestPath)) return `${dir} holds no archon-plugin.json, so it is not a pack`;
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }).name;
  } catch (error) {
    return `${manifestPath}: ${(error as Error).message}`;
  }
  const wanted = repo.slice(repo.indexOf('/') + 1);
  if (name === wanted) return undefined;
  return `${dir} is the pack "${String(name)}" (its archon-plugin.json name), not "${wanted}": name it with --repo <owner>/${String(name)}`;
}

/** How the check names the commit it read: the reader must know when it is a stand-in. */
export function commitWords(pack: PackIdentity): string {
  if (pack.from === 'checkout') return `${pack.commit} (the checkout's HEAD)`;
  if (pack.from === 'unknown')
    return 'an unknown commit (not an install and not a git checkout: commit unknown)';
  return pack.commit;
}

/**
 * Why `archon pack graph --json` failed, in the CLI's own words: it prints `{ ok: false, error }`
 * on stdout. Output of any other shape is kept as written, so the evidence is not lost.
 */
function cliError(stdout: string, exitCode: number): string {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed)
      return String(parsed.error);
  } catch {
    // Not JSON: the raw text below is the evidence.
  }
  return stdout.trim() || `exited ${String(exitCode)} with no output`;
}

/** A schema refusal as one sentence naming its first issue's path, never a JSON dump. */
function firstIssue(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const [first] = issues;
  const at = first === undefined ? '' : first.path.map(String).join('.');
  return `${at === '' ? 'the input' : at}: ${first?.message ?? 'does not read'}`;
}

/** Copies `tree` into `plugins` where an install puts it, with a receipt naming its commit. */
function installCopy(plugins: string, tree: string, pack: PackIdentity): void {
  const target = packTreePath(plugins, pack.repo, pack.commit);
  mkdirSync(target, { recursive: true });
  cpSync(tree, target, { recursive: true });
  const read = workflowPackReceiptSchema.safeParse({
    schemaVersion: 1,
    id: pack.repo,
    manifest: JSON.parse(readFileSync(join(tree, 'archon-plugin.json'), 'utf8')),
    commit: pack.commit,
    installedAt: new Date().toISOString(),
  });
  if (!read.success)
    throw new Error(`the pack cannot be installed: ${firstIssue(read.error.issues)}`);
  const receipt = read.data;
  const path = receiptPath(plugins, pack.repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

/** The graph of the pack `tree` holds, read on a throwaway home that has only that pack. */
export function graphOfTree(
  tree: string,
  pack: PackIdentity
): { graph: PackGraph } | { error: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'factory-view-home-'));
  try {
    installCopy(getPluginsPath(scratch), tree, pack);
    const packKey = pack.repo.replace('/', '.');
    const read = Bun.spawnSync(
      ['bun', 'run', 'cli', 'pack', 'graph', packKey, '--cwd', root, '--json'],
      {
        cwd: root,
        stderr: 'inherit',
        // The child reads the scratch home only; '' keeps `.env` loading from restoring a live one.
        env: { ...process.env, ARCHON_HOME: scratch, ARCHON_FACTORY_LIVE_HOME: '' },
      }
    );
    const stdout = read.stdout.toString();
    if (read.exitCode !== 0) return { error: cliError(stdout, read.exitCode) };
    const graph = packGraphSchema.safeParse(JSON.parse(stdout));
    if (!graph.success)
      return { error: `the pack graph does not read: ${firstIssue(graph.error.issues)}` };
    return { graph: graph.data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What the check prints and its exit code. */
export interface CheckReport {
  code: 0 | 1;
  lines: string[];
}

const line = (problem: FactoryViewProblem): string =>
  `${problem.path.map(String).join('.') || '(file)'}: [${problem.kind}] ${problem.message}`;

/** `view` (the file's parsed JSON) read and reconciled with `graph`, as the view route serves it. */
export function checkView(view: unknown, graph: PackGraph): CheckReport {
  const { problems } = servedFactoryView(view, graph);
  return {
    code: problems.length === 0 ? 0 : 1,
    lines: [...problems.map(line), `${String(problems.length)} problems`],
  };
}

/** The command line's pack dir, `--view` and `--repo`, or a usage error. */
export function parseArgs(
  args: readonly string[]
): { dir: string; view?: string; repo?: string } | { error: string } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg !== '--view' && arg !== '--repo') {
      positional.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) return { error: `${arg} needs a value\n${USAGE}` };
    flags.set(arg, value);
    i++;
  }
  if (positional.length !== 1 || positional[0]?.startsWith('--')) return { error: USAGE };
  return {
    dir: resolve(positional[0] ?? ''),
    view: flags.get('--view'),
    repo: flags.get('--repo'),
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(args.error);
    return 2;
  }
  const pack = packIdentity(args.dir, args.repo);
  if ('error' in pack) {
    console.error(pack.error);
    return 2;
  }
  const notThePack = packFolderProblem(args.dir, pack.repo);
  if (notThePack !== undefined) {
    console.error(notThePack);
    return 2;
  }
  const viewPath = args.view === undefined ? join(args.dir, FACTORY_VIEW_PATH) : resolve(args.view);
  let view: unknown;
  try {
    view = JSON.parse(readFileSync(viewPath, 'utf8'));
  } catch (error) {
    console.error(`${viewPath}: ${(error as Error).message}`);
    return 1;
  }
  const read = graphOfTree(args.dir, pack);
  if ('error' in read) {
    console.error(`${args.dir}: could not read the pack graph of ${pack.repo}: ${read.error}`);
    return 1;
  }
  console.log(`Checking ${viewPath} against ${pack.repo} at ${commitWords(pack)}`);
  const report = checkView(view, read.graph);
  for (const entry of report.lines) console.log(entry);
  return report.code;
}

if (import.meta.main) process.exit(main());
