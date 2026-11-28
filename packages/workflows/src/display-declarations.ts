/**
 * What `archon validate` refuses in a workflow's `display:` declarations, the parts a reader
 * counts with rather than shows (`schemas/display.ts`): a mark whose `means` is outside the
 * readers' vocabulary, and a `results` pointer the workflow's result cannot hold. The loader
 * keeps both, so an older engine still loads a newer pack's slug; a misspelling is caught
 * here, where an author looks, instead of silently dropping a count.
 */
import type { DagNode, ResolvedWorkflow } from './schemas';
import { DISPLAY_MARK_MEANINGS } from './schemas/display';

export interface DisplayDeclarationFinding {
  readonly message: string;
  readonly hint: string;
}

const MEANINGS: readonly string[] = DISPLAY_MARK_MEANINGS;

type SchemaNode = Readonly<Record<string, unknown>>;

function isSchema(value: unknown): value is SchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether the RFC 6901 `tokens` reach a declared place in `schema`: each object token through
 * `properties`, each array index through `items`, any branch of `anyOf`, `oneOf` or `allOf`.
 * `additionalProperties` does not count: a reader needs a place the workflow names.
 */
function reaches(schema: unknown, tokens: readonly string[]): boolean {
  if (!isSchema(schema)) return false;
  if (tokens.length === 0) return true;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some(branch => reaches(branch, tokens))) return true;
  }
  const [token, ...rest] = tokens as [string, ...string[]];
  const properties = schema.properties;
  if (isSchema(properties) && Object.hasOwn(properties, token))
    return reaches(properties[token], rest);
  if (/^(0|[1-9][0-9]*)$/.test(token) && isSchema(schema.items)) return reaches(schema.items, rest);
  return false;
}

/** The pointer's reference tokens, `~1` and `~0` decoded. */
function tokensOf(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function meansFindings(workflow: ResolvedWorkflow): DisplayDeclarationFinding[] {
  const display = workflow.display;
  const marks = [
    ...(display?.marks ?? []).map(mark => ({ mark, where: 'display.marks' })),
    ...(display?.replaces ?? []).flatMap(entry =>
      (entry.marks ?? []).map(mark => ({
        mark,
        where: `display.replaces '${entry.workflow}' marks`,
      }))
    ),
  ];
  return marks
    .filter(({ mark }) => !MEANINGS.includes(mark.means))
    .map(({ mark, where }) => ({
      message: `Workflow '${workflow.name}' ${where}: step '${mark.node}' outcome '${mark.outcome}' means '${mark.means}', which no reader knows (known: ${MEANINGS.join(', ')})`,
      hint: `Use one of ${MEANINGS.join(', ')}; a reader ignores any other, so its count would silently go missing.`,
    }));
}

function resultsFindings(workflow: ResolvedWorkflow): DisplayDeclarationFinding[] {
  // `replaces[].results` points into a retired workflow's results, which has no YAML here.
  const results = Object.entries(workflow.display?.results ?? {});
  if (results.length === 0) return [];
  const node: DagNode | undefined = workflow.nodes.find(n => n.id === workflow.returns);
  const schema = node?.output_format;
  const missing =
    node === undefined
      ? 'the workflow declares no returns node'
      : schema === undefined
        ? `its returns node '${node.id}' declares no output_format`
        : undefined;
  return results
    .filter(([, pointer]) => missing !== undefined || !reaches(schema, tokensOf(pointer)))
    .map(([name, pointer]) => ({
      message: `Workflow '${workflow.name}' display.results '${name}' points at '${pointer}', ${missing === undefined ? `which node '${workflow.returns ?? ''}' output_format does not declare` : `but ${missing}`}`,
      hint: "Point at a property the returns node's output_format declares, through its properties and items.",
    }));
}

/** Each `display:` declaration of the flattened `workflow` that `archon validate` refuses. */
export function displayDeclarationFindings(
  workflow: ResolvedWorkflow
): DisplayDeclarationFinding[] {
  return [...meansFindings(workflow), ...resultsFindings(workflow)];
}
