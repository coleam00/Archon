#!/usr/bin/env bun
/**
 * eval-portfolio — the one-command in-loop regression gate (manual entry point;
 * /evolve invokes the same suites directly).
 *
 * Runs the standing-eval-suite workflow for each portfolio suite (golden, then
 * regressions) and prints one combined PASS/FAIL summary. Exit 1 on any gate
 * failure or detection miss.
 *
 * HONEST GUARDED SURFACE: this validates the VERIFIER layer — the judge workflow
 * YAML, its rubric prompts, the eval scripts, suite.json weights/thresholds, and
 * model-tier config. Run it BEFORE shipping a change to any of those. It does NOT
 * exercise CLAUDE.md rules or agent checklists (see .archon/evals/recall/ for the
 * memory-firing probes).
 *
 * Named script (NOT inline) — see eval-load-suite.ts for why.
 * Usage: bun .archon/scripts/eval-portfolio.ts [suite ...]   (default: golden regressions)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const suites = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['golden', 'regressions'];
const historyPath = join(process.cwd(), '.archon', 'state', 'eval-history.jsonl');

interface Scorecard {
  suite: string;
  gate: string;
  votes?: number;
  overall: number | null;
  detection_misses?: Array<{ case_id: string }>;
  regressions?: Array<{ dim: string }>;
  scored_at: string;
}

function lastScorecard(suite: string): Scorecard | null {
  if (!existsSync(historyPath)) return null;
  const lines = readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const sc = JSON.parse(lines[i]) as Scorecard;
    if (sc.suite === suite) return sc;
  }
  return null;
}

let anyFail = false;
const results: string[] = [];
for (const suite of suites) {
  const suiteDir = join(process.cwd(), '.archon', 'evals', suite);
  if (!existsSync(join(suiteDir, 'suite.json'))) {
    console.error(`[portfolio] suite "${suite}" not found at ${suiteDir} — failing loudly.`);
    process.exit(1);
  }
  const before = lastScorecard(suite)?.scored_at;
  console.log(`[portfolio] running suite: ${suite} ...`);
  const run = spawnSync('bun', ['run', 'cli', 'workflow', 'run', 'standing-eval-suite'], {
    env: { ...process.env, EVAL_SUITE: suite },
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  const sc = lastScorecard(suite);
  if (run.status !== 0 || !sc || sc.scored_at === before) {
    console.error(`[portfolio] ${suite}: workflow failed or produced no new scorecard — gate FAILS.`);
    process.exit(1);
  }
  const misses = sc.detection_misses?.length ?? 0;
  const regs = sc.regressions?.length ?? 0;
  const line = `${suite}: ${sc.gate} (votes=${sc.votes ?? 1}, overall=${sc.overall ?? 'n/a'}, detection_misses=${misses}, regressions=${regs})`;
  results.push(line);
  if (sc.gate !== 'PASS') anyFail = true;
}

console.log('\n=== PORTFOLIO GATE ===');
for (const r of results) console.log(r);
console.log(anyFail ? 'PORTFOLIO: FAIL' : 'PORTFOLIO: PASS');
process.exit(anyFail ? 1 : 0);
