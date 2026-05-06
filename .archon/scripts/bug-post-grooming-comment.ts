#!/usr/bin/env bun
/**
 * Read $ARTIFACTS_DIR/groomed-bug.json, render a markdown summary of the
 * grooming verdict, and post it as a Jira comment on the Bug ticket.
 *
 * The comment also embeds the full groomed-bug.json blob inside an
 * ARCHON-GROOMING-BLOB code fence so the bug-test-strategy workflow
 * can later extract it back out via bug-load-grooming.ts.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — for issue_key
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
    body += `_These ACs will be appended to the ticket description and used by the test-strategy and dev workflows downstream. Edit them now if they don't match your intent._\n\n`;
  }

  body += `### Next step\n\n`;
  body += `Promote this ticket to **Selected for Development** to start the bug fix pipeline.\n\n`;
} else {
  const verdictTitle = {
    working_as_designed: '✅ Working as designed',
    feature_request_disguised_as_bug: '💡 Feature request, not a bug',
    environment_or_user_error: '🌐 Environment / user error',
    cannot_reproduce: '❓ Cannot reproduce',
  }[verdict as string] ?? `❓ ${verdict}`;

  body += `## ${verdictTitle}\n\n`;
  body += `**Grooming confidence:** ${confidence}\n\n`;
  body += `${reasoning}\n\n`;
  body += `_The bug pipeline halted at the grooming phase. If you disagree with this verdict, override the workflow manually and re-trigger; otherwise close the ticket or convert it to a Story._\n\n`;
}

// Embed the raw JSON blob so bug-load-grooming.ts can extract it later.
body += `<!-- ARCHON-GROOMING-BLOB:START -->\n`;
body += '```json\n';
body += JSON.stringify(groomed, null, 2);
body += '\n```\n';
body += `<!-- ARCHON-GROOMING-BLOB:END -->\n`;

// Post via Jira REST API
const baseUrl = process.env.JIRA_BASE_URL!;
const email = process.env.JIRA_USER_EMAIL!;
const token = process.env.JIRA_API_TOKEN!;
const auth = Buffer.from(`${email}:${token}`).toString('base64');

const res = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  // Jira Cloud accepts ADF; for plain markdown-style content we wrap as a
  // single text block. The renderer in Jira Cloud will honor markdown in a
  // text-paragraph node when the user has enabled markdown rendering, but
  // most installations show it as plain text. That's acceptable — the
  // grooming comment is for engineers, not end users.
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

if (!res.ok) {
  const text = await res.text();
  console.error(`Failed to post grooming comment: HTTP ${res.status}: ${text}`);
  process.exit(1);
}

console.log(`Posted grooming verdict (${verdict}) to ${issueKey}`);
process.stdout.write(JSON.stringify({ posted: true, verdict, issue_key: issueKey }));
