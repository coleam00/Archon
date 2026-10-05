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
 * Usage:
 *   bun run scripts/generate-codex-protocol.ts          # write
 *   bun run scripts/generate-codex-protocol.ts --check  # verify (exit 2 if stale)
 *
 * Exit codes:
 *   0  generated (and unchanged, if --check)
 *   1  unexpected error (binary missing, generator failure)
 *   2  --check was passed and the directory would change
 */
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, posix, resolve } from 'path';
import { resolveBundledCodexBinary } from '../packages/providers/src/codex/binary-resolver';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OUTPUT_DIR = join(REPO_ROOT, 'packages/providers/src/codex/protocol');
const CHECK_ONLY = process.argv.includes('--check');

/** The generated types the provider imports; everything they import comes along. */
const ROOTS = [
  'ClientRequest',
  'ServerNotification',
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
    const proc = Bun.spawnSync([codexBin, 'app-server', 'generate-ts', '--out', out], {
      stderr: 'pipe',
    });
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
        'Regenerate with `bun run generate:codex-protocol`; verify with `bun run check:codex-protocol`.',
        '',
      ].join('\n')
    );
    return files;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function readExisting(dir: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw e;
  }
  for (const entry of entries) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of await readExisting(dir, rel)) files.set(k, v);
    } else {
      files.set(rel, (await readFile(join(dir, rel), 'utf-8')).replace(/\r\n/g, '\n'));
    }
  }
  return files;
}

async function main(): Promise<void> {
  const generated = await generate();
  const existing = await readExisting(OUTPUT_DIR);

  if (CHECK_ONLY) {
    const stale = [...new Set([...generated.keys(), ...existing.keys()])].filter(
      file => generated.get(file) !== existing.get(file)
    );
    if (stale.length > 0) {
      console.error(
        `packages/providers/src/codex/protocol/ is stale vs the pinned @openai/codex (${stale.length} files differ, e.g. ${stale.slice(0, 3).join(', ')}).\nRun: bun run generate:codex-protocol`
      );
      process.exit(2);
    }
    console.log('check:codex-protocol OK');
    return;
  }

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
