/**
 * File every accepted discovery as a tracker issue, once.
 *
 * Review consolidates work it proved but this change does not do (unrelated
 * defects, a fix an operator-stated boundary stopped, a note the owner declined)
 * into `discoveries.json`. A record nobody files is lost the moment the run ends, so
 * delivery files one issue per record, linking back to the run and the pull
 * request. Each record gains the `issue` URL it now lives at, written back as
 * soon as the issue exists, so a resumed run files nothing twice and the
 * terminal report can point at it. A matching title is not reused: an open issue with the same title
 * may describe different work, and reusing it would report this record filed
 * while its claim and evidence were never published.
 *
 * Forge-selected runs recover an existing issue by a stable content marker.
 * The default gh path persists the URL before its independent read-back.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  forgeSource,
  invokeForge,
  parseCreatedWorkItem,
  parsePrRecord,
} from '../../.shared/forge.ts';
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
      `${sources === '' ? '' : `, recorded by ${sources}`}). The run filed it instead of fixing it in that change.`,
  ].join('\n');
}

try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const source = forgeSource();
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

      const marker = `<!-- archon-discovery:${createHash('sha256')
        .update(
          JSON.stringify({
            title,
            claim: asText(record.claim),
            evidence: record.evidence ?? null,
            relation: asText(record.relation),
          })
        )
        .digest('hex')} -->`;
      let url: string;
      if (source === 'forge') {
        url = parseCreatedWorkItem(
          invokeForge('workitem.create', {
            repo: pr.repo,
            title,
            marker,
            body: `${marker}\n${body(record, pr.url)}`,
          }),
          pr.repo
        ).url;
        record.issue = url;
        writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
      } else {
        const bodyPath = join(scratch, 'body.md');
        writeFileSync(bodyPath, body(record, pr.url));
        url = gh('issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyPath);
        // Persist before read-back so a resumed gh run retains the created URL.
        record.issue = url;
        writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
        const readBack = JSON.parse(gh('issue', 'view', url, '--json', 'title')) as {
          title: string;
        };
        if (readBack.title !== title) throw new Error(`issue read-back disagrees for ${url}`);
      }
      filed.push(url);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  emit({ issues: filed });
} catch (error) {
  refuse(`file-discoveries: ${error instanceof Error ? error.message : String(error)}`);
}
