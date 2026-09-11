#!/usr/bin/env bun
/**
 * Regenerates packages/workflows/src/defaults/bundled-defaults.generated.ts from
 * the packs selected by packages/workflows/src/defaults/bundle-index.json.
 * bundle-inventory.ts owns the file selection for this script and live source capture.
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
import { readFile, writeFile } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { execFileAsync } from '@archon/git';
import {
  collectBundleSources,
  readBundleContent,
  readBundleIndex,
} from '../packages/workflows/src/defaults/bundle-inventory';

import type { BundledScriptPack } from '../packages/workflows/src/defaults/bundled-script-pack';
import type { WorkflowResourceOwner } from '../packages/workflows/src/packaged-workflow';

// BUNDLED_DEFAULTS_REPO_ROOT is a test seam: the integration tests point the
// script at a throwaway git repo (see
// packages/workflows/src/defaults/generate-bundled-defaults.test.ts).
const REPO_ROOT = process.env.BUNDLED_DEFAULTS_REPO_ROOT
  ? resolve(process.env.BUNDLED_DEFAULTS_REPO_ROOT)
  : resolve(import.meta.dir, '..');
const COMMANDS_REL = '.archon/commands/defaults';
const WORKFLOWS_REL = '.archon/workflows/defaults';
const WORKFLOWS_ROOT_REL = '.archon/workflows';
const WORKFLOWS_ROOT = join(REPO_ROOT, WORKFLOWS_ROOT_REL);
const OUTPUT_PATH = join(
  REPO_ROOT,
  'packages/workflows/src/defaults/bundled-defaults.generated.ts'
);

const CHECK_ONLY = process.argv.includes('--check');

interface BundledFile {
  name: string;
  content: string;
}

type BundledWorkflowOwner = Pick<WorkflowResourceOwner, 'pack' | 'workflow'>;

/**
 * Refuse to embed files that git does not track (#1578). An untracked file in
 * defaults/ would silently ship inside locally built binaries while being
 * absent from every other checkout and from CI builds — fail loudly instead.
 *
 * Intentionally stricter than the selected inventory: `git ls-files` recurses into
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

async function assertTrackedPackagedFiles(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const relativePaths = paths.map(path => relative(REPO_ROOT, path).replaceAll('\\', '/'));
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--', ...relativePaths],
    { cwd: REPO_ROOT }
  );
  const tracked = new Set(stdout.trim().split('\n').filter(Boolean));
  const missing = relativePaths.filter(path => !tracked.has(path));
  if (missing.length > 0) {
    throw new Error(
      `Packaged workflows contain untracked files that would be embedded into the binary bundle:\n${missing
        .map(path => `  ${path}`)
        .join('\n')}\n\nStage and commit them, or remove them from the packaged workflow folder.`
    );
  }
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

function renderMapRecord<T>(
  comment: string,
  exportName: string,
  typeName: string,
  entries: ReadonlyMap<string, T>,
  recordType = `Record<string, ${typeName}>`
): string {
  const rendered = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)},`)
    .join('\n');
  return [
    `// ${comment} (${entries.size} total)`,
    `export const ${exportName}: ${recordType} = {`,
    rendered,
    '};',
  ].join('\n');
}

function renderFile(
  commands: BundledFile[],
  workflows: BundledFile[],
  workflowOwners: ReadonlyMap<string, BundledWorkflowOwner>,
  scriptPacks: ReadonlyMap<string, BundledScriptPack>,
  workflowPaths: ReadonlyMap<string, string>
): string {
  const header = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Regenerate with: bun run generate:bundled',
    ' * Verify up-to-date:  bun run check:bundled',
    ' *',
    ' * Source of truth: bundle-index.json selects packs; bundle-inventory.ts selects files.',
    ' *',
    ' * Contents are inlined as plain string literals (JSON-escaped) so this',
    ' * module loads in both Bun and Node. Previous versions used',
    " * `import X from '...' with { type: 'text' }` which is Bun-specific.",
    ' */',
    '',
  ].join('\n');

  return [
    header,
    "import type { BundledScriptPack } from './bundled-script-pack';",
    "import type { WorkflowResourceOwner } from '../packaged-workflow';",
    '',
    "export type BundledWorkflowOwner = Pick<WorkflowResourceOwner, 'pack' | 'workflow'>;",
    '',
    renderRecord('Bundled commands', 'BUNDLED_COMMANDS', commands),
    '',
    renderRecord('Bundled workflows', 'BUNDLED_WORKFLOWS', workflows),
    '',
    renderMapRecord(
      'Authored workflow paths beneath the bundled scope',
      'BUNDLED_WORKFLOW_PATHS',
      'string',
      workflowPaths
    ),
    '',
    renderMapRecord(
      'Packaged workflow owners',
      'BUNDLED_WORKFLOW_OWNERS',
      'BundledWorkflowOwner',
      workflowOwners,
      'Readonly<Partial<Record<keyof typeof BUNDLED_WORKFLOWS, BundledWorkflowOwner>>>'
    ),
    '',
    renderMapRecord(
      'Bundled script packs',
      'BUNDLED_SCRIPT_PACKS',
      'BundledScriptPack',
      scriptPacks
    ),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const packs = await readBundleIndex(
    join(REPO_ROOT, 'packages/workflows/src/defaults/bundle-index.json')
  );
  const files = await collectBundleSources(
    WORKFLOWS_ROOT,
    join(REPO_ROOT, '.archon/commands'),
    packs
  );
  if (packs.includes('defaults')) {
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
  }
  await assertTrackedPackagedFiles(
    files
      .filter(
        file =>
          !file.relativePath.startsWith('workflows/defaults/') &&
          !file.relativePath.startsWith('commands/defaults/')
      )
      .map(file => file.sourcePath)
  );

  const commands: BundledFile[] = [];
  const workflows: BundledFile[] = [];
  const workflowOwners = new Map<string, BundledWorkflowOwner>();
  const workflowPaths = new Map<string, string>();
  const scriptPacks = new Map<string, BundledScriptPack>();
  for (const file of files) {
    const content = await readBundleContent(file);
    if (file.kind === 'command') commands.push({ name: file.name, content });
    else if (file.kind === 'workflow') {
      workflows.push({ name: file.name, content });
      workflowPaths.set(file.name, file.relativePath);
      if (file.owner) workflowOwners.set(file.name, file.owner);
    } else {
      const prior = scriptPacks.get(file.pack) ?? { files: {}, scripts: {} };
      scriptPacks.set(file.pack, {
        files: { ...prior.files, [file.packPath]: content },
        scripts: file.entry
          ? {
              ...prior.scripts,
              [file.entry.name]: { path: file.packPath, runtime: file.entry.runtime },
            }
          : prior.scripts,
      });
    }
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  workflows.sort((a, b) => a.name.localeCompare(b.name));
  const contents = renderFile(commands, workflows, workflowOwners, scriptPacks, workflowPaths);
  if (CHECK_ONLY) {
    let existing = '';
    try {
      const raw = await readFile(OUTPUT_PATH, 'utf-8');
      // Same LF normalization as the bundled contents — the .ts itself may be
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
      `bundled-defaults.generated.ts is up to date (${commands.length} commands, ${workflows.length} workflows, ${scriptPacks.size} script packs).`
    );
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(
    `Wrote ${OUTPUT_PATH}\n  ${commands.length} commands, ${workflows.length} workflows, ${scriptPacks.size} script packs.`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
