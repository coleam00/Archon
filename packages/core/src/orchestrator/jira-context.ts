/**
 * JIRA ticket prefetch for the orchestrator router.
 *
 * Chat platforms (Slack/Telegram/CLI) deliver a free-text message like
 * "plan DEV-2602" that references a JIRA key but carries NO inline ticket
 * context (unlike the Jira webhook adapter, which builds context from the issue
 * it received). Without the ticket details the orchestrator can only see project
 * names/repo URLs and falls back to asking the user "which project?".
 *
 * This helper detects a JIRA key in the message and fetches the ticket so the
 * orchestrator can match it to a registered project on its own. It is strictly
 * best-effort: a missing key, missing credentials, network error, or unexpected
 * payload all return `undefined`, and the chat turn proceeds without ticket
 * context (the user is simply asked which project, the prior behaviour).
 */
import { createLogger } from '@archon/paths';
import { toError } from '../utils/error';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.jira-context');
  return cachedLog;
}

/**
 * Inline JIRA key matcher: a project key (uppercase letter followed by
 * letters/digits) + dash + number, bounded so it isn't a substring of a longer
 * token. Mirrors the adapter's anchored `^[A-Z][A-Z0-9]+-\d+$` but for use
 * inside free text. A false positive (e.g. "UTF-8") simply yields a failed
 * fetch and a `undefined` result — harmless.
 */
const INLINE_ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** Max characters of the ticket description to inject (keeps the prompt lean). */
const MAX_DESCRIPTION_CHARS = 1500;

/** Minimal ADF node shape — JIRA REST v3 returns descriptions as an ADF tree. */
interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

interface JiraIssueResponse {
  key?: string;
  fields?: {
    summary?: string;
    description?: AdfNode | string | null;
    issuetype?: { name?: string };
    status?: { name?: string };
    components?: { name?: string }[];
    labels?: string[];
  };
}

/**
 * Extract the first JIRA issue key from a free-text message, or undefined.
 */
export function extractJiraKey(message: string): string | undefined {
  return INLINE_ISSUE_KEY_RE.exec(message)?.[0];
}

/**
 * Recursively collect text from an ADF node tree, inserting newlines after
 * block-level nodes so paragraph structure survives flattening. Mirrors the
 * adapter's `collectText`; duplicated (not shared) because `@archon/core` must
 * not depend on `@archon/adapters`, and the logic is small and stable.
 */
function flattenAdf(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? '';
  const childText = (node.content ?? []).map(flattenAdf).join('');
  const blockTypes = new Set(['paragraph', 'heading', 'codeBlock', 'listItem', 'blockquote']);
  return blockTypes.has(node.type) ? `${childText}\n` : childText;
}

/** Flatten an ADF description (object) or pass through a plain string. */
function descriptionToText(description: AdfNode | string | null | undefined): string {
  if (description == null) return '';
  if (typeof description === 'string') return description;
  if (typeof description === 'object' && 'type' in description) {
    return flattenAdf(description)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

/**
 * Fetch a referenced JIRA ticket and format it as an orchestrator context block.
 *
 * @param message - the raw user message; scanned for a JIRA key
 * @param env - the effective env bag (process.env merged with config/db env) —
 *   read for `JIRA_BASE_URL`, `JIRA_USER`, `JIRA_API_TOKEN`
 * @returns a context string ready to inject into the system prompt, or
 *   `undefined` when there is no key, no credentials, or the fetch fails.
 */
export async function fetchJiraTicketContext(
  message: string,
  env: Record<string, string | undefined>
): Promise<string | undefined> {
  const key = extractJiraKey(message);
  if (!key) return undefined;

  const baseUrl = env.JIRA_BASE_URL?.replace(/\/+$/, '');
  const user = env.JIRA_USER;
  const apiToken = env.JIRA_API_TOKEN;
  if (!baseUrl || !user || !apiToken) {
    getLog().debug({ key, hasBaseUrl: !!baseUrl }, 'jira_context.credentials_missing');
    return undefined;
  }

  const authHeader = `Basic ${Buffer.from(`${user}:${apiToken}`).toString('base64')}`;
  try {
    const res = await fetch(
      `${baseUrl}/rest/api/3/issue/${key}?fields=summary,description,issuetype,status,components,labels`,
      { headers: { Authorization: authHeader, Accept: 'application/json' } }
    );
    if (!res.ok) {
      getLog().warn({ key, status: res.status }, 'jira_context.fetch_failed');
      return undefined;
    }
    const issue = (await res.json()) as JiraIssueResponse;
    const fields = issue.fields ?? {};

    let description = descriptionToText(fields.description);
    if (description.length > MAX_DESCRIPTION_CHARS) {
      description = description.slice(0, MAX_DESCRIPTION_CHARS) + '\n…(truncated)';
    }

    const components = (fields.components ?? [])
      .map(c => c.name)
      .filter((n): n is string => !!n)
      .join(', ');
    const labels = (fields.labels ?? []).join(', ');

    getLog().debug({ key }, 'jira_context.fetched');

    const lines = [
      '[Referenced JIRA Ticket]',
      `Key: ${issue.key ?? key}`,
      `Summary: ${fields.summary ?? ''}`,
      `Type: ${fields.issuetype?.name ?? 'unknown'}`,
      `Status: ${fields.status?.name ?? 'unknown'}`,
    ];
    if (components) lines.push(`Components: ${components}`);
    if (labels) lines.push(`Labels: ${labels}`);
    if (description) lines.push('', 'Description:', description);
    return lines.join('\n');
  } catch (error) {
    getLog().warn({ err: toError(error), key }, 'jira_context.fetch_failed');
    return undefined;
  }
}
