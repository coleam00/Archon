import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PackageManifest } from './check-package-edges';

/**
 * The repository's type-check: one TypeScript 7 `tsc -b` build over every workspace package
 * and root TypeScript project, plus each package that keeps a `type-check` script of its own.
 *
 * Every package is a project that references the workspace packages it imports, so a
 * dependent reads its dependencies' declarations instead of re-checking their source, and
 * each project's `.tsbuild` cache lets a warm run skip what nothing changed. One project is
 * checked at a time (`--builders 1 --checkers 1`), so peak memory is the largest single
 * project rather than a sum, and the package scripts run after the build, not beside it.
 * Measured 2026-11-22 on an 11-core machine: the whole repository from no cache peaked at
 * 1.7 GB in 45 s, where the earlier pool of two `tsc --noEmit` reached 4.6 GB in 74 s.
 *
 * TypeScript 7 is installed as `typescript-native` and run by path. `typescript` stays 5.x,
 * because the lint scripts and third-party tools use its JS API, which 7 does not ship.
 */

/** The TypeScript projects outside the workspace packages, checked from the repository root. */
export const ROOT_TSC_PROJECTS = [
  'scripts/tsconfig.json',
  '.archon/workflows/tsconfig.json',
] as const;

export type RootTscProject = (typeof ROOT_TSC_PROJECTS)[number];

export const REPO_ROOT = resolve(import.meta.dir, '..');

export type WorkspaceManifest = PackageManifest & {
  name: string;
  scripts?: Record<string, string>;
};

/** Every `packages/*` manifest, with `path` the package directory relative to the root. */
export function workspacePackages(root = REPO_ROOT): WorkspaceManifest[] {
  return [...new Bun.Glob('packages/*/package.json').scanSync({ cwd: root })]
    .map(manifest => manifest.replaceAll('\\', '/'))
    .sort()
    .map((manifest): WorkspaceManifest => {
      const parsed = JSON.parse(readFileSync(join(root, manifest), 'utf8')) as Omit<
        WorkspaceManifest,
        'path'
      >;
      return { ...parsed, path: dirname(manifest) };
    });
}

export interface TypeCheckTask {
  name: string;
  command: string[];
  cwd: string;
}

/**
 * How one package is type-checked. A package with a `type-check` script runs that script: the
 * docs site's Astro project needs `astro sync` first and is not part of the build. Any other
 * package with a `tsconfig.json` is a project in the build; one with neither has nothing to check.
 */
export function packageCheck(
  manifest: WorkspaceManifest,
  root = REPO_ROOT
): { kind: 'script'; task: TypeCheckTask } | { kind: 'project'; path: string } | null {
  if (manifest.scripts?.['type-check'] !== undefined) {
    return {
      kind: 'script',
      task: {
        name: manifest.name,
        command: ['bun', 'run', 'type-check'],
        cwd: join(root, manifest.path),
      },
    };
  }
  if (existsSync(join(root, manifest.path, 'tsconfig.json'))) {
    return { kind: 'project', path: `${manifest.path}/tsconfig.json` };
  }
  return null;
}

/** The TypeScript 7 compiler's entry point, resolved from the root manifest's alias. */
export function nativeTsc(root = REPO_ROOT): string {
  return join(dirname(Bun.resolveSync('typescript-native/package.json', root)), 'bin', 'tsc');
}

/**
 * One `tsc -b` over `projects` (tsconfig paths relative to the root). The build also brings
 * every project they reference up to date, so a project's dependencies are always checked
 * first, from their `.tsbuild` cache when nothing they read changed.
 */
export function buildTask(projects: readonly string[], root = REPO_ROOT): TypeCheckTask {
  return {
    name: `tsc -b ${projects.map(project => project.replace(/\/tsconfig\.json$/, '')).join(' ')}`,
    command: [
      process.execPath,
      nativeTsc(root),
      '-b',
      '--builders',
      '1',
      '--checkers',
      '1',
      ...projects,
    ],
    cwd: root,
  };
}

/** The build over `projects` plus the packages that check themselves, as tasks to run. */
export function typeCheckTasks(
  projects: readonly string[],
  scripts: readonly TypeCheckTask[],
  root = REPO_ROOT
): TypeCheckTask[] {
  return [...(projects.length > 0 ? [buildTask(projects, root)] : []), ...scripts];
}

/**
 * Runs every task, one after another, and returns the names of those that failed. Each task's
 * output is printed when it exits; a failure does not stop the others, so one pass reports every
 * type error. One at a time keeps the peak at the largest task instead of a sum.
 */
export async function runTypeChecks(tasks: readonly TypeCheckTask[]): Promise<string[]> {
  const failed: string[] = [];
  for (const task of tasks) {
    const startedAt = Date.now();
    // TypeScript 7 takes its working directory from $PWD, which can keep a symlinked path (on
    // macOS /tmp is /private/tmp), while it follows package symlinks to real paths. The two then
    // name one declaration twice and a cold build reports dozens of false errors, so every task
    // runs from the real path.
    const cwd = realpathSync(task.cwd);
    const child = Bun.spawn(task.command, {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const status = code === 0 ? 'ok' : `FAILED (exit ${String(code)})`;
    console.log(`=== ${task.name}: ${status} in ${seconds}s ===`);
    const output = `${stdout}${stderr}`.trim();
    if (code !== 0 && output.length > 0) console.log(output);
    if (code !== 0) failed.push(task.name);
  }
  return failed;
}

/** Prints the failures and returns the process exit code. */
export function reportTypeChecks(failed: readonly string[], total: number): number {
  if (failed.length === 0) {
    console.log(`type-check passed (${String(total)} ${total === 1 ? 'task' : 'tasks'})`);
    return 0;
  }
  console.error(`type-check failed in ${String(failed.length)} of ${String(total)} tasks:`);
  for (const name of failed) console.error(`  ${name}`);
  return 1;
}

if (import.meta.main) {
  const checks = workspacePackages().flatMap(manifest => packageCheck(manifest) ?? []);
  const tasks = typeCheckTasks(
    [
      ...checks.flatMap(check => (check.kind === 'project' ? [check.path] : [])),
      ...ROOT_TSC_PROJECTS,
    ],
    checks.flatMap(check => (check.kind === 'script' ? [check.task] : []))
  );
  process.exitCode = reportTypeChecks(await runTypeChecks(tasks), tasks.length);
}
