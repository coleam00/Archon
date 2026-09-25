import { z } from '@hono/zod-openapi';
import {
  type ForgeSourceCapabilities,
  type SourceActor,
  checkResultSchema,
  forgeEventEnvelopeSchema,
  type ForgeEvent,
  type ForgeEventEnvelope,
} from '@archon/forge';

type PrLifecycleAction = Extract<ForgeEvent, { kind: 'pr.lifecycle' }>['action'];

export const githubSourceCapabilities = {
  events: [
    ...(['opened', 'edited', 'closed', 'reopened'] as const).map(action => ({
      kind: 'issue.lifecycle' as const,
      action,
    })),
    ...(
      [
        'opened',
        'edited',
        'head_updated',
        'ready',
        'drafted',
        'closed',
        'merged',
        'reopened',
      ] as const
    ).map(action => ({ kind: 'pr.lifecycle' as const, action })),
    ...(['added', 'removed'] as const).map(action => ({ kind: 'label.changed' as const, action })),
    { kind: 'check.changed', action: 'changed', unitKind: 'check' } as const,
    { kind: 'check.changed', action: 'changed', unitKind: 'commit_status' } as const,
  ],
} satisfies ForgeSourceCapabilities;

export interface GitHubEnvelopeContext {
  sourceInstanceId: string;
  deliveryId: string | null;
  contentDigest: string;
  receivedAt: string;
  host: string;
  eventName: string;
}

export type GitHubNormalizationResult =
  | { status: 'normalized'; envelope: ForgeEventEnvelope }
  | { status: 'unsupported'; reason: string }
  | { status: 'malformed'; reason: string };

const repositorySchema = z.object({ full_name: z.string().min(1) });
const senderSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  login: z.string().min(1).nullable().optional(),
});
const baseSchema = z.object({
  action: z.string().min(1),
  repository: repositorySchema,
  sender: senderSchema.optional(),
});
const issueSchema = baseSchema.extend({
  issue: z.object({
    number: z.number().int().positive(),
    state: z.enum(['open', 'closed']),
    updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
  label: z
    .object({
      id: z.union([z.string().min(1), z.number().int()]).optional(),
      name: z.string().min(1),
    })
    .optional(),
});
const pullRequestSchema = baseSchema.extend({
  pull_request: z.object({
    number: z.number().int().positive(),
    state: z.enum(['open', 'closed']),
    draft: z.boolean().nullable().optional(),
    merged: z.boolean().optional(),
    updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
    closed_at: z.iso.datetime({ offset: true }).nullable().optional(),
    merged_at: z.iso.datetime({ offset: true }).nullable().optional(),
    head: z
      .object({ sha: z.string().min(1), ref: z.string().min(1).nullable().optional() })
      .nullable()
      .optional(),
    base: z
      .object({ sha: z.string().min(1), ref: z.string().min(1).nullable().optional() })
      .nullable()
      .optional(),
  }),
  label: z
    .object({
      id: z.union([z.string().min(1), z.number().int()]).optional(),
      name: z.string().min(1),
    })
    .optional(),
});
const checkRunSchema = baseSchema.extend({
  check_run: z.object({
    id: z.union([z.string().min(1), z.number().int()]),
    name: z.string().min(1),
    head_sha: z.string().min(1),
    status: z.string().min(1),
    conclusion: z.string().min(1).nullable().optional(),
    started_at: z.iso.datetime({ offset: true }).nullable().optional(),
    completed_at: z.iso.datetime({ offset: true }).nullable().optional(),
    pull_requests: z.array(z.object({ number: z.number().int().positive() })),
  }),
});
const statusSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  sha: z.string().min(1),
  name: z.string().min(1).optional(),
  context: z.string().min(1).optional(),
  state: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }).nullable().optional(),
  updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
  repository: repositorySchema,
  sender: senderSchema.optional(),
});

function id(value: string | number | undefined): string | null {
  return value === undefined ? null : String(value);
}

function actor(
  sender: z.infer<typeof senderSchema> | undefined,
  host: string
): SourceActor | undefined {
  return sender ? { host, id: String(sender.id), login: sender.login ?? null } : undefined;
}

export function checkPhase(status: string): 'pending' | 'running' | 'completed' | 'unknown' {
  if (['queued', 'pending', 'waiting', 'requested'].includes(status)) return 'pending';
  if (['in_progress'].includes(status)) return 'running';
  if (['completed', 'success', 'failure', 'error'].includes(status)) return 'completed';
  return 'unknown';
}

export function checkResult(
  value: string | null | undefined
): z.infer<typeof checkResultSchema> | null {
  if (value === null || value === undefined) return null;
  const parsed = checkResultSchema.safeParse(value);
  return parsed.success ? parsed.data : 'unknown';
}

function malformed(error: z.ZodError): GitHubNormalizationResult {
  const issue = error.issues[0];
  return {
    status: 'malformed',
    reason: issue ? `${issue.path.join('.') || 'payload'}: ${issue.message}` : 'Invalid payload',
  };
}

export function normalizeGitHubWebhook(
  payload: unknown,
  context: GitHubEnvelopeContext
): GitHubNormalizationResult {
  let event: ForgeEvent;
  let occurredAt: string | null = null;
  let sourceActor: ReturnType<typeof actor>;
  if (context.eventName === 'issues') {
    const parsed = issueSchema.safeParse(payload);
    if (!parsed.success) return malformed(parsed.error);
    const value = parsed.data;
    sourceActor = actor(value.sender, context.host);
    occurredAt = value.issue.updated_at ?? null;
    if (value.action === 'labeled' || value.action === 'unlabeled') {
      if (!value.label) return { status: 'malformed', reason: 'label: Required for label action' };
      event = {
        kind: 'label.changed',
        action: value.action === 'labeled' ? 'added' : 'removed',
        subject: {
          kind: 'issue',
          ref: {
            repo: { host: context.host, path: value.repository.full_name },
            number: value.issue.number,
          },
        },
        label: { name: value.label.name, id: id(value.label.id) },
      };
    } else if (['opened', 'edited', 'closed', 'reopened'].includes(value.action)) {
      event = {
        kind: 'issue.lifecycle',
        action: value.action as 'opened' | 'edited' | 'closed' | 'reopened',
        issue: {
          repo: { host: context.host, path: value.repository.full_name },
          number: value.issue.number,
        },
        state: value.issue.state,
      };
    } else
      return { status: 'unsupported', reason: `Unsupported GitHub issues action: ${value.action}` };
  } else if (context.eventName === 'pull_request') {
    const parsed = pullRequestSchema.safeParse(payload);
    if (!parsed.success) return malformed(parsed.error);
    const value = parsed.data;
    sourceActor = actor(value.sender, context.host);
    occurredAt =
      value.pull_request.merged_at ??
      value.pull_request.closed_at ??
      value.pull_request.updated_at ??
      null;
    if (value.action === 'labeled' || value.action === 'unlabeled') {
      if (!value.label) return { status: 'malformed', reason: 'label: Required for label action' };
      event = {
        kind: 'label.changed',
        action: value.action === 'labeled' ? 'added' : 'removed',
        subject: {
          kind: 'pr',
          ref: {
            repo: { host: context.host, path: value.repository.full_name },
            number: value.pull_request.number,
          },
        },
        label: { name: value.label.name, id: id(value.label.id) },
      };
    } else {
      const action =
        value.action === 'synchronize'
          ? 'head_updated'
          : value.action === 'ready_for_review'
            ? 'ready'
            : value.action === 'converted_to_draft'
              ? 'drafted'
              : value.action === 'closed' && value.pull_request.merged
                ? 'merged'
                : value.action;
      if (
        ![
          'opened',
          'edited',
          'head_updated',
          'ready',
          'drafted',
          'closed',
          'reopened',
          'merged',
        ].includes(action)
      )
        return {
          status: 'unsupported',
          reason: `Unsupported GitHub pull_request action: ${value.action}`,
        };
      event = {
        kind: 'pr.lifecycle',
        action: action as PrLifecycleAction,
        pr: {
          repo: { host: context.host, path: value.repository.full_name },
          number: value.pull_request.number,
        },
        state: value.pull_request.state,
        draft: value.pull_request.draft ?? null,
        head: value.pull_request.head
          ? { objectId: value.pull_request.head.sha, branch: value.pull_request.head.ref ?? null }
          : null,
        base: value.pull_request.base
          ? { objectId: value.pull_request.base.sha, branch: value.pull_request.base.ref ?? null }
          : null,
      };
    }
  } else if (context.eventName === 'check_run') {
    const parsed = checkRunSchema.safeParse(payload);
    if (!parsed.success) return malformed(parsed.error);
    const value = parsed.data;
    if (value.action !== 'created' && value.action !== 'completed') {
      return { status: 'unsupported', reason: 'Unsupported GitHub check_run action' };
    }
    sourceActor = actor(value.sender, context.host);
    occurredAt = value.check_run.completed_at ?? value.check_run.started_at ?? null;
    event = {
      kind: 'check.changed',
      action: 'changed',
      repo: { host: context.host, path: value.repository.full_name },
      revision: value.check_run.head_sha,
      unit: { kind: 'check', id: String(value.check_run.id), name: value.check_run.name },
      nativeState: value.check_run.status,
      phase: checkPhase(value.check_run.status),
      nativeResult: value.check_run.conclusion ?? null,
      result: checkResult(value.check_run.conclusion),
      pullRequests: value.check_run.pull_requests.map(pr => ({
        repo: { host: context.host, path: value.repository.full_name },
        number: pr.number,
      })),
    };
  } else if (context.eventName === 'status') {
    const parsed = statusSchema.safeParse(payload);
    if (!parsed.success) return malformed(parsed.error);
    const value = parsed.data;
    sourceActor = actor(value.sender, context.host);
    occurredAt = value.updated_at ?? value.created_at ?? null;
    event = {
      kind: 'check.changed',
      action: 'changed',
      repo: { host: context.host, path: value.repository.full_name },
      revision: value.sha,
      unit: {
        kind: 'commit_status',
        id: String(value.id),
        name: value.context ?? value.name ?? 'status',
      },
      nativeState: value.state,
      phase: checkPhase(value.state),
      nativeResult: value.state,
      result: ['pending', 'queued'].includes(value.state)
        ? null
        : value.state === 'success'
          ? 'success'
          : ['failure', 'error'].includes(value.state)
            ? 'failure'
            : 'unknown',
      pullRequests: [],
    };
  } else return { status: 'unsupported', reason: `Unsupported GitHub event: ${context.eventName}` };

  const envelope = forgeEventEnvelopeSchema.safeParse({
    schemaVersion: 1,
    sourceInstanceId: context.sourceInstanceId,
    deliveryId: context.deliveryId,
    contentDigest: context.contentDigest,
    receivedAt: context.receivedAt,
    occurredAt,
    sourceActor,
    event,
  });
  return envelope.success
    ? { status: 'normalized', envelope: envelope.data }
    : malformed(envelope.error);
}
