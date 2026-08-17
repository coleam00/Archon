/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import type { WorkflowDefinition, WorkflowLoadError, DagNode, WorkflowNodeHooks } from './schemas';
import {
  isBashNode,
  isLoopNode,
  isLoopGroupNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isIncludeNode,
  isWorkflowNode,
  isPersistableNode,
} from './schemas';
import { createLogger } from '@archon/paths';
import {
  isRegisteredProvider,
  getRegisteredProviders,
  getProviderCapabilities,
} from '@archon/providers';
import {
  dagNodeSchema,
  BASH_NODE_AI_FIELDS,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  KNOWN_DAG_NODE_KEYS,
  KNOWN_NODE_NESTED_KEYS,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
  betasSchema,
} from './schemas/dag-node';
import type { NestedKeySpec } from './schemas/dag-node';
import {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  workflowInputSpecSchema,
  KNOWN_WORKFLOW_KEYS,
  KNOWN_WORKFLOW_NESTED_KEYS,
  WORKFLOW_ONLY_KEYS,
} from './schemas/workflow';
import type {
  WorkflowRequirement,
  WorkflowEvidencePolicy,
  WorkflowInputSpec,
} from './schemas/workflow';
import { INPUT_NAME_PATTERN, inputEnvKey } from './schemas/dag-node';
import { workflowNodeHooksSchema } from './schemas/hooks';
import { z } from '@hono/zod-openapi';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.loader');
  return cachedLog;
}

/**
 * Parse an optional, schema-validated workflow field with warn-and-drop
 * semantics: a present-but-invalid value is logged and dropped (returns
 * undefined) rather than rejecting the whole workflow, so a typo in one field
 * doesn't abort the discovery pass. Mirrors the policy used for `tags` /
 * `interactive`. `extra` merges into the warning payload (e.g. the list of
 * valid enum options).
 *
 * The return type is inferred from the schema (`z.output<S>`), so
 * preprocess-based schemas (e.g. `thinkingConfigSchema`, whose input is
 * `unknown`) still resolve to their parsed output type rather than their
 * input type. zod v4 removed `ZodTypeDef` as the middle type parameter, so the
 * old `z.ZodType<T, z.ZodTypeDef, unknown>` form no longer compiles.
 */
function parseOptionalField<S extends z.ZodType>(
  raw: unknown,
  schema: S,
  filename: string,
  event: string,
  extra?: Record<string, unknown>
): z.output<S> | undefined {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  if (raw !== undefined) {
    getLog().warn({ filename, value: raw, ...extra }, event);
  }
  return undefined;
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
 * The one shape of a `$nodeId.output` reference. Both scanners below build their own
 * RegExp from it — a `g`-flagged one for the multi-match dangling-ref sweep and a plain one
 * for `fan_out.items` — because a `g` regex carries mutable `lastIndex` and sharing a single
 * instance across call sites is how that turns into skipped matches. Sharing the SOURCE is
 * the part that matters: a second hand-written copy inside a function that already warns
 * "KEEP IN SYNC" is exactly the drift that warning is about.
 */
const OUTPUT_REF_SOURCE = String.raw`\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output`;

/** `when:` also accepts `$nodeId.field` as shorthand for `$nodeId.output.field`. */
const WHEN_REF_SOURCE = String.raw`\$([a-zA-Z_][a-zA-Z0-9_-]*)\.([a-zA-Z_][a-zA-Z0-9_]*)`;

/**
 * The node's `id` for messages, falling back to its 1-based position when the
 * id is missing or blank (the schema reports that separately as an error).
 */
function nodeIdForMessages(raw: unknown, index: number): string {
  const rawId =
    raw !== null && typeof raw === 'object' && 'id' in raw
      ? String((raw as Record<string, unknown>).id)
      : '';
  return rawId.trim() || `#${String(index + 1)}`;
}

/**
 * Guidance for a key the engine drops, appended to the unknown-key warning.
 *
 * `interactive` gets its own text because it is the reported failure (#2213):
 * an author writes it expecting a human gate, the key is dropped, and the run
 * proceeds unattended. Both escapes offered here actually gate — in particular
 * `loop.gate_message` ALONE does not: the executor requires
 * `loop.interactive && loop.gate_message` (dag-executor.ts, `runLoopNode` /
 * `runLoopGroupNode`), so naming only `gate_message` would hand the author a
 * loop with a message and no gate.
 */
function unknownNodeKeyHint(key: string): string {
  if (key === 'interactive') {
    return (
      " Nothing on this node gates. For a human gate, use an 'approval:' node; to gate each" +
      " iteration of a loop, set BOTH 'loop.interactive: true' and 'loop.gate_message'" +
      " ('gate_message' on its own does not gate). Workflow-level 'interactive:' is a" +
      ' different setting, and only on the web UI — it keeps the run in the foreground' +
      ' there; chat platforms already run in the foreground, so it does nothing for them.'
    );
  }
  if (WORKFLOW_ONLY_KEYS.has(key)) {
    return ` ('${key}' is valid at workflow level, not on individual nodes.)`;
  }
  return '';
}

/**
 * Record one unknown-key warning, both for callers and for the run-time log.
 *
 * `id` is the bare node or workflow id — a stable value a log consumer can
 * filter on. `label` is its human rendering (it may carry a breadcrumb, e.g.
 * `Node 'refine' → loop_group node 'check'`) and appears only inside the
 * message prose, never as a structured field.
 */
function pushUnknownKeyWarning(
  id: string,
  label: string,
  key: string,
  hint: string,
  event: string,
  warnings: string[]
): void {
  const message = `${label}: unknown key '${key}' will be ignored.${hint}`;
  warnings.push(message);
  // Carry the prose, not just the payload: the run path (`archon workflow run`)
  // reads this log line and never reads the warning string (#2213).
  getLog().warn({ id, key, warning: message }, event);
}

/**
 * Warn about keys Zod silently stripped from a nested config object, recursing
 * through the sub-objects `spec` describes. `keyPath` is the dotted prefix that
 * locates the key inside the node (e.g. `approval.on_reject.`).
 */
function collectUnknownConfigKeys(
  raw: unknown,
  spec: NestedKeySpec,
  id: string,
  label: string,
  keyPath: string,
  event: string,
  warnings: string[]
): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;

  if (spec.kind === 'record') {
    for (const [entryKey, entryValue] of Object.entries(obj)) {
      collectUnknownConfigKeys(
        entryValue,
        spec.entry,
        id,
        label,
        `${keyPath}${entryKey}.`,
        event,
        warnings
      );
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    if (!spec.keys.has(key)) {
      pushUnknownKeyWarning(id, label, `${keyPath}${key}`, '', event, warnings);
      continue;
    }
    const child = spec.children?.get(key);
    if (child) {
      collectUnknownConfigKeys(obj[key], child, id, label, `${keyPath}${key}.`, event, warnings);
    }
  }
}

/**
 * Warn about unknown keys on a raw node that Zod silently stripped (#2213).
 * Catches misplaced workflow-level keys (`interactive:` on a command node),
 * typos (`contxt:` instead of `context:`), and the same mistakes one level down
 * inside `approval:` / `retry:` / `loop:` / `agents:`.
 *
 * Recurses into a `loop_group` body: those entries are full DAG nodes parsed by
 * the same schema, so they strip unknown keys just as silently — and a body node
 * is exactly where an `interactive: true` gate is most likely to be attempted.
 */
function collectUnknownNodeKeys(raw: unknown, id: string, label: string, warnings: string[]): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_DAG_NODE_KEYS.has(key)) {
      pushUnknownKeyWarning(
        id,
        label,
        key,
        unknownNodeKeyHint(key),
        'node_unknown_key_ignored',
        warnings
      );
      continue;
    }
    const nested = KNOWN_NODE_NESTED_KEYS.get(key);
    if (nested) {
      collectUnknownConfigKeys(
        obj[key],
        nested,
        id,
        label,
        `${key}.`,
        'node_unknown_key_ignored',
        warnings
      );
    }
  }

  const group = obj.loop_group;
  if (group === null || typeof group !== 'object' || Array.isArray(group)) return;
  const body = (group as Record<string, unknown>).nodes;
  if (!Array.isArray(body)) return;
  body.forEach((bodyNode: unknown, i: number) => {
    const bodyId = nodeIdForMessages(bodyNode, i);
    collectUnknownNodeKeys(bodyNode, bodyId, `${label} → loop_group node '${bodyId}'`, warnings);
  });
}

/**
 * Validate and parse a single DagNode from raw YAML data.
 * Replaces the former parseDagNode + parseRetryConfig + parseToolList +
 * parseNodeHooks + parseIdleTimeout functions.
 */
function parseDagNode(
  raw: unknown,
  index: number,
  errors: string[],
  warnings: string[]
): DagNode | null {
  // Extract id early for error messages (may be empty/invalid — schema will catch it)
  const id = nodeIdForMessages(raw, index);

  const result = dagNodeSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(formatNodeIssue(id, issue));
    }
    return null;
  }

  const node = result.data;

  collectUnknownNodeKeys(raw, id, `Node '${id}'`, warnings);

  // Warn about AI-specific fields on non-AI nodes (runtime behavior, not schema errors)
  let nonAiNode: { type: string; fields: readonly string[] } | undefined;
  if (isCancelNode(node)) {
    nonAiNode = { type: 'cancel', fields: BASH_NODE_AI_FIELDS };
  } else if (isIncludeNode(node)) {
    nonAiNode = { type: 'include', fields: INCLUDE_NODE_IGNORED_FIELDS };
  } else if (isWorkflowNode(node)) {
    nonAiNode = { type: 'workflow', fields: WORKFLOW_NODE_IGNORED_FIELDS };
  } else if (isApprovalNode(node)) {
    nonAiNode = { type: 'approval', fields: BASH_NODE_AI_FIELDS };
  } else if (isLoopNode(node)) {
    nonAiNode = { type: 'loop', fields: LOOP_NODE_AI_FIELDS };
  } else if (isLoopGroupNode(node)) {
    nonAiNode = { type: 'loop_group', fields: LOOP_GROUP_NODE_AI_FIELDS };
  } else if (isScriptNode(node)) {
    nonAiNode = { type: 'script', fields: SCRIPT_NODE_AI_FIELDS };
  } else if ('bash' in node && typeof node.bash === 'string') {
    nonAiNode = { type: 'bash', fields: BASH_NODE_AI_FIELDS };
  }
  if (nonAiNode) {
    const presentAiFields = nonAiNode.fields.filter(
      f => (raw as Record<string, unknown>)[f] !== undefined
    );
    if (presentAiFields.length > 0) {
      getLog().warn(
        { id: node.id, fields: presentAiFields },
        `${nonAiNode.type}_node_ai_fields_ignored`
      );
    }
  }

  return node;
}

/**
 * Validate DAG structure: unique IDs, depends_on references exist, no cycles,
 * and every runtime-substituted node-output reference points to a known node in its
 * current or enclosing loop scope.
 * Returns error message or null if valid.
 *
 * Exported so the include-expander can re-run the same structural checks on the
 * fully-flattened, namespaced node list after inlining (duplicate-id collisions,
 * cycles introduced by rewired edges, unknown deps).
 */
export function validateDagStructure(
  nodes: DagNode[],
  enclosingIds?: ReadonlySet<string>
): string | null {
  // Check ID uniqueness
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      return `Duplicate node id: '${node.id}'`;
    }
    // A loop_group body node must not reuse an enclosing DAG's node id: the executor
    // seeds each iteration's scoped output map with the outer outputs, so a colliding
    // body node would silently shadow the outer node for $id.output refs.
    if (enclosingIds?.has(node.id)) {
      return `Node id '${node.id}' shadows a node id in the enclosing DAG`;
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

  // Check $nodeId.output references across every public YAML field the executor substitutes at
  // runtime: when:, and the text surfaces that flow through substituteNodeOutputRefs
  // (prompt, bash, script, approval.message/on_reject.prompt, cancel, loop.prompt,
  // loop.until_bash, loop_group.until_bash, workflow.input/with/fan_out.items). A dangling
  // ref in any of them can bind the wrong flat-DAG output or fail at run time, so all must
  // be validated here.
  //
  // KEEP IN SYNC (public runtime node-ref surfaces):
  //   1. this scan (loader validateDagStructure) — validates refs,
  //   2. rewriteNodeOutputRefs (include-expander.ts) — renames refs on inline,
  //   3. the substituteNodeOutputRefs call sites (dag-executor.ts) — resolves refs at run,
  // Adding a substituted field to one means updating all three. Included loop-command
  // bodies are validated separately while materialized, then rewritten by (2).
  // applyInputsMacro is intentionally a superset because some AI configuration strings
  // accept include inputs without being runtime node-ref surfaces.
  //
  // Runtime substitution is syntax-agnostic: canonical refs inside Markdown fences and
  // inline code are live too. Validation therefore scans every surface verbatim.
  const outputRefPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
  const whenRefPattern = new RegExp(WHEN_REF_SOURCE, 'g');
  for (const node of nodes) {
    const sources: { field: string; text: string }[] = [];
    if ('prompt' in node && typeof node.prompt === 'string') {
      sources.push({ field: 'prompt', text: node.prompt });
    }
    if (isBashNode(node)) sources.push({ field: 'bash', text: node.bash });
    if (isScriptNode(node)) sources.push({ field: 'script', text: node.script });
    // workflow.input is a live ref surface (a data string), scanned verbatim like
    // bash/script — not prose, so no markdown stripping. workflow.fan_out.items (slice
    // 2, PR-C) is a live `$node.output` ref to a JSON array — scanned the same way.
    if (isWorkflowNode(node)) {
      if (node.input) sources.push({ field: 'input', text: node.input });
      if (node.fan_out) sources.push({ field: 'fan_out.items', text: node.fan_out.items });
      // A `workflow:` node's `with:` values (#2470) are live ref surfaces: unlike
      // an `include:` node's `with:` (inlined by the macro and caught post-expansion
      // by this same scan), sub-run `with:` values are never inlined — they resolve
      // at runtime into `$INPUTS.<name>` — so scan them here for dangling refs.
      if (node.with) {
        for (const [name, value] of Object.entries(node.with)) {
          sources.push({ field: `with.${name}`, text: value });
        }
      }
    }
    if (isCancelNode(node)) sources.push({ field: 'cancel', text: node.cancel });
    if (isApprovalNode(node)) {
      sources.push({ field: 'approval.message', text: node.approval.message });
      if (node.approval.on_reject !== undefined) {
        sources.push({
          field: 'approval.on_reject.prompt',
          text: node.approval.on_reject.prompt,
        });
      }
    }
    if (isLoopNode(node)) {
      if (typeof node.loop.prompt === 'string') {
        sources.push({ field: 'loop.prompt', text: node.loop.prompt });
      }
      if (node.loop.until_bash) {
        sources.push({ field: 'loop.until_bash', text: node.loop.until_bash });
      }
    }
    if (isLoopGroupNode(node) && node.loop_group.until_bash) {
      sources.push({ field: 'loop_group.until_bash', text: node.loop_group.until_bash });
    }
    for (const source of sources) {
      let m: RegExpExecArray | null;
      outputRefPattern.lastIndex = 0; // reset stateful g-flag regex before each new source string
      while ((m = outputRefPattern.exec(source.text)) !== null) {
        const refNodeId = m[1];
        // `$INPUTS.name` is an input macro. In particular, `$INPUTS.output` also
        // matches the canonical node-ref grammar, so the macro must take precedence.
        if (refNodeId === 'INPUTS') continue;
        // Output refs (unlike depends_on) may also reach ENCLOSING-scope nodes: the
        // executor seeds a loop_group iteration's scoped output map with the outer
        // DAG's outputs, so `$outerNode.output` inside a body prompt is valid.
        if (refNodeId !== undefined && !ids.has(refNodeId) && !enclosingIds?.has(refNodeId)) {
          return `Node '${node.id}' field '${source.field}' references unknown node '$${refNodeId}.output'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
        }
      }
    }

    if (node.when !== undefined) {
      let m: RegExpExecArray | null;
      whenRefPattern.lastIndex = 0;
      while ((m = whenRefPattern.exec(node.when)) !== null) {
        const refNodeId = m[1];
        const field = m[2];
        // `$INPUTS.name` is an include-time macro, not a node reference. It is
        // resolved (or rejected as missing) before the composed graph is revalidated.
        if (refNodeId === 'INPUTS') continue;
        if (refNodeId !== undefined && !ids.has(refNodeId) && !enclosingIds?.has(refNodeId)) {
          return `Node '${node.id}' field 'when' references unknown node '$${refNodeId}.${field ?? ''}'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
        }
      }
    }
  }

  // fan_out.items (slice 2, PR-C) must reference the output of a node that is a
  // TRANSITIVE dependency of the fan-out node — so the item array is guaranteed
  // produced before the node expands. A same-layer or downstream producer would race
  // (the ref resolves to nothing → the node fails closed at run time); catch it at
  // load time with an actionable message instead. A literal `items` with no `$…output`
  // ref is left to the runtime fail-closed check (it must still parse to an array).
  const directDeps = new Map<string, string[]>(nodes.map(n => [n.id, n.depends_on ?? []]));
  const transitiveDepsOf = (nodeId: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(directDeps.get(nodeId) ?? [])];
    while (stack.length > 0) {
      const dep = stack.pop();
      if (dep === undefined || seen.has(dep)) continue;
      seen.add(dep);
      stack.push(...(directDeps.get(dep) ?? []));
    }
    return seen;
  };
  for (const node of nodes) {
    if (!isWorkflowNode(node) || !node.fan_out) continue;
    const refMatch = new RegExp(OUTPUT_REF_SOURCE).exec(node.fan_out.items);
    const producerId = refMatch?.[1];
    if (producerId === undefined) continue; // no ref surface — runtime fail-closed owns it
    if (!transitiveDepsOf(node.id).has(producerId)) {
      return `Node '${node.id}' fan_out.items references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so its item array is produced first`;
    }
  }

  // Recursively validate loop_group bodies as scoped sub-DAGs. A loop_group body is
  // sealed for GRAPH edges: its depends_on edges resolve within the body (not the
  // outer DAG), and the body is itself a DAG (unique ids, no cycles). $nodeId.output
  // refs are wider — the accumulated enclosing-scope ids are passed down so body
  // prompts may reference outer nodes (mirrors the executor seeding the scoped output
  // map with outer outputs). Nested loop_groups recurse naturally, accumulating scope.
  // Outer-DAG cycle/depends_on checks above operate on the flattened top-level node
  // list and treat each loop_group as one outer node.
  for (const node of nodes) {
    if (isLoopGroupNode(node)) {
      // `include` inside a loop_group body is rejected in v1 (bounds the interaction
      // surface — see the plan's NOT Building). An include is a load-time inlining
      // directive; nesting it inside a per-iteration sub-DAG body is not yet supported.
      const includeInBody = node.loop_group.nodes.find(isIncludeNode);
      if (includeInBody) {
        return `loop_group '${node.id}' body: 'include' is not supported inside a loop_group body`;
      }
      // `workflow:` (sub-run) inside a loop_group body is rejected (bounds the
      // interaction surface — see the plan's NOT Building). This wholesale rejection
      // also covers a fan-out (`fan_out:`) workflow node in a loop_group body (slice 2,
      // PR-C): a fan-out is a `workflow:` node, so nesting it per-iteration is likewise
      // out of scope.
      const workflowInBody = node.loop_group.nodes.find(isWorkflowNode);
      if (workflowInBody) {
        return `loop_group '${node.id}' body: 'workflow' (sub-run) is not supported inside a loop_group body`;
      }
      const scopeIds = new Set([...(enclosingIds ?? []), ...ids]);
      const bodyError = validateDagStructure(node.loop_group.nodes, scopeIds);
      if (bodyError) {
        return `loop_group '${node.id}' body: ${bodyError}`;
      }
    }
  }

  return null; // valid
}

export type ParseResult =
  | { workflow: WorkflowDefinition; error: null; warnings: string[] }
  | { workflow: null; error: WorkflowLoadError; warnings?: never };

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
    const parseWarnings: string[] = [];
    const dagNodes = (raw.nodes as unknown[])
      .map((n: unknown, i: number) => parseDagNode(n, i, validationErrors, parseWarnings))
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

    // Validate provider identity at load time, both at the workflow level and
    // per node. Model strings are NOT validated — they pass through to the SDK
    // at run time, which is the source of truth for what model names exist
    // (vendor SDKs ship new models faster than Archon can update).
    if (provider && !isRegisteredProvider(provider)) {
      return {
        workflow: null,
        error: {
          filename,
          error: `Unknown provider '${provider}'. Registered: ${getRegisteredProviders()
            .map(p => p.id)
            .join(', ')}`,
          errorType: 'validation_error',
        },
      };
    }
    for (const node of dagNodes) {
      if (node.provider !== undefined && !isRegisteredProvider(node.provider)) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}': unknown provider '${node.provider}'. Registered: ${getRegisteredProviders()
              .map(p => p.id)
              .join(', ')}`,
            errorType: 'validation_error',
          },
        };
      }
    }

    // persist_session capability gating: when the effective provider is known at
    // load time (explicit at node or workflow level), reject the workflow if the
    // provider doesn't support session resume. When the provider is implicit (set
    // via .archon/config.yaml defaults), the check defers to runtime in
    // dag-executor.
    //
    // Only command + prompt nodes participate in cross-run session persistence today
    // (see `isPersistableNode` for the exclusion list):
    //   - bash / script / approval / cancel nodes don't invoke a provider at all.
    //   - loop nodes manage their own per-iteration session threading; cross-run
    //     persistence for loops isn't wired. `parseDagNode` emits a
    //     `loop_node_ai_fields_ignored` warning when `persist_session` appears on one.
    //   - context:'fresh' nodes explicitly bypass persistence in the executor.
    // Skipping these here prevents false validation failures when a workflow opts
    // in via workflow-level `persist_sessions: true` and contains, e.g., a bash node.
    const workflowPersistSessions = raw.persist_sessions === true;
    for (const node of dagNodes) {
      if (!isPersistableNode(node)) continue;
      if ('context' in node && node.context === 'fresh') continue;

      const nodePersist = 'persist_session' in node ? node.persist_session : undefined;
      const effectivePersist = nodePersist ?? workflowPersistSessions;
      if (!effectivePersist) continue;

      const explicitProvider = ('provider' in node ? node.provider : undefined) ?? provider;
      if (explicitProvider && isRegisteredProvider(explicitProvider)) {
        const caps = getProviderCapabilities(explicitProvider);
        if (!caps.sessionResume) {
          return {
            workflow: null,
            error: {
              filename,
              error: `Node '${node.id}' has persist_session: true but provider '${explicitProvider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`,
              errorType: 'validation_error',
            },
          };
        }
      }
    }

    // Validate modelReasoningEffort / webSearchMode — warn and ignore invalid values.
    const modelReasoningEffort = parseOptionalField(
      raw.modelReasoningEffort,
      modelReasoningEffortSchema,
      filename,
      'invalid_model_reasoning_effort',
      { valid: modelReasoningEffortSchema.options }
    );
    // The deprecation is resolved below, once `effort` has been parsed too —
    // `modelReasoningEffort` is TRANSLATED into it rather than carried forward.
    const webSearchMode = parseOptionalField(
      raw.webSearchMode,
      webSearchModeSchema,
      filename,
      'invalid_web_search_mode',
      { valid: webSearchModeSchema.options }
    );

    const interactive = typeof raw.interactive === 'boolean' ? raw.interactive : undefined;
    if (raw.interactive !== undefined && typeof raw.interactive !== 'boolean') {
      getLog().warn({ filename, value: raw.interactive }, 'invalid_interactive_value_ignored');
    }

    // Warn if any interactive loop node exists in a non-interactive workflow
    // (approval messages won't reach the user in web background runs)
    if (!interactive) {
      // Covers loop: and loop_group: gates, including loops nested inside loop_group bodies.
      const hasInteractiveLoop = (ns: DagNode[]): boolean =>
        ns.some(
          n =>
            (isLoopNode(n) && n.loop.interactive === true) ||
            (isLoopGroupNode(n) &&
              (n.loop_group.interactive === true || hasInteractiveLoop(n.loop_group.nodes)))
        );
      if (hasInteractiveLoop(dagNodes)) {
        getLog().warn({ filename }, 'interactive_loop_in_non_interactive_workflow');
      }
    }

    // Warn (non-blocking) when signal_completes is set without interactive: the flag
    // only changes interactive-gate behavior — a non-interactive loop already
    // completes on the signal, so the author's intent is likely a missing
    // `interactive: true`. The workflow still loads.
    const hasSignalCompletesWithoutInteractive = (ns: DagNode[]): boolean =>
      ns.some(
        n =>
          (isLoopNode(n) && n.loop.signal_completes === true && n.loop.interactive !== true) ||
          (isLoopGroupNode(n) &&
            ((n.loop_group.signal_completes === true && n.loop_group.interactive !== true) ||
              hasSignalCompletesWithoutInteractive(n.loop_group.nodes)))
      );
    if (hasSignalCompletesWithoutInteractive(dagNodes)) {
      getLog().warn({ filename }, 'signal_completes_without_interactive_ignored');
    }

    // Parse workflow-level worktree policy. Same warn-and-ignore pattern used
    // for `interactive` / `modelReasoningEffort` — invalid values are dropped
    // rather than rejected, so a typo in one workflow doesn't nuke the whole
    // discovery pass. Only `worktree.enabled` is recognised today.
    let worktreePolicy: { enabled?: boolean } | undefined;
    if (raw.worktree !== undefined) {
      if (
        typeof raw.worktree === 'object' &&
        raw.worktree !== null &&
        !Array.isArray(raw.worktree)
      ) {
        const rawEnabled = (raw.worktree as Record<string, unknown>).enabled;
        if (typeof rawEnabled === 'boolean') {
          worktreePolicy = { enabled: rawEnabled };
        } else if (rawEnabled !== undefined) {
          getLog().warn({ filename, value: rawEnabled }, 'invalid_worktree_enabled_value_ignored');
        }
      } else {
        getLog().warn({ filename, value: raw.worktree }, 'invalid_worktree_block_ignored');
      }
    }

    // Parse workflow-level container policy (folder-project container backend).
    // Same warn-and-ignore pattern as `worktree`. `enabled` pins the container
    // backend on without `--container`; `write_back` ('approve' | 'auto') chooses
    // whether the finished run's overlay diff pauses for review or applies directly.
    let containerPolicy: { enabled?: boolean; write_back?: 'approve' | 'auto' } | undefined;
    if (raw.container !== undefined) {
      if (
        typeof raw.container === 'object' &&
        raw.container !== null &&
        !Array.isArray(raw.container)
      ) {
        const rawContainer = raw.container as Record<string, unknown>;
        const rawEnabled = rawContainer.enabled;
        const rawWriteBack = rawContainer.write_back;
        const policy: { enabled?: boolean; write_back?: 'approve' | 'auto' } = {};
        if (typeof rawEnabled === 'boolean') {
          policy.enabled = rawEnabled;
        } else if (rawEnabled !== undefined) {
          getLog().warn({ filename, value: rawEnabled }, 'invalid_container_enabled_value_ignored');
        }
        if (rawWriteBack === 'approve' || rawWriteBack === 'auto') {
          policy.write_back = rawWriteBack;
        } else if (rawWriteBack !== undefined) {
          getLog().warn(
            { filename, value: rawWriteBack },
            'invalid_container_write_back_value_ignored'
          );
        }
        if (policy.enabled !== undefined || policy.write_back !== undefined) {
          containerPolicy = policy;
        }
      } else {
        getLog().warn({ filename, value: raw.container }, 'invalid_container_block_ignored');
      }
    }

    // Parse workflow-level evidence policy (#2230). Unlike the worktree/container
    // convenience policies, a malformed block REJECTS the workflow instead of
    // warn-and-ignore: silently dropping a declared terminal-success gate would
    // let a run complete ungated — not fail-safe. Same hard-reject posture as
    // unknown-provider and persist_session capability validation above.
    let evidencePolicy: WorkflowEvidencePolicy | undefined;
    if (raw.evidence_policy !== undefined) {
      const parsedEvidence = workflowEvidencePolicySchema.safeParse(raw.evidence_policy);
      if (!parsedEvidence.success) {
        return {
          workflow: null,
          error: {
            filename,
            error:
              "Invalid evidence_policy: expected { required: boolean }. When required is true, the run is refused terminal 'completed' unless $ARTIFACTS_DIR/evidence.json exists.",
            errorType: 'validation_error',
          },
        };
      }
      evidencePolicy = parsedEvidence.data;
    }

    // Parse mutates_checkout — boolean, omitted means true (run the path-lock guard).
    // Same parse/warn pattern as `interactive` (invalid non-boolean values are dropped).
    // When false, the executor skips the path-lock guard and allows concurrent runs on the same checkout.
    let mutatesCheckout: boolean | undefined;
    if (raw.mutates_checkout !== undefined) {
      if (typeof raw.mutates_checkout === 'boolean') {
        mutatesCheckout = raw.mutates_checkout;
      } else {
        getLog().warn(
          { filename, value: raw.mutates_checkout },
          'invalid_mutates_checkout_value_ignored'
        );
      }
    }

    // Parse optional tags — type-narrow, trim, and dedupe so authors can't
    // ship ["GitLab", "GitLab ", "gitlab"] as three distinct values.
    // An explicit empty array is preserved (suppresses keyword inference in the
    // UI); an absent or invalid block leaves `tags` undefined (falls back to
    // inference). Same warn-and-ignore pattern as the worktree block above.
    let tags: string[] | undefined;
    if (Array.isArray(raw.tags)) {
      tags = [
        ...new Set(
          raw.tags
            .filter((t): t is string => typeof t === 'string')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        ),
      ];
    } else if (raw.tags !== undefined) {
      getLog().warn({ filename, value: raw.tags }, 'invalid_tags_block_ignored');
    }

    // Parse optional requires — the external-capability enum list (today only
    // `github`) that hard-blocks invocation when the originating user hasn't connected
    // that identity (see assertWorkflowRequirementsMet). Same warn-and-drop policy as
    // `tags`: invalid entries are dropped with a warning; an absent/empty list leaves
    // `requires` undefined. Without this block the field is silently discarded here and
    // the capability gate can never fire for a discovered workflow.
    let requires: WorkflowRequirement[] | undefined;
    if (Array.isArray(raw.requires)) {
      const valid: WorkflowRequirement[] = [];
      for (const entry of raw.requires) {
        const parsed = workflowRequirementSchema.safeParse(entry);
        if (parsed.success) valid.push(parsed.data);
        else getLog().warn({ filename, value: entry }, 'invalid_workflow_requires_entry_ignored');
      }
      const deduped = [...new Set(valid)];
      if (deduped.length > 0) requires = deduped;
    } else if (raw.requires !== undefined) {
      getLog().warn({ filename, value: raw.requires }, 'invalid_workflow_requires_block_ignored');
    }

    // Parse optional inputs — the declared signature (#2470). Per-key warn-and-drop:
    // an invalid spec, a non-identifier name (env mangling needs identifier names), or
    // a contradictory `required: true` + `default:` pair is dropped with a warning. The
    // surviving record is set only when non-empty. Absent/invalid block leaves `inputs`
    // undefined — a workflow with no declared inputs keeps Phase-1 behaviour untouched.
    let inputs: Record<string, WorkflowInputSpec> | undefined;
    const rawInputs = raw.inputs;
    if (rawInputs !== undefined) {
      if (
        typeof rawInputs === 'object' &&
        rawInputs !== null &&
        !Array.isArray(rawInputs) &&
        (Object.getPrototypeOf(rawInputs) === Object.prototype ||
          Object.getPrototypeOf(rawInputs) === null)
      ) {
        const valid: Record<string, WorkflowInputSpec> = {};
        for (const [name, spec] of Object.entries(rawInputs as Record<string, unknown>)) {
          if (!INPUT_NAME_PATTERN.test(name)) {
            getLog().warn({ filename, name }, 'invalid_workflow_input_name_ignored');
            continue;
          }
          const parsed = workflowInputSpecSchema.safeParse(spec);
          if (!parsed.success) {
            getLog().warn({ filename, name, value: spec }, 'invalid_workflow_input_spec_ignored');
            continue;
          }
          if (parsed.data.required === true && parsed.data.default !== undefined) {
            getLog().warn(
              { filename, name },
              'contradictory_workflow_input_required_with_default_ignored'
            );
            continue;
          }
          valid[name] = parsed.data;
        }
        // Reject env-key mangling collisions: two names that fold to the same
        // INPUTS_<UPPER_SNAKE> env key would silently clobber each other for
        // bash/script sub-run nodes (Task 17). Catch it here where all names are
        // visible; a colliding pair is a hard load error, not a warn-and-drop.
        const envKeyOwners = new Map<string, string>();
        for (const name of Object.keys(valid)) {
          const envKey = inputEnvKey(name);
          const existing = envKeyOwners.get(envKey);
          if (existing !== undefined) {
            return {
              workflow: null,
              error: {
                filename,
                error: `Workflow inputs '${existing}' and '${name}' both map to env var '${envKey}' — rename one so each input has a unique env key`,
                errorType: 'validation_error',
              },
            };
          }
          envKeyOwners.set(envKey, name);
        }
        if (Object.keys(valid).length > 0) inputs = valid;
      } else {
        getLog().warn({ filename, value: rawInputs }, 'invalid_workflow_inputs_block_ignored');
      }
    }

    // Parse optional returns — the node id whose output IS this workflow's result
    // (#2470). Accept a non-empty string; reject every other present value. Silently
    // dropping an invalid selector would change the workflow result by falling back to
    // positional sink selection. The referenced id
    // must name a top-level node — checked below once dagNodes is assembled.
    let returns: string | undefined;
    if (typeof raw.returns === 'string' && raw.returns.trim().length > 0) {
      returns = raw.returns.trim();
    } else if (raw.returns !== undefined) {
      getLog().warn({ filename, value: raw.returns }, 'invalid_workflow_returns_value_rejected');
      return {
        workflow: null,
        error: {
          filename,
          error:
            "Invalid 'returns': expected the non-empty id of a top-level node whose output is this workflow's result",
          errorType: 'validation_error',
        },
      };
    }
    // `returns` must name a top-level node id. Done here (not in validateDagStructure,
    // which takes nodes and is reused for loop_group bodies / the expander with no
    // `returns` in scope) now that dagNodes is computed.
    if (returns !== undefined && !dagNodes.some(n => n.id === returns)) {
      return {
        workflow: null,
        error: {
          filename,
          error: `Workflow declares returns: '${returns}' but no top-level node has that id`,
          errorType: 'validation_error',
        },
      };
    }

    // Parse workflow-level fallback fields. Same warn-and-drop pattern as
    // `modelReasoningEffort` / `webSearchMode` above. These are declared on
    // `workflowBaseSchema` and consumed by the DAG executor's
    // `workflowLevelOptions` (the object literal at the top of
    // `executeDagWorkflow`, reading `workflow.effort` etc.) as defaults that
    // per-node options inherit when unset. Without this block, a workflow YAML
    // that sets e.g. `effort: high` at the root would be dropped here and the
    // executor would read undefined, so a node without its own `effort` would
    // never inherit the workflow-level default.
    const declaredEffort = parseOptionalField(
      raw.effort,
      effortLevelSchema,
      filename,
      'invalid_workflow_effort_value_ignored',
      { valid: effortLevelSchema.options }
    );

    // Deprecated by #2556: `modelReasoningEffort:` was a second, Codex-only
    // spelling of reasoning depth. It is TRANSLATED into `effort:` here rather
    // than carried onto the workflow, so nothing downstream ever sees it.
    //
    // Translating at load time (rather than honouring it at execution time) is
    // what makes the deprecation terminal instead of indefinite: `effort:` has a
    // node-level counterpart and `modelReasoningEffort:` does not, so any pass
    // that collapses workflow-level config onto nodes — #1764's Task 1 — can
    // handle the translated form and could never have handled the original.
    //
    // Every `modelReasoningEffort` value is a valid `effort` rung, so the
    // translation is total. When both are declared, `effort:` wins and the old
    // field is dropped: the loader cannot know which nodes resolve to Codex, so
    // preserving the old field's Codex-only precedence is not expressible here.
    const effort = declaredEffort ?? modelReasoningEffort;
    if (modelReasoningEffort !== undefined) {
      const message =
        declaredEffort === undefined
          ? `Workflow '${raw.name}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and ` +
            `has been applied as 'effort: ${modelReasoningEffort}'. Write 'effort:' instead — it applies ` +
            'on every provider that has a reasoning control, and can be set per node.'
          : `Workflow '${raw.name}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and was ` +
            `IGNORED because this workflow also declares 'effort: ${declaredEffort}', which now applies on ` +
            "every provider including Codex. Delete the 'modelReasoningEffort:' line.";
      parseWarnings.push(message);
      // Carry the prose, not just the payload: the run path reads this log line
      // and never reads the warning string (#2213).
      getLog().warn({ filename, warning: message }, 'workflow_model_reasoning_effort_deprecated');
    }
    const thinking = parseOptionalField(
      raw.thinking,
      thinkingConfigSchema,
      filename,
      'invalid_workflow_thinking_value_ignored'
    );
    const sandbox = parseOptionalField(
      raw.sandbox,
      sandboxSettingsSchema,
      filename,
      'invalid_workflow_sandbox_value_ignored'
    );

    // fallbackModel: non-empty trimmed string. Inline trim rather than
    // `safeParse` so a stray surrounding space is normalised rather than rejected.
    const fallbackModelTrimmed =
      typeof raw.fallbackModel === 'string' ? raw.fallbackModel.trim() : '';
    const fallbackModel = fallbackModelTrimmed.length > 0 ? fallbackModelTrimmed : undefined;
    if (raw.fallbackModel !== undefined && fallbackModel === undefined) {
      getLog().warn(
        { filename, value: raw.fallbackModel, expected: 'non-empty string' },
        'invalid_workflow_fallback_model_value_ignored'
      );
    }

    // betas: trim, drop empties, then validate the cleaned list through
    // `betasSchema` (non-empty array of non-empty strings). An empty result
    // drops the field entirely — the Claude SDK expects a populated beta header
    // or none at all. The schema's `.nonempty()` enforces non-emptiness at
    // runtime, so the cleaned list reaches the SDK validated without a cast.
    let betas: string[] | undefined;
    if (raw.betas !== undefined) {
      const cleaned = Array.isArray(raw.betas)
        ? raw.betas
            .filter((b): b is string => typeof b === 'string')
            .map(b => b.trim())
            .filter(b => b.length > 0)
        : [];
      const betasResult = betasSchema.safeParse(cleaned);
      if (betasResult.success) {
        betas = betasResult.data;
      } else {
        getLog().warn({ filename, value: raw.betas }, 'invalid_workflow_betas_value_ignored');
      }
    }

    // Detect unknown workflow-level keys, and unknown keys inside the nested
    // workflow-level configs (#2213)
    const workflowName = raw.name;
    const workflowLabel = `Workflow '${workflowName}'`;
    for (const key of Object.keys(raw)) {
      if (!KNOWN_WORKFLOW_KEYS.has(key)) {
        const hint = KNOWN_DAG_NODE_KEYS.has(key)
          ? ` ('${key}' is valid on individual nodes, not at workflow level.)`
          : '';
        pushUnknownKeyWarning(
          workflowName,
          workflowLabel,
          key,
          hint,
          'workflow_unknown_key_ignored',
          parseWarnings
        );
        continue;
      }
      const nested = KNOWN_WORKFLOW_NESTED_KEYS.get(key);
      if (nested) {
        collectUnknownConfigKeys(
          raw[key],
          nested,
          workflowName,
          workflowLabel,
          `${key}.`,
          'workflow_unknown_key_ignored',
          parseWarnings
        );
      }
    }

    return {
      workflow: {
        name: raw.name,
        description: raw.description,
        provider,
        model,
        // `modelReasoningEffort` is deliberately absent — it was translated into
        // `effort` above, so nothing downstream ever sees the deprecated field.
        webSearchMode,
        interactive,
        ...(mutatesCheckout !== undefined ? { mutates_checkout: mutatesCheckout } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(fallbackModel !== undefined ? { fallbackModel } : {}),
        ...(betas !== undefined ? { betas } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
        ...(workflowPersistSessions ? { persist_sessions: true } : {}),
        nodes: dagNodes,
        ...(worktreePolicy ? { worktree: worktreePolicy } : {}),
        ...(containerPolicy ? { container: containerPolicy } : {}),
        ...(evidencePolicy !== undefined ? { evidence_policy: evidencePolicy } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(requires !== undefined ? { requires } : {}),
        ...(inputs !== undefined ? { inputs } : {}),
        ...(returns !== undefined ? { returns } : {}),
      },
      error: null,
      warnings: parseWarnings,
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
