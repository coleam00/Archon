#!/usr/bin/env bun
/**
 * The authoritative gate for standing-eval-suite. Pure JSON math:
 *  - N-VOTE MEDIAN (A4): reads every results-<n>.json the score nodes wrote and
 *    takes the per-case-per-dimension median, de-flaking single-vote ±1 wobble.
 *  - QUEUE-IDENTITY CHECK: every case queued by load-suite must be scored exactly
 *    once in every vote file — a judge that silently drops, duplicates, or invents
 *    a case fails the gate loudly instead of escaping the math.
 *  - DETECTION GATE (A3): if the suite carries a labels.json (failure-derived
 *    defect cases), each labelled case's median on its trap dimension must be
 *    <= max_score (the judge must CATCH the defect). Labelled cases are EXCLUDED
 *    from the mean/threshold math — their intentionally-low scores would poison
 *    the means. Labels live OUTSIDE case YAMLs so judges stay blind.
 *  - thresholds + per-case floor + regression-vs-baseline as before.
 * Writes a scorecard to $ARTIFACTS_DIR/eval/scorecard.json and appends one trend
 * line to .archon/state/eval-history.jsonl (gitignored). Fails loudly (exit 1) if
 * any vote is missing/invalid — "set the bar at the eval, not the demo."
 *
 * Named script (NOT inline) — see eval-load-suite.ts for why.
 * Reads: process.cwd(), EVAL_SUITE (default "seed"), ARTIFACTS_DIR.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const suite = process.env.EVAL_SUITE || 'seed';
const dir = join(process.cwd(), '.archon', 'evals', suite);
const art = process.env.ARTIFACTS_DIR;
if (!art) {
  console.error('ARTIFACTS_DIR not set');
  process.exit(1);
}
const evalDir = join(art, 'eval');

const manifest = JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8'));
const dims: string[] = manifest.dimensions;
const weights: Record<string, number> = manifest.weights;
const t = manifest.thresholds;

// ---------- Expected case ids from the queue (identity source of truth) ----------
// The id is regex-extracted from each queued YAML (top-level `id:` line) — no yaml
// package needed (bun can't resolve it from checkout root here).
const queuePath = join(evalDir, 'queue.txt');
if (!existsSync(queuePath)) {
  console.error(`queue.txt missing at ${queuePath} — load-suite did not run. Gate FAILS.`);
  process.exit(1);
}
const queuedPaths = readFileSync(queuePath, 'utf8').split(/\r?\n/).filter(Boolean);
const expectedIds: string[] = [];
for (const p of queuedPaths) {
  const m = readFileSync(p, 'utf8').match(/^id:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  if (!m) {
    console.error(`Case file has no top-level id: ${p} — gate FAILS.`);
    process.exit(1);
  }
  expectedIds.push(m[1].trim());
}
const expectedSet = new Set(expectedIds);
if (expectedSet.size !== expectedIds.length) {
  console.error(`Duplicate case ids in the queue: ${expectedIds.join(', ')} — gate FAILS.`);
  process.exit(1);
}

// ---------- Load every vote file (results-<n>.json) ----------
type CaseScores = Record<string, { score: number; rationale?: string }>;
type VoteResult = Array<{ case_id: string; scores: CaseScores }>;
const voteFiles = readdirSync(evalDir)
  .filter((f) => /^results-\d+\.json$/.test(f))
  .sort();
if (voteFiles.length === 0) {
  console.error(`No results-<n>.json vote files in ${evalDir} — judges produced nothing. Gate FAILS.`);
  process.exit(1);
}
const votes: VoteResult[] = [];
for (const f of voteFiles) {
  let parsed: VoteResult;
  try {
    parsed = JSON.parse(readFileSync(join(evalDir, f), 'utf8'));
  } catch (e) {
    console.error(`${f} is not valid JSON: ${(e as Error).message} — gate FAILS.`);
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error(`${f} is empty or not an array — gate FAILS.`);
    process.exit(1);
  }
  // Queue-identity: exactly the queued case set, each exactly once, all dims numeric.
  const seen = new Set<string>();
  for (const r of parsed) {
    if (!expectedSet.has(r.case_id)) {
      console.error(`${f} scored unknown case "${r.case_id}" (not in queue) — gate FAILS.`);
      process.exit(1);
    }
    if (seen.has(r.case_id)) {
      console.error(`${f} scored case "${r.case_id}" more than once — gate FAILS.`);
      process.exit(1);
    }
    seen.add(r.case_id);
    for (const d of dims) {
      const s = r.scores && r.scores[d] && r.scores[d].score;
      if (typeof s !== 'number') {
        console.error(`${f}: case "${r.case_id}" is missing a numeric score for "${d}" — gate FAILS.`);
        process.exit(1);
      }
    }
  }
  const dropped = expectedIds.filter((id) => !seen.has(id));
  if (dropped.length > 0) {
    console.error(`${f} silently dropped queued case(s): ${dropped.join(', ')} — gate FAILS.`);
    process.exit(1);
  }
  votes.push(parsed);
}

// ---------- Median-of-N per case per dimension ----------
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// Rationale kept from the first vote whose score equals the median (grounded, not synthesized).
const medianByCase: Record<string, CaseScores> = {};
for (const id of expectedIds) {
  const scores: CaseScores = {};
  for (const d of dims) {
    const voteScores = votes.map((v) => v.find((r) => r.case_id === id)!.scores[d]);
    const med = median(voteScores.map((x) => x.score));
    const src = voteScores.find((x) => x.score === med) || voteScores[0];
    scores[d] = { score: med, rationale: src.rationale };
  }
  medianByCase[id] = scores;
}

// ---------- Detection gate (labels.json — failure-derived defect cases) ----------
const labelsPath = join(dir, 'labels.json');
type Label = { trap_dim: string; max_score: number; source?: string };
let labels: Record<string, Label> = {};
if (existsSync(labelsPath)) {
  labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
  for (const [id, lab] of Object.entries(labels)) {
    if (!expectedSet.has(id)) {
      console.error(`labels.json labels case "${id}" which is not in the queue — stale label. Gate FAILS.`);
      process.exit(1);
    }
    if (!dims.includes(lab.trap_dim)) {
      console.error(`labels.json case "${id}" has unknown trap_dim "${lab.trap_dim}" — gate FAILS.`);
      process.exit(1);
    }
  }
}
const labelledIds = new Set(Object.keys(labels));
const detectionMisses: Array<{ case_id: string; trap_dim: string; median: number; max_score: number }> = [];
for (const [id, lab] of Object.entries(labels)) {
  const med = medianByCase[id][lab.trap_dim].score;
  if (med > lab.max_score) {
    detectionMisses.push({ case_id: id, trap_dim: lab.trap_dim, median: med, max_score: lab.max_score });
  }
}

// ---------- Threshold math over UNLABELLED cases only ----------
const gradedIds = expectedIds.filter((id) => !labelledIds.has(id));
const meanByDim: Record<string, number> = {};
let overall: number | null = null;
let caseFailures: string[] = [];
let dimFloorFailures: string[] = [];
if (gradedIds.length > 0) {
  for (const d of dims) {
    const vals = gradedIds.map((id) => medianByCase[id][d].score);
    meanByDim[d] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  overall = dims.reduce((sum, d) => sum + (weights[d] || 0) * meanByDim[d], 0);
  caseFailures = gradedIds.filter((id) => Math.min(...dims.map((d) => medianByCase[id][d].score)) < t.case_min);
  dimFloorFailures = dims.filter((d) => meanByDim[d] < t.dim_floor);
}

// ---------- Regression vs committed baseline (optional; unlabelled means only) ----------
const baselinePath = join(dir, 'baseline.json');
let regressions: Array<{ dim: string; baseline: number; current: number }> = [];
let baselineUsed = false;
if (existsSync(baselinePath) && gradedIds.length > 0) {
  baselineUsed = true;
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baseDims: Record<string, number> = (base && base.mean_by_dim) || {};
  regressions = dims
    .filter((d) => typeof baseDims[d] === 'number' && baseDims[d] - meanByDim[d] > t.regression_tolerance)
    .map((d) => ({ dim: d, baseline: baseDims[d], current: meanByDim[d] }));
}

// ---------- Gate ----------
const thresholdGatePasses =
  gradedIds.length === 0 ||
  ((overall as number) >= t.overall_min &&
    dimFloorFailures.length === 0 &&
    caseFailures.length === 0 &&
    regressions.length === 0);
const gate = thresholdGatePasses && detectionMisses.length === 0 ? 'PASS' : 'FAIL';

const scorecard = {
  suite,
  gate,
  votes: votes.length,
  n_cases: expectedIds.length,
  n_labelled: labelledIds.size,
  overall: overall === null ? null : Number(overall.toFixed(3)),
  overall_min: t.overall_min,
  mean_by_dim: Object.fromEntries(Object.entries(meanByDim).map(([d, v]) => [d, Number(v.toFixed(3))])),
  dim_floor: t.dim_floor,
  dim_floor_failures: dimFloorFailures,
  case_min: t.case_min,
  case_failures: caseFailures,
  detection_misses: detectionMisses,
  baseline_used: baselineUsed,
  regressions,
  scored_at: new Date().toISOString(),
};

writeFileSync(join(evalDir, 'scorecard.json'), JSON.stringify(scorecard, null, 2));
const stateDir = join(process.cwd(), '.archon', 'state');
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, 'eval-history.jsonl'), JSON.stringify(scorecard) + '\n');

console.log(JSON.stringify(scorecard, null, 2));
