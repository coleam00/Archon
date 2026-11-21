import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PackageManifest } from './check-package-edges';

/**
 * The repository's type-check: every workspace package's own `type-check` script, plus the
 * root TypeScript projects, run through a fixed-size pool.
 *
 * `bun --filter '*' type-check` started a `tsc` for every package at once, about 1.3 GB each.
 * `tsc` is single-threaded, so running more of them than the machine has cores buys no wall
 * time and only adds memory. CI's `static` job runs on a 4-vCPU runner.
 */
export const TYPE_CHECK_CONCURRENCY = 4;

/** The TypeScript projects outside the workspace packages, checked from the repository root. */
export const ROOT_TSC_PROJECTS = [
  'scripts/tsconfig.json',
  '.archon/scripts/tsconfig.json',
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

/** A package's own `type-check` script; a package without one has nothing to check. */
export function packageTask(manifest: WorkspaceManifest, root = REPO_ROOT): TypeCheckTask | null {
  if (manifest.scripts?.['type-check'] === undefined) return null;
  return {
    name: manifest.name,
    command: ['bun', 'run', 'type-check'],
    cwd: join(root, manifest.path),
  };
}

export function rootProjectTask(project: RootTscProject, root = REPO_ROOT): TypeCheckTask {
  return { name: project, command: ['bun', 'x', 'tsc', '--noEmit', '-p', project], cwd: root };
}

/**
 * Runs every task, at most `concurrency` at a time, and returns the number that failed. Each
 * task's output is buffered and printed when it exits, so parallel output never interleaves.
 * A failure does not stop the others: one pass reports every type error.
 */
export async function runTypeChecks(
  tasks: readonly TypeCheckTask[],
  concurrency = TYPE_CHECK_CONCURRENCY
): Promise<string[]> {
  const failed: string[] = [];
  const queue = [...tasks];
  const worker = async (): Promise<void> => {
    for (let task = queue.shift(); task !== undefined; task = queue.shift()) {
      const startedAt = Date.now();
      const child = Bun.spawn(task.command, { cwd: task.cwd, stdout: 'pipe', stderr: 'pipe' });
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
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return failed;
}

/** Prints the failures and returns the process exit code. */
export function reportTypeChecks(failed: readonly string[], total: number): number {
  if (failed.length === 0) {
    console.log(`type-check passed (${String(total)} projects)`);
    return 0;
  }
  console.error(`type-check failed in ${String(failed.length)} of ${String(total)} projects:`);
  for (const name of failed) console.error(`  ${name}`);
  return 1;
}

if (import.meta.main) {
  const tasks = [
    ...workspacePackages().flatMap(manifest => packageTask(manifest) ?? []),
    ...ROOT_TSC_PROJECTS.map(project => rootProjectTask(project)),
  ];
  process.exitCode = reportTypeChecks(await runTypeChecks(tasks), tasks.length);
}
