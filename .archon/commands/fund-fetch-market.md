---
description: Fetch global market data (US stocks, A-share indices, HK stocks, global indices)
argument-hint: (none — runs Python data collector)
---

# Fund Fetch Market Data

You are a data collection agent. Your task is to fetch global market data using the Python collection script.

## Task

Run the market data collection script:

```bash
cd ~/Data_share/基金分析/Quantitative\ analysis\ for\ Funds && uv run python .archon/scripts/fund-data-collectors.py --action market
```

## Expected Output

The script outputs a JSON object to stdout with these fields:
- `us_stocks`: Array of US stock quotes (symbol, name, latest_price, change_pct, pe_ratio, pb_ratio, volume)
- `a_indices`: Array of A-share index quotes
- `hk_stocks`: Array of HK stock quotes
- `global_indices`: Array of global index quotes
- `_errors`: Array of error messages for failed collections (may be empty)

## After Collection

1. Parse the JSON output
2. Summarize what was collected:
   - Stock count per market (US, A-share, HK, Global)
   - Top 5 US stocks by change_pct (biggest gainers and losers)
   - A-share index overview (which indices are up/down)
3. Note any failures from `_errors`
4. Save the raw JSON to `$ARTIFACTS_DIR/market_data.json` for downstream nodes

## Expected Duration

~10-15 seconds (yfinance batch + akshare serial calls)
