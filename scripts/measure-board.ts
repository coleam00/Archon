/**
 * How long a project's board, Overview and Needs you tab take to be complete in a browser
 * (DESIGN.md, COMBINED direction, "Speed is a requirement"): 3 s on a warm server, 10 s on a
 * freshly started one, at 1440x900.
 *
 *   bun scripts/measure-board.ts --base http://127.0.0.1:3241 --project <codebaseId>
 *     [--pages board,overview,needs-you] [--runs 1] [--settle 6000] [--wait-ready]
 *     [--screenshots <dir>]
 *
 * Each run opens the page in a new `agent-browser` session (an empty browser cache). An init
 * script, registered before the first navigation, samples the page every 50 ms from
 * `performance.now()` (milliseconds since navigation start): the board's columns, cards, cards
 * with a title and cards with round progress, the Overview's number tiles and map cards, the
 * Needs you rows, the text length of the page, and the fetches in flight. The page is complete
 * at the last sample that changed anything, once no fetch has been in flight and nothing has
 * changed for `--settle` ms. `--wait-ready` waits for the server to answer first, so a run
 * started right after a server starts measures a freshly started server.
 *
 * It prints one markdown table of the runs and, per run, the `/api/` waterfall (each read's
 * start and end) with its slowest read. Read-only: it opens pages and never presses anything.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Sample {
  t: number;
  columns: number;
  cards: number;
  titled: number;
  rounds: number;
  tiles: number;
  map: number;
  rows: number;
  text: number;
  inflight: number;
}

interface Resource {
  path: string;
  start: number;
  end: number;
}

const METRICS = ['columns', 'cards', 'titled', 'rounds', 'tiles', 'map', 'rows', 'text'] as const;
type Metric = (typeof METRICS)[number];

/** What a page needs before it can count as complete at all. */
const READY: Record<string, (s: Sample) => boolean> = {
  board: s => s.columns > 0 && s.cards > 0,
  overview: s => s.tiles > 0 && s.map > 0,
  'needs-you': s => s.text > 0,
};

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const base = arg('base');
const project = arg('project');
if (base === undefined || project === undefined) {
  console.error(
    'usage: bun scripts/measure-board.ts --base <url> --project <codebaseId> [...]\n' +
      "  <codebaseId> is the project's `id` in GET <url>/api/codebases, as in /console/p/<id>/board"
  );
  process.exit(2);
}
const pages = (arg('pages') ?? 'board,overview,needs-you').split(',');
const runs = Number(arg('runs') ?? '1');
const settleMs = Number(arg('settle') ?? '6000');
/** A directory to save each run's screenshot in, once the page is complete. */
const screenshots = arg('screenshots');
const timeoutMs = 240_000;

// The sampler the browser runs before any page script. It wraps `fetch` to count reads in
// flight, so a page still waiting on a read never looks settled.
const INIT = `(() => {
  const log = []; let inflight = 0; let last = '';
  const f = window.fetch.bind(window);
  window.fetch = (...a) => { inflight++; return f(...a).finally(() => { inflight--; }); };
  const count = s => document.querySelectorAll(s).length;
  const sample = () => {
    const cards = [...document.querySelectorAll('li[data-item]')];
    const s = {
      columns: [...document.querySelectorAll('[data-stage]')].filter(e => !e.closest('[data-card]')).length,
      cards: cards.length,
      titled: cards.filter(c => c.querySelector('[data-item-title]')).length,
      rounds: count('[data-card-rounds]'),
      tiles: count('[data-number]'),
      map: count('[data-flow-stage], [data-card]'),
      rows: count('[data-needs-row]'),
      text: (document.querySelector('main') || document.body || { innerText: '' }).innerText.length,
      inflight,
    };
    const key = JSON.stringify(s);
    if (key !== last) { last = key; log.push({ t: Math.round(performance.now()), ...s }); }
  };
  const resources = () => JSON.stringify(performance.getEntriesByType('resource')
    .filter(e => e.name.includes('/api/'))
    .map(e => { const u = new URL(e.name); return { path: u.pathname + u.search,
      start: Math.round(e.startTime), end: Math.round(e.responseEnd) }; }));
  window.__measure = { log, sample, resources, json: () => JSON.stringify(log), now: () => Math.round(performance.now()) };
  setInterval(sample, 50);
})();`;

const dir = mkdtempSync(join(tmpdir(), 'measure-board-'));
const initPath = join(dir, 'init.js');
writeFileSync(initPath, INIT);

let call = 0;
/**
 * The first call in a session starts that session's browser daemon, which inherits the call's
 * stdout and stderr: a pipe would never close, so the output goes through a file.
 */
function browser(session: string, ...args: string[]): string {
  const out = join(dir, `out-${(call++).toString()}.txt`);
  const result = Bun.spawnSync(['agent-browser', '--session', session, ...args], {
    stdin: 'ignore',
    stdout: Bun.file(out),
    stderr: Bun.file(`${out}.err`),
  });
  if (result.exitCode !== 0)
    throw new Error(
      `agent-browser ${args.join(' ')} failed: ${readFileSync(`${out}.err`, 'utf8').trim()}`
    );
  return readFileSync(out, 'utf8').trim();
}

/** `eval` prints its value as JSON; a string result is JSON inside JSON. */
function evalJson<T>(session: string, js: string): T {
  const printed = JSON.parse(browser(session, 'eval', js)) as unknown;
  return JSON.parse(typeof printed === 'string' ? printed : JSON.stringify(printed)) as T;
}

async function waitReady(): Promise<void> {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new Error(`${base} did not answer /api/health within 120 s`);
}

interface Result {
  page: string;
  run: number;
  complete: number | null;
  last: Partial<Record<Metric, number>>;
  final: Sample | null;
  resources: Resource[];
}

/** When each metric last changed, read from the change log. */
function lastChanges(log: Sample[]): Partial<Record<Metric, number>> {
  const at: Partial<Record<Metric, number>> = {};
  for (let i = 1; i < log.length; i++)
    for (const m of METRICS) if (log[i][m] !== log[i - 1][m]) at[m] = log[i].t;
  return at;
}

async function measure(page: string, run: number): Promise<Result> {
  const session = `measure-board-${process.pid}-${page}-${run}`;
  try {
    browser(session, '--init-script', initPath, 'open', 'about:blank');
    browser(session, 'set', 'viewport', '1440', '900');
    browser(session, 'open', `${base}/console/p/${project}/${page}`);
    const started = Date.now();
    let log: Sample[] = [];
    while (Date.now() - started < timeoutMs) {
      await Bun.sleep(1000);
      // A .cmd shim runs agent-browser on Windows, so an eval carries no quotes or brackets.
      log = evalJson<Sample[]>(session, 'window.__measure.json()');
      const now = evalJson<number>(session, 'window.__measure.now()');
      const tail = log.at(-1);
      const ready = log.some(s => READY[page]?.(s) ?? true);
      if (tail !== undefined && ready && tail.inflight === 0 && now - tail.t >= settleMs) break;
    }
    const resources = evalJson<Resource[]>(session, 'window.__measure.resources()');
    if (screenshots !== undefined)
      browser(session, 'screenshot', join(screenshots, `${page}-${run.toString()}.png`));
    const settled = log.at(-1);
    const done = settled !== undefined && settled.inflight === 0;
    // The last change to what a person sees; a sample that only moved the in-flight count
    // does not count.
    const changes = lastChanges(log);
    const complete = done ? Math.max(0, ...Object.values(changes)) : null;
    return { page, run, complete, last: changes, final: settled ?? null, resources };
  } finally {
    try {
      browser(session, 'close');
    } catch {
      // Already closed.
    }
  }
}

const fmt = (ms: number | undefined | null): string =>
  ms === undefined || ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`;

if (process.argv.includes('--wait-ready')) await waitReady();
const results: Result[] = [];
try {
  for (let run = 1; run <= runs; run++)
    for (const page of pages) {
      const result = await measure(page, run);
      results.push(result);
      console.error(`${page} #${run}: complete ${fmt(result.complete)}`);
    }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  '| page | run | complete | columns | titles | rounds | tiles | map | rows | api reads | last read ends | slowest read |'
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const slowest = [...r.resources].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  const f = r.final;
  const titles = f === null ? '-' : `${fmt(r.last.titled)} (${f.titled}/${f.cards})`;
  // A board where no card drew round progress has no round time to give: say so, rather than
  // leave a blank beside a complete time.
  const rounds =
    r.page === 'board' && f !== null && f.cards > 0 && f.rounds === 0
      ? 'not seen'
      : fmt(r.last.rounds);
  const lastEnd = Math.max(0, ...r.resources.map(x => x.end));
  console.log(
    `| ${r.page} | ${r.run} | ${r.complete === null ? 'timed out' : fmt(r.complete)} | ${fmt(r.last.columns)} | ${titles} | ${rounds} | ${fmt(r.last.tiles)} | ${fmt(r.last.map)} | ${fmt(r.last.rows)} | ${r.resources.length} | ${fmt(lastEnd)} | ${slowest === undefined ? '-' : `${slowest.path.split('?')[0]} ${fmt(slowest.end - slowest.start)}`} |`
  );
}
if (results.some(r => r.page === 'board' && r.final !== null && r.final.rounds === 0))
  console.log(
    "\nRounds 'not seen': no card drew round progress, so its time was not measured. Cards read rounds from the pack graph's display: words; for an installed pack without them, install a pack tree that has them first (ENGINEERING.md)."
  );
console.log('\nWhat each page drew when complete (the same data must draw the same counts):\n');
console.log('| page | run | columns | cards | titled | with rounds | tiles | map cards | rows |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const { page, run, final: f } of results)
  if (f !== null)
    console.log(
      `| ${page} | ${run} | ${f.columns} | ${f.cards} | ${f.titled} | ${f.rounds} | ${f.tiles} | ${f.map} | ${f.rows} |`
    );
for (const r of results) {
  console.log(`\n<details><summary>${r.page} #${r.run}: /api/ waterfall (ms)</summary>\n`);
  console.log('```');
  for (const x of [...r.resources].sort((a, b) => a.start - b.start))
    console.log(
      `${String(x.start).padStart(6)} ${String(x.end).padStart(6)} ${String(x.end - x.start).padStart(6)}  ${x.path.length > 110 ? `${x.path.slice(0, 110)}…` : x.path}`
    );
  console.log('```\n</details>');
}
