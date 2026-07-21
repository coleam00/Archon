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
import { execFileAsync } from '@archon/git';

// BUNDLED_DEFAULTS_REPO_ROOT is a test seam: the integration tests point the
// script at a throwaway git repo (see
// packages/workflows/src/defaults/generate-bundled-defaults.test.ts).
const REPO_ROOT = process.env.BUNDLED_DEFAULTS_REPO_ROOT
  ? resolve(process.env.BUNDLED_DEFAULTS_REPO_ROOT)
  : resolve(import.meta.dir, '..');
const COMMANDS_REL = '.archon/commands/defaults';
const WORKFLOWS_REL = '.archon/workflows/defaults';
const COMMANDS_DIR = join(REPO_ROOT, COMMANDS_REL);
const WORKFLOWS_DIR = join(REPO_ROOT, WORKFLOWS_REL);
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

/**
 * Refuse to embed files that git does not track (#1578). An untracked file in
 * defaults/ would silently ship inside locally built binaries while being
 * absent from every other checkout and from CI builds — fail loudly instead.
 *
 * Intentionally stricter than collectFiles(): `git ls-files` recurses into
 * subdirectories and reports every untracked path, while the embedder only
 * reads top-level files with matching extensions. The asymmetry is deliberate
 * — anything untracked under defaults/ is a mistake worth flagging, even if
 * the embedder would ignore it today.
 */
async function assertNoUntrackedFiles(
  relDir: string,
  label: string,
  suggestedDest: string
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard', relDir],
      { cwd: REPO_ROOT }
    ));
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const detail = err.stderr?.trim() || err.message;
    // No fallback on purpose: skipping the check would re-introduce the exact
    // failure mode this guard exists to catch (embedding untracked files).
    throw new Error(
      `Failed to run \`git ls-files\` to verify ${label} is fully tracked: ${detail}\n` +
        'Is git installed and on PATH?',
      { cause: err }
    );
  }
  const untracked = stdout.trim().split('\n').filter(Boolean);
  if (untracked.length > 0) {
    const list = untracked.map(f => `  ${f}`).join('\n');
    throw new Error(
      `${label} contains untracked files that would be embedded into the binary bundle:\n${list}\n\n` +
        'Untracked files in defaults/ — stage and commit them (git add + git commit),\n' +
        `or move them to ${suggestedDest}.`
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

  // Runs after ensureDir (a missing directory still wins) and before
  // collectFiles (untracked files abort before being read into the bundle).
  await Promise.all([
    assertNoUntrackedFiles(
      COMMANDS_REL,
      'Commands defaults (.archon/commands/defaults/)',
      '.archon/commands/ (project-scope) or ~/.archon/commands/ (home-scope)'
    ),
    assertNoUntrackedFiles(
      WORKFLOWS_REL,
      'Workflows defaults (.archon/workflows/defaults/)',
      '.archon/workflows/ (project-scope) or ~/.archon/workflows/ (home-scope)'
    ),
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
