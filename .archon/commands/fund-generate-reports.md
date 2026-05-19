---
description: Generate analysis reports in Markdown, CSV, and JSON formats
argument-hint: (none — reads scoring_results.json from artifacts)
---

# Fund Generate Reports

You are a report generation agent. Your task is to produce the final analysis reports in all three output formats.

## Pre-requisite Data

The report generator expects:
- `$ARTIFACTS_DIR/scoring_results.json` — Fund analysis results from fund-score-engine
- `$ARTIFACTS_DIR/news_analysis.json` — (optional) News sentiment analysis
- `$ARTIFACTS_DIR/macro_data.json` — (optional) Macro indicator data

## Task

Run the report generator:

```bash
bun run .archon/scripts/fund-report-generator.ts \
  --scores "$ARTIFACTS_DIR/scoring_results.json" \
  --output-dir "$ARTIFACTS_DIR"
```

## Output Files

The generator produces three files in `$ARTIFACTS_DIR`:

### 1. `基金投资分析报告.md` (Markdown)
Full analysis report with:
- Section I: Macro Overview — indicator collection status
- Section II: News Impact Summary — sentiment, top news table
- Section III: Fund Analysis Details — per-fund six-dim scores + five-dim screening
- Section IV: Investment Recommendation Summary — ranked table
- Section V: Risk Disclaimer

### 2. `基金分析结果.csv` (CSV)
Excel-compatible table (UTF-8 BOM encoded) with:
- Fund code, name, category
- All six dimension scores, five screening results
- Composite score, recommendation, risk warnings

### 3. `基金分析结果.json` (JSON)
Machine-readable summary with:
- Generation timestamp, news sentiment, macro coverage
- Recommendation distribution counts
- Full per-fund analysis data

## After Generation

1. Confirm each output file path
2. Show a brief summary:
   - Total funds in report
   - Recommendation distribution (BUY/HOLD/REDUCE/SELL counts)
   - Top recommended fund
3. Note any data quality warnings

## Expected Duration

<1 second
