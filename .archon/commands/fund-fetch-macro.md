---
description: Fetch 26 macroeconomic indicators (China + US + global)
argument-hint: (none — runs Python data collector)
---

# Fund Fetch Macro Indicators

You are a data collection agent. Your task is to fetch macroeconomic indicators using the Python collection script.

## Task

Run the macro data collection script:

```bash
cd ~/Data_share/基金分析/Quantitative\ analysis\ for\ Funds && uv run python .archon/scripts/fund-data-collectors.py --action macro
```

## Expected Output

The script collects 26 macroeconomic indicators and outputs a JSON object:
- Keys are indicator names (e.g., `PMI_MANUFACTURING`, `CPI_YOY`, `USA_CPI_YOY`, `GOLD_SPOT`)
- Values are arrays of data rows
- `_errors`: Array of failed indicators
- `_success_count`: Number of successfully collected indicators
- `_total`: 26

## After Collection

1. Parse the JSON output
2. Report:
   - Success rate (e.g., "22/26 indicators collected")
   - List any failed indicators and their error messages
   - Key indicator summary:
     - Latest PMI values (Manufacturing + Non-Manufacturing)
     - Latest CPI/PPI trends
     - Gold spot price and change
     - US-CN yield spread
3. Note any significant data gaps
4. Save the raw JSON to `$ARTIFACTS_DIR/macro_data.json` for downstream nodes

## Expected Duration

~30-35 seconds (26 indicators × 1 second throttle interval)

## Important

Each indicator call is independent — failure of one does not affect others. The script uses a 1-second sleep between calls to respect akshare rate limits.
