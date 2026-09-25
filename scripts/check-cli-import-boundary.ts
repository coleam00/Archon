import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const repoRoot = join(import.meta.dir, '..');
const CLI_ENTRY = join(repoRoot, 'packages/cli/src/cli.ts');

type BuildMetafile = NonNullable<Bun.BuildOutput['metafile']>;

function staticallyReachableInputs(metafile: BuildMetafile, start: string): string[] {
  const pending = [start];
  const visited = new Set<string>();
  const inputs = new Set<string>();

  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (outputPath === undefined || visited.has(outputPath)) continue;
    visited.add(outputPath);

    const output = metafile.outputs[outputPath];
    if (!output) throw new Error(`Build metafile references missing output '${outputPath}'.`);
    for (const input of Object.keys(output.inputs)) inputs.add(input);
    for (const imported of output.imports) {
      if (imported.kind !== 'dynamic-import') pending.push(imported.path);
    }
  }

  return [...inputs].sort();
}

function repositoryInput(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/');
  const packagesIndex = normalized.indexOf('packages/');
  return packagesIndex === -1 ? undefined : normalized.slice(packagesIndex);
}

function buildImportGraph(entry: string, outdir: string): BuildMetafile {
  const metafilePath = join(outdir, 'metafile.json');
  const result = spawnSync(
    process.execPath,
    [
      'build',
      entry,
      '--target=bun',
      '--format=esm',
      '--splitting',
      `--outdir=${outdir}`,
      `--metafile=${metafilePath}`,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 20000 }
  );
  if (result.status !== 0) {
    throw new Error(`Import graph build failed for ${entry}:\n${result.stdout}\n${result.stderr}`, {
      cause: result.error,
    });
  }
  return JSON.parse(readFileSync(metafilePath, 'utf8')) as BuildMetafile;
}

const buildDir = mkdtempSync(join(tmpdir(), 'archon-cli-import-graph-'));
try {
  const metafile = buildImportGraph(CLI_ENTRY, join(buildDir, 'cli'));
  // Isolate the handoff graph: shared CLI chunks can contain unrelated inputs.
  const handoffMetafile = buildImportGraph(
    join(repoRoot, 'packages/core/src/config/run-config-handoff.ts'),
    join(buildDir, 'handoff')
  );
  const entry = Object.entries(metafile.outputs).find(([, output]) =>
    output.entryPoint?.replaceAll('\\', '/').endsWith('packages/cli/src/cli.ts')
  )?.[0];
  assert.ok(entry, 'CLI entrypoint is missing from the build graph');

  const forbidden = staticallyReachableInputs(metafile, entry)
    .map(repositoryInput)
    .filter(
      (input): input is string =>
        input !== undefined &&
        (input.startsWith('packages/cli/src/commands/') ||
          input.startsWith('packages/core/src/') ||
          input.startsWith('packages/git/src/') ||
          input.startsWith('packages/providers/src/') ||
          input.startsWith('packages/workflows/src/'))
    );
  assert.deepEqual(forbidden, [], 'CLI startup imports heavyweight implementation');
  const internalInputs = Object.keys(handoffMetafile.inputs)
    .map(repositoryInput)
    .filter((input): input is string => input !== undefined)
    .sort();
  assert.deepEqual(internalInputs, [
    'packages/core/src/config/run-config-handoff.ts',
    'packages/core/src/utils/token-crypto.ts',
    'packages/paths/src/archon-paths.ts',
    'packages/paths/src/effort.ts',
    'packages/paths/src/logger.ts',
    'packages/workflows/src/schemas/durable-wait.ts',
    'packages/workflows/src/schemas/effort.ts',
    'packages/workflows/src/schemas/model-binding.ts',
    'packages/workflows/src/schemas/run-config.ts',
  ]);
  console.log('CLI startup and detached handoff import boundaries pass.');
} finally {
  await removeTempTree(buildDir);
}
