import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isPathInside } from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';
import { listArtifactFiles, resolveRunArtifactsDir } from './workflow-inspect';
import { getLog, resolveRunIdArg } from './workflow-shared';

interface ArtifactsOptions {
  json?: boolean;
  cwd?: string;
}

/** Exits 1. Under `--json` it is one `{ ok: false }` document on stdout; otherwise one stderr line. */
async function fail(json: boolean | undefined, error: string, runId?: string): Promise<1> {
  if (json) await writeJsonLine({ ok: false, runId, error });
  else await writeStderr(`${error}\n`);
  return 1;
}

/**
 * `archon workflow artifacts <run-id> [path]`: list a run's artifact files, or
 * print one. Read-only and serverless; the run id resolves like `workflow get`.
 * `args` are the positionals after `artifacts`.
 */
export async function workflowArtifactsCommand(
  host: WorkflowHost,
  args: string[],
  opts: ArtifactsOptions
): Promise<number> {
  const [runId, path] = args;
  if (!runId || args.length > 2) {
    return fail(opts.json, 'Usage: archon workflow artifacts <run-id> [path] [--json]');
  }
  const resolved = await resolveArtifactsRun(host, runId, opts);
  if (typeof resolved === 'number') return resolved;
  return path === undefined
    ? listArtifacts(resolved.run, resolved.artifactsDir, opts.json)
    : readArtifact(resolved.run, resolved.artifactsDir, path, opts.json);
}

async function resolveArtifactsRun(
  host: WorkflowHost,
  runId: string,
  opts: ArtifactsOptions
): Promise<{ run: WorkflowRun; artifactsDir: string } | number> {
  let run: WorkflowRun | null = null;
  let artifactsDir: string | null;
  try {
    run = await host.deps.store.getWorkflowRun(await resolveRunIdArg(host, runId, opts.cwd));
    if (!run) return fail(opts.json, `Workflow run not found: ${runId}`, runId);
    artifactsDir = await resolveRunArtifactsDir(host, run);
  } catch (error) {
    const id = run?.id ?? runId;
    getLog().error({ err: error as Error, runId: id }, 'cli.workflow_artifacts_failed');
    return fail(opts.json, (error as Error).message, id);
  }
  // An empty list must mean the run wrote nothing, never that its location is unknown.
  if (!artifactsDir) {
    return fail(
      opts.json,
      `Artifacts not available: could not resolve the output location of run ${run.id}`,
      run.id
    );
  }
  return { run, artifactsDir };
}

async function listArtifacts(
  run: WorkflowRun,
  artifactsDir: string,
  json: boolean | undefined
): Promise<number> {
  const { files, omitted } = listArtifactFiles(artifactsDir, Number.POSITIVE_INFINITY);
  if (json) {
    await writeJsonLine({
      runId: run.id,
      artifactsDir,
      files,
      internalFiles: omitted.internalFiles,
      unreadable: omitted.unreadable,
    });
    return 0;
  }
  const lines = [`Artifacts for run ${run.id} (${artifactsDir}):`];
  if (files.length === 0) lines.push('  No artifact files.');
  for (const file of files) lines.push(`  - ${file}`);
  if (omitted.internalFiles > 0) {
    lines.push(`  Engine-internal artifact files (not listed): ${String(omitted.internalFiles)}`);
  }
  for (const dir of omitted.unreadable) {
    lines.push(`  Unreadable artifact directory: ${dir === '' ? '$ARTIFACTS_DIR' : dir}`);
  }
  await writeStdout(`${lines.join('\n')}\n`);
  return 0;
}

async function readArtifact(
  run: WorkflowRun,
  artifactsDir: string,
  path: string,
  json: boolean | undefined
): Promise<number> {
  const bytes = await readContainedFile(run, artifactsDir, path, json);
  if (typeof bytes === 'number') return bytes;
  if (!json) {
    await writeStdout(bytes);
    return 0;
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(
      json,
      `${path} is not UTF-8 text; read it without --json or at ${join(artifactsDir, path)}`,
      run.id
    );
  }
  await writeJsonLine({ runId: run.id, path, content });
  return 0;
}

async function readContainedFile(
  run: WorkflowRun,
  artifactsDir: string,
  path: string,
  json: boolean | undefined
): Promise<Buffer | number> {
  // One realpath containment check covers `..`, absolute-looking input and
  // symlinks that point out of the run's directory.
  try {
    const realDir = await realpath(artifactsDir);
    const realCandidate = await realpath(join(artifactsDir, path));
    if (!isPathInside(realDir, realCandidate, { includeRoot: true })) {
      return fail(json, `Artifact path is outside run ${run.id}'s artifacts: ${path}`, run.id);
    }
    if ((await stat(realCandidate)).isDirectory()) {
      return fail(
        json,
        `${path} is a directory; list with archon workflow artifacts ${run.id}`,
        run.id
      );
    }
    return await readFile(realCandidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR: a path that walks through a file, such as `plan.md/x`.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return fail(json, `Artifact not found: ${path}`, run.id);
    }
    getLog().error({ err: error as Error, runId: run.id }, 'cli.workflow_artifacts_failed');
    return fail(json, `Could not read artifact ${path}: ${(error as Error).message}`, run.id);
  }
}
