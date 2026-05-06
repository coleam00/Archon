#!/usr/bin/env bun
/**
 * Read $ARTIFACTS_DIR/groomed-bug.json, render a markdown summary of the
 * grooming verdict, and post it as a Jira comment on the Bug ticket.
 *
 * Idempotent: before posting, deletes any prior comment that contains
 * the ARCHON-GROOMING-BLOB marker so re-runs replace the comment
 * rather than stack new ones.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — issue_key
 *   $ARTIFACTS_DIR/groomed-bug.json     — written by archon-groom-bug
 *
 * Env:
 *   JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN
 */
import { readFileSync } from 'node:fs';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR;
if (!ARTIFACTS_DIR) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const trigger = JSON.parse(
  readFileSync(`${ARTIFACTS_DIR}/trigger-payload.json`, 'utf8'),
);
const issueKey: string = trigger.issue_key;
if (!issueKey) {
  console.error('issue_key missing from trigger-payload.json');
  process.exit(1);
}

const groomed = JSON.parse(
  readFileSync(`${ARTIFACTS_DIR}/groomed-bug.json`, 'utf8'),
);

const verdict = groomed.verdict ?? 'unknown';
const confidence = groomed.confidence ?? 'unknown';
const severity = groomed.severity ?? 'unknown';
const reasoning = groomed.reasoning ?? '';
const missing: string[] = Array.isArray(groomed.missing_information)
  ? groomed.missing_information
  : [];

let body = '';

if (verdict === 'genuine_bug') {
  body += `## 🐛 Bug Grooming Verdict: Genuine Bug\n\n`;
  body += `**Severity:** ${severity}\n`;
  body += `**Grooming confidence:** ${confidence}\n\n`;
  body += `${reasoning}\n\n`;

  if (groomed.reproduction) {
    const r = groomed.reproduction;
    body += `### Reproduction\n\n`;
    if (Array.isArray(r.steps) && r.steps.length > 0) {
      body += r.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n');
      body += '\n\n';
    }
    if (r.expected) body += `**Expected:** ${r.expected}\n`;
    if (r.actual) body += `**Actual:** ${r.actual}\n`;
    if (r.error_signal) body += `**Error signal:** \`${r.error_signal}\`\n`;
    body += '\n';
  }

  if (Array.isArray(groomed.affected_files) && groomed.affected_files.length > 0) {
    body += `### Likely affected files\n\n`;
    for (const f of groomed.affected_files) {
      body += `- \`${f.path}\` (${f.confidence}) — ${f.reason}\n`;
    }
    body += '\n';
  }

  if (Array.isArray(groomed.acceptance_criteria) && groomed.acceptance_criteria.length > 0) {
    body += `### Extrapolated Acceptance Criteria\n\n`;
    for (const ac of groomed.acceptance_criteria) {
      body += `- ${ac}\n`;
    }
    body += '\n';
    body += `_These ACs will be appended to the ticket description and used by the rest of the pipeline. Edit them now if they don't match your intent._\n\n`;
  }
} else if (verdict === 'insufficient_information') {
  body += `## ❓ Need more information before I can groom this bug\n\n`;
  body += `**Grooming confidence:** ${confidence}\n\n`;
  body += `${reasoning}\n\n`;
  if (missing.length > 0) {
    body += `### What's missing\n\n`;
    for (const m of missing) {
      body += `- ${m}\n`;
    }
    body += '\n';
  }
  body += `### Next step\n\n`;
  body += `Edit the ticket description to fill in the items above, then transition this ticket to **Selected for Development** to retry. The ticket has been moved back to **Backlog** so it's clear the pipeline paused.\n\n`;
} else {
  const verdictTitle: Record<string, string> = {
    working_as_designed: '✅ Working as designed',
    feature_request_disguised_as_bug: '💡 Feature request, not a bug',
    environment_or_user_error: '🌐 Environment / user error',
    cannot_reproduce: '❓ Cannot reproduce',
  };
  body += `## ${verdictTitle[verdict] ?? `❓ ${verdict}`}\n\n`;
  body += `**Grooming confidence:** ${confidence}\n\n`;
  body += `${reasoning}\n\n`;
  body += `### Next step\n\n`;
  body += `The ticket has been moved back to **Backlog**. If you disagree with this verdict, edit the description to clarify and transition to Selected for Development again. Otherwise, close this ticket or convert it to a Story.\n\n`;
}

// Embed the raw JSON blob so re-grooming can find and replace this comment.
body += `<!-- ARCHON-GROOMING-BLOB:START -->\n`;
body += '```json\n';
body += JSON.stringify(groomed, null, 2);
body += '\n```\n';
body += `<!-- ARCHON-GROOMING-BLOB:END -->\n`;

const baseUrl = process.env.JIRA_BASE_URL!;
const email = process.env.JIRA_USER_EMAIL!;
const token = process.env.JIRA_API_TOKEN!;
const auth = Buffer.from(`${email}:${token}`).toString('base64');

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}
function flattenAdf(node: AdfNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) {
    const sep =
      node.type === 'paragraph' || node.type === 'listItem' ? '\n' : '';
    return node.content.map(flattenAdf).join(sep);
  }
  return '';
}

// Step 1: idempotency — find and delete any prior ARCHON-GROOMING-BLOB
// comments. Doing this before posting prevents stacking on re-runs.
const listRes = await fetch(
  `${baseUrl}/rest/api/3/issue/${issueKey}/comment?maxResults=100`,
  {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  },
);
if (listRes.ok) {
  const data = (await listRes.json()) as {
    comments?: Array<{ id: string; body: AdfNode }>;
  };
  const priorIds = (data.comments ?? [])
    .filter((c) => flattenAdf(c.body).includes('ARCHON-GROOMING-BLOB:START'))
    .map((c) => c.id);
  for (const id of priorIds) {
    const delRes = await fetch(
      `${baseUrl}/rest/api/3/issue/${issueKey}/comment/${id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Basic ${auth}` },
      },
    );
    if (!delRes.ok) {
      console.warn(`Failed to delete prior grooming comment ${id}: HTTP ${delRes.status}`);
      // continue anyway; worst case is duplicate comments
    }
  }
  if (priorIds.length > 0) {
    console.log(`Deleted ${priorIds.length} prior grooming comment(s).`);
  }
} else {
  console.warn(`Failed to list comments for idempotency check: HTTP ${listRes.status}`);
}

// Step 2: post the new comment
const postRes = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: body }],
        },
      ],
    },
  }),
});

if (!postRes.ok) {
  const text = await postRes.text();
  console.error(`Failed to post grooming comment: HTTP ${postRes.status}: ${text}`);
  process.exit(1);
}

console.log(`Posted grooming verdict (${verdict}) to ${issueKey}`);
process.stdout.write(JSON.stringify({ posted: true, verdict, issue_key: issueKey }));
