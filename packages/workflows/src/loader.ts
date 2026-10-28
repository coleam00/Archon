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

  if (Object.hasOwn(raw, 'steps')) {
    return '`steps:` format has been removed. Workflows must use `nodes:` (DAG) format. See https://archon.diy/reference/workflow-language/ for the workflow language reference.';
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
  try {
    const raw = parseYaml(content) as Record<string, unknown>;
    return parseWorkflowDocument(raw, filename, providers, configuredEnvNames);
  } catch (error) {
    return yamlParseFailure(filename, error as Error);
  }
}

/** Header, nodes and graph first, then the workflow-level fields, then whole-workflow contracts. */
function parseWorkflowDocument(
  raw: Record<string, unknown>,
  filename: string,
  providers: ProviderRegistry,
  configuredEnvNames: ReadonlySet<string> | undefined
): ParseResult {
  const reject = (error: string): ParseResult => ({
    workflow: null,
    error: { filename, error, errorType: 'validation_error' },
  });

  const header = parseWorkflowHeader(raw, filename);
  if (typeof header === 'string') return reject(header);

  const parsedNodes = parseDagNodes(header.nodes, filename);
  if (typeof parsedNodes === 'string') return reject(parsedNodes);
  const { nodes: dagNodes, warnings: parseWarnings } = parsedNodes;

  const graphError = nodeGraphError(dagNodes, filename);
  if (graphError !== null) return reject(graphError);

  collectConditionalJoinWarnings(dagNodes, parseWarnings);
  collectLegacyPauseWarnings(dagNodes, header.nodes, parseWarnings);
  warnInteractiveDeprecated(raw, header.name, filename, parseWarnings);

  const fields = parseWorkflowFields(
    raw,
    header.name,
    dagNodes,
    filename,
    providers,
    parseWarnings
  );
  if (typeof fields === 'string') return reject(fields);

  collectUnknownWorkflowKeys(raw, header.name, parseWarnings);

  const workflow = buildWorkflowDefinition(header, dagNodes, fields);
  const contractError = workflowContractError(workflow, configuredEnvNames, parseWarnings);
  if (contractError !== null) return reject(contractError);

  return {
    workflow,
    error: null,
    warnings: parseWarnings,
  };
}

function warnInteractiveDeprecated(
  raw: Record<string, unknown>,
  workflowName: string,
  filename: string,
  parseWarnings: string[]
): void {
  if (raw.interactive === undefined) return;
  const message =
    `Workflow '${workflowName}': workflow-level 'interactive:' is deprecated and has no effect. ` +
    'Any workflow can start in the foreground, in the background or from a trigger; a ' +
    'pause waits in the attention queue until it is answered. Remove the line.';
  parseWarnings.push(message);
  getLog().debug({ filename, warning: message }, 'workflow_interactive_deprecated');
}

/** The workflow-level fields, each already validated, before they are assembled. */
interface WorkflowFields {
  readonly provider: string | undefined;
  readonly model: WorkflowDefinition['model'];
  readonly webSearchMode: WorkflowDefinition['webSearchMode'];
  readonly persistSessions: boolean;
  readonly mutatesCheckout: ReturnType<typeof parseMutatesCheckout>;
  readonly effort: ReturnType<typeof resolveEffort>;
  readonly fallbackModel: ReturnType<typeof parseFallbackModel>;
  readonly betas: ReturnType<typeof parseBetas>;
  readonly sandbox: WorkflowDefinition['sandbox'];
  readonly worktree: ReturnType<typeof parseWorktreePolicy>;
  readonly container: ReturnType<typeof parseContainerPolicy>;
  readonly evidencePolicy: WorkflowDefinition['evidence_policy'];
  readonly budget: WorkflowDefinition['budget'];
  readonly tags: ReturnType<typeof parseTags>;
  readonly requires: ReturnType<typeof parseRequires>;
  readonly inputs: WorkflowDefinition['inputs'];
  readonly returns: WorkflowDefinition['returns'];
  readonly outcomeField: WorkflowDefinition['outcome_field'];
  readonly deprecated: WorkflowDefinition['deprecated'];
}

/**
 * Every workflow-level field, or the first error. Fields that are invalid but harmless
 * (`modelReasoningEffort`, `webSearchMode`, `sandbox` and the warn-only parsers) are
 * logged and ignored rather than rejected, as they always were.
 */
function parseWorkflowFields(
  raw: Record<string, unknown>,
  workflowName: string,
  dagNodes: readonly (DagNode | IncludeDirective)[],
  filename: string,
  providers: ProviderRegistry,
  parseWarnings: string[]
): WorkflowFields | string {
  const provider =
    typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : undefined;
  const model = parseWorkflowModel(raw.model);
  if ('error' in model) return model.error;

  const persistSessions = raw.persist_sessions === true;
  const providerError =
    unknownProviderError(provider, dagNodes, providers) ??
    sessionResumeProviderError(dagNodes, provider, providers) ??
    persistSessionError(dagNodes, persistSessions, provider, providers, parseWarnings);
  if (providerError !== null) return providerError;

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

  const worktree = parseWorktreePolicy(raw.worktree, filename);
  const container = parseContainerPolicy(raw.container, filename);
  const evidencePolicy = parseEvidencePolicy(raw.evidence_policy);
  if ('error' in evidencePolicy) return evidencePolicy.error;
  const budget = parseRunBudget(raw.budget);
  if ('error' in budget) return budget.error;
  const deprecated = parseDeprecation(raw.deprecated);
  if ('error' in deprecated) return deprecated.error;
  const mutatesCheckout = parseMutatesCheckout(raw.mutates_checkout, filename);
  const tags = parseTags(raw.tags, filename);
  const requires = parseRequires(raw.requires, filename);
  const inputs = parseInputs(raw.inputs, filename);
  if ('error' in inputs) return inputs.error;
  const returns = parseReturns(raw.returns, dagNodes, filename);
  if ('error' in returns) return returns.error;
  const outcomeField = parseOutcomeField(raw.outcome_field, filename);
  if ('error' in outcomeField) return outcomeField.error;
  const effort = resolveEffort(
    raw.effort,
    modelReasoningEffort,
    workflowName,
    filename,
    parseWarnings
  );
  const sandbox = parseOptionalField(
    raw.sandbox,
    sandboxSettingsSchema,
    filename,
    'invalid_workflow_sandbox_value_ignored'
  );

  return {
    provider,
    model: model.value,
    webSearchMode,
    persistSessions,
    mutatesCheckout,
    effort,
    fallbackModel: parseFallbackModel(raw.fallbackModel, filename),
    betas: parseBetas(raw.betas, filename),
    sandbox,
    worktree,
    container,
    evidencePolicy: evidencePolicy.value,
    budget: budget.value,
    tags,
    requires,
    inputs: inputs.value,
    returns: returns.value,
    outcomeField: outcomeField.value,
    deprecated: deprecated.value,
  };
}

/** Unset optional fields are left out of the definition, except `provider` and `webSearchMode`. */
function buildWorkflowDefinition(
  header: WorkflowHeader,
  dagNodes: (DagNode | IncludeDirective)[],
  fields: WorkflowFields
): WorkflowDefinition {
  return {
    name: header.name,
    description: header.description,
    provider: fields.provider,
    model: fields.model,
    // `modelReasoningEffort` is deliberately absent — it was translated into
    // `effort` by `resolveEffort`, so nothing downstream ever sees the deprecated field.
    webSearchMode: fields.webSearchMode,
    ...executionSettings(fields),
    nodes: dagNodes,
    ...runPolicies(fields),
  };
}

function executionSettings(fields: WorkflowFields): Partial<WorkflowDefinition> {
  return {
    ...(fields.mutatesCheckout !== undefined ? { mutates_checkout: fields.mutatesCheckout } : {}),
    ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
    ...(fields.fallbackModel !== undefined ? { fallbackModel: fields.fallbackModel } : {}),
    ...(fields.betas !== undefined ? { betas: fields.betas } : {}),
    ...(fields.sandbox !== undefined ? { sandbox: fields.sandbox } : {}),
    ...(fields.persistSessions ? { persist_sessions: true } : {}),
  };
}

function runPolicies(fields: WorkflowFields): Partial<WorkflowDefinition> {
  return {
    ...(fields.worktree ? { worktree: fields.worktree } : {}),
    ...(fields.container ? { container: fields.container } : {}),
    ...(fields.evidencePolicy !== undefined ? { evidence_policy: fields.evidencePolicy } : {}),
    ...(fields.budget !== undefined ? { budget: fields.budget } : {}),
    ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
    ...(fields.requires !== undefined ? { requires: fields.requires } : {}),
    ...(fields.inputs !== undefined ? { inputs: fields.inputs } : {}),
    ...(fields.returns !== undefined ? { returns: fields.returns } : {}),
    ...(fields.outcomeField !== undefined ? { outcome_field: fields.outcomeField } : {}),
    ...(fields.deprecated !== undefined ? { deprecated: fields.deprecated } : {}),
  };
}

/** The first error in the contracts that span the whole workflow: exec inputs, outcome, budget. */
function workflowContractError(
  workflow: WorkflowDefinition,
  configuredEnvNames: ReadonlySet<string> | undefined,
  parseWarnings: string[]
): string | null {
  const execInputValidation = validateInlineExecInputs(workflow, configuredEnvNames);
  parseWarnings.push(...execInputValidation.warnings);
  if (execInputValidation.errors.length > 0) return execInputValidation.errors.join(' ');
  return validateWorkflowOutcomeDeclaration(workflow) ?? validateRunBudgetShape(workflow);
}

function yamlParseFailure(filename: string, err: Error): ParseResult {
  // Extract line number from YAML parse errors if available
  const linePattern = /line (\d+)/i;
  const lineMatch = linePattern.exec(err.message);
  const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
  // Debug for the same reason as the validation failures above: the returned
  // parse_error is what the author sees, and discovery re-parses on every command.
  getLog().debug(
    {
      filename,
      lineInfo: lineInfo || undefined,
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
