/**
 * Zod schemas for DAG node types.
 *
 * Design: a flat "raw" schema validates all fields (with mutual exclusivity enforced via
 * superRefine), then a transform produces one of the six concrete variant types
 * (CommandNode, PromptNode, BashNode, LoopNode, ApprovalNode, CancelNode) as the DagNode union.
 * Per-variant schemas (commandNodeSchema etc.) are exported for type derivation only —
 * use dagNodeSchema for validation.
 *
 * z.union() is NOT used here — YAML nodes lack an explicit `type` discriminant,
 * so a flat schema with superRefine is cleaner than a z.union() with implicit discriminants.
 */
import { z } from '@hono/zod-openapi';
import { stepRetryConfigSchema } from './retry';
import { loopNodeConfigSchema } from './loop';
import { workflowNodeHooksSchema } from './hooks';
import { isValidCommandName } from '../command-validation';
import { isModelCompatible } from '../model-validation';

// ---------------------------------------------------------------------------
// TriggerRule
// ---------------------------------------------------------------------------

export const triggerRuleSchema = z.enum([
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
]);

export type TriggerRule = z.infer<typeof triggerRuleSchema>;

/** Canonical list of trigger rules — derived from schema, do not duplicate. */
export const TRIGGER_RULES: readonly TriggerRule[] = triggerRuleSchema.options;

// ---------------------------------------------------------------------------
// Claude SDK option schemas
// ---------------------------------------------------------------------------

/** Claude Agent SDK effort level — controls reasoning depth. Different from Codex modelReasoningEffort. */
export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'max']);

export type EffortLevel = z.infer<typeof effortLevelSchema>;

/**
 * Claude Agent SDK ThinkingConfig — string shorthand or full object form.
 * Shorthand: 'adaptive' → { type: 'adaptive' }, 'enabled' → { type: 'enabled' }, 'disabled' → { type: 'disabled' }.
 */
export const thinkingConfigSchema = z.preprocess(
  val => {
    if (typeof val === 'string') {
      if (val === 'adaptive') return { type: 'adaptive' };
      if (val === 'enabled') return { type: 'enabled' };
      if (val === 'disabled') return { type: 'disabled' };
    }
    return val;
  },
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('adaptive') }),
    z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().positive().optional() }),
    z.object({ type: z.literal('disabled') }),
  ])
);

export type ThinkingConfig = z.infer<typeof thinkingConfigSchema>;

/**
 * Claude Agent SDK SandboxSettings — OS-level filesystem/network restrictions.
 * Uses passthrough() to match the SDK's loose schema (index signature allows extra fields).
 */
export const sandboxSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    network: z
      .object({
        allowedDomains: z.array(z.string()).optional(),
        allowManagedDomainsOnly: z.boolean().optional(),
        allowUnixSockets: z.array(z.string()).optional(),
        allowAllUnixSockets: z.boolean().optional(),
        allowLocalBinding: z.boolean().optional(),
        httpProxyPort: z.number().optional(),
        socksProxyPort: z.number().optional(),
      })
      .optional(),
    filesystem: z
      .object({
        allowWrite: z.array(z.string()).optional(),
        denyWrite: z.array(z.string()).optional(),
        denyRead: z.array(z.string()).optional(),
      })
      .optional(),
    ignoreViolations: z.record(z.array(z.string())).optional(),
    enableWeakerNestedSandbox: z.boolean().optional(),
    enableWeakerNetworkIsolation: z.boolean().optional(),
    excludedCommands: z.array(z.string()).optional(),
    ripgrep: z
      .object({
        command: z.string(),
        args: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

// ---------------------------------------------------------------------------
// DagNodeBase — common fields shared by all node types
// ---------------------------------------------------------------------------

export const dagNodeBaseSchema = z.object({
  id: z.string(),
  depends_on: z.array(z.string()).optional(),
  when: z.string().optional(),
  trigger_rule: triggerRuleSchema.optional(),
  model: z.string().optional(),
  provider: z.string().trim().min(1).optional(),
  context: z.enum(['fresh', 'shared']).optional(),
  output_format: z.record(z.unknown()).optional(),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
  idle_timeout: z.number().optional(),
  retry: stepRetryConfigSchema.optional(),
  hooks: workflowNodeHooksSchema.optional(),
  mcp: z.string().min(1, "'mcp' must be a non-empty string path").optional(),
  skills: z
    .array(z.string().min(1, 'each skill must be a non-empty string'))
    .nonempty("'skills' must be a non-empty array")
    .optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  maxBudgetUsd: z.number().positive().optional(),
  systemPrompt: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: z.array(z.string().min(1)).nonempty("'betas' must be a non-empty array").optional(),
  sandbox: sandboxSettingsSchema.optional(),
});

export type DagNodeBase = z.infer<typeof dagNodeBaseSchema>;

// ---------------------------------------------------------------------------
// Per-variant schemas — exported for type derivation only (use dagNodeSchema for validation)
// ---------------------------------------------------------------------------

export const commandNodeSchema = dagNodeBaseSchema.extend({
  command: z.string(),
});

/** DAG node that runs a named command from .archon/commands/ */
export type CommandNode = z.infer<typeof commandNodeSchema> & {
  prompt?: never;
  bash?: never;
  loop?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

export const promptNodeSchema = dagNodeBaseSchema.extend({
  prompt: z.string(),
});

/** DAG node with an inline prompt (no command file) */
export type PromptNode = z.infer<typeof promptNodeSchema> & {
  command?: never;
  bash?: never;
  loop?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/**
 * Bash node schema — extends base with `bash` (shell script) and `timeout` (ms).
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 */
export const bashNodeSchema = dagNodeBaseSchema.extend({
  bash: z.string(),
  timeout: z.number().optional(),
});

/** DAG node that runs a shell script without AI */
export type BashNode = z.infer<typeof bashNodeSchema> & {
  command?: never;
  prompt?: never;
  loop?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/**
 * Script node schema — extends base with `script` (inline code or named script),
 * `runtime` ('bun' or 'uv'), `deps` (dependency list), and `timeout` (ms).
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 */
export const scriptNodeSchema = dagNodeBaseSchema.extend({
  script: z.string().min(1, 'script cannot be empty'),
  runtime: z.enum(['bun', 'uv']),
  deps: z.array(z.string().min(1, 'each dep must be a non-empty string')).optional(),
  timeout: z.number().optional(),
});

/** DAG node that runs a TypeScript or Python script via bun or uv */
export type ScriptNode = z.infer<typeof scriptNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  approval?: never;
  cancel?: never;
};

/**
 * Loop node schema — extends base with `loop` config.
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 * retry is not supported on loop nodes (enforced at parse time).
 */
export const loopNodeSchema = dagNodeBaseSchema.extend({
  loop: loopNodeConfigSchema,
});

/** DAG node that runs an AI prompt in a loop until a completion condition is met */
export type LoopNode = z.infer<typeof loopNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/** Schema for the `on_reject` sub-object on approval nodes. */
export const approvalOnRejectSchema = z.object({
  prompt: z.string().min(1, "'on_reject.prompt' must be a non-empty string"),
  max_attempts: z.number().int().min(1).max(10).optional(),
});

export type ApprovalOnReject = z.infer<typeof approvalOnRejectSchema>;

/**
 * Approval node schema — pauses the workflow for human review.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 */
export const approvalNodeSchema = dagNodeBaseSchema.extend({
  approval: z.object({
    message: z.string().min(1, "'approval.message' must not be empty"),
    capture_response: z.boolean().optional(),
    on_reject: approvalOnRejectSchema.optional(),
  }),
});

/** DAG node that pauses workflow execution for human approval */
export type ApprovalNode = z.infer<typeof approvalNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  cancel?: never;
  script?: never;
};

/**
 * Cancel node schema — terminates the workflow run with a reason string.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 */
export const cancelNodeSchema = dagNodeBaseSchema.extend({
  cancel: z.string().min(1, "'cancel' reason must not be empty"),
});

/** DAG node that cancels the workflow run with a reason string */
export type CancelNode = z.infer<typeof cancelNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  approval?: never;
  script?: never;
};

/** A single node in a DAG workflow. command, prompt, bash, loop, approval, cancel, and script are mutually exclusive. */
export type DagNode =
  | CommandNode
  | PromptNode
  | BashNode
  | LoopNode
  | ApprovalNode
  | CancelNode
  | ScriptNode;

// ---------------------------------------------------------------------------
// AI-specific fields that are meaningless on bash/loop nodes
// ---------------------------------------------------------------------------

/** AI-specific fields that are meaningless on bash/loop nodes — exported for loader warnings */
export const BASH_NODE_AI_FIELDS: readonly string[] = [
  'provider',
  'model',
  'context',
  'output_format',
  'allowed_tools',
  'denied_tools',
  'hooks',
  'mcp',
  'skills',
  'effort',
  'thinking',
  'maxBudgetUsd',
  'systemPrompt',
  'fallbackModel',
  'betas',
  'sandbox',
];

/** AI-specific fields that are meaningless on script nodes — same as bash nodes */
export const SCRIPT_NODE_AI_FIELDS: readonly string[] = BASH_NODE_AI_FIELDS;

// ---------------------------------------------------------------------------
// dagNodeSchema — flat validation schema with transform to DagNode
// ---------------------------------------------------------------------------

/**
 * Validates a raw YAML object as a DAG node and transforms it to a typed DagNode.
 *
 * Enforces:
 * - Non-empty id
 * - Exactly one of command/prompt/bash/loop (mutual exclusivity)
 * - command name validity (via isValidCommandName)
 * - Model/provider compatibility (via isModelCompatible)
 * - idle_timeout must be a finite positive number
 * - retry not allowed on loop nodes
 * - timeout on bash must be positive
 */
export const dagNodeSchema = dagNodeBaseSchema
  .extend({
    // Mode fields (exactly one required)
    command: z.string().optional(),
    prompt: z.string().optional(),
    bash: z.string().optional(),
    loop: loopNodeConfigSchema.optional(),
    approval: z
      .object({
        message: z.string().min(1, "'approval.message' must not be empty"),
        capture_response: z.boolean().optional(),
        on_reject: approvalOnRejectSchema.optional(),
      })
      .optional(),
    cancel: z.string().optional(),
    // Script-only
    script: z.string().optional(),
    runtime: z.enum(['bun', 'uv']).optional(),
    deps: z.array(z.string().min(1, 'each dep must be a non-empty string')).optional(),
    // Bash/Script shared
    timeout: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    const id = data.id.trim();

    // id must be non-empty
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing required field 'id'",
        path: ['id'],
      });
      return z.NEVER;
    }

    const hasCommand = typeof data.command === 'string' && data.command.trim().length > 0;
    const hasPrompt = typeof data.prompt === 'string' && data.prompt.trim().length > 0;
    const hasBash = typeof data.bash === 'string' && data.bash.trim().length > 0;
    const hasLoop = data.loop !== undefined;
    const hasApproval = data.approval !== undefined;
    const hasCancel = typeof data.cancel === 'string' && data.cancel.trim().length > 0;
    const hasScript = typeof data.script === 'string' && data.script.trim().length > 0;

    const modeCount = [
      hasCommand,
      hasPrompt,
      hasBash,
      hasLoop,
      hasApproval,
      hasCancel,
      hasScript,
    ].filter(Boolean).length;

    if (modeCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'command', 'prompt', 'bash', 'loop', 'approval', 'cancel', and 'script' are mutually exclusive",
      });
      return z.NEVER;
    }
    if (modeCount === 0) {
      if (typeof data.bash === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'bash script cannot be empty',
          path: ['bash'],
        });
        return z.NEVER;
      }
      if (typeof data.prompt === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'prompt cannot be empty',
          path: ['prompt'],
        });
        return z.NEVER;
      }
      if (typeof data.script === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'script cannot be empty',
          path: ['script'],
        });
        return z.NEVER;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "must have either 'command', 'prompt', 'bash', 'loop', 'approval', 'cancel', or 'script'",
      });
      return z.NEVER;
    }

    // Command name validation
    if (hasCommand && !isValidCommandName((data.command ?? '').trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid command name "${(data.command ?? '').trim()}"`,
        path: ['command'],
      });
    }

    // Bash node validations
    if (hasBash) {
      if (data.timeout !== undefined && (data.timeout <= 0 || !isFinite(data.timeout))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'timeout' must be a positive number (ms)",
          path: ['timeout'],
        });
      }
    }

    // Script node validations
    if (hasScript) {
      if (data.runtime === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'runtime' is required for script nodes ('bun' or 'uv')",
          path: ['runtime'],
        });
      }
      if (data.timeout !== undefined && (data.timeout <= 0 || !isFinite(data.timeout))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'timeout' must be a positive number (ms)",
          path: ['timeout'],
        });
      }
    }

    // Loop node: retry not supported
    if (hasLoop && data.retry !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'retry' is not supported on loop nodes (loop manages its own iteration)",
        path: ['retry'],
      });
    }

    // idle_timeout must be finite and positive
    if (
      data.idle_timeout !== undefined &&
      (data.idle_timeout <= 0 || !isFinite(data.idle_timeout))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'idle_timeout' must be a finite positive number (ms)",
        path: ['idle_timeout'],
      });
    }

    // Provider/model compatibility (AI nodes only)
    if (!hasBash && !hasLoop && !hasScript && data.provider && data.model) {
      try {
        if (!isModelCompatible(data.provider, data.model)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `model "${data.model}" is not compatible with provider "${data.provider}"`,
          });
        }
      } catch (e) {
        // isModelCompatible throws on unknown providers — surface as a validation issue
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: (e as Error).message,
        });
      }
    }
  })
  .transform((data): DagNode => {
    const id = data.id.trim();

    // Common base fields (sparse — only include defined values)
    const base = {
      id,
      ...(data.depends_on !== undefined && data.depends_on.length > 0
        ? { depends_on: data.depends_on }
        : {}),
      ...(data.when !== undefined ? { when: data.when } : {}),
      ...(data.trigger_rule !== undefined ? { trigger_rule: data.trigger_rule } : {}),
      ...(data.idle_timeout !== undefined ? { idle_timeout: data.idle_timeout } : {}),
    };

    // Shared optional fields (valid on AI and bash nodes)
    const shared = {
      ...(data.retry !== undefined ? { retry: data.retry } : {}),
    };

    // AI-only fields (not applicable to bash/loop nodes)
    const aiOnly = {
      ...(data.model !== undefined ? { model: data.model } : {}),
      ...(data.provider !== undefined ? { provider: data.provider } : {}),
      ...(data.context !== undefined ? { context: data.context } : {}),
      ...(data.output_format !== undefined ? { output_format: data.output_format } : {}),
      ...(data.allowed_tools !== undefined ? { allowed_tools: data.allowed_tools } : {}),
      ...(data.denied_tools !== undefined ? { denied_tools: data.denied_tools } : {}),
      ...(data.hooks !== undefined ? { hooks: data.hooks } : {}),
      ...(data.mcp !== undefined ? { mcp: data.mcp.trim() } : {}),
      ...(data.skills !== undefined ? { skills: data.skills.map(s => s.trim()) } : {}),
      ...(data.effort !== undefined ? { effort: data.effort } : {}),
      ...(data.thinking !== undefined ? { thinking: data.thinking } : {}),
      ...(data.maxBudgetUsd !== undefined ? { maxBudgetUsd: data.maxBudgetUsd } : {}),
      ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
      ...(data.fallbackModel !== undefined ? { fallbackModel: data.fallbackModel } : {}),
      ...(data.betas !== undefined ? { betas: data.betas } : {}),
      ...(data.sandbox !== undefined ? { sandbox: data.sandbox } : {}),
    };

    if (data.command !== undefined && data.command.trim().length > 0) {
      return { ...base, ...shared, ...aiOnly, command: data.command.trim() } as CommandNode;
    }
    if (data.prompt !== undefined && data.prompt.trim().length > 0) {
      return { ...base, ...shared, ...aiOnly, prompt: data.prompt.trim() } as PromptNode;
    }
    if (data.bash !== undefined && data.bash.trim().length > 0) {
      return {
        ...base,
        ...shared,
        bash: data.bash.trim(),
        ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      } as BashNode;
    }
    if (data.script !== undefined && data.script.trim().length > 0) {
      // runtime is guaranteed by superRefine to be defined at this point
      if (!data.runtime) throw new Error('unreachable: runtime must be defined for script nodes');
      return {
        ...base,
        ...shared,
        script: data.script.trim(),
        runtime: data.runtime,
        ...(data.deps !== undefined ? { deps: data.deps } : {}),
        ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      } as ScriptNode;
    }
    if (data.approval !== undefined) {
      return { ...base, ...shared, approval: data.approval } as ApprovalNode;
    }
    if (data.cancel !== undefined && data.cancel.trim().length > 0) {
      return { ...base, ...shared, cancel: data.cancel.trim() } as CancelNode;
    }
    // loop — guaranteed by superRefine to be defined at this point
    if (!data.loop) throw new Error('unreachable: loop must be defined after superRefine');
    return { ...base, loop: data.loop } as LoopNode;
  })
  .openapi('DagNode');

// ---------------------------------------------------------------------------
// Type guards (preserved from original types.ts)
// ---------------------------------------------------------------------------

/** Type guard: check if a DAG node is a bash (shell script) node */
export function isBashNode(node: DagNode): node is BashNode {
  return 'bash' in node && typeof node.bash === 'string';
}

/** Type guard: check if a DAG node is a loop (iterative) node */
export function isLoopNode(node: DagNode): node is LoopNode {
  return 'loop' in node && typeof node.loop === 'object' && node.loop !== null;
}

/** Type guard: check if a DAG node is an approval (human-in-the-loop) node */
export function isApprovalNode(node: DagNode): node is ApprovalNode {
  return 'approval' in node && typeof node.approval === 'object' && node.approval !== null;
}

/** Type guard: check if a DAG node is a cancel (workflow termination) node */
export function isCancelNode(node: DagNode): node is CancelNode {
  return 'cancel' in node && typeof node.cancel === 'string';
}

/** Type guard: check if a DAG node is a script node */
export function isScriptNode(node: DagNode): node is ScriptNode {
  return 'script' in node && typeof node.script === 'string';
}

/** Type guard: validates a value is a known TriggerRule */
export function isTriggerRule(value: unknown): value is TriggerRule {
  return typeof value === 'string' && (TRIGGER_RULES as readonly string[]).includes(value);
}
