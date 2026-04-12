import { createLogger } from '@archon/paths';
import type { Codebase, Conversation, HandleMessageContext, IPlatformAdapter } from '../types';
import { findWebhookRuleBySlug } from '../db/webhook-rules';
import { dispatchNamedWorkflow } from '../orchestrator/orchestrator-agent';
import type { WebhookRule } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('webhook-rules');
  return cachedLog;
}

export async function matchRuleBySlug(pathSlug: string): Promise<WebhookRule | null> {
  return findWebhookRuleBySlug(pathSlug);
}

export function normalizeWebhookPayload(rawBody: string, contentType?: string | null): string {
  const trimmedBody = rawBody.trim();
  if (!trimmedBody) {
    return '(empty)';
  }

  const shouldTryJson =
    (contentType?.toLowerCase().includes('json') ?? false) ||
    trimmedBody.startsWith('{') ||
    trimmedBody.startsWith('[');

  if (!shouldTryJson) {
    return trimmedBody;
  }

  try {
    return JSON.stringify(JSON.parse(trimmedBody), null, 2);
  } catch {
    return trimmedBody;
  }
}

export function buildWebhookWorkflowInput(params: {
  pathSlug: string;
  rawBody: string;
  contentType?: string | null;
}): string {
  const normalizedBody = normalizeWebhookPayload(params.rawBody, params.contentType);

  return [
    'A webhook rule matched this request.',
    `Webhook slug: ${params.pathSlug}`,
    `Content-Type: ${params.contentType?.trim() || 'unknown'}`,
    '',
    'Request body:',
    normalizedBody,
  ].join('\n');
}

export async function dispatchMatchedWebhookRule(params: {
  platform: IPlatformAdapter;
  conversationId: string;
  conversation: Conversation;
  codebase: Codebase;
  pathSlug: string;
  rawBody: string;
  contentType?: string | null;
  isolationHints?: HandleMessageContext['isolationHints'];
  matchedRule?: WebhookRule | null;
}): Promise<WebhookRule | null> {
  const matchedRule = params.matchedRule ?? (await matchRuleBySlug(params.pathSlug));

  if (!matchedRule) {
    getLog().debug({ pathSlug: params.pathSlug }, 'webhook_rule_not_matched');
    return null;
  }

  const userMessage = buildWebhookWorkflowInput({
    pathSlug: params.pathSlug,
    rawBody: params.rawBody,
    contentType: params.contentType,
  });

  getLog().info(
    {
      codebaseId: params.codebase.id,
      workflowName: matchedRule.workflow_name,
      pathSlug: params.pathSlug,
    },
    'webhook_rule_dispatch_started'
  );

  await dispatchNamedWorkflow(
    params.platform,
    params.conversationId,
    params.conversation,
    params.codebase,
    matchedRule.workflow_name,
    userMessage,
    params.isolationHints
  );

  getLog().info(
    {
      codebaseId: params.codebase.id,
      workflowName: matchedRule.workflow_name,
      pathSlug: params.pathSlug,
    },
    'webhook_rule_dispatch_completed'
  );

  return matchedRule;
}
