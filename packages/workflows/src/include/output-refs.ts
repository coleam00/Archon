import type { DagNode } from '../schemas';
import {
  isAgentNode,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
  isNodeContextResume,
} from '../schemas';
import {
  OUTPUT_REF_SOURCE,
  LOOP_PREV_OUTPUT_REF_SOURCE,
  EXECUTION_CHECKOUT_REF_SOURCE,
} from '../output-ref';
import { mapNodeTemplateSlots } from '../template-walker';
import {
  readComposedMeta,
  readIncludeOutputAliases,
  setIncludeOutputAliases,
  type IncludeOutputAliases,
} from '../compiled-command';

/** Matches the canonical current-output prefix; only the node-id segment is rewritten. */
export const OUTPUT_REF_PATTERN = new RegExp(OUTPUT_REF_SOURCE, 'g');

/**
 * Cross-iteration body refs use the same executable node ids, under a distinct prefix.
 * When a reusable block is inlined into a loop_group body, its authored sibling ids must
 * follow the same namespace rewrite as current-iteration `$id.output` refs.
 */
const LOOP_PREV_OUTPUT_REF_PATTERN = new RegExp(LOOP_PREV_OUTPUT_REF_SOURCE, 'g');

/**
 * `when:`-only ref pattern. The condition grammar (condition-evaluator.ts) additionally
 * accepts the SHORTHAND `$id.field` form (equivalent to `$id.output.field`) alongside
 * `$id.output` / `$id.output.field`. So in a `when:` a bare `$id` followed by `.` and a
 * field name is a node reference whose id must be renamed too — OUTPUT_REF_PATTERN (which
 * requires the literal `.output`) would miss `$verify.exit_code == '0'`. The lookahead
 * matches `$id` only when a `.<field>` follows, and rewrites just the id segment.
 */
const WHEN_REF_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_-]*)(?=\.[a-zA-Z_])/g;

export function applyOutputRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(OUTPUT_REF_PATTERN, (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$${renamed}.output`;
  });
}

/** `$<id>.execution.checkoutStart` names a sibling node too, so its id follows the same rename. */
function applyExecutionCheckoutRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(new RegExp(EXECUTION_CHECKOUT_REF_SOURCE, 'g'), (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$${renamed}.execution.checkoutStart`;
  });
}

function applyLoopPrevOutputRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(LOOP_PREV_OUTPUT_REF_PATTERN, (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$LOOP_PREV.${renamed}.output`;
  });
}

function applyWhenRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(WHEN_REF_PATTERN, (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$${renamed}`;
  });
}

/**
 * Give every command-sourced node in `node`'s scope the include aliases its body may read
 * (#3972) — the same aliases `rewriteNodeOutputRefs` applies to an inline prompt there,
 * including inside loop_group bodies. A body list's own includes were attached first and
 * shadow the enclosing list's, matching the order the inline rewrite runs in.
 */
export function attachIncludeOutputAliases(node: DagNode, aliases: IncludeOutputAliases): void {
  if (
    (isAgentNode(node) && node.source.kind === 'command') ||
    (isLoopNode(node) && node.loop.command !== undefined)
  ) {
    setIncludeOutputAliases(node, { ...aliases, ...readIncludeOutputAliases(node) });
  }
  if (isLoopGroupNode(node)) {
    for (const body of node.loop_group.nodes) {
      if (!isIncludeDirective(body)) attachIncludeOutputAliases(body, aliases);
    }
  }
}

/**
 * Rewrite node-output references in a node's text-bearing fields via `rename`.
 * Mutates the (already-cloned) node in place. Recurses into loop_group bodies so a
 * body node's reference to an enclosing (namespaced) node is rewritten too.
 * `command` is a command NAME, never a ref, and is intentionally not rewritten.
 *
 * Three field classes, each with the right ref grammar:
 *   - `when:` — dual grammar (`$id.output[.field]` AND shorthand `$id.field`), never
 *     markdown → `applyWhenRefRename`. Missing the shorthand would leave e.g.
 *     `$verify.exit_code` pointing at a renamed sibling (silent fail-closed skip).
 *   - Prompt text (prompt / loop.prompt / approval fields) — canonical `.output` refs are
 *     live everywhere, including Markdown code spans, because runtime substitution is
 *     syntax-agnostic.
 *   - Code/expression (bash / script / wait.until / wait.event / wait.attention /
 *     loop.until_bash / loop_group.until_bash / cancel / workflow.input / workflow.fan_out.items) — canonical
 *     `.output` refs are LIVE (never documentation) → rewritten verbatim.
 *
 * Public runtime node-ref surfaces stay aligned across this rewrite, the loader's
 * validateDagStructure scan, and the substituteNodeOutputRefs call sites in
 * dag-executor.ts. Included loop-command bodies are validated separately during command
 * materialization, then their compiled prompts pass through this rewrite.
 *
 * applyInputsMacro walks the same field set. It used to be a deliberate SUPERSET — adding
 * systemPrompt and agents, which took include inputs but no runtime substitution — and that
 * asymmetry is what made a workflow using `$INPUTS.<name>` in a `systemPrompt:` resolve when
 * composed and stay literal when run standalone (#2476). Those fields receive runtime
 * substitution since #1764, so they are ordinary node-ref surfaces and are walked here too.
 */
export function rewriteNodeOutputRefs(
  node: DagNode,
  renameOutputRef: (id: string) => string,
  expandDependency: (id: string) => string[],
  renameLoopPrevRef: (id: string) => string
): void {
  const code = (text: string): string =>
    applyExecutionCheckoutRefRename(
      applyLoopPrevOutputRefRename(applyOutputRefRename(text, renameOutputRef), renameLoopPrevRef),
      renameOutputRef
    );
  const whenExpr = (text: string): string => applyWhenRefRename(text, renameOutputRef);

  if (node.when !== undefined) node.when = whenExpr(node.when);

  // A loop_group body node carries the enclosing include's boundary too (markComposedNode
  // stamps it on every body node), and that boundary names outer-graph ids. When the
  // enclosing block is itself included one level further out, those ids are renamed
  // like every other reference here — otherwise a body node keeps pointing at an id that
  // no longer exists in the flat graph and is skipped as "upstream failed" on the first
  // iteration, which is how a two-level composition (lifecycle → ship → deliver's
  // corrections loop) failed at runtime while each level worked on its own.
  const rewriteStructuralRefs = (target: DagNode): void => {
    if (isNodeContextResume(target.context)) {
      target.context.resume = renameOutputRef(target.context.resume);
    }
    for (const boundary of readComposedMeta(target)?.boundaries ?? []) {
      boundary.dependsOn = boundary.dependsOn.flatMap(expandDependency);
      if (boundary.when !== undefined) boundary.when = whenExpr(boundary.when);
    }
    if (isLoopGroupNode(target)) {
      // A body may still be an unexpanded include directive at this stage; those carry
      // no composed metadata of their own, so only real nodes are rewritten (the same
      // guard markComposedNode applies when it stamps the boundary in the first place).
      for (const body of target.loop_group.nodes) {
        if (!isIncludeDirective(body)) rewriteStructuralRefs(body);
      }
    }
  };
  rewriteStructuralRefs(node);

  const rewritten = mapNodeTemplateSlots(node, slot =>
    slot.surface === 'binding_default'
      ? slot.value
      : slot.surface === 'condition'
        ? whenExpr(slot.value)
        : code(slot.value)
  );
  Object.assign(node, rewritten);
}
