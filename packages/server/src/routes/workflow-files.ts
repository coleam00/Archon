import { readFile } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { getBundledWorkflowsPath } from '@archon/paths';
import { providerRegistry } from '@archon/providers';
import {
  readPackWorkflowFolders,
  readScopePacks,
  type PackWorkflowFolder,
  type PackWorkflowLocation,
} from '@archon/workflows/pack-layout';
import type { WorkflowLoadError } from '@archon/workflows/schemas/workflow';
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

/** A by-name lookup matched a packaged workflow folder that discovery reports as a load error. */
export class PackagedWorkflowFolderError extends Error {}

/** A directory that cannot be listed fails the lookup instead of hiding the workflow. */
function readFailure({ error, cause }: WorkflowLoadError): Error {
  return new Error(error, { cause });
}

/** The one YAML file of a packaged workflow folder, read and parsed; null when it vanished. */
async function readPackagedFile(
  pack: string,
  { folder, path, filename }: PackWorkflowLocation
): Promise<RawWorkflowFile | null> {
  const absolutePath = join(path, filename);
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return {
    absolutePath,
    filename: `${pack}/${folder}/${filename}`,
    packaged: true,
    parsed: parseWorkflow(content, filename, providerRegistry),
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
  return yamlStem(basename(file.absolutePath)) === name || workflowFolder === name;
}

function yamlStem(filename: string): string {
  return filename.replace(/\.ya?ml$/, '');
}

interface PackagedMatches {
  files: RawWorkflowFile[];
  /** Malformed workflow folders that answer to the name by folder name or YAML stem. */
  folderErrors: PackagedWorkflowFolderError[];
}

/** The load error of a malformed folder that answers to `name`, by folder name or YAML stem. */
function folderErrorFor(
  entry: Extract<PackWorkflowFolder, { kind: 'error' }>,
  name: string
): PackagedWorkflowFolderError | undefined {
  // An unreadable folder may hold the named workflow; its YAML stems are unknown.
  if (entry.error.errorType === 'read_error') throw readFailure(entry.error);
  const answers = entry.folder === name || entry.yamlFiles.some(file => yamlStem(file) === name);
  return answers ? new PackagedWorkflowFolderError(entry.error.error) : undefined;
}

async function collectPackMatches(
  pack: string,
  packPath: string,
  name: string,
  matches: PackagedMatches
): Promise<void> {
  const listing = await readPackWorkflowFolders(packPath, pack);
  if ('error' in listing) throw readFailure(listing.error);
  for (const entry of listing.folders) {
    if (entry.kind === 'empty') continue;
    if (entry.kind === 'error') {
      const folderError = folderErrorFor(entry, name);
      if (folderError !== undefined) matches.folderErrors.push(folderError);
      continue;
    }
    const file = await readPackagedFile(pack, entry);
    if (file !== null && answersToName(file, entry.folder, name)) matches.files.push(file);
  }
}

/**
 * The packaged workflow `name` resolves to under `workflowsRoot`. A workflow file that
 * answers to the name wins, because discovery lists it; only when none does, a malformed
 * workflow folder that answers to the name throws its discovery load error rather than
 * reading as not found. An unreadable root, pack or workflow folder fails the lookup.
 * An invalid pack directory is skipped: no workflow name attributes to it.
 */
export async function findPackagedWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  const { packs, errors } = await readScopePacks(workflowsRoot);
  const unreadable = errors.find(error => error.errorType === 'read_error');
  if (unreadable !== undefined) throw readFailure(unreadable);

  const matches: PackagedMatches = { files: [], folderErrors: [] };
  for (const pack of packs) await collectPackMatches(pack.name, pack.path, name, matches);
  if (matches.files.length > 1) {
    throw new Error(`Multiple packaged workflows declare the name '${name}'`);
  }
  const [file] = matches.files;
  if (file !== undefined) return file;
  const [folderError] = matches.folderErrors;
  if (folderError !== undefined) throw folderError;
  return null;
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
