/**
 * Structural validation: node-id hygiene (non-empty, unique) and per-variant
 * required-field checks. Hand-rolled to match the engine's superRefine intent
 * without depending on a runtime schema.
 */
import type {
  BuilderNode,
  BuilderWorkflow,
  Issue,
  LoopNodeData,
  ScriptNodeData,
  WaitNodeData,
} from '../types';
import { OUTPUT_REF_SOURCE } from '@/lib/node-ref';
import { makeIssue } from './make-issue';

const waitTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/;
const wholeInputsRefPattern = /^\$INPUTS\.[a-zA-Z_][a-zA-Z0-9_-]*$/;
// @archon/web cannot import workflow runtime values, so this copies
// MAX_DURABLE_WAIT_MS from @archon/workflows/schemas/durable-wait;
// scripts/node-ref-parity.test.ts fails when the two differ.
export const MAX_DURABLE_WAIT_MS = 1_000 * 365 * 24 * 60 * 60 * 1_000;

function isValidWaitTimestamp(value: string): boolean {
  if (new RegExp(OUTPUT_REF_SOURCE).test(value) || wholeInputsRefPattern.test(value.trim())) {
    return true;
  }
  const match = waitTimestampPattern.exec(value);
  if (match === null) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6] ?? 0)
  );
}

/** Empty (or whitespace-only) ids and duplicate ids across the node list. */
function checkIds(nodes: BuilderNode[]): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const id = node.id.trim();
    if (id.length === 0) {
      issues.push(
        makeIssue({
          rule: 'structural.id.empty',
          severity: 'error',
          source: 'client-instant',
          message: 'node id must not be empty',
          path: { nodeId: node.id, field: 'id' },
        })
      );
      continue;
    }
    if (seen.has(id)) {
      issues.push(
        makeIssue({
          rule: 'structural.id.duplicate',
          severity: 'error',
          source: 'client-instant',
          message: `duplicate node id '${id}'`,
          path: { nodeId: id, field: 'id' },
        })
      );
    }
    seen.add(id);
  }
  return issues;
}

// Cross-package conformance is enforced by scripts/node-ref-parity.test.ts;
// the web bundle cannot import the engine's dagNodeSchema.
function checkUntilField(field: string, schema: Record<string, unknown> | undefined): string[] {
  if (schema === undefined) {
    return ['loop.until_field requires output_format; author the schema in YAML'];
  }
  const properties = schema.properties;
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    !Object.keys(properties).includes(field)
  ) {
    return [`loop.until_field '${field}' must be declared in output_format.properties`];
  }
  const issues: string[] = [];
  if (!Array.isArray(schema.required) || !schema.required.includes(field)) {
    issues.push(`loop.until_field '${field}' must be listed in output_format.required`);
  }
  const property: unknown = Reflect.get(properties, field);
  const type =
    property !== null && typeof property === 'object' && 'type' in property
      ? property.type
      : undefined;
  if (typeof type === 'string' && type !== 'boolean') {
    issues.push(`loop.until_field '${field}' must have type 'boolean', not '${type}'`);
  }
  return issues;
}

/** Records field issues against one node, in the order the checks run. */
interface FieldReport {
  missing(field: string, message: string): void;
  /**
   * Distinct from `missing`: the field is present but holds an invalid value, so
   * the UI shouldn't render it as a required-but-empty field.
   */
  invalid(field: string, message: string): void;
}

function fieldReport(nodeId: string, issues: Issue[]): FieldReport {
  const push =
    (rule: 'structural.field.missing' | 'structural.field.invalid') =>
    (field: string, message: string): void => {
      issues.push(
        makeIssue({
          rule,
          severity: 'error',
          source: 'client-instant',
          message,
          path: { nodeId, field },
        })
      );
    };
  return { missing: push('structural.field.missing'), invalid: push('structural.field.invalid') };
}

function requireText(report: FieldReport, field: string, value: string, message: string): void {
  if (value.trim().length === 0) report.missing(field, message);
}

function checkScript(data: ScriptNodeData, report: FieldReport): void {
  requireText(report, 'script', data.script, 'script must not be empty');
  if (data.runtime !== 'bun' && data.runtime !== 'uv')
    report.invalid('runtime', "script requires runtime 'bun' or 'uv'");
}

/**
 * One-of rule (mirrors the engine schema): exactly one prompt source, and
 * whichever is present must be non-empty.
 */
function checkLoopPromptSource(data: LoopNodeData, report: FieldReport): void {
  if (data.prompt !== undefined && data.command !== undefined)
    report.invalid('loop.command', "loop accepts exactly one of 'prompt' or 'command', not both");
  else if (data.command !== undefined)
    requireText(report, 'loop.command', data.command, 'loop requires a command name');
  else
    requireText(
      report,
      'loop.prompt',
      data.prompt ?? '',
      'loop requires a prompt (or a command file)'
    );
}

/**
 * Completion channels (#2563) — a hand-written mirror of the two rules in the
 * engine's `loopNodeConfigSchema`, because @archon/web cannot import
 * @archon/workflows. `scripts/node-ref-parity.test.ts` derives its cases from
 * the engine's channel tuple to enforce agreement in CI.
 */
function checkLoopChannels(
  data: LoopNodeData,
  outputFormat: Record<string, unknown> | undefined,
  report: FieldReport
): void {
  // 1. A declared channel must be non-blank. Blank is broken at runtime, not
  //    just untidy: `bash -c "   "` exits 0, and a blank signal matches any
  //    whitespace-only line in the model's output.
  if (data.until?.trim().length === 0)
    report.missing('loop.until', "loop requires a non-blank 'until' signal");
  if (data.until_bash?.trim().length === 0)
    report.missing('loop.until_bash', "loop requires a non-blank 'until_bash' check");
  if (data.until_field?.trim().length === 0)
    report.missing('loop.until_field', "loop requires a non-blank 'until_field' name");
  if (data.until_field !== undefined) {
    for (const message of checkUntilField(data.until_field.trim(), outputFormat)) {
      report.invalid('loop.until_field', message);
    }
  }
  // 2. At least one channel must be declared at all.
  if (data.until === undefined && data.until_bash === undefined && data.until_field === undefined)
    report.missing(
      'loop.until',
      "loop requires a completion channel: an 'until' signal, an 'until_bash' check, or an 'until_field' name"
    );
}

function checkLoop(
  data: LoopNodeData,
  outputFormat: Record<string, unknown> | undefined,
  report: FieldReport
): void {
  checkLoopPromptSource(data, report);
  checkLoopChannels(data, outputFormat, report);
  if (!Number.isInteger(data.max_iterations) || data.max_iterations <= 0)
    report.invalid('loop.max_iterations', 'loop requires a positive integer max_iterations');
}

/** A positive integer number of milliseconds no greater than `MAX_DURABLE_WAIT_MS`. */
function isDurableWaitMs(value: number | undefined): boolean {
  return (
    value !== undefined && Number.isInteger(value) && value > 0 && value <= MAX_DURABLE_WAIT_MS
  );
}

function checkWaitCondition(data: WaitNodeData, report: FieldReport): void {
  const conditions = [data.duration_ms, data.until, data.event, data.attention].filter(
    value => value !== undefined
  );
  if (conditions.length !== 1) {
    report.invalid(
      'wait',
      "wait requires exactly one of 'duration_ms', 'until', 'event', or 'attention'"
    );
  }
}

function checkWaitUntil(until: string | undefined, report: FieldReport): void {
  if (until?.trim().length === 0) {
    report.missing('wait.until', 'wait timestamp must not be empty');
  } else if (until !== undefined && !isValidWaitTimestamp(until)) {
    report.invalid(
      'wait.until',
      'wait timestamp must be an ISO-8601 UTC timestamp or contain a runtime reference'
    );
  }
}

function checkWaitEvent(data: WaitNodeData, report: FieldReport): void {
  if (data.event?.trim().length === 0) report.missing('wait.event', 'wait event must not be empty');
  if (data.event !== undefined && !isDurableWaitMs(data.deadline_ms)) {
    report.invalid(
      'wait.deadline_ms',
      'event waits require a positive integer deadline no greater than 1000 years'
    );
  }
  if (data.event === undefined && data.deadline_ms !== undefined) {
    report.invalid('wait.deadline_ms', 'deadline is only supported for event waits');
  }
}

function checkWait(data: WaitNodeData, report: FieldReport): void {
  checkWaitCondition(data, report);
  if (data.duration_ms !== undefined && !isDurableWaitMs(data.duration_ms)) {
    report.invalid(
      'wait.duration_ms',
      'wait duration must be a positive integer no greater than 1000 years'
    );
  }
  checkWaitUntil(data.until, report);
  checkWaitEvent(data, report);
  if (data.attention?.trim().length === 0) {
    report.missing('wait.attention', 'wait action message must not be empty');
  }
}

/** Per-variant required-field checks (mirrors the engine's mode-field rules). */
function checkRequiredFields(node: BuilderNode): Issue[] {
  const issues: Issue[] = [];
  const report = fieldReport(node.id, issues);
  // Messages omit the node id — `path.nodeId` carries it, and display layers
  // render the path, so an embedded prefix would double-print.
  switch (node.variant) {
    case 'prompt':
      requireText(report, 'prompt', node.data.prompt, 'prompt must not be empty');
      break;
    case 'command':
      requireText(report, 'command', node.data.command, 'command must not be empty');
      break;
    case 'bash':
      requireText(report, 'bash', node.data.bash, 'bash script must not be empty');
      break;
    case 'script':
      checkScript(node.data, report);
      break;
    case 'loop':
      checkLoop(node.data, node.base.output_format, report);
      break;
    case 'approval':
      requireText(report, 'approval.message', node.data.message, 'approval requires a message');
      break;
    case 'wait':
      checkWait(node.data, report);
      break;
    case 'cancel':
      requireText(report, 'cancel', node.data.reason, 'cancel requires a reason');
      break;
    case 'opaque':
      // Carried verbatim from a file the engine already parsed; the server's
      // validate re-checks it on save. Nothing here the builder could fix.
      break;
  }
  return issues;
}

/** Validate node-id hygiene and per-variant required fields. */
export function validateStructural(workflow: BuilderWorkflow): Issue[] {
  const issues: Issue[] = checkIds(workflow.nodes);
  for (const node of workflow.nodes) {
    issues.push(...checkRequiredFields(node));
  }
  return issues;
}
