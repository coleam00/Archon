/**
 * Zod schemas for per-node hook configuration.
 */
import { z } from '@hono/zod-openapi';

/**
 * Supported hook events for per-node hooks.
 * Uses the same event names as the Claude Agent SDK's HookEvent type.
 */
export const workflowHookEventSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'Setup',
  'TeammateIdle',
  'TaskCompleted',
  'TaskCreated',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
]);

export type WorkflowHookEvent = z.infer<typeof workflowHookEventSchema>;

/** Canonical list of hook events — derived from schema, do not duplicate. */
export const WORKFLOW_HOOK_EVENTS: readonly WorkflowHookEvent[] = workflowHookEventSchema.options;

/**
 * A single hook matcher in a YAML workflow definition.
 * Maps 1:1 to the SDK's HookCallbackMatcher.
 *
 * Exactly one of `response` (static JSON) or `command` (dynamic shell script) must be set.
 */
export const workflowHookMatcherSchema = z
  .object({
    /** Regex pattern to match tool names (PreToolUse/PostToolUse) or event subtypes. */
    matcher: z.string().optional(),
    /** Static: the SDK SyncHookJSONOutput to return when this hook fires. */
    response: z.record(z.unknown()).optional(),
    /**
     * Dynamic: shell command to run when this hook fires.
     * Receives hook input as JSON on stdin; must write SyncHookJSONOutput JSON to stdout.
     * Non-zero exit code is treated as a hook failure (logged, response ignored).
     */
    command: z.string().min(1).optional(),
    /** Timeout in seconds (default: SDK default of 60). */
    timeout: z.number().positive().optional(),
  })
  .refine(m => (m.response !== undefined) !== (m.command !== undefined), {
    message: 'Exactly one of "response" or "command" must be set on a hook matcher',
  });

export type WorkflowHookMatcher = z.infer<typeof workflowHookMatcherSchema>;

/**
 * Per-node hook configuration keyed by event name.
 * Each event maps to an array of matchers with static responses.
 *
 * Fields are listed explicitly (not z.record) so TypeScript narrows event names
 * to the WorkflowHookEvent union. `.strict()` rejects unknown keys, producing
 * clear validation errors for typos like 'preToolUse'.
 */
export const workflowNodeHooksSchema = z
  .object({
    PreToolUse: z.array(workflowHookMatcherSchema).optional(),
    PostToolUse: z.array(workflowHookMatcherSchema).optional(),
    PostToolUseFailure: z.array(workflowHookMatcherSchema).optional(),
    Notification: z.array(workflowHookMatcherSchema).optional(),
    UserPromptSubmit: z.array(workflowHookMatcherSchema).optional(),
    SessionStart: z.array(workflowHookMatcherSchema).optional(),
    SessionEnd: z.array(workflowHookMatcherSchema).optional(),
    Stop: z.array(workflowHookMatcherSchema).optional(),
    StopFailure: z.array(workflowHookMatcherSchema).optional(),
    SubagentStart: z.array(workflowHookMatcherSchema).optional(),
    SubagentStop: z.array(workflowHookMatcherSchema).optional(),
    PreCompact: z.array(workflowHookMatcherSchema).optional(),
    PostCompact: z.array(workflowHookMatcherSchema).optional(),
    PermissionRequest: z.array(workflowHookMatcherSchema).optional(),
    Setup: z.array(workflowHookMatcherSchema).optional(),
    TeammateIdle: z.array(workflowHookMatcherSchema).optional(),
    TaskCompleted: z.array(workflowHookMatcherSchema).optional(),
    TaskCreated: z.array(workflowHookMatcherSchema).optional(),
    Elicitation: z.array(workflowHookMatcherSchema).optional(),
    ElicitationResult: z.array(workflowHookMatcherSchema).optional(),
    ConfigChange: z.array(workflowHookMatcherSchema).optional(),
    WorktreeCreate: z.array(workflowHookMatcherSchema).optional(),
    WorktreeRemove: z.array(workflowHookMatcherSchema).optional(),
    InstructionsLoaded: z.array(workflowHookMatcherSchema).optional(),
    CwdChanged: z.array(workflowHookMatcherSchema).optional(),
    FileChanged: z.array(workflowHookMatcherSchema).optional(),
  })
  .strict();

export type WorkflowNodeHooks = z.infer<typeof workflowNodeHooksSchema>;
