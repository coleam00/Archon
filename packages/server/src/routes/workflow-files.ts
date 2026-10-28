import { readFile, readdir, stat } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { getBundledWorkflowsPath } from '@archon/paths';
import { providerRegistry } from '@archon/providers';
import { isValidWorkflowFolderSegment } from '@archon/workflows/workflow-discovery';
import { FIXTURES_DIR } from '@archon/workflows/fixture-layout';
import { parseWorkflow, parseYaml } from '@archon/workflows/loader';
import { BUNDLED_WORKFLOWS } from '@archon/workflows/defaults';

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
  const acceptedNames = new Set(name.includes('/') ? [name, basename(name)] : [name]);
  for (const ext of ['yaml', 'yml']) {
    const filename = `${name}.${ext}`;
    const absolutePath = join(dir, filename);
    try {
      const content = await readFile(absolutePath, 'utf-8');
      const parsed = parseWorkflow(content, filename, providerRegistry);
      if (parsed.workflow !== null && !acceptedNames.has(parsed.workflow.name)) continue;
      return { absolutePath, filename, packaged: false, parsed, content };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return null;
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
 * A packaged workflow answers to the name it declares. One that does not parse
 * has no declared name, so its file stem or workflow folder stands in, letting
 * GET report why the named workflow is broken.
 */
function answersToName(file: RawWorkflowFile, workflowFolder: string, name: string): boolean {
  if (file.parsed.workflow !== null) return file.parsed.workflow.name === name;
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
    if (parsed.error !== null || parsed.workflow?.name === name) {
      return { filename, parsed, content: direct };
    }
  }

  let match: WorkflowFile | null = null;
  for (const [filenameStem, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    if (filenameStem === name) continue;
    const filename = `${filenameStem}.yaml`;
    const parsed = parseWorkflow(content, filename, providerRegistry);
    if (parsed.workflow?.name !== name) continue;
    if (match !== null) throw new Error(`Multiple bundled workflows declare the name '${name}'`);
    match = { filename, parsed, content };
  }
  return match;
}
