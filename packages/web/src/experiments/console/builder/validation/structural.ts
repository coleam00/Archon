/**
 * Structural validation: node-id hygiene (non-empty, unique) and per-variant
 * required-field checks. Hand-rolled to match the engine's superRefine intent
 * without depending on a runtime schema.
 */
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import { OUTPUT_REF_SOURCE } from '@/lib/node-ref';
import { makeIssue } from './make-issue';

const waitTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z$/;
const wholeInputsRefPattern = /^\$INPUTS\.[a-zA-Z_][a-zA-Z0-9_-]*$/;
// @archon/web cannot import workflow runtime values. Keep aligned with
// MAX_DURABLE_WAIT_MS in @archon/workflows/schemas/dag-node.
const MAX_DURABLE_WAIT_MS = 1_000 * 365 * 24 * 60 * 60 * 1_000;

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

/** Per-variant required-field checks (mirrors the engine's mode-field rules). */
function checkRequiredFields(node: BuilderNode): Issue[] {
  const issues: Issue[] = [];
  const missing = (field: string, message: string): void => {
    issues.push(
      makeIssue({
        rule: 'structural.field.missing',
        severity: 'error',
        source: 'client-instant',
        message,
        path: { nodeId: node.id, field },
      })
    );
  };
  // Distinct from `missing`: the field is present but holds an invalid value, so
  // the UI shouldn't render it as a required-but-empty field.
  const invalid = (field: string, message: string): void => {
    issues.push(
      makeIssue({
        rule: 'structural.field.invalid',
        severity: 'error',
        source: 'client-instant',
        message,
        path: { nodeId: node.id, field },
      })
    );
  };

  // Messages omit the node id — `path.nodeId` carries it, and display layers
  // render the path, so an embedded prefix would double-print.
  switch (node.variant) {
    case 'prompt':
      if (node.data.prompt.trim().length === 0) missing('prompt', 'prompt must not be empty');
      break;
    case 'command':
      if (node.data.command.trim().length === 0) missing('command', 'command must not be empty');
      break;
    case 'bash':
      if (node.data.bash.trim().length === 0) missing('bash', 'bash script must not be empty');
      break;
    case 'script':
      if (node.data.script.trim().length === 0) missing('script', 'script must not be empty');
      if (node.data.runtime !== 'bun' && node.data.runtime !== 'uv')
        invalid('runtime', "script requires runtime 'bun' or 'uv'");
      break;
    case 'loop':
      // One-of rule (mirrors the engine schema): exactly one prompt source,
      // and whichever is present must be non-empty.
      if (node.data.prompt !== undefined && node.data.command !== undefined)
        invalid('loop.command', "loop accepts exactly one of 'prompt' or 'command', not both");
      else if (node.data.command !== undefined) {
        if (node.data.command.trim().length === 0)
          missing('loop.command', 'loop requires a command name');
      } else if ((node.data.prompt ?? '').trim().length === 0)
        missing('loop.prompt', 'loop requires a prompt (or a command file)');
      // Completion channels (#2563) — a hand-written mirror of the two rules in
      // the engine's `loopControlSchema`, because @archon/web cannot import
      // @archon/workflows. Keep the pair in step; verify by parsing both, not by
      // reading them — `scripts/node-ref-parity.test.ts` does exactly that, in CI.
      //
      // 1. A declared channel must be non-blank. Blank is broken at runtime, not
      //    just untidy: `bash -c "   "` exits 0, and a blank signal matches any
      //    whitespace-only line in the model's output.
      if (node.data.until?.trim().length === 0)
        missing('loop.until', "loop requires a non-blank 'until' signal");
      if (node.data.until_bash?.trim().length === 0)
        missing('loop.until_bash', "loop requires a non-blank 'until_bash' check");
      if (node.data.until_field?.trim().length === 0)
        missing('loop.until_field', "loop requires a non-blank 'until_field' name");
      // 2. At least one channel must be declared at all.
      if (
        node.data.until === undefined &&
        node.data.until_bash === undefined &&
        node.data.until_field === undefined
      )
        missing(
          'loop.until',
          "loop requires a completion channel: an 'until' signal, an 'until_bash' check, or an 'until_field' name"
        );
      if (!Number.isInteger(node.data.max_iterations) || node.data.max_iterations <= 0)
        invalid('loop.max_iterations', 'loop requires a positive integer max_iterations');
      break;
    case 'approval':
      if (node.data.message.trim().length === 0)
        missing('approval.message', 'approval requires a message');
      break;
    case 'wait': {
      const conditions = [node.data.duration_ms, node.data.until, node.data.event].filter(
        value => value !== undefined
      );
      if (conditions.length !== 1) {
        invalid('wait', "wait requires exactly one of 'duration_ms', 'until', or 'event'");
      }
      if (
        node.data.duration_ms !== undefined &&
        (!Number.isInteger(node.data.duration_ms) ||
          node.data.duration_ms <= 0 ||
          node.data.duration_ms > MAX_DURABLE_WAIT_MS)
      ) {
        invalid(
          'wait.duration_ms',
          'wait duration must be a positive integer no greater than 1000 years'
        );
      }
      if (node.data.until?.trim().length === 0) {
        missing('wait.until', 'wait timestamp must not be empty');
      } else if (node.data.until !== undefined && !isValidWaitTimestamp(node.data.until)) {
        invalid(
          'wait.until',
          'wait timestamp must be an ISO-8601 UTC timestamp or contain a runtime reference'
        );
      }
      if (node.data.event?.trim().length === 0)
        missing('wait.event', 'wait event must not be empty');
      if (
        node.data.event !== undefined &&
        (node.data.deadline_ms === undefined ||
          !Number.isInteger(node.data.deadline_ms) ||
          node.data.deadline_ms <= 0 ||
          node.data.deadline_ms > MAX_DURABLE_WAIT_MS)
      ) {
        invalid(
          'wait.deadline_ms',
          'event waits require a positive integer deadline no greater than 1000 years'
        );
      }
      if (node.data.event === undefined && node.data.deadline_ms !== undefined) {
        invalid('wait.deadline_ms', 'deadline is only supported for event waits');
      }
      break;
    }
    case 'cancel':
      if (node.data.reason.trim().length === 0) missing('cancel', 'cancel requires a reason');
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
