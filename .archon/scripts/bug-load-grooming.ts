#!/usr/bin/env bun
/**
 * Load the groomed-bug.json blob that bug-post-grooming-comment.ts
 * embedded into a Jira comment, back into the current run's
 * $ARTIFACTS_DIR/groomed-bug.json.
 *
 * The bug-test-strategy workflow runs in a fresh artifacts dir from
 * the bug-groom workflow, but it needs the structured grooming output
 * to feed archon-analyze-test-gap. Posting the JSON blob to Jira and
 * re-reading it here is the artifact-passing mechanism that doesn't
 * require shared state between workflow runs.
 *
 * Reads:
 *   $ARTIFACTS_DIR/trigger-payload.json — issue_key
 *
 * Writes:
 *   $ARTIFACTS_DIR/groomed-bug.json
 *
 * Env:
 *   JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN
 */
import { readFileSync, writeFileSync } from 'node:fs';

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

const baseUrl = process.env.JIRA_BASE_URL!;
const email = process.env.JIRA_USER_EMAIL!;
const token = process.env.JIRA_API_TOKEN!;
const auth = Buffer.from(`${email}:${token}`).toString('base64');

// Pull comments most-recent first; scan for the ARCHON-GROOMING-BLOB
// marker. Cloud Jira doesn't support inverse ordering in this endpoint
// directly, but maxResults=100 and we filter client-side.
const res = await fetch(
  `${baseUrl}/rest/api/3/issue/${issueKey}/comment?maxResults=100`,
  {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  },
);
if (!res.ok) {
  console.error(`Failed to list comments: HTTP ${res.status}`);
  process.exit(1);
}

const data = await res.json();
const comments: Array<{ body: unknown; created: string; id: string }> =
  data.comments ?? [];

// Sort newest-first
comments.sort((a, b) => (a.created < b.created ? 1 : -1));

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

const BLOB_RE =
  /<!-- ARCHON-GROOMING-BLOB:START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- ARCHON-GROOMING-BLOB:END -->/;

let extracted: string | null = null;
for (const c of comments) {
  const text = flattenAdf(c.body as AdfNode);
  const m = text.match(BLOB_RE);
  if (m) {
    extracted = m[1];
    break;
  }
}

if (!extracted) {
  console.error(
    `No ARCHON-GROOMING-BLOB found in any comment on ${issueKey}. ` +
      `Was bug-groom run on this ticket?`,
  );
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(extracted);
} catch (e) {
  console.error(`Found grooming blob but it's not valid JSON: ${(e as Error).message}`);
  process.exit(1);
}

const out = `${ARTIFACTS_DIR}/groomed-bug.json`;
writeFileSync(out, JSON.stringify(parsed, null, 2));
console.log(`Loaded grooming blob for ${issueKey} → ${out}`);
process.stdout.write(JSON.stringify({ loaded: true, path: out }));
