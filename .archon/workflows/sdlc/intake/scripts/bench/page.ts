/**
 * The evaluation page for one batch: every row's versions side by side, each with
 * its verdict and route, the five typed fields, any close proposal or maintainer
 * recommendation with its links, cost and time, and the triage report. The operator
 * marks each version right, wrong or partly right, with a note. Where a mark overrides
 * the scorer's expected answer, the page says so beside the verdict.
 *
 * A small local server renders the page from the output directory on every request
 * and appends each mark to the directory's marks file, so marks tally across batches
 * and the scorer reads them. A batch run that failed a hard check is shown as failed,
 * with nothing to mark.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchChecks, Line } from './runner.ts';
import { MARKS, type MarkValue, closeCheck, judgedBy, latestByVersion, readChecks, readMarks, recordMark } from './score.ts';
import { type BenchSet, type Row, batchRows } from './set.ts';

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** A link only for an http(s) URL; anything else is shown as text. */
function link(url: string): string {
  return /^https?:\/\//i.test(url) ? `<a href="${escape(url)}">${escape(url)}</a>` : escape(url);
}

function known(row: Row): string {
  const facts = [
    `group <b>${escape(row.group)}</b>`,
    `trust <b>${escape(row.trust)}</b>`,
    row.known.canonical === undefined ? '' : `duplicate of ${link(row.known.canonical)}`,
    row.known.fixed_by === undefined ? '' : `closed by ${link(row.known.fixed_by)}`,
    row.known.type === undefined ? '' : `human type <b>${escape(row.known.type)}</b>`,
    row.known.disposition === undefined
      ? ''
      : `dispositioned <b>${escape(row.known.disposition.contract)}${row.known.disposition.route === undefined ? '' : `/${escape(row.known.disposition.route)}`}</b>${row.known.disposition.note === undefined ? '' : `: ${escape(row.known.disposition.note)}`} (a right or wrong mark overrides it)`,
    row.body_from === 'current' ? '<i>creation body unrecoverable; the current body stood in</i>' : '',
  ];
  return facts.filter(fact => fact !== '').join(' · ');
}

function verdictCell(line: Line, row: Row, outDir: string, mark: MarkValue | undefined): string {
  const parts: string[] = [`<div>judged by <b>${escape(judgedBy(line))}</b></div>`];
  if (line.path !== null) parts.push(`<div>intake path <b>${escape(line.path)}</b></div>`);
  const { verdict } = line;
  if (verdict === null) {
    parts.push('<div><i>triage did not run</i></div>');
  } else {
    parts.push(`<div class="verdict">${escape(verdict.contract)}${verdict.route === null ? '' : ` → ${escape(verdict.route)}`}${verdict.pull_request === null ? '' : ` (PR ${String(verdict.pull_request)})`}</div>`);
    if (verdict.contract === 'NO_ACTION') {
      const { closure } = verdict;
      const target = closure == null ? '' : `: ${closure.kind === 'duplicate' ? 'duplicate of' : 'delivered by'} ${link(closure.url)}`;
      parts.push(`<div><b>Proposes close</b> without a person${target}</div>`);
      const checked = closeCheck(row, line);
      if (checked === 'false') parts.push('<div class="warn">Counts as a false close unless you mark it right.</div>');
      if (checked === 'pending' && mark !== 'right' && mark !== 'wrong') {
        parts.push(`<div>A merged pull request on the base references this issue: ${(line.merged_on_base ?? []).map(link).join(', ')}. Mark whether it fixes the issue: the close bar stays pending until you mark it right or wrong.</div>`);
      }
    }
    if (verdict.blocked_reason != null) parts.push(`<div><b>Maintainer recommendation:</b> ${escape(verdict.blocked_reason)}</div>`);
    if ((verdict.blocked_by ?? []).length > 0) parts.push(`<div>waits on ${(verdict.blocked_by ?? []).map(link).join(', ')}</div>`);
    if (verdict.proposed_edits != null) parts.push(`<div><b>Proposed contract:</b> ${escape(verdict.proposed_edits.title)}</div>`);
    parts.push('<table class="fields">');
    for (const name of ['type', 'size', 'complexity', 'importance', 'urgency'] as const) {
      parts.push(`<tr><th>${name}</th><td><b>${escape(verdict[name].value)}</b> ${escape(verdict[name].reason)}</td></tr>`);
    }
    parts.push('</table>');
    if (verdict.summary !== undefined && verdict.summary !== '') parts.push(`<p>${escape(verdict.summary)}</p>`);
    if (line.mode === 'live') parts.push('<div><i>A live run keeps no summary, maintainer recommendation or links on its work item.</i></div>');
  }
  const cost = line.cost_usd === null ? 'cost unreported' : `$${line.cost_usd.toFixed(4)}`;
  const time = line.duration_ms === null ? '' : `, ${(line.duration_ms / 1000).toFixed(0)} s`;
  parts.push(`<div class="meta">${escape(cost)}${escape(time)} · run ${escape(line.run_id ?? 'none')}</div>`);
  if (line.leak.length > 0) parts.push(`<div class="warn">Looked the issue up (excluded from accuracy): ${line.leak.map(escape).join('; ')}</div>`);
  if (line.problems.length > 0) parts.push(`<div class="warn">${line.problems.map(escape).join('<br>')}</div>`);
  if (line.report !== null && existsSync(join(outDir, line.report))) {
    parts.push(`<details><summary>Triage report</summary><pre>${escape(readFileSync(join(outDir, line.report), 'utf8'))}</pre></details>`);
  }
  return parts.join('\n');
}

function markForm(line: Line, current: { mark: MarkValue; note: string } | undefined): string {
  if (line.run_id === null) return '';
  const options = MARKS.map(
    mark => `<label><input type="radio" name="mark" value="${mark}"${current?.mark === mark ? ' checked' : ''}> ${mark}</label>`
  ).join(' ');
  return `<form class="mark" data-run="${escape(line.run_id)}" data-row="${escape(line.row)}" data-label="${escape(line.version.label)}">
${options}
<textarea name="note" placeholder="note">${escape(current?.note ?? '')}</textarea>
<button type="submit">Save</button> <span class="saved"></span>
</form>`;
}

/** The lines a batch's page shows: each version's latest line per row of the batch. */
export function batchLines(set: BenchSet, outDir: string, batch: number): Map<string, Map<string, Line>> {
  const ids = new Set(batchRows(set, batch).map(row => row.id));
  const shown = new Map<string, Map<string, Line>>();
  for (const [label, rows] of latestByVersion(outDir)) {
    const inBatch = new Map([...rows].filter(([id]) => ids.has(id)));
    if (inBatch.size > 0) shown.set(label, inBatch);
  }
  return shown;
}

/** A line can be marked only when its batch run passed every hard check. */
export function markable(line: Line, checks: ReadonlyMap<string, BatchChecks>): boolean {
  return line.run_id !== null && checks.get(line.batch_run)?.passed === true;
}

export function renderPage(set: BenchSet, outDir: string, batch: number): string {
  const rows = batchRows(set, batch);
  const lines = batchLines(set, outDir, batch);
  const labels = [...lines.keys()];
  const checks = readChecks(outDir);
  const marks = readMarks(outDir);
  const batchRuns = [...new Set([...lines.values()].flatMap(byRow => [...byRow.values()].map(line => line.batch_run)))];
  const failures = batchRuns.flatMap(batchRun => {
    const record = checks.get(batchRun);
    if (record === undefined) return [`<li>${escape(batchRun)}: no hard-check record; the runner did not finish this batch run</li>`];
    return Object.entries(record.checks)
      .filter(([, value]) => !value.ok)
      .map(([name, value]) => `<li>${escape(batchRun)} failed <b>${escape(name)}</b>: ${value.problems.map(escape).join('; ')}</li>`);
  });

  const sections = rows.map(row => {
    const cells = labels.map(label => {
      const line = lines.get(label)?.get(row.id);
      if (line === undefined) return '<td><i>not run</i></td>';
      const mark = line.run_id === null ? undefined : marks.get(line.run_id);
      return `<td>${verdictCell(line, row, outDir, mark?.mark)}${markable(line, checks) ? markForm(line, mark) : '<div class="warn">Batch run failed a hard check: nothing to mark.</div>'}</td>`;
    });
    return `<section>
<h2>${escape(row.id)}: ${escape(row.title)}</h2>
<div class="known">${known(row)}</div>
<details><summary>Issue as opened</summary><pre>${escape(row.body)}</pre></details>
<table class="versions"><tr>${labels.map(label => `<th>${escape(label)}</th>`).join('')}</tr><tr>${cells.join('')}</tr></table>
</section>`;
  });

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Intake bench, batch ${String(batch)}</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 1.5rem; }
section { border-top: 1px solid #ccc; padding: .5rem 0 1rem; }
table.versions { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.versions td, table.versions th { border: 1px solid #ddd; padding: .5rem; vertical-align: top; text-align: left; }
table.fields th { text-align: left; padding-right: .5rem; }
.verdict { font-weight: bold; font-size: 1.1em; }
.meta { color: #666; font-size: .9em; margin-top: .3rem; }
.warn { color: #a00; }
.failed { background: #fee; border: 1px solid #a00; padding: .5rem 1rem; }
pre { white-space: pre-wrap; max-height: 30rem; overflow: auto; background: #f7f7f7; padding: .5rem; }
form.mark textarea { width: 100%; min-height: 3rem; }
</style></head><body>
<h1>Intake bench, batch ${String(batch)}</h1>
<p>${escape(set.repo.host)}/${escape(set.repo.path)} · versions: ${labels.map(escape).join(', ') || 'none run'}</p>
${failures.length > 0 ? `<div class="failed"><b>This batch failed a hard check.</b> Its failed runs cannot be marked.<ul>${failures.join('')}</ul></div>` : ''}
${sections.join('\n')}
<script>
for (const form of document.querySelectorAll('form.mark')) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const saved = form.querySelector('.saved');
    saved.textContent = 'saving';
    try {
      const response = await fetch('/marks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: form.dataset.run, mark: data.get('mark'), note: data.get('note') ?? '' }),
      });
      saved.textContent = response.ok ? 'saved' : 'not saved: ' + (await response.text());
    } catch (error) {
      saved.textContent = 'not saved: ' + error.message;
    }
  });
}
</script>
</body></html>
`;
}

/** Record a mark posted from the page, refusing a run the page does not let the operator mark. */
export function postMark(set: BenchSet, outDir: string, batch: number, body: unknown): void {
  if (typeof body !== 'object' || body === null) throw new Error('a mark is a JSON object');
  const { run_id: runId, mark, note } = body as Record<string, unknown>;
  const checks = readChecks(outDir);
  const line = [...batchLines(set, outDir, batch).values()].flatMap(byRow => [...byRow.values()]).find(entry => entry.run_id === runId);
  if (line === undefined || !markable(line, checks)) throw new Error(`run ${String(runId)} is not a markable run of batch ${String(batch)}`);
  if (!MARKS.includes(mark as MarkValue)) throw new Error(`mark must be one of ${MARKS.join(', ')}`);
  recordMark(outDir, {
    run_id: line.run_id as string,
    batch,
    row: line.row,
    label: line.version.label,
    mark: mark as MarkValue,
    note: typeof note === 'string' ? note : '',
  });
}

/** Serve the batch's page on the loopback interface until the process is stopped. */
export function servePage(set: BenchSet, outDir: string, batch: number, port: number): string {
  batchRows(set, batch);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(renderPage(set, outDir, batch), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      // JSON only: another site's page can post a plain form here without a preflight.
      if (request.method === 'POST' && url.pathname === '/marks' && request.headers.get('content-type') === 'application/json') {
        try {
          postMark(set, outDir, batch, await request.json());
          return new Response('ok');
        } catch (error) {
          return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
        }
      }
      return new Response('not found', { status: 404 });
    },
  });
  return server.url.href;
}
