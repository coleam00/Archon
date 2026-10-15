#!/usr/bin/env bun
/**
 * Regenerates packages/providers/src/codex/protocol/ from the pinned `@openai/codex`
 * binary's `codex app-server generate-ts` (#3564).
 *
 * Why: the Codex provider speaks the app-server JSON-RPC protocol. Its types must come
 * from Codex itself, not a hand-written copy, and a Codex upgrade must fail CI until they
 * are regenerated. The generator writes the whole protocol; only the import closure of the
 * roots below is kept, because that is all the provider reads.
 *
 * Regenerate with `bun run generate:codex-protocol` after an SDK upgrade.
 */
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, posix, resolve } from 'path';
import { resolveBundledCodexBinary } from '../packages/providers/src/codex/binary-resolver';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OUTPUT_DIR = join(REPO_ROOT, 'packages/providers/src/codex/protocol');

/** The generated types the provider imports; everything they import comes along. */
const ROOTS = [
  'ClientRequest',
  'ServerNotification',
  // Requests Codex sends the client; Archon answers the ChatGPT token refresh by name.
  'ServerRequest',
  'v2/DynamicToolCallParams',
  // Response shapes: the test fake builds its replies against them.
  'InitializeResponse',
  'v2/ThreadStartResponse',
  'v2/ThreadResumeResponse',
  'v2/ThreadForkResponse',
  'v2/TurnStartResponse',
  'v2/TurnInterruptResponse',
  'v2/LoginAccountResponse',
  'v2/GetAccountResponse',
  'v2/Account',
  'v2/DynamicToolCallResponse',
  // Workflow-node capability scoping reads these.
  'v2/ConfigReadResponse',
  'v2/PluginInstalledResponse',
  'v2/PluginReadResponse',
  'v2/ListMcpServerStatusResponse',
];

async function generate(): Promise<Map<string, string>> {
  const { path: codexBin } = resolveBundledCodexBinary();
  const version = JSON.parse(
    await readFile(
      Bun.resolveSync('@openai/codex/package.json', join(REPO_ROOT, 'packages/providers')),
      'utf-8'
    )
  ) as { version: string };

  const out = await mkdtemp(join(tmpdir(), 'codex-protocol-'));
  try {
    const proc = Bun.spawnSync(
      [codexBin, 'app-server', 'generate-ts', '--experimental', '--out', out],
      {
        stderr: 'pipe',
      }
    );
    if (proc.exitCode !== 0) {
      throw new Error(`codex app-server generate-ts failed: ${proc.stderr.toString()}`);
    }

    // Walk relative imports from the roots. Paths are posix so the result is the same on Windows.
    const files = new Map<string, string>();
    const pending = ROOTS.map(root => `${root}.ts`);
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (files.has(file)) continue;
      const source = (await readFile(join(out, file), 'utf-8')).replace(/\r\n/g, '\n');
      files.set(file, source);
      for (const match of source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
        pending.push(posix.normalize(posix.join(posix.dirname(file), `${match[1]}.ts`)));
      }
    }
    files.set(
      'README.md',
      [
        '# Codex app-server protocol types',
        '',
        `AUTO-GENERATED from \`@openai/codex\` ${version.version} by \`scripts/generate-codex-protocol.ts\`. Do not edit.`,
        '',
        'Regenerate with `bun run generate:codex-protocol`; the version stamp is checked by `scripts/codex-protocol-version.test.ts`.',
        '',
      ].join('\n')
    );
    return files;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (Bun.argv.slice(2).length > 0) {
    throw new Error('Usage: bun run generate:codex-protocol');
  }
  const generated = await generate();
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  for (const [file, contents] of generated) {
    const target = join(OUTPUT_DIR, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf-8');
  }
  console.log(`Generated ${OUTPUT_DIR} (${generated.size} files)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
