/**
 * The fields every DAG node kind shares, and the small vocabularies they use.
 * Each kind's own schema extends `dagNodeBaseSchema` from its own module.
 */
import { SETTING_SOURCES } from '@archon/paths/skills';
import { z } from 'zod';
import { agentDefinitionSchema } from '@archon/provider-contract';
import { stepRetryConfigSchema } from './retry';
import { effortLevelSchema } from './effort';
import { modelRefSchema } from './model-binding';
import {
  betasSchema,
  nodeMcpSchema,
  piNodeConfigSchema,
  sandboxSettingsSchema,
} from './provider-options';
import { workflowNodeHooksSchema } from './hooks';

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

/** Type guard: validates a value is a known TriggerRule */
export function isTriggerRule(value: unknown): value is TriggerRule {
  return typeof value === 'string' && (TRIGGER_RULES as readonly string[]).includes(value);
}

export const nodeContextResumeSchema = z.object({
  resume: z.string().trim().min(1, "'context.resume' must name a node"),
});

export const nodeContextSchema = z.union([z.enum(['fresh', 'shared']), nodeContextResumeSchema]);

export type NodeContext = z.infer<typeof nodeContextSchema>;

export function isNodeContextResume(
  context: NodeContext | undefined
): context is { resume: string } {
  return typeof context === 'object' && context !== null && 'resume' in context;
}

// Kebab-case: no leading/trailing/double hyphens (e.g. `brief-gen`, not `-brief`, `brief-`, `brief--gen`).
export const AGENT_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// DagNodeBase — common fields shared by all node types
// ---------------------------------------------------------------------------

export const dagNodeBaseSchema = z.object({
  id: z.string(),
  // Optional human-readable documentation for the node. Purely informational —
  // the executor never reads it. Declared so workflow authors can self-document
  // nodes inline in the YAML instead of Zod silently stripping the field (#2012).
  description: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  when: z.string().optional(),
  trigger_rule: triggerRuleSchema.optional(),
  model: modelRefSchema.optional(),
  provider: z.string().trim().min(1).optional(),
  context: nodeContextSchema.optional(),
  output_format: z.record(z.string(), z.unknown()).optional(),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
  idle_timeout: z.number().optional(),
  retry: stepRetryConfigSchema.optional(),
  hooks: workflowNodeHooksSchema.optional(),
  mcp: nodeMcpSchema.optional(),
  skills: z.array(z.string().min(1, 'each skill must be a non-empty string')).optional(),
  // Exact provider plugin ids (Claude: `name@marketplace`). A workflow node loads
  // only the plugins it names; the provider fails the node when it cannot.
  plugins: z.array(z.string().trim().min(1, 'each plugin must be a non-empty string')).optional(),
  agents: z
    .record(z.string(), agentDefinitionSchema)
    // Validate agent-id keys in a superRefine rather than via a regex on the
    // record key schema: zod v4 collapses a failing key-schema into a generic
    // "Invalid key in record" message and drops the custom text, so the
    // kebab-case guidance is emitted here (with the offending key in the path).
    .superRefine((map, ctx) => {
      for (const key of Object.keys(map)) {
        if (!AGENT_ID_REGEX.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `agent IDs must be kebab-case (a-z, 0-9, hyphen): '${key}'`,
            path: [key],
          });
        }
      }
    })
    .refine(map => Object.keys(map).length > 0, "'agents' must have at least one entry")
    .optional(),
  // Portable per-node Pi extension posture (#2133). Highest-precedence layer
  // over the install-level `assistants.pi.nodes.<id>` map. Pi-only; ignored
  // (with a warning) on other providers and on non-AI node types.
  pi: piNodeConfigSchema.optional(),
  effort: effortLevelSchema.optional(),
  maxBudgetUsd: z.number().positive().optional(),
  // YAML workflows: string-only. The wider SystemPromptInput (preset object) is used
  // programmatically by the orchestrator for prompt caching; Zod intentionally stays narrow.
  systemPrompt: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
  // Per-node override for which filesystem setting sources Claude loads
  // (CLAUDE.md, skills, commands, agents). Omitting it inherits the
  // assistant-level default (['project', 'user'] when unset). Claude-only;
  // other providers warn and ignore it. Lets a lean node (e.g. a reviewer)
  // skip project/user context loading for faster startup.
  settingSources: z.array(z.enum(SETTING_SOURCES)).optional(),
  betas: betasSchema.optional(),
  sandbox: sandboxSettingsSchema.optional(),
  // Opt out of resume caching: when true, this node re-runs on resume even if a
  // prior run completed it successfully. Use for producers whose exit code does
  // not capture output validity (e.g. bash that writes a file the consumer parses).
  always_run: z.boolean().optional(),
  // Post-run tree-integrity assertion (#2771): when explicitly `false`, the engine
  // snapshots the git working tree before the node runs and fails the node with an
  // error naming it if the snapshot changed — outside the run's engine-owned
  // directories (artifacts/state/logs). Enforced for exec and agent nodes; warned
  // as ignored on wait and workflow (sub-run) nodes, whose execution is not a
  // single checkout-scoped payload. Absent means no enforcement. A layer of guarded
  // nodes only runs concurrently; a layer mixing guarded nodes with any node that
  // isn't checkout-guarded runs sequentially so a sibling's write is never blamed on
  // a guarded node.
  mutates_checkout: z.boolean().optional(),
  // Persist this node's provider session ID across workflow re-runs in the same
  // scope (typically the conversation). The next run in that scope forks the session
  // that existed when it started; a provider without sessionFork starts fresh
  // instead (see `persistedSessionHandling`). Requires a provider with sessionResume
  // capability.
  persist_session: z.boolean().optional(),
  // Declares the semantic type of this node's output (e.g. 'plan', 'findings',
  // 'code', 'summary' — an open set). When set, the executor writes a typed
  // sidecar artifact (`nodes/<id>.md` + `<id>.meta.json`) after the node
  // completes, so other nodes and later runs can locate output by type instead
  // of guessing filenames. Valid on every node type (bash/script produce typed
  // outputs too) — not an AI-only field.
  output_type: z.string().min(1).optional(),
});

export type DagNodeBase = z.infer<typeof dagNodeBaseSchema>;
