import type { WorkflowLoadError, WorkflowWithSource } from '../schemas';
import { installedWorkflowName, listInstalledPacks, type InstalledPack } from '../workflow-source';
import type { DiscoveryContext } from './context';
import { expandScope } from './expand-scope';
import { loadPackWorkflows, type PackWorkflowFile, type ScopeFile } from './load-dir';
import {
  type PackNaming,
  packFileName,
  packNaming,
  packReferenceRefusal,
  qualifyPackNames,
  unloadedEntrypoints,
} from './pack-entrypoints';

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
  naming: PackNaming;
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
    const { qualifiedByName, entrypoints } = qualifyPackNames(loaded.naming, loaded.files);
    for (const names of qualifiedByName.values())
      for (const name of names) reservedNames.add(name.toLowerCase());
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
  const naming = packNaming(pack.manifest.entrypoints, name => installedWorkflowName(pack, name));
  const explainedEntrypoints = reportPackLoadErrors(context, pack, label, loaded.errors, [
    ...naming.entrypointByPath,
  ]);
  for (const [entry, path] of unloadedEntrypoints(naming, loaded.files)) {
    if (!explainedEntrypoints.has(entry)) {
      context.allErrors.push({
        filename: `${label}/${path}`,
        workflowName: installedWorkflowName(pack, entry),
        error: `Entrypoint '${entry}' of installed plugin ${label} did not load from ${path}.`,
        errorType: 'validation_error',
      });
    }
  }
  return { pack, label, files: loaded.files, naming };
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
    const qualified = packFileName(loaded.naming, file);
    const refusal = packReferenceRefusal(
      `installed plugin ${loaded.label}`,
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
