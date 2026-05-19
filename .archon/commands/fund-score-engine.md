---
description: Run the TypeScript scoring engine — six-dimension quantitative scoring + five-dimension screening
argument-hint: (none — reads data files from artifacts)
---

# Fund Score Engine

You are a quantitative analysis agent. Your task is to run the TypeScript scoring engine that computes six-dimension scores and five-dimension screenings for each fund.

## Pre-requisite Data Files

The scoring engine expects these files in `$ARTIFACTS_DIR`:
- `fund_list.json` — Array of fund entries `[{code, name, category}, ...]`
- `holdings_analysis.json` — (optional) Holdings data with FCF, efficiency, dividend, valuation, growth fields
- `macro_data.json` — (optional) Macro indicator data
- `news_analysis.json` — (optional) News sentiment analysis from fund-analyze-news

## Task

Run the scoring engine:

```bash
bun run .archon/scripts/fund-score-engine.ts \
  --funds-file "$ARTIFACTS_DIR/fund_list.json" \
  --holdings-file "$ARTIFACTS_DIR/holdings_analysis.json" \
  --macro-file "$ARTIFACTS_DIR/macro_data.json" \
  --news-file "$ARTIFACTS_DIR/news_analysis.json" \
  --output "$ARTIFACTS_DIR/scoring_results.json"
```

## What the Engine Does

The scoring engine applies:

**Six-Dimension Quantitative Decision Framework**: FCF Quality, Capital Efficiency, Shareholder Return, Valuation Safety, Growth, Macro/Geopolitical Risk — each scored 0-10 with detailed reasoning.

**Five-Dimension Screening Framework**: Fundamental Qualitative, Performance/Risk Quantitative, Holding Penetration, Manager Evaluation, Market/Technical — each returning PASS/WARN/FAIL.

**Key Properties**:
- Deterministic: No random fallbacks — missing data returns `null` scores instead of random estimates
- Weighted composite: Computes a weighted average across available dimensions
- Recommendation mapping: BUY (≥7.5, 0 fails), HOLD (≥6.0, ≤1 fail), REDUCE (≥4.0), SELL (<4.0)

## After Execution

1. Report the scoring summary:
   - Total funds analyzed
   - Count per recommendation tier (BUY/HOLD/REDUCE/SELL)
   - Top 3 funds by composite score
   - Bottom 3 funds by composite score
2. Note any funds with all-null scores (insufficient data)
3. The results are saved to `$ARTIFACTS_DIR/scoring_results.json`

## Expected Duration

<1 second (pure computation, no network calls)

## Important

If any required file is missing, the engine will still run with available data and use null for unavailable dimensions. Report the data coverage to the user.
