/** Engine-private per-node metadata attached during load-time include expansion.
 * Symbols survive object spreads but stay out of YAML, JSON, API payloads, and
 * persisted workflow definitions.
 *
 * A symbol does NOT ride `structuredClone`, so every payload declared here has to be
 * re-attached by `cloneNodeForInclude` (include-expander.ts) and re-walked by BOTH
 * rewrite passes (`rewriteNodeOutputRefs`, `applyInputsMacro`). A payload that misses
 * any of the three works at one nesting level and silently vanishes at two. */
export const COMPILED_LOOP_COMMAND = Symbol('archon.compiled-loop-command');

export type CompiledLoopCommand =
  | { prompt: string; error?: never }
  | { prompt?: never; error: string };

export interface LoopWithCompiledCommand {
  [COMPILED_LOOP_COMMAND]?: CompiledLoopCommand;
}

/** @see ComposedNodeMeta */
export const COMPOSED_NODE = Symbol('archon.composed-node');

/**
 * Per-node record of the workflow a node was AUTHORED in, attached when that
 * workflow is inlined into a parent (#1764). It is what lets a composed node keep
 * behaving like its own file's node instead of the composing parent's:
 *
 *  - `origin` — the authoring workflow's name. Write-once (innermost wins), so a
 *    node nested three files deep still names the file that declared it.
 *  - `inputs` — that workflow's contract-resolved `inputs:` (defaults applied),
 *    delivered to its `bash:`/`script:` nodes as `INPUTS_<UPPER_SNAKE>` env vars.
 *    Write-once for the same reason, and because input names carry no namespace:
 *    two levels both declaring `plan` have no disambiguator, so the inner one wins.
 *  - `blockEntry` — this node starts its block. The executor clears the sequential
 *    session cursor there so a composed workflow begins as coldly as it would
 *    standalone.
 */
export interface ComposedNodeMeta {
  origin: string;
  inputs?: Record<string, string>;
  blockEntry?: true;
}

export interface NodeWithComposedMeta {
  [COMPOSED_NODE]?: ComposedNodeMeta;
}

/** Read a node's composition record. One accessor, so the symbol cast lives in one place. */
export function readComposedMeta(node: object): ComposedNodeMeta | undefined {
  return (node as NodeWithComposedMeta)[COMPOSED_NODE];
}

export interface IncludeCommandReadError {
  path: string;
  message: string;
  operation: 'inspect' | 'read';
}

export type IncludeCommandContent = string | null | IncludeCommandReadError;

export function isIncludeCommandReadError(
  value: IncludeCommandContent | undefined
): value is IncludeCommandReadError {
  return typeof value === 'object' && value !== null;
}
