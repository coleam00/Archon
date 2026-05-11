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
 * Determinism: filenames are sorted before emission so `bun run check:bundled`
 * (which regenerates into memory and compares to the committed file) catches
 * unregenerated changes. Wired into `bun run validate` and CI.
 *
 * Usage:
 *   bun run scripts/generate-bundled-defaults.ts           # write
 *   bun run scripts/generate-bundled-defaults.ts --check   # verify (exit 2 if stale)
 *
 * Exit codes:
 *   0  file generated (and unchanged, if --check)
 *   1  unexpected error (missing dir, unreadable source, invalid filename, etc.)
 *   2  --check was passed and the file would change
 */
import { access, readFile, readdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const OUTPUT_PATH = join(
  REPO_ROOT,
  'packages/workflows/src/defaults/bundled-defaults.generated.ts'
);

const CHECK_ONLY = process.argv.includes('--check');

interface BundledFile {
  name: string;
  content: string;
}

async function ensureDir(dir: string, label: string): Promise<void> {
  try {
    await access(dir);
  } catch {
    throw new Error(
      `${label} directory not found: ${dir}\n` +
        `Run this script from the repo root (cwd was ${process.cwd()}), ` +
        'or verify the .archon/ tree exists.'
    );
  }
}

async function collectFiles(dir: string, extensions: readonly string[]): Promise<BundledFile[]> {
  const entries = await readdir(dir);
  const matched = entries
    .map(entry => {
      const ext = extensions.find(e => entry.endsWith(e));
      return ext ? { entry, ext } : undefined;
    })
    .filter((m): m is { entry: string; ext: string } => m !== undefined)
    .sort((a, b) => a.entry.localeCompare(b.entry));

  const files: BundledFile[] = [];
  const seen = new Set<string>();
  for (const { entry, ext } of matched) {
    const name = entry.slice(0, -ext.length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(
        `Bundled default has invalid filename "${entry}" in ${dir}. ` +
          'Names must be kebab-case (lowercase letters, digits, hyphens).'
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `Bundled default name collision: "${name}" appears with multiple extensions in ${dir}. ` +
          'Keep a single file per name (remove either the .yaml or .yml variant).'
      );
    }
    seen.add(name);
    const raw = await readFile(join(dir, entry), 'utf-8');
    // Normalize to LF so output is identical regardless of the checkout's
    // line-ending policy (e.g. Windows `core.autocrlf=true` yields CRLF).
    const content = raw.replace(/\r\n/g, '\n');
    if (!content.trim()) {
      throw new Error(`Bundled default "${entry}" in ${dir} is empty.`);
    }
    files.push({ name, content });
  }
  return files;
}

function renderRecord(comment: string, exportName: string, files: BundledFile[]): string {
  const entries = files
    .map(f => `  ${JSON.stringify(f.name)}: ${JSON.stringify(f.content)},`)
    .join('\n');
  return [
    `// ${comment} (${files.length} total)`,
    `export const ${exportName}: Record<string, string> = {`,
    entries,
    '};',
  ].join('\n');
}

function renderFile(commands: BundledFile[], workflows: BundledFile[]): string {
  const header = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Regenerate with: bun run generate:bundled',
    ' * Verify up-to-date:  bun run check:bundled',
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
  ].join('\n');

  return [
    header,
    renderRecord('Bundled default commands', 'BUNDLED_COMMANDS', commands),
    '',
    renderRecord('Bundled default workflows', 'BUNDLED_WORKFLOWS', workflows),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  await Promise.all([
    ensureDir(COMMANDS_DIR, 'Commands defaults'),
    ensureDir(WORKFLOWS_DIR, 'Workflows defaults'),
  ]);

  const [commands, workflows] = await Promise.all([
    collectFiles(COMMANDS_DIR, ['.md']),
    collectFiles(WORKFLOWS_DIR, ['.yaml', '.yml']),
  ]);

  const contents = renderFile(commands, workflows);

  if (CHECK_ONLY) {
    let existing = '';
    try {
      const raw = await readFile(OUTPUT_PATH, 'utf-8');
      // Same LF normalization as collectFiles — the .ts itself may be
      // checked out with CRLF line endings on Windows.
      existing = raw.replace(/\r\n/g, '\n');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }
    if (existing !== contents) {
      console.error('bundled-defaults.generated.ts is stale.\n' + 'Run: bun run generate:bundled');
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

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
