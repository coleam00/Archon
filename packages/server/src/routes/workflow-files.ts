import { readFile, readdir, stat } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { getBundledWorkflowsPath } from '@archon/paths';
import { providerRegistry } from '@archon/providers';
import { isValidWorkflowFolderSegment } from '@archon/workflows/workflow-discovery';
import { isWorkflowSubdirectory } from '@archon/workflows/workflow-layout';
import { FIXTURES_DIR } from '@archon/workflows/fixture-layout';
import { parseWorkflow, parseYaml } from '@archon/workflows/loader';
import { BUNDLED_WORKFLOWS } from '@archon/workflows/defaults';
import { getLog } from './api-route-kit';

/** A workflow definition found by name: its text, where it came from, and how it parsed. */
export interface WorkflowFile {
  filename: string;
  parsed: ReturnType<typeof parseWorkflow>;
  /** The file text as read. */
  content: string;
}

/** A workflow file found under a workflows folder on disk. */
export interface RawWorkflowFile extends WorkflowFile {
  absolutePath: string;
  /** True for `<pack>/<workflow>/<file>.yaml`; false for a flat `<name>.yaml`. */
  packaged: boolean;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function tryReadWorkflowAt(dir: string, name: string): Promise<RawWorkflowFile | null> {
  for await (const filename of flatWorkflowCandidates(dir, name)) {
    const absolutePath = join(dir, filename);
    try {
      if (!(await stat(absolutePath)).isFile()) continue;
      const content = await readFile(absolutePath, 'utf-8');
      const parsed = parseWorkflow(content, filename, providerRegistry);
      if (!flatWorkflowAnswersToName(parsed, filename, name)) continue;
      return { absolutePath, filename, packaged: false, parsed, content };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return null;
}

async function* flatWorkflowCandidates(dir: string, name: string): AsyncGenerator<string> {
  yield `${name}.yaml`;
  yield `${name}.yml`;
  const entries = (await sortedEntries(dir)) ?? [];
  for (const entry of entries) {
    if (/\.ya?ml$/.test(entry)) yield entry;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    if (!(await isDirectory(entryPath))) continue;
    const files = await flatGroupFiles(entryPath, entry);
    for (const file of files) {
      if (/\.ya?ml$/.test(file)) yield join(entry, file);
    }
  }
}

async function flatGroupFiles(entryPath: string, entry: string): Promise<string[]> {
  try {
    if (!(await isWorkflowSubdirectory(entryPath, entry, 0))) return [];
    return (await sortedEntries(entryPath)) ?? [];
  } catch (err) {
    getLog().warn({ err, entryPath }, 'workflow.group_read_failed');
    return [];
  }
}

function flatWorkflowAnswersToName(
  parsed: WorkflowFile['parsed'],
  filename: string,
  name: string
): boolean {
  if (parsed.workflow === null) {
    return (parsed.error.workflowName ?? filename.replace(/\.ya?ml$/, '')) === name;
  }
  const directPath = filename === `${name}.yaml` || filename === `${name}.yml`;
  return (
    parsed.workflow.name === name ||
    (directPath && name.includes('/') && parsed.workflow.name === basename(name))
  );
}

/**
 * The workflow as authored: the YAML mapping before the engine's normalizing
 * transform. The builder edits this shape, and the normalized `workflow` cannot
 * be sent back (validate rejects it), so GET returns both. Parsed with the same
 * parser the loader uses; undefined when the top level is not a mapping.
 */
export function authoredForm(content: string): Record<string, unknown> | undefined {
  const raw = parseYaml(content);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

/** Entries of `dir`, sorted; null when `dir` does not exist. */
async function sortedEntries(dir: string): Promise<string[] | null> {
  try {
    return (await readdir(dir)).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Subfolders of `dir` that can be a pack or a packaged workflow, in sorted order. */
async function* workflowFolderSegments(dir: string): AsyncGenerator<string> {
  for (const entry of (await sortedEntries(dir)) ?? []) {
    if (entry === FIXTURES_DIR || !isValidWorkflowFolderSegment(entry)) continue;
    if (await isDirectory(join(dir, entry))) yield entry;
  }
}

/** The packaged workflow in `<root>/<pack>/<folder>`: its one YAML file, or null with none or several. */
async function readPackagedWorkflow(
  workflowsRoot: string,
  pack: string,
  workflowFolder: string
): Promise<RawWorkflowFile | null> {
  const workflowPath = join(workflowsRoot, pack, workflowFolder);
  const yamlFiles = ((await sortedEntries(workflowPath)) ?? []).filter(
    entry => entry.endsWith('.yaml') || entry.endsWith('.yml')
  );
  if (yamlFiles.length !== 1) return null;

  const yamlFilename = yamlFiles[0];
  const absolutePath = join(workflowPath, yamlFilename);
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return {
    absolutePath,
    filename: `${pack}/${workflowFolder}/${yamlFilename}`,
    packaged: true,
    parsed: parseWorkflow(content, yamlFilename, providerRegistry),
    content,
  };
}

/**
 * Filename and folder attribution apply only when parsing could not recover a name.
 */
function answersToName(file: RawWorkflowFile, workflowFolder: string, name: string): boolean {
  const declaredName = file.parsed.workflow?.name ?? file.parsed.error?.workflowName;
  if (declaredName !== undefined) return declaredName === name;
  const yamlStem = basename(file.absolutePath).replace(/\.ya?ml$/, '');
  return yamlStem === name || workflowFolder === name;
}

export async function findPackagedWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  let match: RawWorkflowFile | null = null;
  for await (const pack of workflowFolderSegments(workflowsRoot)) {
    for await (const workflowFolder of workflowFolderSegments(join(workflowsRoot, pack))) {
      const file = await readPackagedWorkflow(workflowsRoot, pack, workflowFolder);
      if (file === null || !answersToName(file, workflowFolder, name)) continue;
      if (match !== null) {
        throw new Error(`Multiple packaged workflows declare the name '${name}'`);
      }
      match = file;
    }
  }
  return match;
}

export async function findWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  return (
    (await tryReadWorkflowAt(workflowsRoot, name)) ??
    (await findPackagedWorkflowAt(workflowsRoot, name))
  );
}

export function isBundledWorkflowsRoot(workflowsRoot: string): boolean {
  return resolve(workflowsRoot) === resolve(getBundledWorkflowsPath());
}

export function findBundledWorkflow(name: string): WorkflowFile | null {
  const direct = BUNDLED_WORKFLOWS[name];
  if (direct !== undefined) {
    const filename = `${name}.yaml`;
    const parsed = parseWorkflow(direct, filename, providerRegistry);
    const declaredName = parsed.workflow?.name ?? parsed.error?.workflowName;
    if (declaredName === undefined || declaredName === name) {
      return { filename, parsed, content: direct };
    }
  }

  let match: WorkflowFile | null = null;
  for (const [filenameStem, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    if (filenameStem === name) continue;
    const filename = `${filenameStem}.yaml`;
    const parsed = parseWorkflow(content, filename, providerRegistry);
    if ((parsed.workflow?.name ?? parsed.error?.workflowName) !== name) continue;
    if (match !== null) throw new Error(`Multiple bundled workflows declare the name '${name}'`);
    match = { filename, parsed, content };
  }
  return match;
}
