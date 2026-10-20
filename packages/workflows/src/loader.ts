/**
 * Workflow loader - parses and validates a workflow YAML file
 */
import type { ProviderRegistry } from '@archon/provider-contract';
import type { WorkflowDefinition, WorkflowLoadError, DagNode, IncludeDirective } from './schemas';
import { sandboxSettingsSchema } from './schemas/dag-node';
import { modelReasoningEffortSchema, webSearchModeSchema } from './schemas/workflow';
import { validateInlineExecInputs } from './exec-input-validation';
import { getLog } from './loader/log';
import {
  validateLoopGroupProseCompletion,
  validateNodeOutputFormats,
  validateRunBudgetShape,
  validateWorkflowOutcomeDeclaration,
} from './loader/contracts';
import {
  collectConditionalJoinWarnings,
  collectLegacyPauseWarnings,
  collectUnknownWorkflowKeys,
  warnSignalCompletesWithoutInteractive,
} from './loader/parse-warnings';
import {
  parseBetas,
  parseContainerPolicy,
  parseDeprecation,
  parseEvidencePolicy,
  parseFallbackModel,
  parseWorkflowModel,
  parseInputs,
  parseMutatesCheckout,
  parseOptionalField,
  parseOutcomeField,
  parseRequires,
  parseReturns,
  parseRunBudget,
  parseTags,
  parseWorktreePolicy,
  resolveEffort,
} from './loader/workflow-fields';
import { parseDagNodes } from './loader/node-parse';
import {
  persistSessionError,
  sessionResumeProviderError,
  unknownProviderError,
} from './loader/provider-checks';
import { validateDagStructure } from './loader/dag-structure';

/**
 * Parse workflow YAML with Bun's parser. Every reader of a workflow file goes through here.
 * CRLF is normalized first: Bun keeps the line break of a multi-line quoted scalar in a CRLF
 * file where the YAML spec (and LF input) folds it to a space.
 */
export function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content.replaceAll('\r\n', '\n'));
}

export type ParseResult =
  | { workflow: WorkflowDefinition; error: null; warnings: string[] }
  | { workflow: null; error: WorkflowLoadError; warnings?: never };

interface WorkflowHeader {
  readonly name: string;
  readonly description: string;
  readonly nodes: readonly unknown[];
}

/**
 * The fields every workflow must have, or the error for a document that is not a workflow:
 * not an object, a removed field, a missing name or description, legacy `steps:` or no `nodes:`.
 */
function parseWorkflowHeader(
  raw: Record<string, unknown>,
  filename: string
): WorkflowHeader | string {
  if (!raw || typeof raw !== 'object') {
    return 'YAML file is empty or does not contain an object';
  }

  if (Object.hasOwn(raw, 'thinking')) {
    return "'thinking:' has been removed; use 'effort:' instead";
  }

  // A load failure reaches the author through the returned `error`, which discovery
  // collects for `workflow list`, `validate workflows`, `workflow run`, and the API.
  // Like parse warnings, the log line is debug so a broken file is not repeated on
  // every discovery (#3444).
  if (!raw.name || typeof raw.name !== 'string') {
    getLog().debug({ filename }, 'workflow_missing_name');
    return "Missing required field 'name'";
  }
  if (!raw.description || typeof raw.description !== 'string') {
    getLog().debug({ filename }, 'workflow_missing_description');
    return "Missing required field 'description'";
  }

  // Reject legacy steps-based workflows
  if (Array.isArray(raw.steps) && raw.steps.length > 0) {
    return '`steps:` format has been removed. Workflows must use `nodes:` (DAG) format. See https://archon.diy/guides/authoring-workflows/ for the workflow language reference.';
  }

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    getLog().debug({ filename }, 'workflow_missing_nodes');
    return "Workflow must have 'nodes:' configuration";
  }
  return { name: raw.name, description: raw.description, nodes: raw.nodes };
}

/** The first graph-level error in the parsed nodes: structure, output formats, prose completion. */
function nodeGraphError(
  dagNodes: readonly (DagNode | IncludeDirective)[],
  filename: string
): string | null {
  const structureError = validateDagStructure(dagNodes);
  if (structureError) {
    getLog().debug({ filename, structureError }, 'dag_structure_invalid');
    return structureError;
  }

  const outputFormatError = validateNodeOutputFormats(dagNodes);
  if (outputFormatError) {
    getLog().debug({ filename, outputFormatError }, 'output_format_rejected');
    return outputFormatError;
  }

  const proseCompletionError = validateLoopGroupProseCompletion(dagNodes);
  if (proseCompletionError) {
    getLog().debug({ filename, proseCompletionError }, 'loop_group_prose_completion_rejected');
    return proseCompletionError;
  }
  return null;
}

/**
 * Parse and validate a workflow YAML file
 */
export function parseWorkflow(
  content: string,
  filename: string,
  providers: ProviderRegistry,
  configuredEnvNames?: ReadonlySet<string>
): ParseResult {
  const reject = (error: string): ParseResult => ({
    workflow: null,
    error: { filename, error, errorType: 'validation_error' },
  });
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    const header = parseWorkflowHeader(raw, filename);
    if (typeof header === 'string') return reject(header);

    const parsedNodes = parseDagNodes(header.nodes, filename);
    if (typeof parsedNodes === 'string') return reject(parsedNodes);
    const { nodes: dagNodes, warnings: parseWarnings } = parsedNodes;

    const graphError = nodeGraphError(dagNodes, filename);
    if (graphError !== null) return reject(graphError);

    collectConditionalJoinWarnings(dagNodes, parseWarnings);
    collectLegacyPauseWarnings(dagNodes, header.nodes, parseWarnings);

    if (raw.interactive !== undefined) {
      const message =
        `Workflow '${header.name}': workflow-level 'interactive:' is deprecated and has no effect. ` +
        'Any workflow can start in the foreground, in the background or from a trigger; a ' +
        'pause waits in the attention queue until it is answered. Remove the line.';
      parseWarnings.push(message);
      getLog().debug({ filename, warning: message }, 'workflow_interactive_deprecated');
    }

    // Parse workflow-level fields using WorkflowBaseSchema for validation
    // Note: modelReasoningEffort and webSearchMode use warn-and-ignore for invalid values
    // (consistent with original behavior) rather than schema-level rejection.
    const provider =
      typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : undefined;
    const model = parseWorkflowModel(raw.model);
    if ('error' in model) return reject(model.error);

    const workflowPersistSessions = raw.persist_sessions === true;
    const providerError =
      unknownProviderError(provider, dagNodes, providers) ??
      sessionResumeProviderError(dagNodes, provider, providers) ??
      persistSessionError(dagNodes, workflowPersistSessions, provider, providers, parseWarnings);
    if (providerError !== null) return reject(providerError);

    // Validate modelReasoningEffort / webSearchMode — warn and ignore invalid values.
    const modelReasoningEffort = parseOptionalField(
      raw.modelReasoningEffort,
      modelReasoningEffortSchema,
      filename,
      'invalid_model_reasoning_effort',
      { valid: modelReasoningEffortSchema.options }
    );
    // Parsed here for validation only. The deprecation is RESOLVED below, in
    // `resolveEffort`, because translating needs `effort` too:
    // `modelReasoningEffort` becomes `effort` and is never carried forward.
    const webSearchMode = parseOptionalField(
      raw.webSearchMode,
      webSearchModeSchema,
      filename,
      'invalid_web_search_mode',
      { valid: webSearchModeSchema.options }
    );

    warnSignalCompletesWithoutInteractive(dagNodes, filename);

    const worktreePolicy = parseWorktreePolicy(raw.worktree, filename);
    const containerPolicy = parseContainerPolicy(raw.container, filename);
    const evidencePolicy = parseEvidencePolicy(raw.evidence_policy);
    if ('error' in evidencePolicy) return reject(evidencePolicy.error);
    const budget = parseRunBudget(raw.budget);
    if ('error' in budget) return reject(budget.error);
    const deprecated = parseDeprecation(raw.deprecated);
    if ('error' in deprecated) return reject(deprecated.error);
    const mutatesCheckout = parseMutatesCheckout(raw.mutates_checkout, filename);
    const tags = parseTags(raw.tags, filename);
    const requires = parseRequires(raw.requires, filename);
    const inputs = parseInputs(raw.inputs, filename);
    if ('error' in inputs) return reject(inputs.error);
    const returns = parseReturns(raw.returns, dagNodes, filename);
    if ('error' in returns) return reject(returns.error);
    const outcomeField = parseOutcomeField(raw.outcome_field, filename);
    if ('error' in outcomeField) return reject(outcomeField.error);
    const effort = resolveEffort(
      raw.effort,
      modelReasoningEffort,
      header.name,
      filename,
      parseWarnings
    );
    const sandbox = parseOptionalField(
      raw.sandbox,
      sandboxSettingsSchema,
      filename,
      'invalid_workflow_sandbox_value_ignored'
    );
    const fallbackModel = parseFallbackModel(raw.fallbackModel, filename);
    const betas = parseBetas(raw.betas, filename);

    collectUnknownWorkflowKeys(raw, header.name, parseWarnings);

    const workflow: WorkflowDefinition = {
      name: header.name,
      description: header.description,
      provider,
      model: model.value,
      // `modelReasoningEffort` is deliberately absent — it was translated into
      // `effort` by `resolveEffort`, so nothing downstream ever sees the deprecated field.
      webSearchMode,
      ...(mutatesCheckout !== undefined ? { mutates_checkout: mutatesCheckout } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
      ...(betas !== undefined ? { betas } : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(workflowPersistSessions ? { persist_sessions: true } : {}),
      nodes: dagNodes,
      ...(worktreePolicy ? { worktree: worktreePolicy } : {}),
      ...(containerPolicy ? { container: containerPolicy } : {}),
      ...(evidencePolicy.value !== undefined ? { evidence_policy: evidencePolicy.value } : {}),
      ...(budget.value !== undefined ? { budget: budget.value } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(requires !== undefined ? { requires } : {}),
      ...(inputs.value !== undefined ? { inputs: inputs.value } : {}),
      ...(returns.value !== undefined ? { returns: returns.value } : {}),
      ...(outcomeField.value !== undefined ? { outcome_field: outcomeField.value } : {}),
      ...(deprecated.value !== undefined ? { deprecated: deprecated.value } : {}),
    };
    const execInputValidation = validateInlineExecInputs(workflow, configuredEnvNames);
    parseWarnings.push(...execInputValidation.warnings);
    if (execInputValidation.errors.length > 0) {
      return reject(execInputValidation.errors.join(' '));
    }
    const outcomeDeclarationError = validateWorkflowOutcomeDeclaration(workflow);
    if (outcomeDeclarationError !== null) return reject(outcomeDeclarationError);
    const runBudgetShapeError = validateRunBudgetShape(workflow);
    if (runBudgetShapeError !== null) return reject(runBudgetShapeError);

    return {
      workflow,
      error: null,
      warnings: parseWarnings,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    // Debug for the same reason as the validation failures above: the returned
    // parse_error is what the author sees, and discovery re-parses on every command.
    getLog().debug(
      {
        err,
        filename,
        lineInfo: lineInfo || undefined,
        contentPreview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
      },
      'workflow_parse_failed'
    );
    return {
      workflow: null,
      error: {
        filename,
        error: `YAML parse error${lineInfo}: ${err.message}`,
        errorType: 'parse_error',
      },
    };
  }
}
