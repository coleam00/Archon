/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import type { WorkflowDefinition, WorkflowLoadError, DagNode, WorkflowNodeHooks } from './schemas';
import { isLoopNode, isApprovalNode, isCancelNode, isScriptNode } from './schemas';
import { createLogger } from '@archon/paths';
import { isModelCompatible } from './model-validation';
import { dagNodeSchema, BASH_NODE_AI_FIELDS, SCRIPT_NODE_AI_FIELDS } from './schemas/dag-node';
import { modelReasoningEffortSchema, webSearchModeSchema } from './schemas/workflow';
import { workflowNodeHooksSchema } from './schemas/hooks';
import { z } from '@hono/zod-openapi';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.loader');
  return cachedLog;
}

/**
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

/**
 * Format a Zod validation error issue into a human-readable string for a named node.
 */
function formatNodeIssue(id: string, issue: z.ZodIssue): string {
  const pathStr = issue.path.length > 0 ? `'${issue.path.join('.')}' ` : '';
  return `Node '${id}': ${pathStr}${issue.message}`;
}

/**
 * Validate and parse a single DagNode from raw YAML data.
 * Replaces the former parseDagNode + parseRetryConfig + parseToolList +
 * parseNodeHooks + parseIdleTimeout functions.
 */
function parseDagNode(raw: unknown, index: number, errors: string[]): DagNode | null {
  // Extract id early for error messages (may be empty/invalid — schema will catch it)
  const rawId =
    raw !== null && typeof raw === 'object' && 'id' in raw
      ? String((raw as Record<string, unknown>).id)
      : '';
  const id = rawId.trim() || `#${String(index + 1)}`;

  const result = dagNodeSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(formatNodeIssue(id, issue));
    }
    return null;
  }

  const node = result.data;

  // Warn about AI-specific fields on non-AI nodes (runtime behavior, not schema errors)
  const isNonAiNode =
    ('bash' in node && typeof node.bash === 'string') ||
    isScriptNode(node) ||
    isLoopNode(node) ||
    isApprovalNode(node) ||
    isCancelNode(node);
  if (isNonAiNode) {
    let nodeType: string;
    if (isCancelNode(node)) {
      nodeType = 'cancel';
    } else if (isApprovalNode(node)) {
      nodeType = 'approval';
    } else if (isLoopNode(node)) {
      nodeType = 'loop';
    } else if (isScriptNode(node)) {
      nodeType = 'script';
    } else {
      nodeType = 'bash';
    }
    const aiFields = isScriptNode(node) ? SCRIPT_NODE_AI_FIELDS : BASH_NODE_AI_FIELDS;
    const presentAiFields = aiFields.filter(f => (raw as Record<string, unknown>)[f] !== undefined);
    if (presentAiFields.length > 0) {
      getLog().warn({ id: node.id, fields: presentAiFields }, `${nodeType}_node_ai_fields_ignored`);
    }
  }

  return node;
}

/**
 * Validate DAG structure: unique IDs, depends_on references exist, no cycles,
 * and $nodeId.output refs in when:/prompt: fields point to known nodes.
 * Returns error message or null if valid.
 */
function validateDagStructure(nodes: DagNode[]): string | null {
  // Check ID uniqueness
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      return `Duplicate node id: '${node.id}'`;
    }
    ids.add(node.id);
  }

  // Check depends_on references
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!ids.has(dep)) {
        return `Node '${node.id}' depends_on unknown node '${dep}'`;
      }
    }
  }

  // Cycle detection via Kahn's algorithm
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dep of node.depends_on ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(node.id);
      dependents.set(dep, existing);
    }
  }

  const queue = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
  let visited = 0;

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined) break;
    visited++;
    for (const dep of dependents.get(nodeId) ?? []) {
      const newDegree = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) queue.push(dep);
    }
  }

  if (visited < nodes.length) {
    const cycleNodes = nodes.filter(n => (inDegree.get(n.id) ?? 0) > 0).map(n => n.id);
    return `Cycle detected among nodes: ${cycleNodes.join(', ')}`;
  }

  // Check $nodeId.output references in when: and prompt: fields
  const outputRefPattern = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;
  for (const node of nodes) {
    const sources: string[] = [];
    if (node.when) sources.push(node.when);
    if ('prompt' in node && typeof node.prompt === 'string') sources.push(node.prompt);
    if (isLoopNode(node)) {
      sources.push(node.loop.prompt);
    }
    for (const source of sources) {
      let m: RegExpExecArray | null;
      outputRefPattern.lastIndex = 0; // reset stateful g-flag regex before each new source string
      while ((m = outputRefPattern.exec(source)) !== null) {
        const refNodeId = m[1];
        if (refNodeId !== undefined && !ids.has(refNodeId)) {
          return `Node '${node.id}' references unknown node '$${refNodeId}.output'`;
        }
      }
    }
  }

  return null; // valid
}

export type ParseResult =
  | { workflow: WorkflowDefinition; error: null }
  | { workflow: null; error: WorkflowLoadError };

/**
 * Parse and validate a workflow YAML file
 */
export function parseWorkflow(content: string, filename: string): ParseResult {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object') {
      return {
        workflow: null,
        error: {
          filename,
          error: 'YAML file is empty or does not contain an object',
          errorType: 'validation_error',
        },
      };
    }

    if (!raw.name || typeof raw.name !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_name');
      return {
        workflow: null,
        error: { filename, error: "Missing required field 'name'", errorType: 'validation_error' },
      };
    }
    if (!raw.description || typeof raw.description !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_description');
      return {
        workflow: null,
        error: {
          filename,
          error: "Missing required field 'description'",
          errorType: 'validation_error',
        },
      };
    }

    const errors: string[] = [];

    // Reject legacy steps-based workflows
    const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;
    if (hasSteps) {
      errors.push(
        '`steps:` format has been removed. Workflows now use `nodes:` (DAG) format exclusively. Your bundled defaults are already updated — custom workflows need manual migration. See docs/sequential-dag-migration-guide.md for conversion patterns, or run: claude "Read docs/sequential-dag-migration-guide.md then convert .archon/workflows/<file> to nodes: format"'
      );
    }

    const hasNodes = Array.isArray(raw.nodes) && (raw.nodes as unknown[]).length > 0;

    if (errors.length > 0) {
      return {
        workflow: null,
        error: {
          filename,
          error: errors.join('; '),
          errorType: 'validation_error',
        },
      };
    }

    if (!hasNodes) {
      getLog().warn({ filename }, 'workflow_missing_nodes');
      return {
        workflow: null,
        error: {
          filename,
          error: "Workflow must have 'nodes:' configuration",
          errorType: 'validation_error',
        },
      };
    }

    // Parse DAG nodes using dagNodeSchema
    const validationErrors: string[] = [];
    const dagNodes = (raw.nodes as unknown[])
      .map((n: unknown, i: number) => parseDagNode(n, i, validationErrors))
      .filter((n): n is DagNode => n !== null);

    if (dagNodes.length !== (raw.nodes as unknown[]).length) {
      getLog().warn({ filename, validationErrors }, 'dag_node_validation_failed');
      return {
        workflow: null,
        error: {
          filename,
          error: `DAG node validation failed: ${validationErrors.join('; ')}`,
          errorType: 'validation_error',
        },
      };
    }

    const structureError = validateDagStructure(dagNodes);
    if (structureError) {
      getLog().warn({ filename, structureError }, 'dag_structure_invalid');
      return {
        workflow: null,
        error: { filename, error: structureError, errorType: 'validation_error' },
      };
    }

    // Parse workflow-level fields using WorkflowBaseSchema for validation
    // Note: modelReasoningEffort and webSearchMode use warn-and-ignore for invalid values
    // (consistent with original behavior) rather than schema-level rejection.
    const provider =
      typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : undefined;
    const model = typeof raw.model === 'string' ? raw.model : undefined;

    // Validate model/provider compatibility at workflow level
    if (provider && model && !isModelCompatible(provider, model)) {
      return {
        workflow: null,
        error: {
          filename,
          error: `Model "${model}" is not compatible with provider "${provider}"`,
          errorType: 'validation_error',
        },
      };
    }

    // Validate modelReasoningEffort — warn and ignore invalid values (preserve original behavior)
    const modelReasoningEffortResult = modelReasoningEffortSchema.safeParse(
      raw.modelReasoningEffort
    );
    const modelReasoningEffort = modelReasoningEffortResult.success
      ? modelReasoningEffortResult.data
      : undefined;
    if (raw.modelReasoningEffort !== undefined && !modelReasoningEffortResult.success) {
      getLog().warn(
        { filename, value: raw.modelReasoningEffort, valid: modelReasoningEffortSchema.options },
        'invalid_model_reasoning_effort'
      );
    }

    // Validate webSearchMode — warn and ignore invalid values (preserve original behavior)
    const webSearchModeResult = webSearchModeSchema.safeParse(raw.webSearchMode);
    const webSearchMode = webSearchModeResult.success ? webSearchModeResult.data : undefined;
    if (raw.webSearchMode !== undefined && !webSearchModeResult.success) {
      getLog().warn(
        { filename, value: raw.webSearchMode, valid: webSearchModeSchema.options },
        'invalid_web_search_mode'
      );
    }

    // Filter additionalDirectories — warn on non-strings (preserve original behavior)
    const additionalDirectories = Array.isArray(raw.additionalDirectories)
      ? raw.additionalDirectories.filter((d: unknown) => {
          if (typeof d !== 'string') {
            getLog().warn({ filename, value: d }, 'non_string_additional_directory_filtered');
            return false;
          }
          return true;
        })
      : undefined;

    const interactive = typeof raw.interactive === 'boolean' ? raw.interactive : undefined;
    if (raw.interactive !== undefined && typeof raw.interactive !== 'boolean') {
      getLog().warn({ filename, value: raw.interactive }, 'invalid_interactive_value_ignored');
    }

    // Warn if any interactive loop node exists in a non-interactive workflow
    // (approval messages won't reach the user in web background runs)
    if (!interactive) {
      const hasInteractiveLoop = dagNodes.some(n => isLoopNode(n) && n.loop.interactive === true);
      if (hasInteractiveLoop) {
        getLog().warn({ filename }, 'interactive_loop_in_non_interactive_workflow');
      }
    }

    return {
      workflow: {
        name: raw.name,
        description: raw.description,
        provider,
        model,
        modelReasoningEffort,
        webSearchMode,
        additionalDirectories,
        interactive,
        nodes: dagNodes,
      },
      error: null,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    getLog().error(
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

// ---------------------------------------------------------------------------
// parseNodeHooks is preserved as an export for backward compatibility
// (used by hooks.test.ts). The implementation now uses workflowNodeHooksSchema.
// ---------------------------------------------------------------------------

/**
 * Parse and validate per-node hooks from raw YAML input.
 * Uses workflowNodeHooksSchema internally.
 * Returns undefined for absent, empty, or invalid hooks.
 */
export function parseNodeHooks(
  raw: unknown,
  context: { id: string; errors: string[] }
): WorkflowNodeHooks | undefined {
  if (raw === undefined) return undefined;

  const result = workflowNodeHooksSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const pathStr = issue.path.length > 0 ? `'${issue.path.join('.')}' ` : '';
      context.errors.push(`'${context.id}': hooks ${pathStr}${issue.message}`);
    }
    return undefined;
  }

  // Filter out events with empty matcher arrays and return undefined for empty result
  // (preserves original behavior: hooks is only set when there are actual matchers)
  const filtered = Object.fromEntries(
    Object.entries(result.data).filter(
      ([, matchers]) => Array.isArray(matchers) && matchers.length > 0
    )
  ) as WorkflowNodeHooks;

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
