#!/usr/bin/env bun
/**
 * Transition a Jira task back to Backlog and post a comment explaining why.
 * Used by bug-pipeline when grooming determines the ticket isn't ready to
 * be worked on (not a genuine bug, insufficient information, can't reproduce,
 * contract inadequate, etc.) — moving the ticket back to Backlog gives the
 * human PM visual evidence that the work has paused.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — issue_key
 *
 * Env:
 *   JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN
 *   REASON                — short reason string for the comment
 *   COMMENT_BODY (optional) — full markdown comment body; if absent, a
 *                              minimal comment is generated from REASON
 *
 * stdout: { transitioned, issue_key, to_status }
 */
import { readFile } from 'node:fs/promises';

const artifactsDir = process.env.ARTIFACTS_DIR;
if (!artifactsDir) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const reason = process.env.REASON;
if (!reason) {
  console.error('REASON env var is required');
  process.exit(1);
}

const trigger = JSON.parse(
  await readFile(`${artifactsDir}/trigger-payload.json`, 'utf8'),
) as { issue_key: string };
const issueKey = trigger.issue_key;
if (!issueKey) {
  console.error('issue_key missing from trigger-payload.json');
  process.exit(1);
}

const baseUrl = process.env.JIRA_BASE_URL!;
const email = process.env.JIRA_USER_EMAIL!;
const token = process.env.JIRA_API_TOKEN!;
const auth = Buffer.from(`${email}:${token}`).toString('base64');

// Step 1: find the Backlog transition id
const tRes = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
  headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
});
if (!tRes.ok) {
  console.error(`Failed to list transitions: HTTP ${tRes.status}`);
  process.exit(1);
}
const tData = (await tRes.json()) as {
  transitions?: Array<{ id: string; name: string; to: { name: string } }>;
};

const backlogTransition = (tData.transitions ?? []).find(
  (t) => t.to?.name === 'Backlog',
);
if (!backlogTransition) {
  console.error(
    `No transition to "Backlog" available from current status of ${issueKey}. ` +
      `Available: ${(tData.transitions ?? []).map((t) => t.to?.name).join(', ')}`,
  );
  process.exit(1);
}

// Step 2: post the comment first (so the explanation lands before the
// status change visually)
const commentBody =
  process.env.COMMENT_BODY ??
  `## ⏸️ Pipeline paused — ticket moved back to Backlog\n\n${reason}\n\n` +
    `Edit this ticket and transition it to **Selected for Development** ` +
    `again to retry the bug pipeline.\n`;

const cRes = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
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
          content: [{ type: 'text', text: commentBody }],
        },
      ],
    },
  }),
});
if (!cRes.ok) {
  const t = await cRes.text();
  console.error(`Failed to post pause comment: HTTP ${cRes.status}: ${t}`);
  // continue to transition; the comment is best-effort, the transition is the
  // load-bearing visual signal
}

// Step 3: do the transition
const xRes = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ transition: { id: backlogTransition.id } }),
});
if (!xRes.ok) {
  const t = await xRes.text();
  console.error(`Failed to transition ${issueKey} to Backlog: HTTP ${xRes.status}: ${t}`);
  process.exit(1);
}

console.log(`Transitioned ${issueKey} → Backlog. Reason: ${reason}`);
process.stdout.write(
  JSON.stringify({
    transitioned: true,
    issue_key: issueKey,
    to_status: 'Backlog',
    reason,
  }),
);
