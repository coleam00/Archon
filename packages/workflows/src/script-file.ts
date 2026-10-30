/** Supported script runtime. */
export type ScriptRuntime = 'bun' | 'uv';

/** Supported file extensions and their runtimes */
const EXTENSION_RUNTIME_MAP: Record<string, ScriptRuntime> = {
  '.ts': 'bun',
  '.js': 'bun',
  '.py': 'uv',
};

/**
 * Derive the runtime from a file extension.
 * Returns undefined for unknown extensions.
 */
export function getRuntimeForExtension(ext: string): ScriptRuntime | undefined {
  return EXTENSION_RUNTIME_MAP[ext];
}

/**
 * Maximum subfolder depth we descend into when scanning scripts.
 *
 * `1` matches the workflows/commands convention: allow one level of
 * grouping (e.g. `.archon/scripts/triage/foo.ts`) but no nested folders.
 * We stop at 1 deliberately — deeper nesting has never been part of the
 * documented convention and adds no organizational value, just routing
 * ambiguity when two basenames collide across folders.
 */
export const MAX_SCRIPT_DISCOVERY_DEPTH = 1;
