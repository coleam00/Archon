/**
 * `bun run check:factory-view <pack dir> [--view <file>] [--repo <owner/name>]`: checks a pack's
 * factory view (`<pack dir>/.shared/factory-view.json`, or `--view`) against the pack's graph,
 * with `checkFactoryView`, the check `GET /api/packs/{pack}/view` runs when it reads the file.
 * It prints each problem as `path: [error|warning] message` and exits 1 on any error.
 *
 * `<pack dir>` is a pack tree holding `archon-plugin.json`, such as an installed one at
 * `<home>/plugins/packs/<owner>/<name>/<commit>`; the pack's `owner/name` and commit are read
 * from that path, or from `--repo` with commit `local`. The tree is copied into a throwaway home,
 * laid out as `archon plugin add` lays out an install, and its graph is
 * `archon pack graph <owner.name> --json` there (core `readPackGraph`, the read the graph route
 * answers from). The tree itself is only read, and no live home is touched.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getPluginsPath } from '@archon/paths';
import { workflowPackReceiptSchema } from '../packages/plugin-manifest/src/index';
import { packTreePath, receiptPath } from '../packages/plugin-manifest/src/store';
import { FACTORY_VIEW_PATH, checkFactoryView } from '../packages/workflows/src/factory-view-check';
import { type PackGraph, packGraphSchema } from '../packages/workflows/src/pack-graph';
import { factoryViewSchema } from '../packages/workflows/src/schemas/factory-view';

const root = resolve(import.meta.dir, '..');
const USAGE = 'Usage: bun run check:factory-view <pack dir> [--view <file>] [--repo <owner/name>]';

/** The pack a tree is: its GitHub `owner/name` and the commit it is at. */
export interface PackIdentity {
  repo: string;
  commit: string;
}

/**
 * `owner/name` and commit from a tree installed at `.../packs/<owner>/<name>/<commit>`, else
 * from `repo` at commit `local`; an error when neither names the pack.
 */
export function packIdentity(dir: string, repo?: string): PackIdentity | { error: string } {
  const commit = basename(dir);
  const name = basename(dirname(dir));
  const owner = basename(dirname(dirname(dir)));
  const installed = basename(dirname(dirname(dirname(dir)))) === 'packs';
  if (repo !== undefined) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
      return { error: `--repo ${repo}: expected owner/name` };
    return { repo, commit: installed && `${owner}/${name}` === repo ? commit : 'local' };
  }
  if (installed) return { repo: `${owner}/${name}`, commit };
  return {
    error: `${dir} is not at packs/<owner>/<name>/<commit>; name the pack with --repo <owner/name>`,
  };
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

/** Copies `tree` into `plugins` where an install puts it, with a receipt naming its commit. */
function installCopy(plugins: string, tree: string, pack: PackIdentity): void {
  const target = packTreePath(plugins, pack.repo, pack.commit);
  mkdirSync(target, { recursive: true });
  cpSync(tree, target, { recursive: true });
  const receipt = workflowPackReceiptSchema.parse({
    schemaVersion: 1,
    id: pack.repo,
    manifest: JSON.parse(readFileSync(join(tree, 'archon-plugin.json'), 'utf8')),
    commit: pack.commit,
    installedAt: new Date().toISOString(),
  });
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
    return { graph: packGraphSchema.parse(JSON.parse(stdout)) };
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What the check prints and its exit code. */
export interface CheckReport {
  code: 0 | 1;
  lines: string[];
}

const line = (severity: string, path: readonly PropertyKey[], message: string): string =>
  `${path.map(String).join('.') || '(file)'}: [${severity}] ${message}`;

/** `view` (the file's parsed JSON) checked against `graph`: the schema first, then the names. */
export function checkView(view: unknown, graph: PackGraph): CheckReport {
  const parsed = factoryViewSchema.safeParse(view);
  const problems = parsed.success
    ? checkFactoryView(parsed.data, graph)
    : parsed.error.issues.map(issue => ({
        severity: 'error' as const,
        path: issue.path,
        message: issue.message,
      }));
  const errors = problems.filter(problem => problem.severity === 'error').length;
  return {
    code: errors === 0 ? 0 : 1,
    lines: [
      ...problems.map(problem => line(problem.severity, problem.path, problem.message)),
      `${String(errors)} errors, ${String(problems.length - errors)} warnings`,
    ],
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
  console.log(`Checking ${viewPath} against ${pack.repo} at ${pack.commit}`);
  const report = checkView(view, read.graph);
  for (const entry of report.lines) console.log(entry);
  return report.code;
}

if (import.meta.main) process.exit(main());
