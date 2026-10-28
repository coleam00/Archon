import type { WorkflowLoadError, WorkflowWithSource } from '../schemas';
import { qualifyPackReferences } from '../packaged-workflow';
import { installedWorkflowName, listInstalledPacks, type InstalledPack } from '../workflow-source';
import type { DiscoveryContext } from './context';
import { expandScope } from './expand-scope';
import { loadPackWorkflows, type PackWorkflowFile, type ScopeFile } from './load-dir';

export interface InstalledDiscovery {
  workflows: WorkflowWithSource[];
  support: WorkflowWithSource[];
  /** Lowercased names no project, global or bundled workflow may take. */
  reservedNames: ReadonlySet<string>;
}

/** One installed pack's loaded files, with how the catalog names each of them. */
interface LoadedInstalledPack {
  pack: InstalledPack;
  label: string;
  files: PackWorkflowFile[];
  /** Manifest entrypoint name by its `<folder>/<file>` path. */
  entrypointByPath: Map<string, string>;
}

/**
 * Installed workflow packs, each expanded against its own name map, so its support
 * workflows compose inside the pack and nowhere else. Only manifest entrypoints come
 * back as dispatchable, named `owner/plugin:<entrypoint>`; the rest are support.
 */
export async function discoverInstalled(context: DiscoveryContext): Promise<InstalledDiscovery> {
  const workflows: WorkflowWithSource[] = [];
  const support: WorkflowWithSource[] = [];
  const listed = await listInstalledPacks(context.roots.installed);
  for (const { path, message, cause, workflowName } of listed.errors) {
    context.allErrors.push({
      filename: path,
      ...(workflowName !== undefined ? { workflowName } : {}),
      error: message,
      errorType: 'read_error',
      cause,
    });
  }
  const unavailable = context.capture?.manifest.unavailable_installed_workflows ?? [];
  for (const name of unavailable) {
    context.allErrors.push({
      filename: name,
      workflowName: name,
      error: `Installed workflow '${name}' could not be read when this run's source was captured.`,
      errorType: 'validation_error',
    });
  }
  const catalogEntrypoints = new Set([
    ...listed.packs.flatMap(pack =>
      Object.keys(pack.manifest.entrypoints).map(entry => installedWorkflowName(pack, entry))
    ),
    ...listed.errors.flatMap(error => (error.workflowName ? [error.workflowName] : [])),
    ...unavailable,
  ]);
  const reservedNames = new Set([...catalogEntrypoints].map(name => name.toLowerCase()));
  for (const pack of listed.packs) {
    const loaded = await loadInstalledPack(context, pack);
    const { qualifiedByName, entrypoints } = qualifyPackNames(loaded, reservedNames);
    const files = installedScopeFiles(context, loaded, qualifiedByName, catalogEntrypoints);
    const expandedScope = await expandScope(context, files);
    context.allErrors.push(...expandedScope.errors);
    for (const expanded of expandedScope.workflows) {
      (entrypoints.has(expanded.workflow.name) ? workflows : support).push(expanded);
    }
  }
  return { workflows, support, reservedNames };
}

/**
 * Load one pack's workflows. A load error that explains a manifest entrypoint is reported
 * under that entrypoint's name; an entrypoint that neither loaded nor failed visibly is an
 * error of its own.
 */
async function loadInstalledPack(
  context: DiscoveryContext,
  pack: InstalledPack
): Promise<LoadedInstalledPack> {
  const label = `${pack.owner}/${pack.name}`;
  const loaded = await loadPackWorkflows(
    { ...context, pack: pack.key, source: 'installed', label },
    pack.dir
  );
  const entrypointByPath = new Map(
    Object.entries(pack.manifest.entrypoints).map(([entry, path]) => [path, entry])
  );
  const explainedEntrypoints = reportPackLoadErrors(context, pack, label, loaded.errors, [
    ...entrypointByPath,
  ]);
  for (const [path, entry] of entrypointByPath) {
    if (
      !explainedEntrypoints.has(entry) &&
      !loaded.files.some(file => `${file.folder}/${file.filename}` === path)
    ) {
      context.allErrors.push({
        filename: `${label}/${path}`,
        workflowName: installedWorkflowName(pack, entry),
        error: `Entrypoint '${entry}' of installed plugin ${label} did not load from ${path}.`,
        errorType: 'validation_error',
      });
    }
  }
  return { pack, label, files: loaded.files, entrypointByPath };
}

/** Report each load error, under every entrypoint it explains; returns those entrypoints. */
function reportPackLoadErrors(
  context: DiscoveryContext,
  pack: InstalledPack,
  label: string,
  errors: readonly WorkflowLoadError[],
  entrypointPaths: readonly (readonly [string, string])[]
): Set<string> {
  const explainedEntrypoints = new Set<string>();
  for (const error of errors) {
    const affected = entrypointPaths.filter(([path]) => {
      const filename = `${label}/${path}`;
      return filename === error.filename || filename.startsWith(`${error.filename}/`);
    });
    if (affected.length === 0) context.allErrors.push(error);
    for (const [, entry] of affected) {
      explainedEntrypoints.add(entry);
      context.allErrors.push({ ...error, workflowName: installedWorkflowName(pack, entry) });
    }
  }
  return explainedEntrypoints;
}

function qualifiedPackName(loaded: LoadedInstalledPack, file: PackWorkflowFile): string {
  const entry = loaded.entrypointByPath.get(`${file.folder}/${file.filename}`);
  return installedWorkflowName(loaded.pack, entry ?? file.parsed.workflow.name);
}

/**
 * A pack workflow is referred to inside its pack by its `name:`. It is known
 * outside as owner/plugin:<entrypoint> (entrypoints) or owner/plugin:<name> (support).
 */
function qualifyPackNames(
  loaded: LoadedInstalledPack,
  reservedNames: Set<string>
): { qualifiedByName: Map<string, string[]>; entrypoints: Set<string> } {
  const qualifiedByName = new Map<string, string[]>();
  const entrypoints = new Set<string>();
  for (const file of loaded.files) {
    const qualified = qualifiedPackName(loaded, file);
    reservedNames.add(qualified.toLowerCase());
    if (loaded.entrypointByPath.has(`${file.folder}/${file.filename}`)) entrypoints.add(qualified);
    const authoredName = file.parsed.workflow.name;
    const targets = qualifiedByName.get(authoredName) ?? [];
    targets.push(qualified);
    qualifiedByName.set(authoredName, targets);
  }
  return { qualifiedByName, entrypoints };
}

/** The pack's files under their qualified names, minus each whose references are refused. */
function installedScopeFiles(
  context: DiscoveryContext,
  loaded: LoadedInstalledPack,
  qualifiedByName: ReadonlyMap<string, string[]>,
  catalogEntrypoints: ReadonlySet<string>
): Map<string, ScopeFile> {
  const publicNames = new Set([...catalogEntrypoints, ...[...qualifiedByName.values()].flat()]);
  const files = new Map<string, ScopeFile>();
  for (const file of loaded.files) {
    const filename = `${loaded.label}/${file.folder}/${file.filename}`;
    const qualified = qualifiedPackName(loaded, file);
    const refusal = packReferenceRefusal(
      loaded.label,
      file,
      qualifiedByName,
      catalogEntrypoints,
      publicNames
    );
    if (refusal !== undefined) {
      context.allErrors.push({ filename, workflowName: qualified, ...refusal });
      continue;
    }
    files.set(filename, {
      ...file.parsed,
      workflow: { ...file.parsed.workflow, name: qualified },
      source: 'installed',
    });
  }
  return files;
}

/** Why a pack workflow's references keep it out of the catalog, or `undefined`. */
function packReferenceRefusal(
  label: string,
  file: PackWorkflowFile,
  qualifiedByName: ReadonlyMap<string, string[]>,
  catalogEntrypoints: ReadonlySet<string>,
  publicNames: ReadonlySet<string>
): Pick<WorkflowLoadError, 'error' | 'errorType' | 'cause'> | undefined {
  let references: ReturnType<typeof qualifyPackReferences>;
  try {
    references = qualifyPackReferences(
      file.parsed.workflow,
      qualifiedByName,
      catalogEntrypoints,
      publicNames
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      errorType: 'validation_error',
      cause: error,
    };
  }
  const { supportChildren, ambiguousReferences } = references;
  if (ambiguousReferences.length > 0) {
    return {
      error: ambiguousReferences
        .map(
          name =>
            `Ambiguous workflow reference '${name}': multiple files in installed plugin ${label} declare that name. Use a qualified workflow name.`
        )
        .join(' '),
      errorType: 'validation_error',
    };
  }
  if (supportChildren.length > 0) {
    return {
      error: `'workflow:' launches support workflow ${supportChildren.map(name => `'${name}'`).join(', ')} as a child run. A child run is dispatch, and only entrypoints are dispatchable: compose it with 'include:', or declare it as an entrypoint in archon-plugin.json.`,
      errorType: 'validation_error',
    };
  }
  return undefined;
}
