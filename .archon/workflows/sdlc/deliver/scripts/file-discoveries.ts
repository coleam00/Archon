/**
 * File every accepted discovery as a tracker issue, once.
 *
 * Review consolidates work it proved but that is unrelated to this change into
 * `discoveries.json`. A record nobody files is lost the moment the run ends, so
 * delivery files one issue per record, linking back to the run and the pull
 * request. An open issue with the same title is reused rather than duplicated,
 * and each record gains the `issue` URL it now lives at, so a resumed run files
 * nothing twice and the terminal report can point at it.
 *
 * gh is the transport, as it is for triage's labels: the forge contract has no
 * issue-create operation yet. Each created issue is read back before it counts.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrRecord } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, text } from '../../.shared/io.ts';

interface Discovery {
  title?: unknown;
  claim?: unknown;
  evidence?: unknown;
  relation?: unknown;
  source_nodes?: unknown;
  issue?: unknown;
}

function gh(...args: string[]): string {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

/** A record field as text: strings verbatim, anything else as its JSON. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function body(record: Discovery, prUrl: string): string {
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map(item => `- ${asText(item)}`).join('\n')
    : asText(record.evidence);
  const sources = Array.isArray(record.source_nodes)
    ? record.source_nodes.map(asText).join(', ')
    : '';
  return [
    asText(record.claim),
    '',
    '## Evidence',
    '',
    evidence,
    '',
    `Found while delivering ${prUrl} (Archon run \`${process.env.WORKFLOW_ID ?? 'unknown'}\`` +
      `${sources === '' ? '' : `, recorded by ${sources}`}). It is outside that change, so the run filed it instead of fixing it.`,
  ].join('\n');
}

try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const repo = `${pr.repo.host}/${pr.repo.path}`;
  const path = join(artifactsDir(), 'discoveries.json');
  const records = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : [];
  if (!Array.isArray(records)) throw new Error('discoveries.json is not an array');

  const filed: string[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'archon-discovery-'));
  try {
    for (const record of records as Discovery[]) {
      if (typeof record.issue === 'string' && record.issue !== '') {
        filed.push(record.issue);
        continue;
      }
      const title = typeof record.title === 'string' ? record.title.trim() : '';
      if (title === '') throw new Error('a discovery has no title');

      const open = JSON.parse(
        gh('issue', 'list', '--repo', repo, '--state', 'open', '--search', `${title} in:title`,
          '--json', 'title,url', '--limit', '20')
      ) as { title: string; url: string }[];
      const existing = open.find(issue => issue.title.trim().toLowerCase() === title.toLowerCase());
      if (existing) {
        record.issue = existing.url;
      } else {
        const bodyPath = join(scratch, 'body.md');
        writeFileSync(bodyPath, body(record, pr.url));
        const url = gh('issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyPath);
        const readBack = JSON.parse(gh('issue', 'view', url, '--json', 'title,url')) as {
          title: string;
          url: string;
        };
        if (readBack.title !== title) throw new Error(`issue read-back disagrees for ${url}`);
        record.issue = readBack.url;
      }
      filed.push(String(record.issue));
      // Persist after each issue, so a failure part-way never files one twice.
      writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  emit({ issues: filed });
} catch (error) {
  refuse(`file-discoveries: ${error instanceof Error ? error.message : String(error)}`);
}
