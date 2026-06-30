#!/usr/bin/env bun
/**
 * The authoritative gate for standing-eval-suite. Pure JSON math: per-dimension
 * means, weighted overall, thresholds, per-case floor, and regression-vs-baseline.
 * Writes a scorecard to $ARTIFACTS_DIR/eval/scorecard.json and appends one trend
 * line to .archon/state/eval-history.jsonl (gitignored). Fails loudly (exit 1) if
 * the judge produced no valid results — "set the bar at the eval, not the demo."
 *
 * Named script (NOT inline) — see eval-load-suite.ts for why.
 * Reads: process.cwd(), EVAL_SUITE (default "seed"), ARTIFACTS_DIR.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const suite = process.env.EVAL_SUITE || 'seed';
const dir = join(process.cwd(), '.archon', 'evals', suite);
const art = process.env.ARTIFACTS_DIR;
if (!art) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8'));
const resultsPath = join(art, 'eval', 'results.json');
if (!existsSync(resultsPath)) {
  console.error(`Judge produced no results.json at ${resultsPath} — gate FAILS (verification absent).`);
  process.exit(1);
}
let results: Array<{ case_id: string; scores: Record<string, { score: number; rationale?: string }> }>;
try {
  results = JSON.parse(readFileSync(resultsPath, 'utf8'));
} catch (e) {
  console.error(`results.json is not valid JSON: ${(e as Error).message} — gate FAILS.`);
  process.exit(1);
}
if (!Array.isArray(results) || results.length === 0) {
  console.error('results.json is empty or not an array — gate FAILS.');
  process.exit(1);
}

const dims: string[] = manifest.dimensions;
const weights: Record<string, number> = manifest.weights;
const t = manifest.thresholds;

// Per-dimension means across cases (fail-fast on a missing/non-numeric score).
const meanByDim: Record<string, number> = {};
for (const d of dims) {
  const vals = results.map((r) => {
    const s = r.scores && r.scores[d] && r.scores[d].score;
    if (typeof s !== 'number') {
      console.error(`Case "${r.case_id}" is missing a numeric score for "${d}" — gate FAILS.`);
      process.exit(1);
    }
    return s;
  });
  meanByDim[d] = vals.reduce((a, b) => a + b, 0) / vals.length;
}

const overall = dims.reduce((sum, d) => sum + (weights[d] || 0) * meanByDim[d], 0);

// Per-case floor: any case whose WORST dimension is below case_min.
const caseFailures = results
  .filter((r) => Math.min(...dims.map((d) => r.scores[d].score)) < t.case_min)
  .map((r) => r.case_id);

// Per-dimension floor.
const dimFloorFailures = dims.filter((d) => meanByDim[d] < t.dim_floor);

// Regression vs committed baseline (optional).
const baselinePath = join(dir, 'baseline.json');
let regressions: Array<{ dim: string; baseline: number; current: number }> = [];
let baselineUsed = false;
if (existsSync(baselinePath)) {
  baselineUsed = true;
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baseDims: Record<string, number> = (base && base.mean_by_dim) || {};
  regressions = dims
    .filter((d) => typeof baseDims[d] === 'number' && baseDims[d] - meanByDim[d] > t.regression_tolerance)
    .map((d) => ({ dim: d, baseline: baseDims[d], current: meanByDim[d] }));
}

const gate =
  overall >= t.overall_min &&
  dimFloorFailures.length === 0 &&
  caseFailures.length === 0 &&
  regressions.length === 0
    ? 'PASS'
    : 'FAIL';

const scorecard = {
  suite,
  gate,
  n_cases: results.length,
  overall: Number(overall.toFixed(3)),
  overall_min: t.overall_min,
  mean_by_dim: Object.fromEntries(dims.map((d) => [d, Number(meanByDim[d].toFixed(3))])),
  dim_floor: t.dim_floor,
  dim_floor_failures: dimFloorFailures,
  case_min: t.case_min,
  case_failures: caseFailures,
  baseline_used: baselineUsed,
  regressions,
  scored_at: new Date().toISOString(),
};

writeFileSync(join(art, 'eval', 'scorecard.json'), JSON.stringify(scorecard, null, 2));
const stateDir = join(process.cwd(), '.archon', 'state');
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, 'eval-history.jsonl'), JSON.stringify(scorecard) + '\n');

console.log(JSON.stringify(scorecard, null, 2));
