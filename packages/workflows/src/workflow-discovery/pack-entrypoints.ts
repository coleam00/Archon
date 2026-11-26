import type { WorkflowLoadError } from '../schemas';
import { qualifyPackReferences } from '../packaged-workflow';
import type { PackWorkflowFile } from './load-dir';

/**
 * How a manifest pack's files are named in the catalog: a file the manifest lists as an
 * entrypoint by its manifest key, any other by its authored `name:`, each through `nameFor`.
 * An installed pack prefixes `owner/plugin:`; a pack folder read as the source keeps the
 * bare name. Only the entrypoints are dispatchable; the rest are support.
 */
export interface PackNaming {
  /** Manifest entrypoint key by its `<folder>/<file>` path. */
  readonly entrypointByPath: ReadonlyMap<string, string>;
  readonly nameFor: (name: string) => string;
}

export function packNaming(
  entrypoints: Readonly<Record<string, string>>,
  nameFor: (name: string) => string
): PackNaming {
  return {
    entrypointByPath: new Map(Object.entries(entrypoints).map(([entry, path]) => [path, entry])),
    nameFor,
  };
}

export function packFileName(naming: PackNaming, file: PackWorkflowFile): string {
  const entry = naming.entrypointByPath.get(`${file.folder}/${file.filename}`);
  return naming.nameFor(entry ?? file.parsed.workflow.name);
}

/**
 * A pack workflow is referred to inside its pack by its `name:`. It is known outside by
 * `packFileName`: its entrypoint key for an entrypoint, its authored name for support.
 */
export function qualifyPackNames(
  naming: PackNaming,
  files: readonly PackWorkflowFile[]
): { qualifiedByName: Map<string, string[]>; entrypoints: Set<string> } {
  const qualifiedByName = new Map<string, string[]>();
  const entrypoints = new Set<string>();
  for (const file of files) {
    const qualified = packFileName(naming, file);
    if (naming.entrypointByPath.has(`${file.folder}/${file.filename}`)) entrypoints.add(qualified);
    const authoredName = file.parsed.workflow.name;
    qualifiedByName.set(authoredName, [...(qualifiedByName.get(authoredName) ?? []), qualified]);
  }
  return { qualifiedByName, entrypoints };
}

/** Each entrypoint the manifest lists whose file did not load, as `[key, path]`. */
export function unloadedEntrypoints(
  naming: PackNaming,
  files: readonly PackWorkflowFile[]
): [string, string][] {
  return [...naming.entrypointByPath]
    .filter(([path]) => !files.some(file => `${file.folder}/${file.filename}` === path))
    .map(([path, entry]) => [entry, path]);
}

/**
 * Why a pack workflow's references keep it out of the catalog, or `undefined`. Rewrites
 * its references to the pack's own workflows to their catalog names. `pack` names the pack
 * in the refusal, such as `installed plugin acme/factory`.
 */
export function packReferenceRefusal(
  pack: string,
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
            `Ambiguous workflow reference '${name}': multiple files in ${pack} declare that name. Use a qualified workflow name.`
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
