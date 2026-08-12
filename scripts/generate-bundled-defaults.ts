#!/usr/bin/env bun
/**
 * Regenerates packages/workflows/src/defaults/bundled-defaults.generated.ts from
 * the on-disk legacy defaults and packaged workflows under
 * .archon/workflows/<pack>/<workflow>/.
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
import { access, readFile, readdir, stat, writeFile } from 'fs/promises';
import { basename, extname, join, relative, resolve } from 'path';
import { execFileAsync } from '@archon/git';
import {
  formatPackagedResourceReference,
  isValidWorkflowFolderSegment,
} from '../packages/workflows/src/packaged-workflow';

// BUNDLED_DEFAULTS_REPO_ROOT is a test seam: the integration tests point the
// script at a throwaway git repo (see
// packages/workflows/src/defaults/generate-bundled-defaults.test.ts).
const REPO_ROOT = process.env.BUNDLED_DEFAULTS_REPO_ROOT
  ? resolve(process.env.BUNDLED_DEFAULTS_REPO_ROOT)
  : resolve(import.meta.dir, '..');
const COMMANDS_REL = '.archon/commands/defaults';
const WORKFLOWS_REL = '.archon/workflows/defaults';
const WORKFLOWS_ROOT_REL = '.archon/workflows';
const COMMANDS_DIR = join(REPO_ROOT, COMMANDS_REL);
const WORKFLOWS_DIR = join(REPO_ROOT, WORKFLOWS_REL);
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

interface BundledWorkflowOwner {
  pack: string;
  workflow: string;
}

type BundledScript =
  | {
      content: string;
      extension: '.py';
      runtime: 'uv';
    }
  | {
      content: string;
      extension: '.js' | '.ts';
      runtime: 'bun';
    };

type BundledScriptKind =
  | { extension: '.py'; runtime: 'uv' }
  | { extension: '.js' | '.ts'; runtime: 'bun' };

interface PackagedDefaults {
  workflows: BundledFile[];
  workflowOwners: Map<string, BundledWorkflowOwner>;
  commands: BundledFile[];
  scripts: Map<string, BundledScript>;
  sourcePaths: string[];
}

interface PackagedScriptFile {
  kind: BundledScriptKind;
  localName: string;
  path: string;
  relativePath: string;
}

function getBundledScriptKind(extension: string): BundledScriptKind | null {
  if (extension === '.py') return { extension, runtime: 'uv' };
  if (extension === '.ts' || extension === '.js') return { extension, runtime: 'bun' };
  return null;
}

async function listPackagedScriptFiles(scriptPath: string): Promise<PackagedScriptFile[]> {
  const files: PackagedScriptFile[] = [];
  for (const entry of (await readdir(scriptPath)).sort((a, b) => a.localeCompare(b))) {
    const entryPath = join(scriptPath, entry);
    const entryStat = await stat(entryPath);
    const candidates = entryStat.isDirectory()
      ? (await readdir(entryPath))
          .sort((a, b) => a.localeCompare(b))
          .map(child => ({ path: join(entryPath, child), relativePath: `${entry}/${child}` }))
      : [{ path: entryPath, relativePath: entry }];

    for (const candidate of candidates) {
      if (!(await stat(candidate.path)).isFile()) continue;
      const kind = getBundledScriptKind(extname(candidate.path));
      if (kind === null) continue;
      files.push({
        kind,
        localName: basename(candidate.path, kind.extension),
        path: candidate.path,
        relativePath: candidate.relativePath,
      });
    }
  }
  return files;
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

async function readBundledContent(path: string): Promise<string> {
  const content = (await readFile(path, 'utf-8')).replace(/\r\n/g, '\n');
  if (!content.trim()) throw new Error(`Bundled default "${path}" is empty.`);
  return content;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return false;
    throw new Error(`Failed to inspect packaged workflow path "${path}": ${err.message}`, {
      cause: err,
    });
  }
}

async function collectPackagedDefaults(root: string): Promise<PackagedDefaults> {
  const workflows: BundledFile[] = [];
  const workflowOwners = new Map<string, BundledWorkflowOwner>();
  const commands: BundledFile[] = [];
  const scripts = new Map<string, BundledScript>();
  const sourcePaths: string[] = [];

  for (const pack of (await readdir(root)).sort((a, b) => a.localeCompare(b))) {
    const packPath = join(root, pack);
    if (!(await isDirectory(packPath))) continue;
    if (!isValidWorkflowFolderSegment(pack)) {
      throw new Error(`Invalid packaged workflow pack directory "${pack}".`);
    }

    for (const workflow of (await readdir(packPath)).sort((a, b) => a.localeCompare(b))) {
      const workflowPath = join(packPath, workflow);
      if (!(await isDirectory(workflowPath))) continue;
      if (!isValidWorkflowFolderSegment(workflow)) {
        throw new Error(`Invalid packaged workflow directory "${pack}/${workflow}".`);
      }

      const owner = { source: 'bundled' as const, pack, workflow };
      const entries = (await readdir(workflowPath)).sort((a, b) => a.localeCompare(b));
      const yamlEntries = entries.filter(entry => /\.ya?ml$/.test(entry));
      if (yamlEntries.length !== 1) {
        throw new Error(
          `Packaged workflow "${pack}/${workflow}" must contain exactly one .yaml or .yml file (found ${yamlEntries.length}).`
        );
      }

      const yamlEntry = yamlEntries[0];
      const workflowName = yamlEntry.replace(/\.ya?ml$/, '');
      if (!isValidWorkflowFolderSegment(workflowName)) {
        throw new Error(`Bundled packaged workflow has invalid filename "${yamlEntry}".`);
      }
      if (workflowOwners.has(workflowName)) {
        throw new Error(`Bundled workflow filename collision: "${workflowName}".`);
      }
      const yamlPath = join(workflowPath, yamlEntry);
      workflows.push({ name: workflowName, content: await readBundledContent(yamlPath) });
      workflowOwners.set(workflowName, { pack, workflow });
      sourcePaths.push(yamlPath);

      const commandPath = join(workflowPath, 'commands');
      if (await isDirectory(commandPath)) {
        const seen = new Set<string>();
        for (const entry of (await readdir(commandPath)).sort((a, b) => a.localeCompare(b))) {
          if (!entry.endsWith('.md')) continue;
          const localName = entry.slice(0, -'.md'.length);
          if (!isValidWorkflowFolderSegment(localName)) {
            throw new Error(
              `Invalid packaged command filename "${pack}/${workflow}/commands/${entry}".`
            );
          }
          if (seen.has(localName)) {
            throw new Error(`Duplicate packaged command "${localName}" in ${pack}/${workflow}.`);
          }
          seen.add(localName);
          const path = join(commandPath, entry);
          commands.push({
            name: formatPackagedResourceReference(owner, localName),
            content: await readBundledContent(path),
          });
          sourcePaths.push(path);
        }
      }

      const scriptPath = join(workflowPath, 'scripts');
      if (await isDirectory(scriptPath)) {
        const seen = new Set<string>();
        for (const script of await listPackagedScriptFiles(scriptPath)) {
          const { kind, localName, path, relativePath } = script;
          if (!isValidWorkflowFolderSegment(localName)) {
            throw new Error(
              `Invalid packaged script filename "${pack}/${workflow}/scripts/${relativePath}".`
            );
          }
          if (seen.has(localName)) {
            throw new Error(`Duplicate packaged script "${localName}" in ${pack}/${workflow}.`);
          }
          seen.add(localName);
          const key = formatPackagedResourceReference(owner, localName);
          scripts.set(key, { content: await readBundledContent(path), ...kind });
          sourcePaths.push(path);
        }
      }
    }
  }

  workflows.sort((a, b) => a.name.localeCompare(b.name));
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows, workflowOwners, commands, scripts, sourcePaths };
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
  scripts: ReadonlyMap<string, BundledScript>
): string {
  const header = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Regenerate with: bun run generate:bundled',
    ' * Verify up-to-date:  bun run check:bundled',
    ' *',
    ' * Source of truth:',
    ' *   .archon/commands/defaults/*.md (legacy)',
    ' *   .archon/workflows/defaults/*.{yaml,yml} (legacy)',
    ' *   .archon/workflows/<pack>/<workflow>/',
    ' *',
    ' * Contents are inlined as plain string literals (JSON-escaped) so this',
    ' * module loads in both Bun and Node. Previous versions used',
    " * `import X from '...' with { type: 'text' }` which is Bun-specific.",
    ' */',
    '',
  ].join('\n');

  return [
    header,
    'export interface BundledWorkflowOwner {',
    '  readonly pack: string;',
    '  readonly workflow: string;',
    '}',
    '',
    'export type BundledScript =',
    "  | { readonly content: string; readonly extension: '.py'; readonly runtime: 'uv' }",
    "  | { readonly content: string; readonly extension: '.js' | '.ts'; readonly runtime: 'bun' };",
    '',
    renderRecord('Bundled commands', 'BUNDLED_COMMANDS', commands),
    '',
    renderRecord('Bundled workflows', 'BUNDLED_WORKFLOWS', workflows),
    '',
    renderMapRecord(
      'Packaged workflow owners',
      'BUNDLED_WORKFLOW_OWNERS',
      'BundledWorkflowOwner',
      workflowOwners,
      'Readonly<Partial<Record<keyof typeof BUNDLED_WORKFLOWS, BundledWorkflowOwner>>>'
    ),
    '',
    renderMapRecord('Bundled scripts', 'BUNDLED_SCRIPTS', 'BundledScript', scripts),
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

  const [legacyCommands, legacyWorkflows, packaged] = await Promise.all([
    collectFiles(COMMANDS_DIR, ['.md']),
    collectFiles(WORKFLOWS_DIR, ['.yaml', '.yml']),
    collectPackagedDefaults(WORKFLOWS_ROOT),
  ]);
  await assertTrackedPackagedFiles(packaged.sourcePaths);

  const legacyWorkflowNames = new Set(legacyWorkflows.map(workflow => workflow.name));
  for (const workflow of packaged.workflows) {
    if (legacyWorkflowNames.has(workflow.name)) {
      throw new Error(
        `Bundled workflow filename collision: "${workflow.name}" exists in both the legacy defaults directory and a packaged workflow folder.`
      );
    }
  }
  const commands = [...legacyCommands, ...packaged.commands].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const workflows = [...legacyWorkflows, ...packaged.workflows].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const contents = renderFile(commands, workflows, packaged.workflowOwners, packaged.scripts);

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
      `bundled-defaults.generated.ts is up to date (${commands.length} commands, ${workflows.length} workflows, ${packaged.scripts.size} scripts).`
    );
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(
    `Wrote ${OUTPUT_PATH}\n  ${commands.length} commands, ${workflows.length} workflows, ${packaged.scripts.size} scripts.`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
