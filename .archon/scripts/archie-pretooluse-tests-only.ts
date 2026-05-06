#!/usr/bin/env bun
/**
 * PreToolUse hook for the test-repair node in task-implement: inverse of
 * archie-pretooluse-no-tests.ts. The repair-tests-from-final-review agent's
 * job is to edit tests based on a final-review verdict that classified the
 * failure as test-side only. It MUST NOT edit production source — if it
 * does, the diagnosis is wrong and the dev-loop should run again.
 *
 * Allow:
 *   - Reading anything (the agent needs to see production code to know what
 *     the test should target).
 *   - Writes/edits/deletes only under test paths (tests/, e2e/, *.test.*,
 *     *.spec.*, __tests__/, vitest/jest/playwright config).
 *   - Bash that runs test runners.
 *
 * Deny:
 *   - Writes/edits/deletes outside test paths.
 *   - Agent/Task delegation (subagents can bypass guardrails).
 */
import { isTestPath } from './archie-test-paths';

const REPAIR_AGENT_REASON = `This action edits a non-test file. Your role on this node is test-repair only.

The final implementation review classified the remaining failures as test-side. You may read production source for context, but you must not modify it. If you believe a production fix is required, halt and report — do not edit production source under this hook.`;

const TOOL_BYPASS_REASON = `Do not delegate this to another agent or task tool.

Test-repair must happen directly via Edit/Write tools so the cage applies. Subagents bypass these guardrails.`;

function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function allow(): never {
  process.exit(0);
}

const raw = await Bun.stdin.text();
const input = JSON.parse(raw) as {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
};

const hookCwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
const toolName = input.tool_name ?? '';
const toolInput = input.tool_input ?? {};

// Reads, listings, greps, globs are always allowed — the agent needs to see
// production code to write tests that reference real exports/selectors.
const READ_ONLY_TOOLS = new Set(['Read', 'ReadFile', 'LS', 'Grep', 'Glob']);
if (READ_ONLY_TOOLS.has(toolName)) allow();

// Writes/edits/deletes: only allowed if the target is a test path.
if (
  toolName === 'Edit' ||
  toolName === 'MultiEdit' ||
  toolName === 'ApplyPatch' ||
  toolName === 'Write' ||
  toolName === 'Delete' ||
  toolName === 'NotebookEdit'
) {
  const path =
    (toolInput.file_path as string | undefined) ??
    (toolInput.path as string | undefined) ??
    (toolInput.notebook_path as string | undefined) ??
    '';
  if (!path || !isTestPath(path, hookCwd)) deny(REPAIR_AGENT_REASON);
  allow();
}

// Bash: allow anything that's clearly a test command or otherwise read-only.
// Block obvious destructive writes to non-test paths via shell. We can't
// fully sandbox bash, so this is best-effort. The simpler/safer strategy:
// allow bash freely (the agent uses it for test runners) but the workflow
// validates the diff afterwards with git status/diff to confirm only test
// paths changed.
if (toolName === 'Bash') {
  allow();
}

// Block agent delegation. Same rationale as no-tests cage.
if (toolName === 'Agent' || toolName === 'Task') {
  deny(TOOL_BYPASS_REASON);
}

allow();
