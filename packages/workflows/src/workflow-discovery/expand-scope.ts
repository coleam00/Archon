import { dirname } from 'path';
import type {
  DeclaredWorkflowConfig,
  ParsedWorkflowLoadError,
  ResolvedWorkflow,
  WorkflowDefinition,
  WorkflowLoadError,
  WorkflowWithSource,
} from '../schemas';
import { isIncludeDirective, isLoopGroupNode } from '../schemas';
import { collectLoopGroupSinkWarnings } from '../loader/parse-warnings';
import { expandWorkflowIncludes } from '../include-expander';
import { attachHomeMcpDirectory } from '../compiled-command';
import { resolveIncludeBlockCommandContents } from './command-scan';
import type { DiscoveryContext } from './context';
import type { ScopeFile } from './load-dir';
import { validateNamedScripts } from './named-scripts';

/**
 * Final discovery step: inline every `include:` node (see include-expander.ts).
 * Resolves include targets against the full name map (bundled < global < project
 * precedence already applied to `files`), then swaps each workflow for
 * its flattened, namespaced form. A workflow that fails to expand is dropped and
 * its errors returned to the catalog. Only `.workflow` changes — `source` is kept.
 */
export async function expandScope(
  context: DiscoveryContext,
  files: Map<string, ScopeFile>
): Promise<{ workflows: WorkflowWithSource[]; errors: WorkflowLoadError[] }> {
  const errors: ParsedWorkflowLoadError[] = [];
  await validateNamedScripts(context, files, errors);
  const duplicateNames = reportDuplicateNames(files, errors);
  attachGlobalMcpDirectories(files);

  const rawByName = new Map<string, WorkflowDefinition>();
  // Map workflow NAME → its real filename, so expansion errors (keyed by name inside the
  // pure expander) can be reported against the includer's actual file. Duplicate names
  // are excluded from expansion above, so first-seen is unambiguous for the rest.
  const filenameByName = new Map<string, string>();
  for (const [filename, { workflow }] of files) {
    if (duplicateNames.has(workflow.name)) continue; // ambiguous — errored above, excluded
    rawByName.set(workflow.name, workflow);
    if (!filenameByName.has(workflow.name)) filenameByName.set(workflow.name, filename);
  }
  // Pre-resolve command-file contents for include-target command nodes so the expander
  // can catch a block command file that references a sibling id namespacing renames.
  const commandContents = await resolveIncludeBlockCommandContents(
    context.roots,
    rawByName,
    context.commandScan
  );
  const { workflows: expandedByName, errors: expansionErrors } = expandWorkflowIncludes(
    rawByName,
    commandContents,
    [...context.allErrors, ...errors]
  );
  // Re-key expansion errors from workflow name to the includer's real filename.
  errors.push(
    ...expansionErrors.map(e => ({
      ...e,
      workflowName: e.filename,
      filename: filenameByName.get(e.filename) ?? e.filename,
    }))
  );

  const result: WorkflowWithSource[] = [];
  for (const file of files.values()) {
    if (duplicateNames.has(file.workflow.name)) continue; // dropped as a duplicate-name collision
    const expanded = expandedByName.get(file.workflow.name);
    if (!expanded) continue; // expansion failed for this workflow — drop it
    result.push(expandedWorkflow(file, expanded));
  }
  return { workflows: result, errors };
}

/**
 * Overrides are by FILENAME, but include targets resolve by workflow NAME. Two
 * surviving files (after filename-precedence) declaring the same `name:` would
 * silently collapse in the name map — last-writer-wins, emitting the same expanded
 * workflow under both filenames with the wrong source label and making include
 * resolution order-dependent. Detect the collision and error the offending files
 * instead (resilient: drop only the colliding entries, keep discovering the rest).
 * Same-name shadowing was already ambiguous before `include:`; the name map just made
 * it load-bearing, so this hardens a pre-existing gap.
 */
function reportDuplicateNames(
  files: ReadonlyMap<string, ScopeFile>,
  errors: ParsedWorkflowLoadError[]
): Set<string> {
  const filenamesByName = new Map<string, string[]>();
  for (const [filename, { workflow }] of files) {
    const existing = filenamesByName.get(workflow.name);
    if (existing) existing.push(filename);
    else filenamesByName.set(workflow.name, [filename]);
  }
  const duplicateNames = new Set<string>();
  for (const [name, filenames] of filenamesByName) {
    if (filenames.length <= 1) continue;
    duplicateNames.add(name);
    for (const filename of filenames) {
      errors.push({
        filename,
        workflowName: name,
        error: `Duplicate workflow name '${name}' — also declared in ${filenames
          .filter(f => f !== filename)
          .join(
            ', '
          )}. Workflow names must be unique; same-name files do not override each other (overrides are by filename).`,
        errorType: 'validation_error',
      });
    }
  }
  return duplicateNames;
}

function attachGlobalMcpDirectories(files: ReadonlyMap<string, ScopeFile>): void {
  for (const { workflow, source, filePath } of files.values()) {
    if (source !== 'global' || filePath === undefined) continue;
    const attachDirectory = (nodes: WorkflowDefinition['nodes']): void => {
      for (const node of nodes) {
        if ('mcp' in node && node.mcp !== undefined)
          attachHomeMcpDirectory(node, dirname(filePath));
        if (!isIncludeDirective(node) && isLoopGroupNode(node))
          attachDirectory(node.loop_group.nodes);
      }
    };
    attachDirectory(workflow.nodes);
  }
}

function expandedWorkflow(
  { workflow, source, parseWarnings }: ScopeFile,
  expanded: ResolvedWorkflow
): WorkflowWithSource {
  // Expansion collapses workflow-level node config onto the nodes and removes it
  // (#1764), so the RAW parse is the only place left that knows what the author
  // wrote. Captured here, where both forms are in hand, for display surfaces.
  const declared: DeclaredWorkflowConfig = {
    ...(workflow.provider !== undefined ? { provider: workflow.provider } : {}),
    ...(workflow.model !== undefined ? { model: workflow.model } : {}),
    ...(workflow.effort !== undefined ? { effort: workflow.effort } : {}),
  };
  // The loop_group sink-shape verdicts belong to the EXPANDED graph (#2756): a body
  // whose terminal sink arrives through `include:` is an opaque target name until
  // here, so judging it at parse time silently cleared shapes it could not see.
  // This is the check's only pass — a directly-authored sink keeps its id through
  // expansion, so it is reported here exactly once too.
  const warnings = [...parseWarnings];
  collectLoopGroupSinkWarnings(expanded.nodes, warnings);
  return {
    workflow: expanded,
    source,
    // Omitted rather than empty, matching the `errors` field on the same
    // surfaces: presence alone is the signal.
    ...(warnings.length > 0 ? { parseWarnings: warnings } : {}),
    ...(Object.keys(declared).length > 0 ? { declared } : {}),
  };
}
