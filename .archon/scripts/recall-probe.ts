#!/usr/bin/env bun
/**
 * recall-probe — memory-firing measurement (.archon/evals/recall/).
 *
 * For each case: create a throwaway fixture dir, spawn a FRESH headless
 * `claude -p` session (sonnet tier) with the planted task, and grep the full
 * stream-json transcript for binary evidence that the target memory's rule was
 * APPLIED. fired iff every `evidence` regex matches AND no `forbidden` regex
 * matches. N runs per case (RECALL_RUNS, default 3 — n=1 is not calibration).
 *
 * A low firing rate is a FINDING about the memory's description/index hook —
 * fix the memory, never soften the evidence regexes.
 *
 * Named script (NOT inline) — see eval-load-suite.ts for why. Dep-free: cases
 * are JSON (this harness has no AI judge reading them, so YAML buys nothing).
 * Usage: bun .archon/scripts/recall-probe.ts [case-id ...]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

interface RecallCase {
  id: string;
  memory: string;
  task: string;
  fixture?: Array<{ path: string; content: string }>;
  evidence: string[];
  forbidden: string[];
}

const casesDir = join(process.cwd(), '.archon', 'evals', 'recall', 'cases');
if (!existsSync(casesDir)) {
  console.error(`recall cases dir not found: ${casesDir}`);
  process.exit(1);
}
const runs = Math.max(1, Number(process.env.RECALL_RUNS || 3));
const filterIds = process.argv.slice(2);
const caseFiles = readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort();
const cases: RecallCase[] = caseFiles
  .map((f) => JSON.parse(readFileSync(join(casesDir, f), 'utf8')) as RecallCase)
  .filter((c) => filterIds.length === 0 || filterIds.includes(c.id));
if (cases.length === 0) {
  console.error(`no recall cases matched ${filterIds.join(', ') || '(all)'}`);
  process.exit(1);
}
if (runs === 1) console.log('[recall] RECALL_RUNS=1 — one run is a smoke, NOT calibration.');

// JS RegExp has no PCRE-style inline flag group like (?i); translate a leading
// one (e.g. (?i), (?im)) into the flags argument. The harness always wants 'm'.
function compileProbe(pattern: string): RegExp {
  const m = pattern.match(/^\(\?([imsuy]+)\)/);
  const flags = [...new Set('m' + (m ? m[1] : ''))].join('');
  return new RegExp(m ? pattern.slice(m[0].length) : pattern, flags);
}

function probeOnce(c: RecallCase, runIdx: number): { fired: boolean; detail: string } {
  const dir = join(tmpdir(), 'recall-probe', `${c.id}-${Date.now()}-${runIdx}`);
  mkdirSync(dir, { recursive: true });
  try {
    for (const fx of c.fixture || []) {
      const p = join(dir, fx.path);
      const resolved = resolve(p);
      if (resolved !== resolve(dir) && !resolved.startsWith(resolve(dir) + sep)) {
        console.error(`recall case "${c.id}" fixture path escapes the sandbox: ${fx.path}`);
        process.exit(1);
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, fx.content);
    }
    if ((c.fixture || []).some((fx) => fx.path === 'init.sh')) {
      // Provide a git identity so a fixture `git commit` doesn't fail 128 in a
      // throwaway dir with no configured user.name/user.email.
      const initRes = spawnSync('bash', ['init.sh'], {
        cwd: dir,
        timeout: 30000,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'archon-eval',
          GIT_AUTHOR_EMAIL: 'eval@archon.local',
          GIT_COMMITTER_NAME: 'archon-eval',
          GIT_COMMITTER_EMAIL: 'eval@archon.local',
        },
      });
      if (initRes.error || initRes.status !== 0) {
        const lastErr = (initRes.stderr || '').trim().split('\n').pop() || '';
        return { fired: false, detail: `init.sh failed (exit ${initRes.status}${initRes.error ? `, ${initRes.error.message}` : ''}${lastErr ? `: ${lastErr}` : ''}) — fixture broken, not a memory-recall signal` };
      }
    }
    // The prompt is passed via STDIN, not as an argv element. On Windows `claude`
    // resolves to claude.cmd, which Node can only spawn with shell:true — and
    // shell:true does NOT quote argv, so a multi-word `-p <task>` gets split at
    // spaces (the prompt is truncated to its first word, silently mismeasuring
    // recall). `claude -p` with no inline prompt reads the prompt from stdin; the
    // remaining flags contain no spaces, so they survive shell:true intact.
    const res = spawnSync(
      'claude',
      [
        '-p',
        '--model', 'sonnet',
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '12',
        '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
      ],
      { cwd: dir, input: c.task, timeout: 300000, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    const transcript = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.error) {
      return { fired: false, detail: `session failed to run: ${res.error.message}` };
    }
    if (res.status !== 0) {
      // A session that errored (rate limit, crash, timeout) after emitting partial
      // stream-json must not be scored on that truncated output — it is not a
      // valid recall data point.
      return { fired: false, detail: `session error (exit ${res.status})${transcript.trim() ? ' — partial output discarded' : ''}` };
    }
    const missing = c.evidence.filter((e) => !compileProbe(e).test(transcript));
    const violated = c.forbidden.filter((f) => compileProbe(f).test(transcript));
    if (violated.length > 0) return { fired: false, detail: `forbidden matched: ${violated[0]}` };
    if (missing.length > 0) return { fired: false, detail: `evidence missing: ${missing[0]}` };
    return { fired: true, detail: 'ok' };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

const report: Array<{ id: string; memory: string; fired: number; runs: number; details: string[] }> = [];
for (const c of cases) {
  const details: string[] = [];
  let fired = 0;
  for (let i = 1; i <= runs; i++) {
    console.log(`[recall] ${c.id} run ${i}/${runs} ...`);
    const r = probeOnce(c, i);
    if (r.fired) fired++;
    details.push(r.detail);
    console.log(`[recall]   -> ${r.fired ? 'FIRED' : 'not fired'} (${r.detail})`);
  }
  report.push({ id: c.id, memory: c.memory, fired, runs, details });
}

const summary = {
  probed_at: new Date().toISOString(),
  runs_per_case: runs,
  cases: report.map((r) => ({ id: r.id, memory: r.memory, firing_rate: `${r.fired}/${r.runs}` })),
};
const stateDir = join(process.cwd(), '.archon', 'state');
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, 'recall-history.jsonl'), JSON.stringify(summary) + '\n');

console.log('\n=== RECALL FIRING RATES ===');
for (const r of report) console.log(`${r.id}  ${r.fired}/${r.runs}  (${r.memory})`);
