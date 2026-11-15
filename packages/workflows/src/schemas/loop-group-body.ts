import type { DagNode } from './dag-node';
import type { IncludeDirective } from './include-node';
import { isGateNode, isIncludeDirective, isLoopGroupNode, isWaitNode } from './node-guards';

/**
 * A loop_group body's terminal sinks: the entries no other body entry depends on,
 * in body order. A gate or wait only pauses the enclosing loop when it is the SOLE
 * one (#2707 step 3) — see `loopGroupSoleTerminalSink`. Load-time checks and the
 * runtime share this so the two can never disagree about which node a body ends on.
 */
function loopGroupBodySinks<T extends { id: string; depends_on?: readonly string[] }>(
  body: readonly T[]
): T[] {
  const dependedOn = new Set(body.flatMap(n => n.depends_on ?? []));
  return body.filter(n => !dependedOn.has(n.id));
}

/** The body's only terminal sink, or `undefined` when it ends on zero or several. */
export function loopGroupSoleTerminalSink<T extends { id: string; depends_on?: readonly string[] }>(
  body: readonly T[]
): T | undefined {
  const sinks = loopGroupBodySinks(body);
  return sinks.length === 1 ? sinks[0] : undefined;
}

/**
 * The body entries an iteration's output is read from, in body order: the terminal
 * sinks, with a sink that asks a human (an approval gate or an attention wait) read
 * past to the entries it depends on. A pause asks about the work; it is not the work,
 * so the group's output is the same whether the pause was skipped or answered (#4043).
 * The answer stays on the pause's own output, where `until_bash` and
 * `$LOOP_PREV.<pause>.output` read it.
 */
export function loopGroupOutputNodes<T extends DagNode | IncludeDirective>(
  body: readonly T[]
): T[] {
  return loopGroupBodySinks(body).flatMap(sink =>
    !isIncludeDirective(sink) &&
    (isGateNode(sink) || (isWaitNode(sink) && sink.wait.attention !== undefined))
      ? body.filter(n => sink.depends_on?.includes(n.id))
      : [sink]
  );
}

/**
 * Collect the static ids of every node in a loop_group body, recursing into nested
 * loop_group bodies. This is the *typo detector* for `$LOOP_PREV.<id>.output.<field>`
 * refs: an id that matches no node anywhere in the (possibly nested) body is a genuine
 * typo, distinct from a real body id that merely has no prior-iteration output yet.
 * The loader refuses a `$LOOP_PREV` ref whose id is outside this set for every enclosing
 * body, so the load check and the runtime agree on which ids a body may name.
 *
 * The transitive set (not just the outer group's direct ids) is deliberate: nested
 * loop_group bodies reuse the OUTER loop's prior-iteration snapshot, so a ref inside a
 * nested body may legitimately name an inner-group node id (which resolves to '' at the
 * outer granularity — see `loopPrevRefToken` in dag/loop-scope.ts). Including descendants keeps
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
