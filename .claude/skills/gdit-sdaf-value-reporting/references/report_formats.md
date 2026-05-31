# Value Reporting — Example Output Formats

Reference document showing example output for each report type and output format. All data is synthetic.

---

## Project Summary (terminal)

```
$ python3 scripts/value_report.py --scope project

Value Report — Project Summary
══════════════════════════════════════════════════════════════════════════════════
 Specs │ Tasks │ Done │ In Prog │ Pts Est │ Pts Act │ Human LOE │ AI Actual │ Savings   │ Ratio
───────┼───────┼──────┼─────────┼─────────┼─────────┼───────────┼───────────┼───────────┼──────
 12    │ 47    │ 42   │ 3       │ 156     │ 148     │ 98h 30m   │ 9h 45m    │ 88h 45m   │ 10.1x
───────┼───────┼──────┼─────────┼─────────┼─────────┼───────────┼───────────┼───────────┼──────
 Savings: 90.1%  │  Velocity: 8.3 pts/month
══════════════════════════════════════════════════════════════════════════════════

 Spec                        │ Tasks │ Done │ Pts Est │ Human LOE │ AI Actual │ Savings  │ Ratio
─────────────────────────────┼───────┼──────┼─────────┼───────────┼───────────┼──────────┼──────
 user-authentication         │ 6     │ 6    │ 21      │ 14h       │ 1h 15m    │ 12h 45m  │ 11.2x
 data-export                 │ 4     │ 4    │ 13      │ 8h        │ 55m       │ 7h 5m    │ 8.7x
 skill-creator               │ 9     │ 9    │ 28      │ 18h       │ 2h 10m    │ 15h 50m  │ 8.3x
 ...                         │       │      │         │           │           │          │
```

## Feature Detail (terminal)

```
$ python3 scripts/value_report.py --scope feature --spec user-auth --detail

Feature Detail — user-authentication
══════════════════════════════════════════════════════════════════════════════════
 Task │ Pts Est │ Pts Act │ Human LOE │ AI Est │ AI Actual │ Savings  │ Flag
──────┼─────────┼─────────┼───────────┼────────┼───────────┼──────────┼─────────
 1    │ 5       │ 5       │ 4h        │ 45m    │ 40m       │ 3h 20m   │
 2    │ 3       │ 3       │ 2h        │ 20m    │ 15m       │ 1h 45m   │ ▼ OVER
 3    │ 3       │ 3       │ 2h        │ 20m    │ 50m       │ 1h 10m   │ ▲ UNDER
 4    │ 5       │ 5       │ 4h        │ 45m    │ 30m       │ 3h 30m   │
──────┼─────────┼─────────┼───────────┼────────┼───────────┼──────────┼─────────
 Tot  │ 16      │ 16      │ 12h       │ 2h 10m │ 2h 15m    │ 9h 45m   │
 Savings: 81.3%  │  Ratio: 5.3x
```

## Trend Analysis (terminal)

```
$ python3 scripts/value_report.py --trend --period monthly --since 2026-01-01

Trend Analysis — Monthly
══════════════════════════════════════════════════════════════════════════════════
 Period  │ Tasks │ Points │ Velocity │ Human LOE │ AI Actual │ Savings  │ Ratio
─────────┼───────┼────────┼──────────┼───────────┼───────────┼──────────┼──────
 2026-01 │ 8     │ 26     │ 26       │ 16h       │ 1h 45m    │ 14h 15m  │ 9.1x
 2026-02 │ 12    │ 38     │ 38       │ 24h       │ 2h 20m    │ 21h 40m  │ 10.3x
 2026-03 │ 14    │ 48     │ 48       │ 30h       │ 2h 50m    │ 27h 10m  │ 10.6x
 2026-04 │ 8     │ 36     │ 36       │ 28h 30m   │ 2h 50m    │ 25h 40m  │ 10.1x
══════════════════════════════════════════════════════════════════════════════════
 Note: 2 tasks excluded (missing Complete timestamp)
```

## Estimation Accuracy (terminal)

```
$ python3 scripts/value_report.py --accuracy

Estimation Accuracy
══════════════════════════════════════════════════════════════════════════════════
 Spec                    │ Tasks │ Pts Est │ Pts Act │ Pts Ratio │ Time Est │ Time Act │ Time Ratio
─────────────────────────┼───────┼─────────┼─────────┼───────────┼──────────┼──────────┼───────────
 data-export             │ 4     │ 13      │ 18      │ 1.38      │ 2h       │ 3h 30m   │ 1.75
 user-authentication     │ 6     │ 21      │ 19      │ 0.90      │ 3h 30m   │ 2h 15m   │ 0.64
 skill-creator           │ 9     │ 28      │ 30      │ 1.07      │ 4h 30m   │ 5h       │ 1.11
══════════════════════════════════════════════════════════════════════════════════
 Simple Avg   │ Pts: 1.12  │ Time: 1.17
 Weighted Avg │ Pts: 1.08  │ Time: 1.05
```

## Dashboard (terminal)

```
$ python3 scripts/value_report.py --dashboard

Value Dashboard — gdit-sdaf
─────────────────────────────────
Tasks: 42 completed, 3 in-progress, 2 not started
Savings: 90.1% (10.1x) — 88h 45m saved
Velocity: 8.3 points/month
Estimation: 1.05 avg accuracy (time)
```

## Status (terminal)

```
$ python3 scripts/value_report.py --status

Task Status
══════════════════════════════════════════════════════════════════════════════════
 Spec                        │ Total │ Done │ In Prog │ Not Started │ Missing Data
─────────────────────────────┼───────┼──────┼─────────┼─────────────┼─────────────
 iac-validation              │ 5     │ 2    │ 1       │ 2           │ 0
 code-validation             │ 4     │ 1    │ 0       │ 1           │ 2
 user-authentication         │ 6     │ 6    │ 0       │ 0           │ 0
 skill-creator               │ 9     │ 9    │ 0       │ 0           │ 0
─────────────────────────────┼───────┼──────┼─────────┼─────────────┼─────────────
 Total                       │ 47    │ 42   │ 3       │ 2           │ 2
```

---

## Markdown Output

```
$ python3 scripts/value_report.py --dashboard --format markdown

## Value Dashboard — gdit-sdaf

| Metric | Value |
|--------|-------|
| Tasks Completed | 42 |
| Tasks In Progress | 3 |
| Tasks Not Started | 2 |
| Savings | 90.1% (10.1x) |
| Time Saved | 88h 45m |
| Velocity | 8.3 points/month |
| Estimation Accuracy | 1.05 (time) |
```

---

## CSV Output

```
$ python3 scripts/value_report.py --scope project --format csv

# Project Summary
specs,tasks,completed,in_progress,points_est,points_act,human_loe_min,ai_actual_min,savings_min,savings_pct,savings_ratio,velocity
12,47,42,3,156,148,5910,585,5325,90.1,10.1,8.3

# Per-Spec Detail
spec,tasks,completed,points_est,points_act,human_loe_min,ai_actual_min,savings_min,savings_pct,savings_ratio
user-authentication,6,6,21,19,840,75,765,91.1,11.2
data-export,4,4,13,18,480,55,425,88.5,8.7
skill-creator,9,9,28,30,1080,130,950,88.0,8.3
```

---

## JSON Output

```json
{
  "metadata": {
    "generated_at": "2026-04-17T12:30:00-04:00",
    "specs_dir": ".kiro/specs/",
    "scope": "dashboard",
    "format_version": "1.0.0"
  },
  "data": {
    "project": "gdit-sdaf",
    "tasks_completed": 42,
    "tasks_in_progress": 3,
    "tasks_not_started": 2,
    "savings_percentage": 90.1,
    "savings_ratio": 10.1,
    "savings_minutes": 5325,
    "velocity_points_per_month": 8.3,
    "estimation_accuracy_time": 1.05
  }
}
```

---

## HTML Output (snippet)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Value Report — gdit-sdaf</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2rem; }
    h1 { color: #1a1a2e; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th { background: #16213e; color: #fff; padding: 0.5rem 1rem; text-align: left; }
    td { padding: 0.5rem 1rem; border-bottom: 1px solid #e0e0e0; }
    tr:nth-child(even) { background: #f5f5f5; }
    tr.total { font-weight: bold; background: #e8f4f8; }
    .meta { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>Value Dashboard — gdit-sdaf</h1>
  <p class="meta">Generated: 2026-04-17T12:30:00-04:00</p>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Tasks Completed</td><td>42</td></tr>
    <tr><td>Tasks In Progress</td><td>3</td></tr>
    <tr><td>Savings</td><td>90.1% (10.1x)</td></tr>
    <tr><td>Time Saved</td><td>88h 45m</td></tr>
    <tr><td>Velocity</td><td>8.3 points/month</td></tr>
    <tr><td>Estimation Accuracy</td><td>1.05 (time)</td></tr>
  </table>
</body>
</html>
```

---

## Comparison Mode (terminal)

```
$ python3 scripts/value_report.py --compare 2026-01-01:2026-02-28,2026-03-01:2026-04-17

Comparison: 2026-01-01 to 2026-02-28 vs 2026-03-01 to 2026-04-17
══════════════════════════════════════════════════════════════════════════════════
 Metric          │ Period A │ Period B │ Delta    │ Change
─────────────────┼──────────┼──────────┼──────────┼────────
 Tasks Completed │ 20       │ 22       │ +2       │ +10.0% ↑
 Points          │ 64       │ 84       │ +20      │ +31.3% ↑
 Human LOE       │ 40h      │ 58h 30m  │ +18h 30m │ +46.3%
 AI Actual       │ 4h 5m    │ 5h 40m   │ +1h 35m  │ +38.8%
 Savings         │ 35h 55m  │ 52h 50m  │ +16h 55m │ +47.1% ↑
 Savings %       │ 89.8%    │ 90.3%    │ +0.5%    │ +0.6%  ↑
 Savings Ratio   │ 9.8x     │ 10.3x    │ +0.5x    │ +5.1%  ↑
```
