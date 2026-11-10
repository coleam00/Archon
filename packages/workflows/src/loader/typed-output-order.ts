/**
 * Load-time ordering of typed-outputs bindings (`with: { <name>: { outputs: <type> } }`).
 *
 * The binding reads what the run has recorded when its node starts, so it is only
 * deterministic when every node that can produce the type is ordered before the reader.
 * Unlike a `$node.output` binding, the producers are named by type and may sit in a loop
 * body or have arrived through an include, so this walks the flattened graph as a tree:
 * a producer is ordered before the reader when, in the innermost scope that holds both,
 * the reader's side depends on the producer's side.
 *
 * A bound type no node declares is refused too: a misspelt type would otherwise read as
 * "this run produced none".
 *
 * Runs on the flattened graph only: before include expansion a producer inside an
 * included block is not visible. The instances of a composed fan-out are expanded at run
 * time and are not visible here at all, so a type only they declare is refused.
 */
import { transitiveDepsLookup } from '../depends-on';
import {
  isExecNode,
  isIncludeDirective,
  isLoopGroupNode,
  isTypedOutputsDirective,
  type DagNode,
  type IncludeDirective,
} from '../schemas';

type Nodes = readonly (DagNode | IncludeDirective)[];

/** One step from the workflow's top level down to a node: the scope, and the member taken. */
interface Step {
  readonly scope: Nodes;
  readonly id: string;
}

interface Placed {
  readonly node: DagNode;
  readonly path: readonly Step[];
}

function placeNodes(scope: Nodes, above: readonly Step[], placed: Placed[]): void {
  for (const node of scope) {
    if (isIncludeDirective(node)) continue;
    const path = [...above, { scope, id: node.id }];
    placed.push({ node, path });
    if (isLoopGroupNode(node)) placeNodes(node.loop_group.nodes, path, placed);
  }
}

type OrderedBefore = (scope: Nodes, later: string, earlier: string) => boolean;

/** Why `producer` is not ordered before `reader`, or null when it is. */
function producerOrderProblem(
  reader: Placed,
  producer: Placed,
  orderedBefore: OrderedBefore
): string | null {
  // The innermost scope that holds both: the first step where their paths part.
  const fork = reader.path.findIndex((step, depth) => step.id !== producer.path[depth]?.id);
  const mine = reader.path[fork];
  const theirs = producer.path[fork];
  if (mine === undefined) return null;
  if (theirs === undefined) {
    return `'${producer.node.id}' produces one and encloses that node, so its output is recorded only after the node has run`;
  }
  if (orderedBefore(mine.scope, mine.id, theirs.id)) return null;
  const through = theirs.id === producer.node.id ? '' : ` (inside '${theirs.id}')`;
  return `its producer '${producer.node.id}'${through} is not an upstream dependency — add '${theirs.id}' to '${mine.id}'.depends_on so the output is recorded first`;
}

/** The types a node binds with `{ outputs }`, by binding name. */
function typedOutputReads(node: DagNode): [name: string, outputType: string][] {
  if (!isExecNode(node)) return [];
  return Object.entries(node.with ?? {}).flatMap(([name, value]) =>
    isTypedOutputsDirective(value) ? [[name, value.outputs] as [string, string]] : []
  );
}

/** The first typed-outputs binding whose producers are not all ordered before it, or null. */
export function validateTypedOutputOrder(nodes: Nodes): string | null {
  const placed: Placed[] = [];
  placeNodes(nodes, [], placed);
  const depsOf = new Map<Nodes, ReturnType<typeof transitiveDepsLookup>>();
  const orderedBefore: OrderedBefore = (scope, later, earlier) => {
    let lookup = depsOf.get(scope);
    if (lookup === undefined) depsOf.set(scope, (lookup = transitiveDepsLookup(scope)));
    return lookup(later).has(earlier);
  };

  for (const reader of placed) {
    for (const [name, outputType] of typedOutputReads(reader.node)) {
      // A node never reads its own current output: it is recorded after the node ends.
      const producers = placed.filter(
        other => other.node.output_type === outputType && other !== reader
      );
      if (producers.length === 0) {
        return `Node '${reader.node.id}' binding 'with.${name}' reads every '${outputType}' output, but no node in this workflow declares output_type: ${outputType} — fix the type, or declare it on the node that produces it`;
      }
      for (const producer of producers) {
        const problem = producerOrderProblem(reader, producer, orderedBefore);
        if (problem !== null) {
          return `Node '${reader.node.id}' binding 'with.${name}' reads every '${outputType}' output, but ${problem}`;
        }
      }
    }
  }
  return null;
}
