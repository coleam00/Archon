---
description: Deep news analysis using Claude AI — sentiment, sector impact, macro risk assessment
argument-hint: (none — reads news_feed.json from artifacts)
---

# Fund Analyze News Impact

You are a senior macroeconomic analyst. Your task is to perform deep, multi-step analysis of financial news and produce a structured assessment of market sentiment and risk.

## Input

Read the news feed from `$ARTIFACTS_DIR/news_feed.json`. This file contains an array of news items with title, source, url, publish_time, and summary fields.

## Analysis Task

Perform the following analysis on the collected news:

### 1. Overall Market Sentiment Assessment
- Categorize the dominant sentiment: POSITIVE / NEGATIVE / NEUTRAL / MIXED
- Count the distribution: how many positive, negative, neutral signals
- Explain the reasoning behind your overall classification

### 2. Key Themes Identification
- Identify 3-5 recurring themes across the news
- Note cross-news correlations — do multiple sources report the same event?
- Flag any contradictory reporting

### 3. Sector Impact Matrix
- List affected sectors/industries and the direction of impact (positive/negative)
- Rank by intensity of impact
- Identify sectors most exposed to current news cycle

### 4. Macro Risk Assessment
- Evaluate geopolitical risk level (LOW / MODERATE / ELEVATED / HIGH)
- Assess policy/regulatory risk signals
- Note any systemic risk indicators

### 5. Top 5 Critical Events
- Select the 5 most impactful news items
- For each: explain why it matters and its potential market impact duration (days/weeks/months)

## Output Format

You MUST output a structured JSON object:

```json
{
  "overall_sentiment": "POSITIVE|NEGATIVE|NEUTRAL|MIXED",
  "sentiment_distribution": {
    "positive": 0,
    "negative": 0,
    "neutral": 0,
    "mixed": 0
  },
  "sentiment_reasoning": "Brief explanation of overall sentiment assessment",
  "key_themes": ["theme1", "theme2"],
  "sector_impacts": [
    {"sector": "金融", "impact": "POSITIVE", "intensity": "HIGH", "reason": ""},
    {"sector": "科技", "impact": "NEGATIVE", "intensity": "MEDIUM", "reason": ""}
  ],
  "macro_risk": {
    "geopolitical": "MODERATE",
    "policy_regulatory": "LOW",
    "systemic": "LOW"
  },
  "top_5_events": [
    {
      "title": "Event title",
      "impact_duration": "weeks",
      "significance": "Why this matters"
    }
  ],
  "summary_text": "1-2 sentence overall summary of the news landscape"
}
```

## After Analysis

1. Save the JSON output to `$ARTIFACTS_DIR/news_analysis.json`
2. Report a brief summary to the user: overall sentiment, key risk signals, and top concern

## Important

- Be specific and data-driven — reference actual news items in your analysis
- If the news feed is empty or unavailable, output NEUTRAL sentiment with a note
- Distinguish between short-term noise and structural trends
