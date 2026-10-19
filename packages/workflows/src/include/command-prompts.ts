import type { AgentNode, DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import { isAgentNode, isLoopGroupNode, isLoopNode } from '../schemas';
import { resolvedBodyNodes } from '../graph-plan';
import {
  COMPILED_LOOP_COMMAND,
  attachComposedBindings,
  isIncludeCommandReadError,
  resolveIncludeOutputAliases,
  setIncludeOutputAliases,
  type CompiledLoopCommand,
  type IncludeCommandContent,
  type LoopWithCompiledCommand,
} from '../compiled-command';
import { IncludeExpansionError } from './expansion-error';
import { OUTPUT_REF_PATTERN } from './output-refs';

/** One command node inside an included block, and the ids its body may reference. */
interface BlockCommandScope {
  includeNode: IncludeDirective;
  child: Pick<WorkflowDefinition, 'name'>;
  commandContents: ReadonlyMap<string, IncludeCommandContent>;
  currentIds: ReadonlySet<string>;
  enclosingIds: ReadonlySet<string>;
  nodePath: string;
}

/**
 * Compile an included workflow's named AI command bodies into the flat DAG. Composition
 * must prove the child's lexical boundary before parent nodes share one output map, so
 * every canonical ref in a resolved body must name a node in the command node's current or
 * enclosing workflow scope. Ordinary command nodes become prompt nodes. Loop commands keep
 * their authored identity plus symbol-keyed compiled prompt/error metadata so cold resume can
 * reach a persisted prompt snapshot even after source deletion. The ordinary namespacing and
 * `$INPUTS` passes transform compiled bodies without a second grammar.
 * Named script files are deliberately outside this function: their source is opaque. An
 * included block can bind inputs in the YAML `script:` selector, but the flattened include
 * does not add `INPUTS_*` environment variables inside the selected script program.
 */
export function materializeBlockCommandPrompts(
  node: DagNode,
  includeNode: IncludeDirective,
  child: Pick<WorkflowDefinition, 'name'>,
  commandContents: ReadonlyMap<string, IncludeCommandContent>,
  currentIds: ReadonlySet<string>,
  enclosingIds: ReadonlySet<string>,
  nodePath: string
): DagNode {
  const scope: BlockCommandScope = {
    includeNode,
    child,
    commandContents,
    currentIds,
    enclosingIds,
    nodePath,
  };
  if (isAgentNode(node) && node.source.kind === 'command') {
    return materializeCommandAgent(node, node.source, scope);
  }

  if (isLoopNode(node) && node.loop.command !== undefined) {
    const existing = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (existing !== undefined) return node;
    const loop = { ...node.loop } as typeof node.loop & LoopWithCompiledCommand;
    loop[COMPILED_LOOP_COMMAND] = compileBlockCommand(node, node.loop.command, scope);
    const materialized: DagNode = { ...node, loop };
    setIncludeOutputAliases(materialized, undefined);
    return materialized;
  }

  if (isLoopGroupNode(node)) {
    const bodyNodes = resolvedBodyNodes(node.loop_group);
    const bodyIds = new Set(bodyNodes.map(body => body.id));
    const bodyEnclosingIds = new Set([...enclosingIds, ...currentIds]);
    return {
      ...node,
      loop_group: {
        ...node.loop_group,
        nodes: bodyNodes.map(body =>
          materializeBlockCommandPrompts(
            body,
            includeNode,
            child,
            commandContents,
            bodyIds,
            bodyEnclosingIds,
            `${nodePath} → ${body.id}`
          )
        ),
      },
    };
  }

  return node;
}

function materializeCommandAgent(
  node: AgentNode,
  source: Extract<AgentNode['source'], { kind: 'command' }>,
  scope: BlockCommandScope
): DagNode {
  const compiled = compileBlockCommand(node, source.name, scope);
  if (compiled.error !== undefined) {
    const content = scope.commandContents.get(source.name);
    throw new IncludeExpansionError(
      compiled.error,
      isIncludeCommandReadError(content) ? 'read_error' : 'validation_error',
      { cause: isIncludeCommandReadError(content) ? content.cause : undefined }
    );
  }
  // The node's own `with:` map has no home on the inline variant, so it moves to the
  // engine-private payload the executor resolves for a materialized node (#2964).
  // It cannot be resolved here: a binding reads a sibling's output mid-run, which is
  // exactly the case composition used to reject as an unpassable missing input.
  const bindings = source.with;
  const materialized: DagNode = { ...node, source: { kind: 'inline', prompt: compiled.prompt } };
  if (bindings !== undefined) attachComposedBindings(materialized, bindings);
  setIncludeOutputAliases(materialized, undefined);
  return materialized;
}

function compileBlockCommand(
  node: DagNode,
  commandName: string,
  scope: BlockCommandScope
): CompiledLoopCommand {
  const { includeNode, child, nodePath } = scope;
  const content = scope.commandContents.get(commandName);
  if (isIncludeCommandReadError(content)) {
    const failure =
      content.operation === 'inspect'
        ? `could not inspect higher-precedence command scope '${content.path}'`
        : `matched '${content.path}' but could not be read`;
    return {
      error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' command '${commandName}' ${failure}: ${content.message}. Archon will not fall through to a lower-precedence command when a higher-precedence scope cannot be inspected or its matched file cannot be read.`,
    };
  }
  if (content === undefined || content === null) {
    return {
      error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' uses command '${commandName}', but its body could not be resolved during composition through the package-owned, project/configured, user, or enabled bundled command scopes. Included commands must resolve before a fresh execution so their references and declared inputs can be compiled safely.`,
    };
  }
  if (content.trim().length === 0) {
    return {
      error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' command '${commandName}' is empty. Included commands must contain a non-whitespace prompt body.`,
    };
  }

  const prompt = resolveIncludeOutputAliases(node, content);
  const offendingRef = firstRefOutsideScope(prompt, scope);
  if (offendingRef !== undefined) {
    return {
      error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' command '${commandName}' references '${offendingRef}' outside its workflow namespace. Declare it under '${child.name}' inputs:, pass the caller value through '${includeNode.id}' with:, and read it as '$INPUTS.<name>' instead.`,
    };
  }
  return { prompt };
}

/** The first `$id.output` in `prompt` naming no node of the command's own or enclosing scope. */
function firstRefOutsideScope(prompt: string, scope: BlockCommandScope): string | undefined {
  const outputRefPattern = new RegExp(OUTPUT_REF_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = outputRefPattern.exec(prompt)) !== null) {
    const referencedId = match[1];
    if (referencedId === 'INPUTS') continue;
    if (
      referencedId !== undefined &&
      !scope.currentIds.has(referencedId) &&
      !scope.enclosingIds.has(referencedId)
    ) {
      return match[0];
    }
  }
  return undefined;
}
