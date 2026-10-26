import type { BindingDirective, DagNode, IncludeDirective, TriggerRule } from './schemas';
import { isIncludeDirective, isLoopGroupNode, isLoopNode } from './schemas';
import { OUTPUT_REF_SOURCE, type JsonValue } from './output-ref';

/** Engine-private per-node metadata attached during load-time include expansion.
 * Symbols survive object spreads but stay out of YAML, JSON, API payloads, and
 * persisted workflow definitions.
 *
 * A symbol does NOT ride `structuredClone`, so every payload declared here has to be
 * re-attached by `cloneNodeWithEngineMetadata` below. A payload that carries refs must
 * also be re-walked by BOTH rewrite passes (`rewriteNodeOutputRefs`, `applyInputsMacro`).
 * A payload that misses either works at one nesting level and silently vanishes at two. */
export const COMPILED_LOOP_COMMAND = Symbol('archon.compiled-loop-command');

export type CompiledLoopCommand =
  | { prompt: string; error?: never }
  | { prompt?: never; error: string };

export interface LoopWithCompiledCommand {
  [COMPILED_LOOP_COMMAND]?: CompiledLoopCommand;
}

/**
 * The node-local `with:` map a command node carried before include expansion compiled
 * its body into an inline prompt (#2964).
 *
 * Composition materializes a command node so the block's refs can be namespaced and its
 * declared inputs bound, which leaves `with:` — a field the schema admits only on the
 * `command` source variant, so an author cannot write it on a prompt node (#2478) —
 * with nowhere to live on the result. Dropping it silently unbound every name the node
 * supplied itself: the compiled body's `$INPUTS.<name>` reached the model as a literal
 * token, or as an empty string when a decoy input had been declared to get past the
 * missing-input check. The executor and the dry-run simulator resolve this payload for a
 * materialized node exactly as they resolve `source.with` for an unmaterialized one, so
 * a binding means the same thing standalone and composed.
 */
export const COMPOSED_BINDINGS = Symbol('archon.composed-bindings');

export type ComposedBindings = Record<string, JsonValue | BindingDirective>;

export interface NodeWithComposedBindings {
  [COMPOSED_BINDINGS]?: ComposedBindings;
}

/** Read a node's surviving node-local bindings. One accessor, so the cast lives in one place. */
export function readComposedBindings(node: object): ComposedBindings | undefined {
  return (node as NodeWithComposedBindings)[COMPOSED_BINDINGS];
}

/** Attach the bindings a materialized command node must keep. @see COMPOSED_BINDINGS */
export function attachComposedBindings(node: object, bindings: ComposedBindings): void {
  (node as NodeWithComposedBindings)[COMPOSED_BINDINGS] = bindings;
}

/**
 * The include ids a command-sourced node can read, each mapped to that include's primary
 * sink (#3972). A command body is not a template slot: it is read only when the node runs
 * standalone, or when an including workflow compiles it, and by then expansion has replaced
 * every include node, so a body's `$<include>.output` would name nothing. Both readers
 * rename those refs through this map first, exactly as expansion renamed an inline prompt's.
 *
 * Its values are ids in the node's own workflow and never need namespacing: an including
 * workflow consumes the map when it compiles the body, and drops it.
 */
const INCLUDE_OUTPUT_ALIASES = Symbol('archon.include-output-aliases');

export type IncludeOutputAliases = Readonly<Record<string, string>>;

interface NodeWithIncludeOutputAliases {
  [INCLUDE_OUTPUT_ALIASES]?: IncludeOutputAliases;
}

export function readIncludeOutputAliases(node: object): IncludeOutputAliases | undefined {
  return (node as NodeWithIncludeOutputAliases)[INCLUDE_OUTPUT_ALIASES];
}

/** Attach or drop a node's alias map. @see INCLUDE_OUTPUT_ALIASES */
export function setIncludeOutputAliases(
  node: object,
  aliases: IncludeOutputAliases | undefined
): void {
  if (aliases === undefined) delete (node as NodeWithIncludeOutputAliases)[INCLUDE_OUTPUT_ALIASES];
  else (node as NodeWithIncludeOutputAliases)[INCLUDE_OUTPUT_ALIASES] = aliases;
}

/** Rename a command body's `$<include>.output` refs to the include's primary sink. */
export function resolveIncludeOutputAliases(node: object, body: string): string {
  const aliases = readIncludeOutputAliases(node);
  if (aliases === undefined) return body;
  return body.replace(new RegExp(OUTPUT_REF_SOURCE, 'g'), (match, id: string) =>
    Object.hasOwn(aliases, id) ? `$${aliases[id]}.output` : match
  );
}

// A composed node keeps the directory of its declaring home YAML, not its includer's.
const HOME_MCP_DIRECTORY = Symbol('archon.home-mcp-directory');

interface NodeWithHomeMcpDirectory {
  [HOME_MCP_DIRECTORY]?: string;
}

export function readHomeMcpDirectory(node: object): string | undefined {
  return (node as NodeWithHomeMcpDirectory)[HOME_MCP_DIRECTORY];
}

export function attachHomeMcpDirectory(node: object, directory: string): void {
  (node as NodeWithHomeMcpDirectory)[HOME_MCP_DIRECTORY] = directory;
}

/** @see ComposedNodeMeta */
export const COMPOSED_NODE = Symbol('archon.composed-node');

/**
 * The caller-level predicate that decides whether one include instance is active.
 * Every descendant carries a copy because load-time expansion removes the include node.
 */
interface ComposedBlockBoundaryBase {
  /** Number of loop bodies crossed since this include was authored. */
  loopDepth?: number;
  dependsOn: string[];
  entryTriggerRules: [TriggerRule, ...TriggerRule[]];
  when?: string;
}

export type ComposedBlockBoundary = ComposedBlockBoundaryBase &
  (
    | {
        /** The node's own trigger/when fields normally enforce this boundary at the entry. */
        isEntry: true;
        /** Resume needs this entry's rule rather than the block-wide rule set. */
        entryTriggerRule: TriggerRule;
      }
    | {
        isEntry: false;
        entryTriggerRule?: never;
      }
  );

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
 *  - `boundaries` — caller-level activation predicates for enclosing include instances,
 *    outermost first. Non-entry descendants enforce them before their local trigger rule.
 */
export interface ComposedNodeMeta {
  origin: string;
  inputs?: Record<string, JsonValue>;
  blockEntry?: true;
  boundaries?: ComposedBlockBoundary[];
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
  cause?: unknown;
}

export type IncludeCommandContent = string | null | IncludeCommandReadError;

export function isIncludeCommandReadError(
  value: IncludeCommandContent | undefined
): value is IncludeCommandReadError {
  return typeof value === 'object' && value !== null;
}

/** `structuredClone` a node and re-attach every engine-private payload declared above,
 * including on loop_group body nodes. */
export function cloneNodeWithEngineMetadata<T extends DagNode | IncludeDirective>(node: T): T {
  const clone = structuredClone(node);
  preserveEngineMetadata(node, clone);
  return clone;
}

function preserveEngineMetadata(
  source: DagNode | IncludeDirective,
  target: DagNode | IncludeDirective
): void {
  if (isIncludeDirective(source) || isIncludeDirective(target)) return;
  const homeMcpDirectory = readHomeMcpDirectory(source);
  if (homeMcpDirectory !== undefined) attachHomeMcpDirectory(target, homeMcpDirectory);
  const meta = readComposedMeta(source);
  if (meta !== undefined) {
    (target as DagNode & NodeWithComposedMeta)[COMPOSED_NODE] = structuredClone(meta);
  }
  const bindings = readComposedBindings(source);
  if (bindings !== undefined) attachComposedBindings(target, structuredClone(bindings));
  setIncludeOutputAliases(target, readIncludeOutputAliases(source));
  preserveCompiledLoopCommand(source, target);
  if (isLoopGroupNode(source) && isLoopGroupNode(target)) {
    for (const [index, sourceChild] of source.loop_group.nodes.entries()) {
      const targetChild = target.loop_group.nodes[index];
      if (targetChild !== undefined) preserveEngineMetadata(sourceChild, targetChild);
    }
  }
}

function preserveCompiledLoopCommand(source: DagNode, target: DagNode): void {
  if (isLoopNode(source) && isLoopNode(target)) {
    const compiled = (source.loop as typeof source.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (compiled !== undefined) {
      (target.loop as typeof target.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND] =
        structuredClone(compiled);
    }
  }
}
