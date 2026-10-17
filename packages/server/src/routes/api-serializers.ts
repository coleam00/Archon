import type { z } from '@hono/zod-openapi';
import type { Codebase, Conversation } from '@archon/core';
import type { MessageRow } from '@archon/core/schemas/message';
import type { DashboardWorkflowRun } from '@archon/core/schemas/workflow-run';
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import {
  isApprovalContext,
  runAttention,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { boundMetadataToolOutputs } from '../adapters/web/truncate';
import { getLog } from './api-route-kit';
import { codebaseSchema } from './schemas/codebase.schemas';
import { conversationSchema, messageSchema } from './schemas/conversation.schemas';
import { dashboardWorkflowRunSchema, workflowRunSchema } from './schemas/workflow.schemas';

// ---------------------------------------------------------------------------
// API transform helpers (Date → ISO string for wire shape)
// ---------------------------------------------------------------------------

type ApiConversation = z.infer<typeof conversationSchema>;
type ApiCodebase = z.infer<typeof codebaseSchema>;
type ApiMessage = z.infer<typeof messageSchema>;
type ApiWorkflowRun = z.infer<typeof workflowRunSchema>;
type ApiDashboardWorkflowRun = z.infer<typeof dashboardWorkflowRunSchema>;

function toISOString(val: Date | string): string;
function toISOString(val: Date | string | null | undefined): string | null;
function toISOString(val: Date | string | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  try {
    return val.toISOString();
  } catch (e) {
    getLog().error({ err: e as Error, invalidDate: val }, 'api.invalid_date_transform');
    return null;
  }
}

export function toApiConversation(row: Conversation): ApiConversation {
  return {
    ...row,
    created_at: toISOString(row.created_at),
    updated_at: toISOString(row.updated_at),
    deleted_at: toISOString(row.deleted_at),
    last_activity_at: toISOString(row.last_activity_at),
  };
}

export function toApiCodebase(row: Codebase): ApiCodebase {
  let commands = row.commands;
  if (typeof commands === 'string') {
    try {
      commands = JSON.parse(commands) as Record<string, { path: string; description: string }>;
    } catch (parseErr) {
      getLog().error({ err: parseErr as Error, codebaseId: row.id }, 'corrupted_commands_json');
      // Fallback: empty map keeps the API response valid and prevents the endpoint
      // from crashing. The corruption is already logged above for operator attention.
      commands = {};
    }
  }
  return {
    ...row,
    commands,
    created_at: toISOString(row.created_at),
    updated_at: toISOString(row.updated_at),
  };
}

export function toApiMessage(row: MessageRow): ApiMessage {
  let metadata = row.metadata;
  if (typeof metadata !== 'string') {
    try {
      metadata = JSON.stringify(metadata);
    } catch (e) {
      getLog().error(
        { err: e as Error, messageId: row.id },
        'api.message_metadata_serialize_failed'
      );
      metadata = '{}';
    }
  }
  // Bound tool_result outputs in hydration responses — the DB keeps the full
  // value; only the browser-bound payload is capped (see #2236).
  return { ...row, metadata: boundMetadataToolOutputs(metadata) };
}

function toApiRunAttention(row: WorkflowRun): ApiWorkflowRun['attention'] {
  const attention = runAttention(row);
  return attention?.kind === 'terminal'
    ? { ...attention, at: toISOString(attention.at) }
    : attention;
}

function toApiRunMetadata(metadata: WorkflowRun['metadata']): ApiWorkflowRun['metadata'] {
  const approval = metadata.approval;
  return isApprovalContext(approval)
    ? { ...metadata, approval: { ...approval, decisions: getApprovalDecisions(approval) } }
    : metadata;
}

export function toApiWorkflowRun(row: WorkflowRun): ApiWorkflowRun {
  return {
    ...row,
    metadata: toApiRunMetadata(row.metadata),
    attention: toApiRunAttention(row),
    started_at: toISOString(row.started_at),
    completed_at: toISOString(row.completed_at),
    last_activity_at: toISOString(row.last_activity_at),
  };
}

export function toApiDashboardWorkflowRun(row: DashboardWorkflowRun): ApiDashboardWorkflowRun {
  return {
    ...row,
    metadata: toApiRunMetadata(row.metadata),
    attention: toApiRunAttention(row),
    started_at: toISOString(row.started_at),
    completed_at: toISOString(row.completed_at),
    last_activity_at: toISOString(row.last_activity_at),
  };
}
