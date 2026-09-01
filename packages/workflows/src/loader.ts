/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  DagNode,
  IncludeDirective,
  WorkflowNodeHooks,
} from './schemas';
import {
  isExecNode,
  isAgentNode,
  isLoopNode,
  isLoopGroupNode,
  isGateNode,
  isWaitNode,
  isHaltNode,
  isWorkflowNode,
  isIncludeDirective,
  isComposeFanOutNode,
  isPersistableNode,
  isNodeContextResume,
} from './schemas';
import { COMPOSE_FAN_OUT_STEP_MARKER } from './fan-out-identity';
import { createLogger } from '@archon/paths';
import {
  isRegisteredProvider,
  getRegisteredProviders,
  getProviderCapabilities,
} from '@archon/providers';
import {
  dagNodeSchema,
  BASH_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  GATE_AND_HALT_IGNORED_FIELDS,
  WAIT_NODE_IGNORED_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  KNOWN_DAG_NODE_KEYS,
  KNOWN_NODE_NESTED_KEYS,
  effortLevelSchema,
  sandboxSettingsSchema,
  betasSchema,
} from './schemas/dag-node';
import type { NestedKeySpec } from './schemas/dag-node';
import {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  workflowDeprecationSchema,
  workflowInputSpecSchema,
  KNOWN_WORKFLOW_KEYS,
  KNOWN_WORKFLOW_NESTED_KEYS,
  WORKFLOW_ONLY_KEYS,
} from './schemas/workflow';
import type {
  WorkflowRequirement,
  WorkflowEvidencePolicy,
  WorkflowDeprecation,
  WorkflowInputSpec,
} from './schemas/workflow';
import { INPUT_NAME_PATTERN, inputEnvKey } from './schemas/dag-node';
import { workflowNodeHooksSchema } from './schemas/hooks';
import { parseLoopPrevWhenAtom, parseWhenAtom, whenAtoms, WHEN_INPUTS_SCOPE } from './when-atom';
import { declaredFieldsFromSchema, OUTPUT_REF_SOURCE, parseWholeOutputRef } from './output-ref';
import { isBindingDirective } from './schemas/dag-node';
import { readComposedBindings } from './compiled-command';
import { visitNodeTemplateSlots } from './template-walker';
import { validateInlineExecInputs } from './exec-input-validation';
import { z } from '@hono/zod-openapi';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.loader');
  return cachedLog;
}

/**
 * Filenames already warned about an inferred workflow-class declaration this process
 * (#2736/#2738's grace period on `validateWorkflowClassPlacement`). `parseWorkflow` runs
 * on every `/workflow list`, chat turn, and CLI invocation — a permanent process-wide
 * latch keeps the WARN a one-time nudge to the author instead of log spam on a
 * long-running server. Mirrors `hasWarnedLegacyHomePath` in `workflow-discovery.ts`: a
 * plain latch (no in-flight-probe dance) is correct here because `parseWorkflow` is fully
 * synchronous, so no concurrent caller can interleave mid-check. Keyed by the bare
 * filename `parseWorkflow` receives (not a scope-qualified path), so two files sharing a
 * basename across bundled/global/project scopes could under-warn on this channel — a
 * cosmetic log-noise tradeoff only, since `parseWarnings` (the channel the workflow's
 * actual author sees, via `/api/workflows` and `/workflow list`) is pushed unconditionally
 * on every parse regardless of this Set.
 */
const warnedClassPlacementFiles = new Set<string>();
/** Exported for tests that need to observe the warning fire more than once per process. */
export function resetClassPlacementWarningForTests(): void {
  warnedClassPlacementFiles.clear();
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
 * preprocess-based schemas still resolve to their parsed output type rather
 * than their input type. zod v4 removed `ZodTypeDef` as the middle type parameter, so the
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

// OUTPUT_REF_SOURCE — the one shape of a `$nodeId.output` reference — moved to
// output-ref.ts (#2637) so the binding-value whole-ref parser, the schema's directive
// validation, and these scanners share ONE grammar. Both scanners below still build
// their own RegExp from it — a `g`-flagged one for the multi-match dangling-ref sweep
// and a plain one for `fan_out.items` — because a `g` regex carries mutable
// `lastIndex` and sharing a single instance across call sites is how that turns into
// skipped matches.

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
 * Validate the run-level authored-outcome declaration against its selected node.
 *
 * Include aliases are deliberately deferred: `parseWorkflow` can only see the
 * `include:` directive, while `expandWorkflowIncludes` owns rebinding that alias
 * to the flattened child's declared return. The expander calls this same helper
 * on the final flat workflow, where every selected node is executable.
 */
export function validateWorkflowOutcomeDeclaration(
  workflow: Pick<WorkflowDefinition, 'returns' | 'outcome_field'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  }
): string | null {
  const field = workflow.outcome_field;
  if (field === undefined) return null;
  if (workflow.returns === undefined) {
    return `Workflow declares outcome_field: '${field}' without returns: — authored outcome must select a result node explicitly`;
  }

  const selectedNode = workflow.nodes.find(node => node.id === workflow.returns);
  if (selectedNode === undefined) {
    return `Workflow declares returns: '${workflow.returns}' but no top-level node has that id`;
  }
  if (isIncludeDirective(selectedNode)) return null;
  if (isLoopGroupNode(selectedNode)) {
    return `Workflow outcome_field: '${field}' cannot select loop_group node '${workflow.returns}' because loop_group output_format is ignored and its runtime output is raw text; select a schema-enforced collector node instead`;
  }
  if (isWorkflowNode(selectedNode) && selectedNode.fan_out !== undefined) {
    return `Workflow outcome_field: '${field}' cannot select fan-out workflow node '${workflow.returns}' because its runtime output is an aggregate array; select a collector node with a required boolean output instead`;
  }
  if (isComposeFanOutNode(selectedNode)) {
    return `Workflow outcome_field: '${field}' cannot select composed fan-out node '${workflow.returns}' because its runtime output is an aggregate array; select a collector node with a required boolean output instead`;
  }

  const schema = selectedNode.output_format;
  if (schema === undefined) {
    return `Workflow outcome_field: '${field}' selects node '${workflow.returns}', but that node declares no output_format`;
  }
  if (schema.type !== 'object') {
    return `Workflow outcome_field: '${field}' requires node '${workflow.returns}' output_format to declare type: object`;
  }
  const declared = declaredFieldsFromSchema(schema);
  if (!declared?.includes(field)) {
    return `Workflow outcome_field: '${field}' is not declared in node '${workflow.returns}' output_format properties${declared && declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ''}`;
  }
  if (!Array.isArray(schema.required) || !schema.required.includes(field)) {
    return `Workflow outcome_field: '${field}' must be listed in node '${workflow.returns}' output_format.required`;
  }
  const properties = schema.properties as Record<string, unknown>;
  const property = properties[field];
  const propertyType =
    property !== null && typeof property === 'object'
      ? (property as { type?: unknown }).type
      : undefined;
  if (propertyType !== 'boolean') {
    return `Workflow outcome_field: '${field}' on node '${workflow.returns}' must explicitly declare type: boolean`;
  }
  return null;
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
  if (spec.kind === 'array') {
    if (!Array.isArray(raw)) return;
    raw.forEach((entry, i) => {
      collectUnknownConfigKeys(
        entry,
        spec.entry,
        id,
        label,
        `${keyPath}${String(i)}.`,
        event,
        warnings
      );
    });
    return;
  }
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
 * True when `node`, used as a loop_group's body-terminal sink, can itself pause
 * in a way that is invisible one level up (#2753) — either directly (a `gate:`
 * node — the pattern #2707 step 3's escalation handles correctly for its OWN
 * enclosing loop_group, but that escalation is bounded to that one level) or
 * transitively (a `loop:` node with `interactive: true`, the legacy mechanism,
 * or a `loop_group:` node that is itself `interactive: true` or whose own sole
 * terminal sink recurses into this same case, following a chain of well-formed
 * sole-terminal-sink nesting to any depth). A gate that is mid-body or
 * co-terminal with another sink breaks the chain here too — the placement
 * check in `collectGateAndLoopDeprecationWarnings` below already warns about
 * that misplacement on its own. Mirrors `findLoopGroupTerminalGate`'s doc comment
 * (dag-executor.ts:4153-4164): the runtime has no unambiguous way to escalate
 * a pause through a sink that isn't a bare gate, so this only makes that gap
 * visible at load time.
 */
function isUnescalatableInteractiveSink(node: DagNode | IncludeDirective): boolean {
  if (isIncludeDirective(node)) return false;
  if (isGateNode(node)) return true;
  if (isLoopNode(node)) return node.loop.interactive === true;
  if (!isLoopGroupNode(node)) return false;
  if (node.loop_group.interactive === true) return true;
  const dependedOn = new Set(node.loop_group.nodes.flatMap(n => n.depends_on ?? []));
  const sinks = node.loop_group.nodes.filter(n => !dependedOn.has(n.id));
  return sinks.length === 1 && isUnescalatableInteractiveSink(sinks[0]);
}

/**
 * #2707 step 1 grow-then-deprecate warnings: `approval.capture_response`,
 * `approval.on_reject`, and node-level loop `interactive:` still parse and
 * function exactly as before (Migration section — these become load errors
 * only after #2123), but warn so authors migrate ahead of that. `$REJECTION_REASON`
 * and `$LOOP_USER_INPUT` are covered as a consequence rather than by a separate
 * text scan: they are populated ONLY inside `on_reject.prompt` / an interactive
 * loop body respectively, so warning on the enabling key covers their only
 * sanctioned usage — any other usage was already a dead (always-empty)
 * reference before this PR, with no behavior for a new warning to explain.
 */
function collectGateAndLoopDeprecationWarnings(
  node: DagNode | IncludeDirective,
  raw: unknown,
  id: string,
  warnings: string[]
): void {
  // An include directive has no gate/loop shape of its own — its expanded
  // contents are scanned once inlined, like collectUnknownNodeKeys's own
  // 'with:' handling for include nodes.
  if (isIncludeDirective(node)) return;
  if (isGateNode(node) && raw !== null && typeof raw === 'object') {
    const rawApproval = (raw as Record<string, unknown>).approval;
    if (rawApproval !== null && typeof rawApproval === 'object') {
      const approvalObj = rawApproval as Record<string, unknown>;
      // capture_response is genuinely ignored ONLY once the gate has also
      // opted into the new mechanism by authoring 'decisions:' (GateNode.
      // decisionsAuthored) — combined with 'on_reject', or on a bare gate with
      // no 'decisions:' authored, it still fully controls whether the
      // reviewer's comment becomes the node's output, exactly as before this
      // PR. Warning unconditionally would be false in those cases.
      if (approvalObj.capture_response !== undefined && node.decisionsAuthored) {
        const message =
          `Node '${id}': 'approval.capture_response' is deprecated. Gate output is now ` +
          `always structured as {decision, text} — read '$${id}.output.text' downstream ` +
          'instead. This field is ignored.';
        warnings.push(message);
        getLog().warn({ id, warning: message }, 'node_capture_response_deprecated');
      }
      if (approvalObj.on_reject !== undefined) {
        const message =
          `Node '${id}': 'approval.on_reject' is deprecated. Declare 'approval.decisions' ` +
          `and wire a rework node with "when: \\"$${id}.output.decision == 'reject'\\"" ` +
          'instead (loop it with loop_group if it should iterate). This gate keeps running ' +
          'via the legacy mechanism until migrated.';
        warnings.push(message);
        getLog().warn({ id, warning: message }, 'node_on_reject_deprecated');
      }
    }
  }
  const interactiveLoop =
    (isLoopNode(node) && node.loop.interactive === true) ||
    (isLoopGroupNode(node) && node.loop_group.interactive === true);
  if (interactiveLoop) {
    const message =
      `Node '${id}': node-level loop 'interactive:' is deprecated. A future release ` +
      're-expresses the interactive loop as a gate + loop_group composition (#2707 step 3). ' +
      'Continue using it for now.';
    warnings.push(message);
    getLog().warn({ id, warning: message }, 'node_loop_interactive_deprecated');
  }

  // The prose `until:` completion channel is deprecated for EVERY loop/loop_group,
  // not only interactive ones (#2707 step 3, "What gets deleted"): its one stated
  // reason to exist — "the iteration output is a message a human reads at an
  // interactive gate" (#2563) — evaporates once that human interaction is a gate
  // node with structured decision output rather than a prose sentinel. `until_bash`
  // and (loop: only) `until_field` are the declared, structured replacements. This
  // keeps running exactly as before; only the guidance is new.
  if (isLoopNode(node) && node.loop.until !== undefined) {
    const message =
      `Node '${id}': the prose 'loop.until' completion signal is deprecated. Declare ` +
      "'loop.until_bash' (deterministic check) or 'loop.until_field' (a declared boolean " +
      'in output_format) instead (#2707 step 3). While supported, emit legacy signals as ' +
      "'<promise>SIGNAL</promise>' or a final standalone signal line.";
    warnings.push(message);
    getLog().warn({ id, warning: message }, 'node_loop_until_deprecated');
  } else if (isLoopGroupNode(node) && node.loop_group.until !== undefined) {
    const message =
      `Node '${id}': the prose 'loop_group.until' completion signal is deprecated. ` +
      "Declare 'loop_group.until_bash' instead — it can read a body node's structured " +
      'output (e.g. \'test $body-node.output.field = "true"\') (#2707 step 3). While ' +
      "supported, emit legacy signals as '<promise>SIGNAL</promise>' or a final standalone " +
      'signal line.';
    warnings.push(message);
    getLog().warn({ id, warning: message }, 'node_loop_group_until_deprecated');
  }

  // A gate node inside a loop_group body only pauses the enclosing loop when it is
  // the body's SOLE terminal sink (#2707 step 3, target-model decision (b)) — a
  // mid-body or co-terminal gate has no defined resume semantics and silently does
  // not stop iteration (mid-body resume-to-node is deferred to #2708). This is
  // guidance for the new authoring pattern, not a rejection: the file keeps loading
  // either way, matching the grow-then-deprecate posture used throughout this
  // function — including for a gate placed here via the legacy `on_reject`
  // mechanism, which predates and is unrelated to this pattern but is equally
  // unable to stop the loop from this position.
  if (isLoopGroupNode(node)) {
    // Every body entry — including an unexpanded `include:` directive, which has
    // the identical `depends_on` shape (both extend dagNodeBaseSchema) and is a
    // real graph participant here, not yet inlined — contributes to and can BE a
    // terminal sink. Excluding it would silently misclassify a gate a downstream
    // include node depends on as "terminal", and miss an include node that is
    // itself a second, co-terminal sink.
    const bodyDependedOn = new Set(node.loop_group.nodes.flatMap(n => n.depends_on ?? []));
    const bodySinks = node.loop_group.nodes.filter(n => !bodyDependedOn.has(n.id));
    // Every gate in the body, not just the first: a body may legitimately contain
    // more than one (e.g. an "approve to start" gate followed by work followed by
    // a "review the result" gate) — only ONE can validly be the sole terminal sink,
    // but each needs its own placement/completion-reference verdict, not just the
    // first one found.
    const gatesInBody = node.loop_group.nodes.filter(n => !isIncludeDirective(n) && isGateNode(n));
    for (const gate of gatesInBody) {
      if (bodyDependedOn.has(gate.id) || bodySinks.length > 1) {
        const message =
          `Node '${gate.id}': a gate node inside a loop_group body must be the ` +
          "body's sole terminal sink to pause the enclosing loop (#2707 step 3) — this " +
          'gate is not, so it will not stop loop iteration. Move it to the end of the ' +
          'body with nothing else depending on it, and no other node left un-depended-on.';
        warnings.push(message);
        getLog().warn({ id: gate.id, warning: message }, 'loop_group_gate_not_terminal_sink');
      } else {
        // Gate is validly the sole terminal sink. Design A (#2707 step 3) is
        // deliberately unopinionated about what a decision means — the group's own
        // 'until_bash' is the completion channel, and it either reads the gate's
        // '$<gateId>.output.decision'/'.text' or it doesn't. If it doesn't, the
        // human's answer is captured (every resolution still writes node_completed)
        // but never consulted for completion — the loop just runs to max_iterations,
        // silently ignoring every response. Structural check (does the until_bash
        // string reference the gate's node id), not prose-sniffing — no judgment
        // about what the check DOES with it, only whether it looks at it at all.
        const untilBash = node.loop_group.until_bash;
        const untilBashRefsGate =
          untilBash !== undefined &&
          Array.from(untilBash.matchAll(new RegExp(OUTPUT_REF_SOURCE, 'g'))).some(
            m => m[1] === gate.id
          );
        if (!untilBashRefsGate) {
          const gateRef = `$${gate.id}.output`;
          const message =
            `Node '${gate.id}': this gate is the loop_group's terminal sink, but ` +
            `'loop_group.until_bash' does not reference '${gateRef}' — the human's ` +
            'decision is captured but never consulted for completion, so the loop only ' +
            `ends via max_iterations. Declare 'until_bash' checking '${gateRef}.decision' ` +
            `(e.g. '[ "${gateRef}.decision" = "approve" ]') so the gate's answer actually ` +
            'drives completion (#2707 step 3).';
          warnings.push(message);
          getLog().warn(
            { id: gate.id, warning: message },
            'loop_group_gate_completion_not_referenced'
          );
        }
      }
    }

    // A body-terminal sink that is itself an interactive loop/loop_group can pause
    // without stopping THIS group (#2753) — a bare gate sink is excluded here since
    // that case is already correctly handled above (and by #2707 step 3 at runtime);
    // this covers a sink whose own pause is trapped one level down instead.
    if (bodySinks.length === 1) {
      const sink = bodySinks[0];
      if (!isIncludeDirective(sink) && !isGateNode(sink) && isUnescalatableInteractiveSink(sink)) {
        const message =
          `Node '${id}': this loop_group's terminal sink ('${sink.id}') is itself an ` +
          'interactive loop/loop_group — a pause inside it does not escalate to stop ' +
          "this loop_group's own iteration (#2753). The outer loop can run further iterations " +
          "while a human's answer to the inner pause is still pending. Only a gate node " +
          'directly as the terminal sink correctly stops the enclosing loop_group ' +
          '(#2707 step 3).';
        warnings.push(message);
        getLog().warn(
          { id, sinkId: sink.id, warning: message },
          'loop_group_nested_pause_not_escalated'
        );
      }
    }
  }

  // Recurse into a loop_group body — mirrors collectUnknownNodeKeys's own body
  // recursion. Resolved and raw body arrays share index order (Zod arrays
  // preserve it), so they're zipped by position rather than by id.
  if (isLoopGroupNode(node) && raw !== null && typeof raw === 'object') {
    const rawGroup = (raw as Record<string, unknown>).loop_group;
    const rawBody =
      rawGroup !== null && typeof rawGroup === 'object'
        ? (rawGroup as Record<string, unknown>).nodes
        : undefined;
    if (Array.isArray(rawBody)) {
      // `id` is unused on the IncludeDirective early-return path above, so a
      // cheap fallback is fine when the body entry isn't a plain DagNode.
      node.loop_group.nodes.forEach((bodyNode, i) => {
        collectGateAndLoopDeprecationWarnings(
          bodyNode,
          rawBody[i],
          isIncludeDirective(bodyNode) ? `#${String(i)}` : bodyNode.id,
          warnings
        );
      });
    }
  }
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
): DagNode | IncludeDirective | null {
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

  // `mutates_checkout:` is workflow-level, so Zod strips a misplaced node-level value
  // before superRefine runs. Ordinary includes inherit the parent declaration; composed
  // fan-out instead consumes the included workflow's declaration for block-level
  // parallelism, so its correction points to that target rather than the parent run.
  if (isIncludeDirective(node) && (raw as Record<string, unknown>).mutates_checkout !== undefined) {
    errors.push(
      `Node '${id}': 'mutates_checkout' is not supported on an include node: a composed block shares the run's single checkout, so concurrency safety is the composing workflow's to declare. Set it at workflow level, or use a 'workflow:' node when you want a separate governed run.`
    );
    return null;
  }
  if (
    isComposeFanOutNode(node) &&
    (raw as Record<string, unknown>).mutates_checkout !== undefined
  ) {
    errors.push(
      `Node '${id}': 'mutates_checkout' is not supported on a composed fan-out node. Declare 'mutates_checkout: false' at the root of the included workflow when its whole block is safe to run concurrently, or set 'fan_out.max_parallel: 1'.`
    );
    return null;
  }

  collectUnknownNodeKeys(raw, id, `Node '${id}'`, warnings);
  collectGateAndLoopDeprecationWarnings(node, raw, id, warnings);

  // `with:` is live on an agent node's command-sourced form (node-local bindings,
  // #2637), on exec (script-runtime only), and on include/workflow (caller inputs).
  // On every other node type Zod strips it silently — surface that through the
  // parse-warnings channel (#2213) so an author learns the binding never attached,
  // without rejecting YAML that loaded fine before.
  const hasWithSupport =
    isIncludeDirective(node) ||
    isWorkflowNode(node) ||
    isComposeFanOutNode(node) ||
    (isExecNode(node) && node.runtime !== 'sh') ||
    (isAgentNode(node) && node.source.kind === 'command');
  if ((raw as Record<string, unknown>).with !== undefined && !hasWithSupport) {
    warnings.push(
      `Node '${id}': 'with' is only supported on command, script, include, and workflow nodes — it is ignored here`
    );
    getLog().warn({ id: node.id }, 'node_with_ignored');
  }

  // Warn about AI-specific fields on non-AI nodes (runtime behavior, not schema errors)
  let nonAiNode: { type: string; fields: readonly string[] } | undefined;
  if (isIncludeDirective(node)) {
    nonAiNode = { type: 'include', fields: INCLUDE_NODE_IGNORED_FIELDS };
  } else if (isComposeFanOutNode(node)) {
    // Same execution-less posture as a static include: the composed body's own nodes
    // carry their config, so AI-level fields declared here are ignored (#2512).
    nonAiNode = { type: 'include', fields: INCLUDE_NODE_IGNORED_FIELDS };
  } else if (isHaltNode(node)) {
    nonAiNode = { type: 'cancel', fields: GATE_AND_HALT_IGNORED_FIELDS };
  } else if (isWorkflowNode(node)) {
    nonAiNode = { type: 'workflow', fields: WORKFLOW_NODE_IGNORED_FIELDS };
  } else if (isGateNode(node)) {
    nonAiNode = { type: 'approval', fields: GATE_AND_HALT_IGNORED_FIELDS };
  } else if (isWaitNode(node)) {
    nonAiNode = { type: 'wait', fields: WAIT_NODE_IGNORED_FIELDS };
  } else if (isLoopNode(node)) {
    nonAiNode = { type: 'loop', fields: LOOP_NODE_AI_FIELDS };
  } else if (isLoopGroupNode(node)) {
    nonAiNode = { type: 'loop_group', fields: LOOP_GROUP_NODE_AI_FIELDS };
  } else if (isExecNode(node)) {
    nonAiNode = { type: node.runtime === 'sh' ? 'bash' : 'script', fields: BASH_NODE_AI_FIELDS };
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
 * Why a producer's WHOLE output cannot be compared to a literal in a `when:` (#2566),
 * or `null` when it can.
 *
 * Comparing a model's entire reply to an exact string is false the moment it writes a
 * sentence instead of a token — and the node is then skipped with no error. Both AI
 * producer kinds below are rejected, but for DIFFERENT reasons, so each gets its own
 * remedy. Each claim was verified by parsing a node through `dagNodeSchema`, not read off
 * the field lists:
 *
 *   'schema-capable' — `prompt:` / `command:` / `loop:`: `output_format` survives the
 *                      transform, and on a valid structured turn the executor REPLACES
 *                      the node's output text with the validated JSON document. So
 *                      declaring one is both the fix (compare a field) and the opt-out
 *                      (the whole output is then a document the author controls, not
 *                      prose). `loop:` joined this group in #2563 — it runs its own
 *                      sendQuery, so the schema reaches the provider and each iteration's
 *                      payload is validated against it. Before that it was its own kind,
 *                      because the field was dropped at parse and declaring one was a
 *                      no-op; that is no longer true and the separate kind is gone.
 *   'loop-group'     — `loop_group:`: `output_format` survives the transform here too,
 *                      but the group never calls the provider itself — its completion
 *                      returns `output: lastIterationOutput` with no `structuredOutput`
 *                      and no `declaredFields`, so the whole-output channel is still the
 *                      last iteration's raw text. Declaring a schema cannot make
 *                      `$group.output` a JSON document. This is the one asymmetry left.
 *
 * Everything else keeps whole-output comparison: `bash:`/`script:` stdout is
 * author-controlled and exact by construction, an `approval:` capture is what a human
 * typed, and a `workflow:` sub-run's output is the callee's business.
 *
 * `command:` is grouped with `prompt:` even though #2566 names only three node types: a
 * command file is an inline prompt that lives in another file, so excluding it would
 * leave the same hazard reachable by moving the prompt.
 */
function freeFormAiProducerKind(node: DagNode): 'schema-capable' | 'loop-group' | null {
  // A `loop:` node is schema-capable since #2563: it makes its own sendQuery, so a
  // declared `output_format` reaches the provider and its output becomes the
  // validated JSON — exactly like a prompt/command node. It therefore gets the same
  // verdict and the same remedy, and there is no longer a separate 'loop' kind. (A
  // `loop_group:` still has none of that: it never calls the provider itself.)
  if (isLoopGroupNode(node)) return 'loop-group';
  if (!isLoopNode(node) && !isAgentNode(node)) return null;
  return node.output_format === undefined ? 'schema-capable' : null;
}

/** The remedy clause for each rejected producer kind (see freeFormAiProducerKind). */
const GATE_ON_A_SHELL_NODE =
  "compute the decision in a 'bash:'/'script:' node (or an 'until_bash' check) and gate on that node's output instead";

/**
 * Validate DAG structure: unique IDs, depends_on references exist, no cycles,
 * every runtime-substituted node-output reference points to a known node in its
 * current or enclosing loop scope, and no `when:` compares a free-form AI output to
 * a literal.
 * Returns error message or null if valid.
 *
 * Exported so the include-expander can re-run the same structural checks on the
 * fully-flattened, namespaced node list after inlining (duplicate-id collisions,
 * cycles introduced by rewired edges, unknown deps).
 *
 * `enclosingNodes` carries the enclosing loop scope's nodes BY ID rather than just
 * their ids, because a `loop_group` body's `when:` may reference an outer producer and
 * the free-form-AI check needs that producer's type and `output_format`.
 */
export function validateDagStructure(
  nodes: readonly (DagNode | IncludeDirective)[],
  enclosingNodes?: ReadonlyMap<string, DagNode | IncludeDirective>
): string | null {
  // Check ID uniqueness
  const nodesById = new Map<string, DagNode | IncludeDirective>();
  for (const node of nodes) {
    if (nodesById.has(node.id)) {
      return `Duplicate node id: '${node.id}'`;
    }
    // A loop_group body node must not reuse an enclosing DAG's node id: the executor
    // seeds each iteration's scoped output map with the outer outputs, so a colliding
    // body node would silently shadow the outer node for $id.output refs.
    if (enclosingNodes?.has(node.id)) {
      return `Node id '${node.id}' shadows a node id in the enclosing DAG`;
    }
    if (node.id.includes(COMPOSE_FAN_OUT_STEP_MARKER)) {
      return `Node id '${node.id}' contains reserved engine namespace '${COMPOSE_FAN_OUT_STEP_MARKER}'`;
    }
    nodesById.set(node.id, node);
  }

  // Check depends_on references
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!nodesById.has(dep)) {
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

  let ready = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
  const layers: string[][] = [];
  let visited = 0;

  while (ready.length > 0) {
    layers.push(ready);
    const nextIds: string[] = [];
    for (const nodeId of ready) {
      visited++;
      for (const dep of dependents.get(nodeId) ?? []) {
        const newDegree = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) nextIds.push(dep);
      }
    }
    ready = nextIds;
  }

  if (visited < nodes.length) {
    const cycleNodes = nodes.filter(n => (inDegree.get(n.id) ?? 0) > 0).map(n => n.id);
    return `Cycle detected among nodes: ${cycleNodes.join(', ')}`;
  }

  // Scalar `shared` inherits one ambient sequential cursor. A multi-node ready set is
  // the executor's exact definition of a parallel layer; it clears that cursor before
  // evaluating `when:` or dispatching either sibling. Reject the otherwise silent no-op
  // here, while the graph is still being loaded. Explicit named resume owns deliberate
  // parallel ancestry (#2099/#2643).
  for (const layer of layers) {
    if (layer.length < 2) continue;
    const sharedNode = layer
      .map(nodeId => nodesById.get(nodeId))
      .find(
        (node): node is DagNode =>
          node !== undefined &&
          !isIncludeDirective(node) &&
          isAgentNode(node) &&
          node.context === 'shared'
      );
    if (sharedNode === undefined) continue;
    if (enclosingNodes !== undefined) {
      return `Node '${sharedNode.id}' uses scalar context: 'shared' in a structurally parallel loop_group body. Scalar 'shared' only inherits the ambient session in sequential layers. Serialize the body nodes with 'depends_on' or use fresh context; context.resume is not supported inside loop_group bodies`;
    }
    return `Node '${sharedNode.id}' uses scalar context: 'shared' in a structurally parallel layer. Scalar 'shared' only inherits the ambient session in sequential layers. Use 'context: { resume: <upstream-node-id> }' to fork an exact upstream session, or serialize the nodes with 'depends_on'`;
  }

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

  const hasDurableWait = (node: DagNode | IncludeDirective): boolean => {
    if (isIncludeDirective(node)) return false;
    if (isWaitNode(node)) return true;
    return isLoopGroupNode(node) && node.loop_group.nodes.some(hasDurableWait);
  };
  const canSuspend = (node: DagNode | IncludeDirective): boolean => {
    if (isIncludeDirective(node)) return false;
    if (isGateNode(node) || isWaitNode(node) || isWorkflowNode(node)) return true;
    if (isLoopNode(node) && node.loop.interactive) return true;
    return (
      isLoopGroupNode(node) &&
      (node.loop_group.interactive === true || node.loop_group.nodes.some(canSuspend))
    );
  };
  const suspensionNodes = nodes.filter(canSuspend);
  for (let index = 0; index < suspensionNodes.length; index++) {
    const left = suspensionNodes[index];
    if (left === undefined) continue;
    for (const right of suspensionNodes.slice(index + 1)) {
      const ordered =
        transitiveDepsOf(left.id).has(right.id) || transitiveDepsOf(right.id).has(left.id);
      if (!ordered && (hasDurableWait(left) || hasDurableWait(right))) {
        return `Suspending nodes '${left.id}' and '${right.id}' can run concurrently; add a dependency so only one suspension owns the run cursor at a time`;
      }
    }
  }

  // template-walker.ts owns every engine template/reference field. Runtime substitution
  // is syntax-agnostic, so this scan checks each text slot verbatim.
  const outputRefPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
  const whenRefPattern = new RegExp(WHEN_REF_SOURCE, 'g');
  for (const node of nodes) {
    const sources: {
      field: string;
      text: string;
      bodyNodes?: readonly (DagNode | IncludeDirective)[];
    }[] = [];
    if (!isIncludeDirective(node)) {
      visitNodeTemplateSlots(
        node,
        slot => {
          if (!slot.outputReference) return;
          sources.push({
            field: slot.path,
            text: slot.value,
            ...(slot.path === 'loop_group.until_bash' && isLoopGroupNode(node)
              ? { bodyNodes: node.loop_group.nodes }
              : {}),
          });
        },
        { recursive: false }
      );
    }
    for (const source of sources) {
      let m: RegExpExecArray | null;
      outputRefPattern.lastIndex = 0; // reset stateful g-flag regex before each new source string
      while ((m = outputRefPattern.exec(source.text)) !== null) {
        const refNodeId = m[1];
        // `$INPUTS.name` is an input macro. In particular, `$INPUTS.output` also
        // matches the canonical node-ref grammar, so the macro must take precedence.
        if (refNodeId === WHEN_INPUTS_SCOPE) continue;
        if (refNodeId === 'LOOP_PREV' && enclosingNodes !== undefined) continue;
        // Output refs (unlike depends_on) may also reach ENCLOSING-scope nodes: the
        // executor seeds a loop_group iteration's scoped output map with the outer
        // DAG's outputs, so `$outerNode.output` inside a body prompt is valid.
        if (
          refNodeId !== undefined &&
          !nodesById.has(refNodeId) &&
          !enclosingNodes?.has(refNodeId) &&
          !source.bodyNodes?.some(bodyNode => bodyNode.id === refNodeId)
        ) {
          if (source.bodyNodes !== undefined) {
            return `Node '${node.id}' field '${source.field}' references unknown node '$${refNodeId}.output'. Expected a node in the loop_group body or current/enclosing DAG scope`;
          }
          return `Node '${node.id}' field '${source.field}' references unknown node '$${refNodeId}.output'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
        }
      }
    }

    if (!isIncludeDirective(node) && isWaitNode(node)) {
      const waitSources: (readonly [string, string])[] = [];
      if (node.wait.until !== undefined) waitSources.push(['wait.until', node.wait.until]);
      if (node.wait.event !== undefined) waitSources.push(['wait.event', node.wait.event]);
      for (const [field, text] of waitSources) {
        outputRefPattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = outputRefPattern.exec(text)) !== null) {
          const producerId = m[1];
          if (
            producerId === undefined ||
            producerId === WHEN_INPUTS_SCOPE ||
            enclosingNodes?.has(producerId)
          ) {
            continue;
          }
          if (!transitiveDepsOf(node.id).has(producerId)) {
            return `Node '${node.id}' field '${field}' references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so the wait condition is produced first`;
          }
        }
      }
    }

    if (node.when !== undefined) {
      let m: RegExpExecArray | null;
      whenRefPattern.lastIndex = 0;
      while ((m = whenRefPattern.exec(node.when)) !== null) {
        const refNodeId = m[1];
        const field = m[2];
        // `$INPUTS.name` is an include-time macro at load and a run-time input scope in
        // a sub-run — either way it is not a node reference.
        if (refNodeId === WHEN_INPUTS_SCOPE) continue;
        if (refNodeId === 'LOOP_PREV' && enclosingNodes !== undefined) continue;
        if (
          refNodeId !== undefined &&
          !nodesById.has(refNodeId) &&
          !enclosingNodes?.has(refNodeId)
        ) {
          return `Node '${node.id}' field 'when' references unknown node '$${refNodeId}.${field ?? ''}'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
        }
      }

      // #2566: reject a `when:` that compares a producer's WHOLE free-form AI output to
      // a literal. `actual === expected` on a model's entire reply is false as soon as
      // the model writes "This is a BUG." instead of "BUG" — and the node is then
      // skipped with no error, so the run reaches a terminal state looking successful
      // while having quietly done less than the author asked for. Caught here, before
      // any spend, with the fix in the message.
      //
      // The atom decomposition comes from the shared `when-atom` parser (the same one
      // the evaluator runs), because the coarse `whenRefPattern` sweep above captures
      // only the first path segment and so cannot tell `$n.output` from
      // `$n.output.field`. An atom that does not parse is left alone: the executor
      // already fails closed on it, loudly.
      for (const atomText of whenAtoms(node.when)) {
        const atom =
          enclosingNodes !== undefined ? parseLoopPrevWhenAtom(atomText) : parseWhenAtom(atomText);
        if (atom?.ref.kind !== 'node' || atom.ref.field !== undefined) continue;
        const producerId = atom.ref.nodeId;
        const producer = nodesById.get(producerId) ?? enclosingNodes?.get(producerId);
        if (!producer || isIncludeDirective(producer)) continue;
        const kind = freeFormAiProducerKind(producer);
        if (kind === null) continue;
        const problem = `Node '${node.id}' field 'when' compares the whole output of AI node '${producerId}' to a literal ('${atom.expected}'). That output is free-form prose, so the comparison silently fails and '${node.id}' is skipped.`;
        if (kind === 'schema-capable') {
          return `${problem} Declare 'output_format' on '${producerId}' and compare a field (e.g. "$${producerId}.output.status ${atom.operator} '${atom.expected}'"), or produce the value from a 'bash:'/'script:' node`;
        }
        if (kind === 'loop-group') {
          return `${problem} A 'loop_group:' node's output is the last iteration's raw text — unlike a 'prompt:' node, declaring 'output_format' does not replace it with the JSON document — so ${GATE_ON_A_SHELL_NODE}`;
        }
        // Exhaustive: a new producer kind must state its own reason rather than inherit
        // whichever branch happened to be last. Silently handing an author the wrong
        // remedy is the same class of failure this whole check exists to remove.
        return kind satisfies never;
      }
    }
  }

  // A named session source must be in the same static scope and complete before its
  // consumer. Runtime validation owns provider/session facts that loading cannot know.
  for (const node of nodes) {
    if (isIncludeDirective(node)) continue;
    if (!isNodeContextResume(node.context)) continue;
    if (enclosingNodes !== undefined) {
      return `Node '${node.id}' uses context.resume inside a loop_group body, which is not supported`;
    }
    const sourceId = node.context.resume;
    const source = nodesById.get(sourceId);
    if (source === undefined) {
      return `Node '${node.id}' context.resume references unknown node '${sourceId}'`;
    }
    if (isIncludeDirective(source) || !(isAgentNode(source) || isLoopNode(source))) {
      return `Node '${node.id}' context.resume source '${sourceId}' is not a session-producing command, prompt, or loop node`;
    }
    if (!transitiveDepsOf(node.id).has(sourceId)) {
      return `Node '${node.id}' context.resume source '${sourceId}' is not an upstream dependency`;
    }
  }

  // fan_out.items (slice 2, PR-C) must reference the output of a node that is a
  // TRANSITIVE dependency of the fan-out node — so the item array is guaranteed
  // produced before the node expands. A same-layer or downstream producer would race
  // (the ref resolves to nothing → the node fails closed at run time); catch it at
  // load time with an actionable message instead. A literal `items` with no `$…output`
  // ref is left to the runtime fail-closed check (it must still parse to an array).
  for (const node of nodes) {
    if (
      isIncludeDirective(node) ||
      !(isWorkflowNode(node) || isComposeFanOutNode(node)) ||
      !node.fan_out
    )
      continue;
    const refMatch = new RegExp(OUTPUT_REF_SOURCE).exec(node.fan_out.items);
    const producerId = refMatch?.[1];
    if (producerId === undefined) continue; // no ref surface — runtime fail-closed owns it
    if (!transitiveDepsOf(node.id).has(producerId)) {
      return `Node '${node.id}' fan_out.items references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so its item array is produced first`;
    }
  }

  // Node-local bindings (#2637) must read UPSTREAM producers, mirroring fan_out.items:
  // depends_on is what guarantees a bound producer is terminal before the consumer
  // runs, so binding resolution needs no new scheduling. Only same-scope producers are
  // enforced — a loop_group body node may read the enclosing scope, whose outputs are
  // settled before the group starts (existing body-ref semantics).
  //
  // A composed command node is scanned through the payload its bindings moved to when
  // expansion compiled its body (#2964). This run over the FLATTENED graph is the only
  // one that can see a caller ref forwarded into a binding through `with:` — the child
  // was proven before that value was inserted, so a ref naming a parent node outside the
  // block's dependencies would otherwise reach the executor and fail the node mid-run.
  for (const node of nodes) {
    // Same capture-before-narrowing as the scan above: the include guard below would
    // otherwise filter a compose_fan_out node out of the binding check entirely.
    const composeFanOut = isComposeFanOutNode(node) ? node : undefined;
    if (isIncludeDirective(node)) continue;
    const nodeWith = isExecNode(node)
      ? node.with
      : isAgentNode(node)
        ? node.source.kind === 'command'
          ? node.source.with
          : readComposedBindings(node)
        : composeFanOut
          ? composeFanOut.with
          : undefined;
    if (nodeWith === undefined) continue;
    for (const [name, value] of Object.entries(nodeWith)) {
      const producerIds: string[] = [];
      if (typeof value === 'string') {
        const refPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
        let refMatch: RegExpExecArray | null;
        while ((refMatch = refPattern.exec(value)) !== null) {
          if (refMatch[1] !== WHEN_INPUTS_SCOPE) producerIds.push(refMatch[1]);
        }
      } else if (isBindingDirective(value)) {
        const ref = parseWholeOutputRef(value.from);
        if (ref !== undefined) producerIds.push(ref.nodeId);
      }
      for (const producerId of producerIds) {
        if (!nodesById.has(producerId)) continue; // enclosing scope, or already rejected above
        if (!transitiveDepsOf(node.id).has(producerId)) {
          return `Node '${node.id}' binding 'with.${name}' references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so its value is produced first`;
        }
      }
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
    if (!isIncludeDirective(node) && isLoopGroupNode(node)) {
      // `workflow:` (sub-run) inside a loop_group body is rejected (bounds the
      // interaction surface — see the plan's NOT Building). This wholesale rejection
      // also covers a fan-out (`fan_out:`) workflow node in a loop_group body (slice 2,
      // PR-C): a fan-out is a `workflow:` node, so nesting it per-iteration is likewise
      // out of scope.
      const workflowInBody = node.loop_group.nodes.find(
        n => !isIncludeDirective(n) && isWorkflowNode(n)
      );
      if (workflowInBody) {
        return `loop_group '${node.id}' body: 'workflow' (sub-run) is not supported inside a loop_group body`;
      }
      const dependedOn = new Set(node.loop_group.nodes.flatMap(n => n.depends_on ?? []));
      const sinks = node.loop_group.nodes.filter(n => !dependedOn.has(n.id));
      const misplacedWait = node.loop_group.nodes.find(
        n => !isIncludeDirective(n) && isWaitNode(n) && (dependedOn.has(n.id) || sinks.length !== 1)
      );
      if (misplacedWait) {
        return `loop_group '${node.id}' body: wait node '${misplacedWait.id}' must be the body's sole terminal sink`;
      }
      const nestedWaitGroup = node.loop_group.nodes.find(
        n => !isIncludeDirective(n) && isLoopGroupNode(n) && hasDurableWait(n)
      );
      if (nestedWaitGroup) {
        return `loop_group '${node.id}' body: wait nodes nested below another loop_group are not supported`;
      }
      const scopeNodes = new Map<string, DagNode | IncludeDirective>([
        ...(enclosingNodes ?? []),
        ...nodesById,
      ]);
      const bodyError = validateDagStructure(node.loop_group.nodes, scopeNodes);
      if (bodyError) {
        return `loop_group '${node.id}' body: ${bodyError}`;
      }
    }
  }

  return null; // valid
}

/**
 * Workflow-class placement check (#2707 step 2): a workflow declared
 * unattended (workflow-level `interactive` not `true`) should not NATIVELY
 * author a pause node anywhere in its DAG — a gate (`approval:`) node, or a
 * `loop`/`loop_group` node with node-level `interactive: true`. The
 * declaration is the workflow's promise about the pause nodes IT authors.
 *
 * GRACE PERIOD (#2736): a violation here does NOT reject the file. Rejecting
 * outright broke every workflow written before the class declaration
 * existed, including ones that only ever ran in the foreground and were
 * never actually unsafe — the hard error had no transition. `parseWorkflow`
 * instead coerces `interactive` to `true` for the rest of this parse and
 * warns once per file (see `warnedClassPlacementFiles`), which closes #1991
 * for these workflows immediately: every dispatch surface reads the SAME
 * parsed `interactive` value this function's result feeds
 * (`assertInteractiveClassNotBackgrounded`, the fan-out spawn check, the web
 * console's own background-vs-foreground branch), so the coercion protects
 * them without waiting for the author to add the declaration. TODO(#2738):
 * once the grace period ends, delete the coercion in `parseWorkflow` and
 * restore the hard error — this function's return value already carries the
 * exact message that error used to return, unchanged. Restoring the hard
 * error also means a leaf gate-authoring block reachable only via `include:`
 * can fail its OWN class check again, so #2738 must also resurrect the
 * `WorkflowLoadError.name`/`failedNames` mechanism this grace-period commit
 * removed (see its git history) — without it, every composer of that block
 * regresses to a misleading "not found" instead of the real cause.
 *
 * Called ONLY from `parseWorkflow`, against ONE file's own unexpanded node
 * list — deliberately NOT re-run against the post-`include:`-expansion node
 * list (see `expandWorkflowIncludes`'s doc comment at its `validateDagStructure`
 * call site for why): a reusable block can legitimately author a gate without
 * declaring its own `interactive: true`, since the SAME block may be composed
 * into an interactive parent, or independently discovered and invoked on its
 * own — load time cannot tell which discovered workflow will actually own a
 * given run (mirrors `findComposedApprovalGate`'s "one reader, one file"
 * reasoning). Composed-gate drivability stays an INVOCATION-time question,
 * answered by `assertComposedGateDriveable` against the run actually being
 * dispatched.
 *
 * Runs on the same node list `validateDagStructure` walks, recursing into
 * `loop_group` bodies (a body pause is governed by the SAME enclosing
 * workflow's class, not a class of its own).
 *
 * A `workflow:` node is also deliberately NOT checked here: its target
 * resolves at spawn, not load (#2200), so whether it can pause is unknowable
 * at this point — see `resolveFanOutChildDefinition`'s interactive-class
 * check in dag-executor.ts for the spawn-time equivalent (fan-out only; a 1:1
 * `workflow:` child is unaffected by design, see #2474's acceptance criteria).
 */
export function validateWorkflowClassPlacement(
  nodes: readonly (DagNode | IncludeDirective)[],
  interactive: boolean | undefined
): string | null {
  if (interactive === true) return null;
  for (const node of nodes) {
    if (isIncludeDirective(node)) continue;
    if (isGateNode(node)) {
      return (
        `Node '${node.id}' is a pause node ('approval:'), but this workflow does not declare ` +
        "'interactive: true'. An unattended workflow may never contain a pause node — declare " +
        "'interactive: true' at the workflow level, or remove this gate."
      );
    }
    if (isLoopNode(node) && node.loop.interactive === true) {
      return (
        `Node '${node.id}' is a pause node ('loop.interactive: true'), but this workflow does not ` +
        "declare 'interactive: true'. An unattended workflow may never contain a pause node — " +
        "declare 'interactive: true' at the workflow level, or remove the node-level 'interactive:'."
      );
    }
    if (isLoopGroupNode(node)) {
      if (node.loop_group.interactive === true) {
        return (
          `Node '${node.id}' is a pause node ('loop_group.interactive: true'), but this workflow ` +
          "does not declare 'interactive: true'. An unattended workflow may never contain a pause " +
          "node — declare 'interactive: true' at the workflow level, or remove the node-level " +
          "'interactive:'."
        );
      }
      const bodyError = validateWorkflowClassPlacement(node.loop_group.nodes, interactive);
      if (bodyError) return bodyError;
    }
  }
  return null;
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

    if (Object.hasOwn(raw, 'thinking')) {
      return {
        workflow: null,
        error: {
          filename,
          error: "'thinking:' has been removed; use 'effort:' instead",
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
      .filter((n): n is DagNode | IncludeDirective => n !== null);

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

    // Workflow-class placement (#2707 step 2) + the typed `interactive` field share
    // one raw-value coercion, computed here so the class check and the field the
    // engine actually reads can never disagree.
    const rawInteractive = typeof raw.interactive === 'boolean' ? raw.interactive : undefined;
    if (raw.interactive !== undefined && typeof raw.interactive !== 'boolean') {
      getLog().warn({ filename, value: raw.interactive }, 'invalid_interactive_value_ignored');
    }
    const classError = validateWorkflowClassPlacement(dagNodes, rawInteractive);
    // Grace period (#2736/#2738) — see this check's doc comment above `validateWorkflowClassPlacement`.
    const interactive = classError ? true : rawInteractive;
    if (classError) {
      const classWarning =
        `Workflow '${raw.name}': ${classError} 'interactive: true' has been applied for this run only ` +
        '(this grace period ends in a future release — see #2738); add the declaration to the file to ' +
        'silence this warning.';
      parseWarnings.push(classWarning);
      if (!warnedClassPlacementFiles.has(filename)) {
        warnedClassPlacementFiles.add(filename);
        // Carry the prose, not just the payload, so the warning is legible on both
        // channels: the log stream, and `parseWarnings` — which `executeWorkflow`
        // persists verbatim as a `workflow_parse_warnings` event (#2213) and
        // `/api/workflows` surfaces per-workflow to the author (see AGENTS.md).
        getLog().warn({ filename, warning: classWarning }, 'workflow_class_placement_inferred');
      }
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
      if (isIncludeDirective(node)) continue;
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

    for (const node of dagNodes) {
      if (isIncludeDirective(node)) continue;
      if (!isNodeContextResume(node.context)) continue;
      const sourceNodeId = node.context.resume;
      const source = dagNodes.find(candidate => candidate.id === sourceNodeId);
      if (source === undefined || isIncludeDirective(source)) continue; // validateDagStructure already reports this case.

      const consumerProvider = node.provider ?? provider;
      const sourceProvider = source.provider ?? provider;
      if (
        consumerProvider !== undefined &&
        sourceProvider !== undefined &&
        consumerProvider !== sourceProvider
      ) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}' context.resume source '${source.id}' uses provider '${sourceProvider}', but the consumer uses '${consumerProvider}'`,
            errorType: 'validation_error',
          },
        };
      }

      const knownProvider = consumerProvider ?? sourceProvider;
      if (knownProvider !== undefined && isRegisteredProvider(knownProvider)) {
        const caps = getProviderCapabilities(knownProvider);
        if (!caps.sessionResume || caps.sessionFork !== true) {
          return {
            workflow: null,
            error: {
              filename,
              error: `Node '${node.id}' context.resume requires immutable session forks, but provider '${knownProvider}' does not support sessionFork`,
              errorType: 'validation_error',
            },
          };
        }
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
      if (isIncludeDirective(node)) continue;
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
    // Parsed here for validation only. The deprecation is RESOLVED far below,
    // next to `const effort = ...`, because translating needs `effort` too:
    // `modelReasoningEffort` becomes `effort` and is never carried forward.
    // Search `workflow_model_reasoning_effort_deprecated` for the other half.
    const webSearchMode = parseOptionalField(
      raw.webSearchMode,
      webSearchModeSchema,
      filename,
      'invalid_web_search_mode',
      { valid: webSearchModeSchema.options }
    );

    // Warn (non-blocking) when signal_completes is set without interactive: the flag
    // only changes interactive-gate behavior — a non-interactive loop already
    // completes on the signal, so the author's intent is likely a missing
    // `interactive: true`. The workflow still loads.
    const hasSignalCompletesWithoutInteractive = (ns: (DagNode | IncludeDirective)[]): boolean =>
      ns.some(
        n =>
          !isIncludeDirective(n) &&
          ((isLoopNode(n) && n.loop.signal_completes === true && n.loop.interactive !== true) ||
            (isLoopGroupNode(n) &&
              ((n.loop_group.signal_completes === true && n.loop_group.interactive !== true) ||
                hasSignalCompletesWithoutInteractive(n.loop_group.nodes))))
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

    // Parse workflow-level deprecation marker (#2781). Like evidence_policy, a
    // malformed block REJECTS the workflow instead of warn-and-ignore: silently
    // dropping it would ship a bundled default with no removal warning at all,
    // defeating the whole deprecation window.
    let deprecated: WorkflowDeprecation | undefined;
    if (raw.deprecated !== undefined) {
      const parsedDeprecation = workflowDeprecationSchema.safeParse(raw.deprecated);
      if (!parsedDeprecation.success) {
        return {
          workflow: null,
          error: {
            filename,
            error:
              'Invalid deprecated: expected { message: string } — the sentence carried in the run-start deprecation notice (#2781).',
            errorType: 'validation_error',
          },
        };
      }
      deprecated = parsedDeprecation.data;
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

    // Authored run outcome (#2618). Unlike cosmetic or provider-default fields,
    // a malformed selector cannot be dropped: doing so would silently turn a
    // declared verdict into outcome=null. The node-schema relationship is
    // validated below on the assembled workflow (and again after include
    // expansion when `returns:` names an include alias).
    let outcomeField: string | undefined;
    if (typeof raw.outcome_field === 'string' && raw.outcome_field.trim().length > 0) {
      outcomeField = raw.outcome_field.trim();
    } else if (raw.outcome_field !== undefined) {
      getLog().warn(
        { filename, value: raw.outcome_field },
        'invalid_workflow_outcome_field_value_rejected'
      );
      return {
        workflow: null,
        error: {
          filename,
          error:
            "Invalid 'outcome_field': expected a non-empty required boolean property name relative to 'returns'",
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
            `has been applied as 'effort: ${modelReasoningEffort}'. NOTE: 'effort:' applies to EVERY node ` +
            'in this workflow, including non-Codex ones, where the old Codex-only field applied to none. ' +
            "Set 'effort:' per node if only some nodes should reason that deeply."
          : `Workflow '${raw.name}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and was ` +
            `IGNORED because this workflow also declares 'effort: ${declaredEffort}', which now applies on ` +
            "every provider including Codex. Delete the 'modelReasoningEffort:' line.";
      parseWarnings.push(message);
      // Carry the prose, not just the payload, so the warning is legible on both
      // channels: the log stream, and `parseWarnings` — which `executeWorkflow`
      // persists verbatim as a `workflow_parse_warnings` event (#2213).
      getLog().warn({ filename, warning: message }, 'workflow_model_reasoning_effort_deprecated');
    }
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

    const workflow: WorkflowDefinition = {
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
      ...(outcomeField !== undefined ? { outcome_field: outcomeField } : {}),
      ...(deprecated !== undefined ? { deprecated } : {}),
    };
    const execInputValidation = validateInlineExecInputs(workflow);
    parseWarnings.push(...execInputValidation.warnings);
    if (execInputValidation.errors.length > 0) {
      return {
        workflow: null,
        error: {
          filename,
          error: execInputValidation.errors.join(' '),
          errorType: 'validation_error',
        },
      };
    }
    const outcomeDeclarationError = validateWorkflowOutcomeDeclaration(workflow);
    if (outcomeDeclarationError !== null) {
      return {
        workflow: null,
        error: {
          filename,
          error: outcomeDeclarationError,
          errorType: 'validation_error',
        },
      };
    }

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
