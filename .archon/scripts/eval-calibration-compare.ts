#!/usr/bin/env bun
/**
 * eval-calibration-compare.ts
 * Compare judge results against human labels for the calibration suite.
 *
 * Usage: bun .archon/scripts/eval-calibration-compare.ts <path-to-results.json>
 *
 * results.json format: array of { case_id: string, scores: { [dim]: { score: number, rationale: string } } }
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const DIMENSIONS = ["correctness", "completeness", "maintainability", "safety", "verification"] as const;
type Dim = typeof DIMENSIONS[number];

interface DimScore {
  score: number;
  rationale: string;
}

interface JudgeResult {
  case_id: string;
  scores: Record<Dim, DimScore>;
}

interface HumanCase {
  correctness: number;
  completeness: number;
  maintainability: number;
  safety: number;
  verification: number;
  verdict: string;
}

interface HumanLabels {
  labeled_by: string;
  bar: Record<string, string>;
  cases: Record<string, HumanCase>;
}

// Planted-defect catch checklist: [caseId, dimension, catchThreshold]
const PLANTED_DEFECTS: [string, Dim, number][] = [
  ["p1-plausible-but-wrong", "correctness", 2],
  ["p2-vacuous-tests", "verification", 2],
  ["p3-injectable-query", "safety", 2],
  ["p4-happy-path-only", "completeness", 2],
  ["p6-comment-lies", "safety", 2],
  ["r1-real-math-untested", "verification", 2],
  ["r3-real-eval-aggregate-script", "verification", 2],
];

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun .archon/scripts/eval-calibration-compare.ts <path-to-results.json>");
    process.exit(1);
  }

  const resultsPath = resolve(args[0]);
  const labelsPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../evals/calibration/human-labels.json"
  );

  // Load human labels
  let humanLabels: HumanLabels;
  try {
    humanLabels = JSON.parse(readFileSync(labelsPath, "utf-8"));
  } catch (e) {
    console.error(`Failed to read human labels from ${labelsPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Load judge results
  let judgeResults: JudgeResult[];
  try {
    judgeResults = JSON.parse(readFileSync(resultsPath, "utf-8"));
  } catch (e) {
    console.error(`Failed to read judge results from ${resultsPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Index judge results by case_id
  const judgeMap = new Map<string, JudgeResult>();
  for (const r of judgeResults) {
    judgeMap.set(r.case_id, r);
  }

  const humanCaseIds = Object.keys(humanLabels.cases);
  const missedCases: string[] = [];
  for (const caseId of humanCaseIds) {
    if (!judgeMap.has(caseId)) {
      missedCases.push(caseId);
    }
  }

  // Compute agreement stats
  let totalPairs = 0;
  let agreedPairs = 0;
  const dimAgreements: Record<Dim, { agreed: number; total: number; sumAbsDelta: number }> = {
    correctness: { agreed: 0, total: 0, sumAbsDelta: 0 },
    completeness: { agreed: 0, total: 0, sumAbsDelta: 0 },
    maintainability: { agreed: 0, total: 0, sumAbsDelta: 0 },
    safety: { agreed: 0, total: 0, sumAbsDelta: 0 },
    verification: { agreed: 0, total: 0, sumAbsDelta: 0 },
  };

  interface Divergence {
    caseId: string;
    dim: Dim;
    human: number;
    judge: number;
    delta: number;
    rationale: string;
  }
  const divergences: Divergence[] = [];

  for (const caseId of humanCaseIds) {
    const humanCase = humanLabels.cases[caseId];
    const judgeResult = judgeMap.get(caseId);
    if (!judgeResult) continue;

    for (const dim of DIMENSIONS) {
      const humanScore = humanCase[dim];
      const judgeScore = judgeResult.scores[dim]?.score;
      if (judgeScore === undefined || judgeScore === null) continue;

      const delta = judgeScore - humanScore;
      const absDelta = Math.abs(delta);
      const agree = absDelta <= 1;

      totalPairs++;
      if (agree) agreedPairs++;

      dimAgreements[dim].total++;
      dimAgreements[dim].sumAbsDelta += absDelta;
      if (agree) dimAgreements[dim].agreed++;

      if (absDelta >= 2) {
        divergences.push({
          caseId,
          dim,
          human: humanScore,
          judge: judgeScore,
          delta,
          rationale: judgeResult.scores[dim]?.rationale ?? "(no rationale)",
        });
      }
    }
  }

  // Print report
  console.log("\n=== CALIBRATION COMPARISON REPORT ===");
  console.log(`Human labels: ${labelsPath}`);
  console.log(`Judge results: ${resultsPath}`);
  console.log(`Labeled by: ${humanLabels.labeled_by}`);
  console.log();

  if (missedCases.length > 0) {
    console.log(`WARNING: Judge did not score ${missedCases.length} labeled case(s):`);
    for (const c of missedCases) console.log(`  - ${c}`);
    console.log();
  }

  const overallPct = totalPairs > 0 ? ((agreedPairs / totalPairs) * 100).toFixed(1) : "N/A";
  console.log(`Overall within-±1 agreement: ${agreedPairs}/${totalPairs} = ${overallPct}%`);
  console.log();

  console.log("Per-dimension agreement (within ±1) and MAE:");
  for (const dim of DIMENSIONS) {
    const d = dimAgreements[dim];
    const pct = d.total > 0 ? ((d.agreed / d.total) * 100).toFixed(1) : "N/A";
    const mae = d.total > 0 ? (d.sumAbsDelta / d.total).toFixed(2) : "N/A";
    console.log(`  ${dim.padEnd(18)} agree=${pct}%  MAE=${mae}`);
  }
  console.log();

  if (divergences.length > 0) {
    console.log(`Large divergences (|delta| >= 2) — ${divergences.length} found:`);
    for (const d of divergences) {
      const sign = d.delta > 0 ? "+" : "";
      console.log(`  [${d.caseId}] ${d.dim}: human=${d.human} judge=${d.judge} (${sign}${d.delta})`);
      console.log(`    rationale: ${d.rationale}`);
    }
  } else {
    console.log("No large divergences (|delta| >= 2) found.");
  }
  console.log();

  // Planted-defect catch checklist
  console.log("=== PLANTED-DEFECT CATCH CHECKLIST ===");
  let caught = 0;
  for (const [caseId, dim, threshold] of PLANTED_DEFECTS) {
    const judgeResult = judgeMap.get(caseId);
    const judgeScore = judgeResult?.scores[dim]?.score;
    if (judgeScore === undefined || judgeScore === null) {
      console.log(`  ${caseId} / ${dim} <= ${threshold}: MISSING (judge did not score this case)`);
      continue;
    }
    const wasCaught = judgeScore <= threshold;
    if (wasCaught) caught++;
    const label = wasCaught ? "CAUGHT" : "MISSED";
    console.log(`  ${caseId} / ${dim} <= ${threshold}: ${label} (judge=${judgeScore})`);
  }
  console.log();
  console.log(`Judge caught ${caught}/${PLANTED_DEFECTS.length} planted defects.`);
  console.log();
}

main();
