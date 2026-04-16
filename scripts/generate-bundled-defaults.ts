#!/usr/bin/env bun
/**
 * Regenerates packages/workflows/src/defaults/bundled-defaults.generated.ts from
 * the on-disk defaults in .archon/commands/defaults/ and .archon/workflows/defaults/.
 *
 * Emits inline string literals (via JSON.stringify) rather than Bun's
 * `import X from '...' with { type: 'text' }` attributes so the module loads
 * in Node too. This fixes two problems at once:
 *   - bundle drift (hand-maintained import list in bundled-defaults.ts)
 *   - SDK blocker #2 (type: 'text' import attributes are Bun-specific)
 *
 * Determinism: filenames are sorted before emission so CI can `git diff
 * --exit-code` on the output to catch unregenerated changes.
 *
 * Usage:
 *   bun run scripts/generate-bundled-defaults.ts
 *
 * Exit codes:
 *   0  file generated (and unchanged, if --check)
 *   1  unexpected error (unreadable source, invalid filename, etc.)
 *   2  --check was passed and the file would change
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const OUTPUT_PATH = join(
  REPO_ROOT,
  'packages/workflows/src/defaults/bundled-defaults.generated.ts'
);

const CHECK_ONLY = process.argv.includes('--check');

async function collectFiles(
  dir: string,
  extensions: readonly string[]
): Promise<Array<{ name: string; content: string }>> {
  const entries = await readdir(dir);
  const matched = entries.filter(entry => extensions.some(ext => entry.endsWith(ext))).sort();

  const files: Array<{ name: string; content: string }> = [];
  for (const entry of matched) {
    const ext = extensions.find(e => entry.endsWith(e));
    if (!ext) continue;
    const name = entry.slice(0, -ext.length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(
        `Bundled default has invalid filename "${entry}" in ${dir}. ` +
          `Names must be kebab-case (lowercase letters, digits, hyphens).`
      );
    }
    const content = await readFile(join(dir, entry), 'utf-8');
    if (!content.trim()) {
      throw new Error(`Bundled default "${entry}" in ${dir} is empty.`);
    }
    files.push({ name, content });
  }
  return files;
}

function renderRecord(
  comment: string,
  typeAlias: string,
  exportName: string,
  files: Array<{ name: string; content: string }>
): string {
  const entries = files
    .map(f => `  ${JSON.stringify(f.name)}: ${JSON.stringify(f.content)},`)
    .join('\n');
  return [
    `// ${comment} (${files.length} total)`,
    `export const ${exportName}: ${typeAlias} = {`,
    entries,
    `};`,
  ].join('\n');
}

function renderFile(
  commands: Array<{ name: string; content: string }>,
  workflows: Array<{ name: string; content: string }>
): string {
  const header = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Regenerate with: bun run scripts/generate-bundled-defaults.ts',
    ' * CI verifies this file is up-to-date via `bun run check:bundled`.',
    ' *',
    ' * Source of truth:',
    ' *   .archon/commands/defaults/*.md',
    ' *   .archon/workflows/defaults/*.{yaml,yml}',
    ' *',
    ' * Contents are inlined as plain string literals (JSON-escaped) so this',
    ' * module loads in both Bun and Node. Previous versions used',
    " * `import X from '...' with { type: 'text' }` which is Bun-specific.",
    ' */',
    '',
    '/* eslint-disable */',
    '',
  ].join('\n');

  return [
    header,
    renderRecord(
      'Bundled default commands',
      'Record<string, string>',
      'BUNDLED_COMMANDS',
      commands
    ),
    '',
    renderRecord(
      'Bundled default workflows',
      'Record<string, string>',
      'BUNDLED_WORKFLOWS',
      workflows
    ),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const [commands, workflows] = await Promise.all([
    collectFiles(COMMANDS_DIR, ['.md']),
    collectFiles(WORKFLOWS_DIR, ['.yaml', '.yml']),
  ]);

  const contents = renderFile(commands, workflows);

  if (CHECK_ONLY) {
    let existing = '';
    try {
      existing = await readFile(OUTPUT_PATH, 'utf-8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }
    if (existing !== contents) {
      console.error(
        `bundled-defaults.generated.ts is stale.\n` +
          `Run: bun run scripts/generate-bundled-defaults.ts`
      );
      process.exit(2);
    }
    console.log(
      `bundled-defaults.generated.ts is up to date (${commands.length} commands, ${workflows.length} workflows).`
    );
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(
    `Wrote ${OUTPUT_PATH}\n  ${commands.length} commands, ${workflows.length} workflows.`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
