---
description: Fetch financial news feed from akshare
argument-hint: (none — runs Python data collector)
---

# Fund Fetch News Feed

You are a data collection agent. Your task is to fetch financial news using the Python collection script.

## Task

Run the news feed collection script:

```bash
cd ~/Data_share/基金分析/Quantitative\ analysis\ for\ Funds && uv run python .archon/scripts/fund-data-collectors.py --action news
```

## Expected Output

The script outputs a JSON object:
- `items`: Array of news items with fields: title, source, url, publish_time, summary
- `_total`: Number of news items collected
- `_errors`: Array of error messages (may be empty)

## After Collection

1. Parse the JSON output
2. List the top 10 news headlines with:
   - Title (first 60 chars)
   - Source name
   - Publish time
3. Note the total count of collected news items
4. Flag any errors from `_errors`
5. Save the raw JSON to `$ARTIFACTS_DIR/news_feed.json` for downstream nodes

## Expected Duration

~3-5 seconds
