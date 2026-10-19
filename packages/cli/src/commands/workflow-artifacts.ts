import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isPathInside } from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';
import { listArtifactFiles, resolveRunArtifactsDir } from './workflow-inspect';
import { getLog, resolveRunIdArg } from './workflow-shared';

/**
 * `archon workflow artifacts <run-id> [path]`: list a run's artifact files, or
 * print one. Read-only and serverless; the run id resolves like `workflow get`.
 *
 * Every failure exits 1. Under `--json` it is one `{ ok: false }` document on
 * stdout; otherwise one line on stderr.
 */
export async function workflowArtifactsCommand(
  host: WorkflowHost,
  runId: string,
  opts: { path?: string; json?: boolean; cwd?: string }
): Promise<number> {
  const failWith = async (error: string, id = runId): Promise<number> => {
    if (opts.json) await writeJsonLine({ ok: false, runId: id, error });
    else await writeStderr(`${error}\n`);
    return 1;
  };

  let run: WorkflowRun | null;
  try {
    run = await host.deps.store.getWorkflowRun(await resolveRunIdArg(host, runId, opts.cwd));
  } catch (error) {
    getLog().error({ err: error as Error, runId }, 'cli.workflow_artifacts_failed');
    return failWith((error as Error).message);
  }
  if (!run) return failWith(`Workflow run not found: ${runId}`);

  const artifactsDir = await resolveRunArtifactsDir(host, run);
  // An empty list must mean the run wrote nothing, never that its location is unknown.
  if (!artifactsDir) {
    return failWith(
      `Artifacts not available: could not resolve the output location of run ${run.id}`,
      run.id
    );
  }

  if (opts.path === undefined) {
    const { files, omitted } = listArtifactFiles(artifactsDir, Number.POSITIVE_INFINITY);
    if (opts.json) {
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

  const path = opts.path;
  const candidate = join(artifactsDir, path);
  // One realpath containment check covers `..`, absolute-looking input and
  // symlinks that point out of the run's directory.
  let bytes: Buffer;
  try {
    const realDir = await realpath(artifactsDir);
    const realCandidate = await realpath(candidate);
    if (!isPathInside(realDir, realCandidate, { includeRoot: true })) {
      return failWith(`Artifact path is outside run ${run.id}'s artifacts: ${path}`, run.id);
    }
    if ((await stat(realCandidate)).isDirectory()) {
      return failWith(
        `${path} is a directory; list with archon workflow artifacts ${run.id}`,
        run.id
      );
    }
    bytes = await readFile(realCandidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR: a path that walks through a file, such as `plan.md/x`.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return failWith(`Artifact not found: ${path}`, run.id);
    }
    getLog().error({ err: error as Error, runId: run.id }, 'cli.workflow_artifacts_failed');
    return failWith(`Could not read artifact ${path}: ${(error as Error).message}`, run.id);
  }

  if (!opts.json) {
    await writeStdout(bytes);
    return 0;
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return failWith(`${path} is not UTF-8 text; read it without --json or at ${candidate}`, run.id);
  }
  await writeJsonLine({ runId: run.id, path, content });
  return 0;
}
