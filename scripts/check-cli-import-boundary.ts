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

function forbiddenBundleInput(input: string): boolean {
  const internal = repositoryInput(input);
  if (internal?.startsWith('packages/server/')) return true;
  if (internal?.startsWith('packages/adapters/')) {
    return (
      internal !== 'packages/adapters/src/platform-policies.ts' && !internal.endsWith('/policy.ts')
    );
  }
  // Shared runtime schemas use @hono/zod-openapi. Its empty Hono wrappers are
  // permitted; removing them requires the separate SDK schema work (#3647).
  return /(?:^|[/\\])node_modules[/\\](?:better-auth|@better-auth[/\\][^/\\]+|@slack[/\\][^/\\]+|discord\.js|@discordjs[/\\][^/\\]+|grammy|telegramify-markdown)(?:[/\\]|$)/.test(
    input
  );
}

async function serverBundleInputs(restoreServerImport = false): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [CLI_ENTRY],
    target: 'bun',
    minify: true,
    metafile: true,
    plugins: restoreServerImport
      ? [
          {
            name: 'prove-server-boundary',
            setup(build): void {
              build.onLoad(
                { filter: /packages[/\\]cli[/\\]src[/\\]commands[/\\]serve\.ts$/ },
                async args => ({
                  contents: `${await Bun.file(args.path).text()}\nconst server = await import('@archon/server'); await server.startServer();`,
                  loader: 'ts',
                })
              );
            },
          },
        ]
      : [],
  });
  if (!result.success || !result.metafile)
    throw new Error(
      `CLI bundle build failed: ${result.logs.map(message => message.message).join('\n')}`
    );
  const forbidden: string[] = [];
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput > 0 && forbiddenBundleInput(input)) {
        forbidden.push(`${input}: ${contribution.bytesInOutput} bytes`);
      }
    }
  }
  return forbidden.sort();
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
    'packages/paths/src/logger.ts',
    'packages/provider-contract/src/effort.ts',
    'packages/workflows/src/schemas/durable-wait.ts',
    'packages/workflows/src/schemas/effort.ts',
    'packages/workflows/src/schemas/model-binding.ts',
    'packages/workflows/src/schemas/run-config.ts',
  ]);
  const policyMetafile = buildImportGraph(
    join(repoRoot, 'packages/adapters/src/platform-policies.ts'),
    join(buildDir, 'platform-policies')
  );
  const policyInputs = Object.keys(policyMetafile.inputs)
    .map(repositoryInput)
    .filter((input): input is string => input !== undefined);
  assert.ok(
    policyInputs.every(
      input =>
        input === 'packages/adapters/src/platform-policies.ts' ||
        (input.startsWith('packages/adapters/src/') && input.endsWith('/policy.ts')) ||
        input.startsWith('packages/core/src/platforms/') ||
        input === 'packages/core/src/schemas/user.ts'
    ),
    'Platform policy bootstrap imports an implementation outside its declaration boundary'
  );
  console.log('CLI startup and detached handoff import boundaries pass.');
  if (process.env.CI) {
    const forbidden = await serverBundleInputs();
    assert.deepEqual(
      forbidden,
      [],
      `CLI bundle contains server or chat code:\n${forbidden.join('\n')}`
    );
    const restored = await serverBundleInputs(true);
    assert.ok(
      restored.some(input => repositoryInput(input)?.startsWith('packages/server/')),
      'Restored server import escaped the bundle check'
    );
    assert.ok(
      restored.some(input => input.includes('better-auth')),
      'Negative proof did not include auth'
    );
    assert.ok(
      restored.some(input => input.includes('discord.js')),
      'Negative proof did not include chat'
    );
    console.log(`Expected rejection with server import restored:\n${restored.join('\n')}`);
    console.log('CLI server-free bundle boundary passes, including its negative proof.');
  } else {
    console.log('Server-free bundle proof runs in CI; local startup boundaries passed.');
  }
} finally {
  await removeTempTree(buildDir);
}
