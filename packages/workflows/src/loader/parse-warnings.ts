import type { DagNode, IncludeDirective } from '../schemas';
import {
  isGateNode,
  isInteractiveSink,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
  isNodeContextResume,
  isWaitNode,
  loopGroupSoleTerminalSink,
} from '../schemas';
import { KNOWN_DAG_NODE_KEYS, KNOWN_NODE_NESTED_KEYS } from '../schemas/dag-node';
import type { NestedKeySpec } from '../schemas/dag-node';
import {
  KNOWN_WORKFLOW_KEYS,
  KNOWN_WORKFLOW_NESTED_KEYS,
  WORKFLOW_ONLY_KEYS,
} from '../schemas/workflow';
import { OUTPUT_REF_SOURCE } from '../output-ref';
import { getLog } from './log';

/**
 * The node's `id` for messages, falling back to its 1-based position when the
 * id is missing or blank (the schema reports that separately as an error).
 */
export function nodeIdForMessages(raw: unknown, index: number): string {
  const rawId =
    raw !== null && typeof raw === 'object' && 'id' in raw
      ? String((raw as Record<string, unknown>).id)
      : '';
  return rawId.trim() || `#${String(index + 1)}`;
}

/**
 * Guidance for a key the engine drops, appended to the unknown-key warning.
 * (A node-level `interactive`, the #2213 report, never gets here: it is a loop
 * setting outside a loop, which `dagNodeSchema` rejects.)
 */
function unknownNodeKeyHint(key: string): string {
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
  // `warnings` is how the author hears about this: `validate`, `workflow list`,
  // `workflow run` (stderr), the API, and the run's `workflow_parse_warnings`
  // event all read it. Every parse warning in this file is also logged at debug, not
  // warn: discovery parses every workflow on each list or run, so a warn line
  // would repeat for workflows the operator did not ask about (#3444).
  getLog().debug({ id, key, warning: message }, event);
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
 * Catches misplaced workflow-level keys (`worktree:` on a command node),
 * typos (`contxt:` instead of `context:`), and the same mistakes one level down
 * inside `approval:` / `retry:` / `loop:` / `agents:`.
 *
 * Recurses into a `loop_group` body: those entries are full DAG nodes parsed by
 * the same schema, so they strip unknown keys just as silently.
 */
export function collectUnknownNodeKeys(
  raw: unknown,
  id: string,
  label: string,
  warnings: string[]
): void {
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
 * A condition-skipped dependency is neither a success nor a failure, so a
 * `none_failed_min_one_success` node whose ONLY dependency has a `when:` skips
 * whenever that condition is false (#3783). Two or more conditional dependencies
 * are usually mutually exclusive branches where one always runs, so they are not
 * flagged. This judges the authored graph, not the expanded one: expansion copies
 * an include's `when:` onto the block's entry nodes, where a whole block skipping
 * together is the intent rather than a mistake.
 */
export function collectConditionalJoinWarnings(
  nodes: readonly (DagNode | IncludeDirective)[],
  warnings: string[]
): void {
  const conditional = new Set(nodes.filter(node => node.when !== undefined).map(node => node.id));
  for (const node of nodes) {
    const [dependency, ...rest] = node.depends_on ?? [];
    if (
      node.trigger_rule === 'none_failed_min_one_success' &&
      dependency !== undefined &&
      rest.length === 0 &&
      conditional.has(dependency)
    ) {
      warnings.push(
        `Node '${node.id}': its only dependency '${dependency}' has a 'when', and ` +
          "'none_failed_min_one_success' needs a successful dependency, so this node skips " +
          `whenever '${dependency}' is condition-skipped. To run after an optional gate, also ` +
          "depend on an unconditional node that runs before it, or use 'all_done' to run even after " +
          'a failure. See /reference/workflow-language/#trigger_rule-values.'
      );
    }
    if (!isIncludeDirective(node) && isLoopGroupNode(node)) {
      collectConditionalJoinWarnings(node.loop_group.nodes, warnings);
    }
  }
}

/**
 * Loop-group sink-shape warnings, judged against the EXPANDED node graph (#2756).
 *
 * Both checks below read resolved nodes only — `depends_on` edges and node kinds —
 * never the raw YAML, so they describe the graph the executor will run rather than
 * what the author typed. That is the point: an `include:` is a legal `loop_group`
 * body entry, and before expansion it is an opaque target name no sink check can
 * classify, so a composed terminal sink is invisible at parse time. This therefore
 * runs once per workflow AFTER `expandWorkflowIncludes`, from the discovery site
 * that pairs warnings with the expanded definition (`workflow-discovery/expand-scope.ts`) — a
 * directly-authored sink keeps its id and its verdict through expansion, so it
 * still warns exactly once.
 */
export function collectLoopGroupSinkWarnings(
  nodes: readonly (DagNode | IncludeDirective)[],
  warnings: string[],
  enclosingOwnerSessions = false
): void {
  for (const node of nodes) {
    if (isIncludeDirective(node) || !isLoopGroupNode(node)) continue;

    // An `include:` is already gone from the body here — expansion replaced it with the
    // block's namespaced nodes, which is what makes a composed terminal sink visible to
    // these checks at all. The body type still admits one, so it stays a participant in
    // the sink count and is never itself classified as a gate or an interactive sink.
    const soleSink = loopGroupSoleTerminalSink(node.loop_group.nodes);
    const hasOwnerSessions =
      enclosingOwnerSessions ||
      node.loop_group.nodes.some(n => !isIncludeDirective(n) && isNodeContextResume(n.context));

    // A gate or attention wait that is the body's sole terminal sink (any other
    // placement is a load error in `validateDagStructure`). The group's own
    // 'until_bash' is the completion channel, and it either reads the pause's
    // '$<id>.output' or it doesn't. If it doesn't, the answer is recorded but never
    // consulted for completion — the loop just runs to max_iterations, silently
    // ignoring every answer. Structural check (does the until_bash string reference
    // the pause's node id), not prose-sniffing. A pause with its own `when:` is exempt:
    // when it skips it has no output, so an until_bash reading it would fail the
    // group (#4043).
    if (
      soleSink !== undefined &&
      !isIncludeDirective(soleSink) &&
      (isGateNode(soleSink) || (isWaitNode(soleSink) && soleSink.wait.attention !== undefined)) &&
      soleSink.when === undefined
    ) {
      const untilBash = node.loop_group.until_bash;
      const untilBashRefsPause =
        untilBash !== undefined &&
        Array.from(untilBash.matchAll(new RegExp(OUTPUT_REF_SOURCE, 'g'))).some(
          m => m[1] === soleSink.id
        );
      if (!untilBashRefsPause) {
        const pauseRef = `$${soleSink.id}.output`;
        const message =
          `Node '${soleSink.id}': this pause is the loop_group's terminal sink, but ` +
          `'loop_group.until_bash' does not reference '${pauseRef}' — the answer is ` +
          'recorded but never consulted for completion, so the loop only ends via ' +
          `max_iterations. Declare 'until_bash' checking '${pauseRef}' (e.g. ` +
          `'decision=${pauseRef}.decision; [ "$decision" = "approve" ]') so the answer ` +
          'drives completion.';
        warnings.push(message);
        getLog().debug(
          { id: soleSink.id, warning: message },
          'loop_group_pause_completion_not_referenced'
        );
      }
    }

    // Interactive plain loops and ambient-only nested groups can pause
    // without stopping THIS group (#2753) — a bare gate sink is excluded here since
    // that case is already correctly handled above (and by #2707 step 3 at runtime);
    // this covers a sink whose own pause is trapped one level down instead.
    if (
      soleSink !== undefined &&
      !isIncludeDirective(soleSink) &&
      !isGateNode(soleSink) &&
      isInteractiveSink(soleSink) &&
      !(hasOwnerSessions && isLoopGroupNode(soleSink))
    ) {
      const message =
        `Node '${node.id}': this loop_group's terminal sink ('${soleSink.id}') is itself an ` +
        'interactive loop/loop_group — a pause inside it does not escalate to stop ' +
        "this loop_group's own iteration (#2753). The outer loop can run further iterations " +
        'while an answer to the inner pause is still pending. Only a gate or wait node ' +
        'directly as the terminal sink correctly stops the enclosing loop_group ' +
        '(#2707 step 3).';
      warnings.push(message);
      getLog().debug(
        { id: node.id, sinkId: soleSink.id, warning: message },
        'loop_group_nested_pause_not_escalated'
      );
    }

    collectLoopGroupSinkWarnings(node.loop_group.nodes, warnings, hasOwnerSessions);
  }
}

/**
 * The prose `until:` completion channel is deprecated for EVERY loop/loop_group,
 * not only interactive ones (#2707 step 3, "What gets deleted"): its one stated
 * reason to exist — "the iteration output is a message a human reads at an
 * interactive gate" (#2563) — evaporates once that interaction is a pause with
 * structured output rather than a prose sentinel. `until_bash` and (loop: only)
 * `until_field` are the declared, structured replacements. This keeps running
 * exactly as before; only the guidance is new.
 */
export function collectLoopUntilDeprecationWarnings(
  node: DagNode | IncludeDirective,
  id: string,
  warnings: string[]
): void {
  // An include directive has no loop shape of its own, and its target is a workflow
  // file in its own right: discovery parses that file and warns on what it declares
  // there, so the inlined copy needs no second notice.
  if (isIncludeDirective(node)) return;
  if (isLoopNode(node) && node.loop.until !== undefined) {
    const message =
      `Node '${id}': the prose 'loop.until' completion signal is deprecated. Declare ` +
      "'loop.until_bash' (deterministic check) or 'loop.until_field' (a declared boolean " +
      'in output_format) instead (#2707 step 3). While supported, emit legacy signals as ' +
      "'<promise>SIGNAL</promise>' or a final standalone signal line.";
    warnings.push(message);
    getLog().debug({ id, warning: message }, 'node_loop_until_deprecated');
  } else if (isLoopGroupNode(node) && node.loop_group.until !== undefined) {
    const message =
      `Node '${id}': the prose 'loop_group.until' completion signal is deprecated. ` +
      "Declare 'loop_group.until_bash' instead — it can read a body node's structured " +
      'output (e.g. \'value=$body-node.output.field; test "$value" = "true"\') (#2707 step 3). While ' +
      "supported, emit legacy signals as '<promise>SIGNAL</promise>' or a final standalone " +
      'signal line.';
    warnings.push(message);
    getLog().debug({ id, warning: message }, 'node_loop_group_until_deprecated');
  }

  if (isLoopGroupNode(node)) {
    for (const bodyNode of node.loop_group.nodes) {
      if (!isIncludeDirective(bodyNode))
        collectLoopUntilDeprecationWarnings(bodyNode, bodyNode.id, warnings);
    }
  }
}

/**
 * The legacy answerable pauses, each still answerable but replaced by an attention
 * wait (#4042). A plain gate, a `decisions:` gate and an `on_reject:` gate
 * are mutually exclusive shapes; `capture_response` can ride on any of them.
 */
type LegacyPauseShape =
  | 'approval'
  | 'decisions'
  | 'on_reject'
  | 'capture_response'
  | 'interactive_loop';

/** Each legacy shape's replacement. The runtime is unchanged: nothing is translated. */
const LEGACY_PAUSE_REPLACEMENTS: Record<LegacyPauseShape, string> = {
  approval:
    "'approval:' is deprecated. Write 'wait: { attention: <message>, form: approval }' " +
    "instead; the next node reads '$<id>.output.decision' and '$<id>.output.text'. A legacy " +
    "reject cancels the run, while an attention wait continues with decision 'reject', so add " +
    "a 'cancel:' node with when: \"$<id>.output.decision == 'reject'\" where rejecting " +
    'should end the run.',
  decisions:
    "'approval.decisions' is deprecated. Write 'wait: { attention: <message>, form: select, " +
    "options: <the same decisions> }' instead; the output is the same {decision, text}.",
  on_reject:
    "'approval.on_reject' and '$REJECTION_REASON' are deprecated. Write 'wait: { attention: " +
    "<message>, form: approval }' followed by a rework node with " +
    "when: \"$<id>.output.decision == 'reject'\" that reads '$<id>.output.text'. To repeat " +
    "the rework, write a 'loop_group' whose body ends in the wait; the rework node comes " +
    "first and reads '$LOOP_PREV.<id>.output.text'.",
  capture_response:
    "'approval.capture_response' is deprecated. An attention wait always records the answer; " +
    "the next node reads '$<id>.output.text'.",
  interactive_loop:
    "loop 'interactive:' with 'gate_message' and '$LOOP_USER_INPUT' is deprecated. Write a " +
    "'loop_group' whose body ends in a 'wait: attention' node instead; the next iteration " +
    "reads '$LOOP_PREV.<id>.output.text', and 'until_bash' checks the answer at " +
    "'$<id>.output'.",
};

function legacyPauseShapes(node: DagNode, raw: unknown): LegacyPauseShape[] {
  const shapes: LegacyPauseShape[] = [];
  if (isGateNode(node)) {
    // Read the raw key: an authored `capture_response: false` is still the legacy key.
    const rawApproval =
      raw !== null && typeof raw === 'object'
        ? (raw as Record<string, unknown>).approval
        : undefined;
    const capturesResponse =
      rawApproval !== null &&
      typeof rawApproval === 'object' &&
      (rawApproval as Record<string, unknown>).capture_response !== undefined;
    if (node.decisionsAuthored) shapes.push('decisions');
    else if (node.decisions.some(decision => decision.rework !== undefined))
      shapes.push('on_reject');
    else shapes.push('approval');
    if (capturesResponse) shapes.push('capture_response');
  }
  if (
    (isLoopNode(node) && node.loop.interactive === true) ||
    (isLoopGroupNode(node) && node.loop_group.interactive === true)
  )
    shapes.push('interactive_loop');
  return shapes;
}

/**
 * One warning per legacy pause shape per workflow file, naming every node that
 * uses it and the attention form that replaces it (#4042). The shapes keep running
 * unchanged; the warning only tells the author how to rewrite.
 *
 * Resolved and raw node arrays share index order (Zod arrays preserve it), so they are
 * zipped by position, recursing into loop_group bodies. An include directive is skipped:
 * discovery parses its target file on its own, and warns there.
 */
export function collectLegacyPauseWarnings(
  nodes: readonly (DagNode | IncludeDirective)[],
  rawNodes: readonly unknown[],
  warnings: string[]
): void {
  const nodeIdsByShape = new Map<LegacyPauseShape, string[]>();
  const visit = (
    body: readonly (DagNode | IncludeDirective)[],
    rawBody: readonly unknown[]
  ): void => {
    body.forEach((node, i) => {
      if (isIncludeDirective(node)) return;
      for (const shape of legacyPauseShapes(node, rawBody[i])) {
        nodeIdsByShape.set(shape, [...(nodeIdsByShape.get(shape) ?? []), node.id]);
      }
      if (isLoopGroupNode(node)) {
        const rawGroup = (rawBody[i] as Record<string, unknown> | undefined)?.loop_group;
        const rawGroupBody =
          rawGroup !== null && typeof rawGroup === 'object'
            ? (rawGroup as Record<string, unknown>).nodes
            : undefined;
        visit(node.loop_group.nodes, Array.isArray(rawGroupBody) ? rawGroupBody : []);
      }
    });
  };
  visit(nodes, rawNodes);

  for (const [shape, nodeIds] of nodeIdsByShape) {
    const label =
      nodeIds.length === 1
        ? `Node '${nodeIds[0]}'`
        : `Nodes ${nodeIds.map(id => `'${id}'`).join(', ')}`;
    const message = `${label}: ${LEGACY_PAUSE_REPLACEMENTS[shape]} It keeps running as before until rewritten.`;
    warnings.push(message);
    getLog().debug({ shape, nodeIds, warning: message }, 'legacy_pause_deprecated');
  }
}

function hasSignalCompletesWithoutInteractive(
  ns: readonly (DagNode | IncludeDirective)[]
): boolean {
  return ns.some(
    n =>
      !isIncludeDirective(n) &&
      ((isLoopNode(n) && n.loop.signal_completes === true && n.loop.interactive !== true) ||
        (isLoopGroupNode(n) &&
          ((n.loop_group.signal_completes === true && n.loop_group.interactive !== true) ||
            hasSignalCompletesWithoutInteractive(n.loop_group.nodes))))
  );
}

/**
 * Warn (non-blocking) when signal_completes is set without interactive: the flag
 * only changes interactive-gate behavior — a non-interactive loop already
 * completes on the signal, so the author's intent is likely a missing
 * `interactive: true`. The workflow still loads.
 */
export function warnSignalCompletesWithoutInteractive(
  nodes: readonly (DagNode | IncludeDirective)[],
  filename: string
): void {
  if (hasSignalCompletesWithoutInteractive(nodes)) {
    getLog().warn({ filename }, 'signal_completes_without_interactive_ignored');
  }
}

/**
 * Detect unknown workflow-level keys, and unknown keys inside the nested
 * workflow-level configs (#2213)
 */
export function collectUnknownWorkflowKeys(
  raw: Record<string, unknown>,
  workflowName: string,
  warnings: string[]
): void {
  const workflowLabel = `Workflow '${workflowName}'`;
  for (const key of Object.keys(raw)) {
    if (key === 'interactive') continue; // deprecated, warned by parseWorkflow
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
        warnings
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
        warnings
      );
    }
  }
}
