import { z } from 'zod';
import { trustedTextBindingSchema } from './schemas/resource-start';
import type { ResolvedWorkflow } from './schemas';
import type { WorkflowDeps } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import type { WorkflowRun } from './schemas/workflow-run';

const actorSchema = z.object({
  host: z.string().min(1),
  id: z.string().min(1),
  login: z.string().min(1).nullable().optional(),
});

export const trustedTextRunMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  requirement: trustedTextBindingSchema,
  title: z.string(),
  body: z.string(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  policy: z.object({
    head: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    maintainers: z.array(z.string().min(1)),
  }),
  acceptedBy: actorSchema.optional(),
});
export type TrustedTextRunMetadata = z.infer<typeof trustedTextRunMetadataSchema>;

export const TRUSTED_TEXT_METADATA_KEY = 'trusted_text';

export function readTrustedTextMetadata(run: {
  metadata: Record<string, unknown> | null | undefined;
}): TrustedTextRunMetadata | undefined {
  const value = run.metadata?.[TRUSTED_TEXT_METADATA_KEY];
  return value === undefined ? undefined : trustedTextRunMetadataSchema.parse(value);
}

export interface TrustedTextEvidence {
  subject: TrustedTextRunMetadata['requirement']['subject'];
  title: string;
  body: string;
  author?: z.infer<typeof actorSchema> | null;
  policy: TrustedTextRunMetadata['policy'] & { maintainersPath: string };
}

export interface WorkflowTrustedTextHost {
  requirementForItem?(itemId: string): Promise<TrustedTextRunMetadata['requirement'] | null>;
  requirementForStart?(
    codebaseId: string,
    itemKey: string
  ): Promise<TrustedTextRunMetadata['requirement'] | null>;
  declare?(
    requirement: TrustedTextRunMetadata['requirement'],
    project: { codebaseId: string; itemKey: string }
  ): Promise<void>;
  authorizeItem?(
    requirement: TrustedTextRunMetadata['requirement'],
    itemId: string
  ): Promise<TrustedTextRunMetadata>;
  readEvidence(requirement: TrustedTextRunMetadata['requirement']): Promise<TrustedTextEvidence>;
  /** Returns a frozen accepted/trusted-author snapshot, or a stable refusal code. */
  authorize(
    requirement: TrustedTextRunMetadata['requirement'],
    project: {
      codebase: { id: string; default_cwd: string; kind: 'repo' | 'folder'; name: string };
      itemKey: string;
    }
  ): Promise<TrustedTextRunMetadata>;
  /** Recheck current evidence against the frozen snapshot; no current text is returned. */
  recheck(snapshot: TrustedTextRunMetadata): Promise<void>;
}

/** Protected mode currently supports only nodes without a shell or remote-read side channel. */
export function assertTrustedTextWorkflowSupported(
  workflow: Pick<ResolvedWorkflow, 'nodes' | 'webSearchMode'>
): void {
  if (workflow.webSearchMode !== 'disabled') throw new Error('trusted_text_web_bypass');
  for (const node of workflow.nodes) {
    const problem = trustedNodeProblem(node);
    if (problem) throw new Error(problem);
  }
}

function trustedNodeProblem(node: ResolvedWorkflow['nodes'][number]): string | undefined {
  if (node.kind === 'wait') return undefined;
  if (node.kind !== 'agent') return 'trusted_text_unsupported_node';
  if (node.mcp !== undefined) return 'trusted_text_mcp_bypass';
  if ((node.plugins?.length ?? 0) > 0) return 'trusted_text_plugin_bypass';
  if (node.agents !== undefined) return 'trusted_text_subagent_bypass';
  if (node.hooks !== undefined) return 'trusted_text_hook_bypass';
  const tools = node.allowed_tools;
  if (!tools || tools.some(tool => !['Read', 'Grep', 'Glob'].includes(tool)))
    return 'trusted_text_direct_read_bypass';
  return undefined;
}

export async function requirePreparedTrustedStart(
  deps: WorkflowDeps,
  opts: Pick<ExecuteWorkflowOptions, 'item' | 'codebaseId'>
): Promise<void> {
  if (!opts.item || !opts.codebaseId || !deps.trustedText?.requirementForStart) return;
  const requirement = await deps.trustedText.requirementForStart(opts.codebaseId, opts.item);
  if (requirement) throw new Error('trusted_text_prepared_start_required');
}

export async function recheckTrustedTextAdmission(
  deps: WorkflowDeps,
  workflow: ResolvedWorkflow,
  run: WorkflowRun
): Promise<void> {
  const snapshot = readTrustedTextMetadata(run);
  if (!snapshot) return;
  if (!deps.trustedText) throw new Error('trusted_text_host_unavailable');
  assertTrustedTextWorkflowSupported(workflow);
  await deps.trustedText.recheck(snapshot);
}
