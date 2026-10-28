/** The references one loop_group iteration resolves in its body's text: `$LOOP_PREV.*` and `$LOOP_USER_INPUT`. */
import {
  type DagNode,
  type IncludeDirective,
  type NodeOutput,
  isIncludeDirective,
  isLoopGroupNode,
} from '../schemas';
import {
  type TemplateToken,
  OutputRefError,
  PRIOR_OUTPUT_PATH_SOURCE,
  assertSupportedOutputRefs,
  canonicalValueText,
  resolveNodeOutputField,
  similarNodeIds,
  substituteTemplate,
  templateToken,
} from '../output-ref';
import { getLog } from './log';
import type { TextSurface } from './references';
import { shellQuote, shellQuoteOrFile } from './shell-quote';

/**
 * Collect the static ids of every node in a loop_group body, recursing into nested
 * loop_group bodies. This is the *typo detector* for `$LOOP_PREV.<id>.output.<field>`
 * refs: an id that matches no node anywhere in the (possibly nested) body is a genuine
 * typo, distinct from a real body id that merely has no prior-iteration output yet.
 *
 * The transitive set (not just the outer group's direct ids) is deliberate: nested
 * loop_group bodies reuse the OUTER loop's prior-iteration snapshot, so a ref inside a
 * nested body may legitimately name an inner-group node id (which resolves to '' at the
 * outer granularity — see {@link loopPrevRefToken}). Including descendants keeps
 * such real-but-empty refs lenient while still catching ids that exist nowhere.
 */
export function collectLoopBodyNodeIds(
  nodes: readonly (DagNode | IncludeDirective)[],
  into: Set<string> = new Set<string>()
): Set<string> {
  for (const n of nodes) {
    into.add(n.id);
    if (!isIncludeDirective(n) && isLoopGroupNode(n))
      collectLoopBodyNodeIds(n.loop_group.nodes, into);
  }
  return into;
}

/**
 * The `$LOOP_PREV.<nodeId>.output[.field]` reference, resolved against one loop_group
 * scope's *prior-iteration* node outputs.
 *
 * Cross-iteration analog of {@link nodeOutputRefToken}: where `$nodeId.output` reads
 * a node's output from the *current* iteration's scope, `$LOOP_PREV.<nodeId>.output` reads
 * the same node's output from the *previous* iteration — letting a body node reference what
 * a sibling (or itself) produced one iteration ago. On iteration 1 (no prior iteration)
 * `loopPrevOutputs` is empty/undefined and every `$LOOP_PREV.*` ref resolves to '' (matching
 * the empty-on-first semantics of the single-node `$LOOP_PREV_OUTPUT`).
 *
 * Field access reuses {@link resolveNodeOutputField} for the same strict no-silent-drop
 * semantics (declared-schema typo / schemaless non-JSON / missing key → throws
 * `OutputRefError`, propagating to the consuming node's failure). The only value that
 * resolves to empty is an author-declared-optional field — or any ref on iteration 1.
 *
 * Two static id sets from the scope (both via {@link collectLoopBodyNodeIds} / its
 * immediate-ids counterpart) drive the absent-output branch. `knownBodyIds` is the
 * TRANSITIVE set (this group's body plus every nested descendant); `directBodyIds` is only
 * THIS group's immediate body ids. When output is absent, the id is classified:
 *   - not in `knownBodyIds` → a typo that matches no body node anywhere. A `.field` ref
 *     throws `OutputRefError('unknown-node')` (loud, with a did-you-mean) — the loop_group
 *     analog of the same fix at the `$node.output.field` seam (#2135/#2142); a whole-text
 *     `$LOOP_PREV.<id>.output` ref stays lenient ('').
 *   - in `knownBodyIds` but not in `directBodyIds` → the id belongs to a NESTED loop_group,
 *     not this group's own body. The token declines the reference so the inner
 *     loop_group's scope, later in the same pass, resolves it against its OWN
 *     prior-iteration snapshot. The outer scope must not consume it, or the inner loop
 *     could never see its own prior iteration.
 *   - in `directBodyIds` with no prior output → legitimate iteration-1 / skipped absence → ''.
 *
 * When `knownBodyIds` is undefined (a scope with no static set) the seam stays fully
 * lenient — every absent ref resolves to '', preserving the pre-#2142 behavior.
 */
export function loopPrevRefToken(scope: LoopBodyScope, escapedForBash: boolean): TemplateToken {
  const { loopPrevOutputs, outputFileDir, knownBodyIds, directBodyIds } = scope;
  const bodyIds = { knownBodyIds, directBodyIds };
  return templateToken(PRIOR_OUTPUT_PATH_SOURCE, groups => {
    const [match, nodeId] = groups;
    // An optional group that did not match is undefined, whatever RegExpExecArray says.
    const field: string | undefined = groups[2];
    const nodeOutput = loopPrevOutputs?.get(nodeId);
    if (!nodeOutput || nodeOutput.state === 'skipped' || nodeOutput.state === 'pending') {
      return resolveAbsentPriorOutput(bodyIds, nodeId, field, match, escapedForBash);
    }
    return renderPriorOutput(nodeOutput, nodeId, field, match, outputFileDir, escapedForBash);
  });
}

function resolveAbsentPriorOutput(
  { knownBodyIds, directBodyIds }: Pick<LoopBodyScope, 'knownBodyIds' | 'directBodyIds'>,
  nodeId: string,
  field: string | undefined,
  match: string,
  escapedForBash: boolean
): string | undefined {
  if (knownBodyIds) {
    if (!knownBodyIds.has(nodeId)) {
      if (field) {
        throw new OutputRefError(nodeId, field, 'unknown-node', {
          reference: match,
          candidates: similarNodeIds(nodeId, knownBodyIds),
        });
      }
    } else if (directBodyIds && !directBodyIds.has(nodeId)) {
      // Leave nested body ids for the inner scope's own prior-iteration snapshot.
      return undefined;
    }
  }
  getLog().debug({ nodeId, match }, 'loop_group_prev_ref_no_prior_output');
  return escapedForBash ? "''" : '';
}

function renderPriorOutput(
  nodeOutput: NodeOutput,
  nodeId: string,
  field: string | undefined,
  match: string,
  outputFileDir: string | undefined,
  escapedForBash: boolean
): string {
  if (!field) {
    return escapedForBash
      ? shellQuoteOrFile(nodeOutput.output, nodeId, undefined, outputFileDir)
      : nodeOutput.output;
  }
  const resolution = resolveNodeOutputField(nodeOutput, nodeId, field, match);
  if (resolution.kind === 'empty') return escapedForBash ? "''" : '';
  const value = resolution.value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = canonicalValueText(value);
  return escapedForBash ? shellQuoteOrFile(text, nodeId, field, outputFileDir) : text;
}

/**
 * One loop_group scope's references: `$LOOP_PREV.*` and, when the scope carries a reply,
 * `$LOOP_USER_INPUT`. A `shell` surface shell-quotes both (spilling large `$LOOP_PREV`
 * values to a file, as {@link nodeOutputRefToken} does). A `script` surface leaves
 * `$LOOP_USER_INPUT` literal: free text cannot be safely quoted into TS/Python source, so
 * the script reads it from its env (#2115). `$LOOP_PREV.*` stays raw there (bounded
 * producer contract).
 */
export function loopScopeTokens(scope: LoopBodyScope, surface: TextSurface): TemplateToken[] {
  const tokens = [loopPrevRefToken(scope, surface === 'shell')];
  const { loopUserInput } = scope;
  if (loopUserInput !== undefined && surface !== 'script') {
    tokens.push(
      templateToken(String.raw`\$LOOP_USER_INPUT`, () =>
        surface === 'shell' ? shellQuote(loopUserInput) : loopUserInput
      )
    );
  }
  return tokens;
}

/**
 * What one loop_group iteration resolves in its body's text: the prior-iteration outputs
 * `$LOOP_PREV.*` reads, the `$LOOP_USER_INPUT` reply, and the static id sets
 * {@link loopPrevRefToken} classifies absent refs with. Built once per iteration by
 * {@link loopBodyScope}. A body node resolves its templates against one scope per enclosing
 * group ({@link RunLayersContext.loopBodyScopes}) in the same pass as its workflow variables
 * and `$node.output` references, so a reply or a previous output is never read as template
 * syntax (#4046).
 */
export interface LoopBodyScope {
  loopPrevOutputs: Map<string, NodeOutput> | undefined;
  /** Undefined leaves `$LOOP_USER_INPUT` to an enclosing scope or the run-level variable. */
  loopUserInput?: string;
  outputFileDir?: string;
  knownBodyIds?: ReadonlySet<string>;
  directBodyIds?: ReadonlySet<string>;
}

/**
 * `knownBodyIds` is TRANSITIVE (this group's body + every nested descendant) — an id absent
 * from it is a typo (`.field` ref → loud failure). `directBodyIds` is only THIS group's
 * immediate ids — an id in knownBodyIds but not directBodyIds belongs to a nested group and
 * is left to that inner group's own scope (#2142).
 */
export function loopBodyScope(
  bodyNodes: readonly DagNode[],
  loopPrevOutputs: Map<string, NodeOutput> | undefined,
  loopUserInput: string,
  outputFileDir: string
): LoopBodyScope {
  return {
    loopPrevOutputs,
    loopUserInput,
    outputFileDir,
    knownBodyIds: collectLoopBodyNodeIds(bodyNodes),
    directBodyIds: new Set(bodyNodes.map(n => n.id)),
  };
}

/**
 * Resolve only the loop_group scopes' references in `text`, for text that is not a
 * template of its own: a body command node's file name, a binding's `if_skipped` default.
 */
export function substituteLoopBodyText(
  text: string,
  scopes: readonly LoopBodyScope[],
  surface: TextSurface = 'prompt'
): string {
  assertSupportedOutputRefs(text);
  return substituteTemplate(
    text,
    scopes.flatMap(scope => loopScopeTokens(scope, surface))
  );
}
