import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas/workflow-run';
import type { ResolvedWorkflow } from './schemas/workflow';
import { resolveDeclaredInputs } from './workflow-inputs';
import type { WorkflowDeps } from './deps';
import {
  prepareWorkflowSource,
  finalizeWorkflowSource,
  preparedWorkflowSourceMetadata,
  recordSelectedWorkflow,
  withCapturedSource,
} from './executor';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import { WORKFLOW_SOURCE_METADATA_KEY, SUBRUN_METADATA_KEYS } from './schemas/workflow-run';

const identity = z.string().trim().min(1).max(256);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const common = {
  id: identity,
  workflow: identity,
  sourceRoot: z.string().refine(isAbsolute, 'Source root must be absolute'),
  source: z.enum(['project', 'global', 'bundled']),
  codebaseId: identity,
  inputs: z.record(z.string(), z.string()).default({}),
  facts: z
    .record(
      z.string(),
      z.enum(['eventId', 'repository', 'issueNumber', 'issueUrl', 'actor', 'tick', 'scheduleId'])
    )
    .default({}),
  overlap: z.enum(['allow', 'skip']),
};

/** Install-owned routing, never populated from an event payload. */
export const triggerBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('schedule'), scheduleId: identity }),
  z.strictObject({
    ...common,
    kind: z.literal('github.issue'),
    repository,
    actors: z.array(identity).min(1),
    action: z.enum(['opened', 'labeled']),
    label: identity.optional(),
  }),
]);
export type TriggerBinding = z.infer<typeof triggerBindingSchema>;
export const triggerBindingsSchema = z.array(triggerBindingSchema).superRefine((bindings, ctx) => {
  if (new Set(bindings.map(b => b.id)).size !== bindings.length)
    ctx.addIssue({ code: 'custom', message: 'Trigger ids must be unique' });
  for (const b of bindings) {
    if (b.kind === 'schedule' && b.overlap !== 'skip')
      ctx.addIssue({ code: 'custom', message: 'Scheduled triggers require overlap: skip' });
    if (b.kind === 'github.issue' && (b.action === 'labeled') !== (b.label !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Only labeled triggers require a label' });
  }
});

export const triggerEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('schedule'),
    eventId: identity,
    scheduleId: identity,
    tick: z.string().datetime({ offset: true }),
  }),
  z.strictObject({
    kind: z.literal('github.issue'),
    eventId: identity,
    repository,
    actor: identity,
    action: z.enum(['opened', 'labeled']),
    label: identity.optional(),
    issueNumber: z.number().int().positive().safe(),
  }),
]);
export type TriggerEvent = z.infer<typeof triggerEventSchema>;
export const triggerAttributionSchema = z.strictObject({
  binding: triggerBindingSchema,
  event: triggerEventSchema,
});

export function authorizeTriggerEvent(binding: TriggerBinding, event: TriggerEvent): void {
  if (binding.kind !== event.kind) throw new Error('Trigger event kind does not match binding');
  if (
    binding.kind === 'schedule' &&
    event.kind === 'schedule' &&
    binding.scheduleId !== event.scheduleId
  )
    throw new Error('Schedule identity does not match binding');
  if (binding.kind === 'github.issue' && event.kind === 'github.issue') {
    if (
      binding.repository.toLowerCase() !== event.repository.toLowerCase() ||
      !binding.actors.some(actor => actor.toLowerCase() === event.actor.toLowerCase())
    )
      throw new Error('Trigger repository or actor is unauthorized');
    if (binding.action !== event.action || binding.label !== event.label)
      throw new Error('Trigger action or label does not match binding');
  }
}

export function resolveTriggerInputs(
  binding: TriggerBinding,
  event: TriggerEvent,
  workflow: ResolvedWorkflow
): Record<string, string> {
  authorizeTriggerEvent(binding, event);
  if (workflow.name !== binding.workflow) throw new Error('Trigger workflow must match exactly');
  const facts: Record<string, string> = { eventId: event.eventId };
  if (event.kind === 'schedule')
    Object.assign(facts, { tick: event.tick, scheduleId: event.scheduleId });
  else
    Object.assign(facts, {
      repository: event.repository,
      actor: event.actor,
      issueNumber: String(event.issueNumber),
      issueUrl: `https://github.com/${event.repository}/issues/${String(event.issueNumber)}`,
    });
  const inputs = { ...binding.inputs };
  for (const [input, fact] of Object.entries(binding.facts)) {
    if (Object.hasOwn(inputs, input))
      throw new Error(`Trigger input '${input}' has both a fixed value and an event fact`);
    if (!Object.hasOwn(facts, fact))
      throw new Error(`Fact '${fact}' is unavailable for ${event.kind}`);
    inputs[input] = facts[fact];
  }
  // Triggers require declarations even though legacy direct invocation permits passthrough.
  resolveDeclaredInputs(inputs, workflow.inputs ?? {}, `Trigger '${binding.id}'`, workflow.name);
  return inputs;
}

export type TriggerAdmission =
  | { disposition: 'accepted' | 'duplicate'; runId: string }
  | { disposition: 'skipped'; runId: string };

export interface IWorkflowTriggerStore {
  getAdmission(triggerId: string, eventId: string): Promise<TriggerAdmission | null>;
  /** Run and event relation commit together; skip decisions are durable too. */
  admit(params: {
    triggerId: string;
    eventId: string;
    overlap: TriggerBinding['overlap'];
    run: Parameters<IWorkflowStore['createWorkflowRun']>[0] & { id: string };
  }): Promise<TriggerAdmission>;
  /** Exactly one host may begin a pending run. No timed takeover of running work. */
  claimPendingRun(runId: string): Promise<WorkflowRun | null>;
}

/** Engine admission owns source selection and atomic run attribution for every host. */
export async function admitWorkflowTrigger(
  deps: WorkflowDeps,
  store: IWorkflowTriggerStore,
  params: {
    binding: TriggerBinding;
    event: TriggerEvent;
    cwd: string;
    conversationId: string;
    userId?: string;
  }
): Promise<TriggerAdmission> {
  const binding = triggerBindingsSchema.parse([params.binding])[0];
  const event = triggerEventSchema.parse(params.event);
  // Authorize even a duplicate before returning its run identity. The immutable
  // captured workflow, rather than today's source files, owns a prior admission.
  authorizeTriggerEvent(binding, event);
  const existing = await store.getAdmission(binding.id, event.eventId);
  if (existing) return existing;
  return withCapturedSource(async owner => {
    let prepared = await prepareWorkflowSource(deps, { sourceRoot: binding.sourceRoot });
    owner.hold(prepared);
    const discovered = await discoverWorkflowsWithConfig(
      params.cwd,
      deps.loadConfig,
      prepared.roots
    );
    const matches = discovered.workflows.filter(entry => entry.workflow.name === binding.workflow);
    if (
      matches.length !== 1 ||
      matches[0].source !== binding.source ||
      discovered.errors.length > 0
    )
      throw new Error(
        `Trigger '${binding.id}' cannot resolve exact workflow '${binding.workflow}' from '${binding.source}': ${discovered.errors.map(error => error.error).join('; ')}`
      );
    const inputs = resolveTriggerInputs(binding, event, matches[0].workflow);
    await recordSelectedWorkflow(prepared.anchor.root, binding.workflow);
    prepared = await finalizeWorkflowSource(deps, prepared, {
      cwd: params.cwd,
      codebaseId: binding.codebaseId,
    });
    owner.hold(prepared);
    // Once the transaction is attempted, an uncertain commit may own this capture.
    // Preserve it on an error; deleting it could strand a committed admission.
    owner.adopt();
    const admission = await store.admit({
      triggerId: binding.id,
      eventId: event.eventId,
      overlap: binding.overlap,
      run: {
        id: prepared.runId,
        workflow_name: binding.workflow,
        conversation_id: params.conversationId,
        codebase_id: binding.codebaseId,
        user_id: params.userId,
        user_message: '',
        metadata: {
          trigger: { binding, event },
          [SUBRUN_METADATA_KEYS.inputs]: inputs,
          [WORKFLOW_SOURCE_METADATA_KEY]: preparedWorkflowSourceMetadata(prepared),
        },
      },
    });
    if (admission.disposition !== 'accepted') {
      // This unique candidate was not committed, so the losing capture has no owner.
      await withCapturedSource(unused => {
        unused.hold(prepared);
        return Promise.resolve();
      });
    }
    return admission;
  });
}
