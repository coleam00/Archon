---
name: value-reporting
description: Aggregate and report AI-assisted development value from tasks.md effort tables. Use when users ask about project savings, ROI, velocity trends, estimation accuracy, sprint status, cross-project metrics, or want to export value reports.
license: MIT
---

# Value Reporting

Aggregate and report AI-assisted development value tracked in tasks.md effort tables across `.kiro/specs/`.

## Quick Start

```bash
# Project summary
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --scope project

# Feature detail for a specific spec
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --scope feature --spec user-auth --detail

# Monthly trend analysis
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --trend --period monthly

# Estimation accuracy
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --accuracy

# Dashboard summary
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --dashboard

# Task status
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --status

# Update Value Summary table in a spec
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --update-summary --spec feature-name

# Export as JSON
python3 ~/.kiro/skills/value-reporting/scripts/value_report.py --scope project --format json --output report.json
```

## CLI Flags

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--scope` | `project`, `feature` | `project` | Report scope |
| `--format` | `terminal`, `markdown`, `csv`, `json`, `html` | `terminal` | Output format |
| `--spec` | pattern | — | Filter specs (substring or glob) |
| `--detail` | flag | off | Per-task breakdown |
| `--trend` | flag | off | Trend analysis |
| `--period` | `weekly`, `monthly`, `quarterly` | `monthly` | Trend granularity |
| `--since` | `YYYY-MM-DD` | — | Tasks completed on/after |
| `--until` | `YYYY-MM-DD` | — | Tasks completed on/before |
| `--accuracy` | flag | off | Estimation accuracy report |
| `--update-summary` | flag | off | Generate Value Summary in tasks.md |
| `--projects` | dirs | — | Cross-project mode |
| `--compare` | ranges | — | Compare two periods or projects |
| `--dashboard` | flag | off | Compact summary |
| `--status` | flag | off | Task completion status |
| `--output` | path | stdout | Write to file |
| `--specs-dir` | path | `.kiro/specs/` | Override specs directory |

## Report Types

- **Project Summary**: Aggregated metrics across all specs — savings, velocity, ROI
- **Feature Detail**: Per-spec and per-task breakdowns with estimation flags
- **Trend Analysis**: Time-based savings and velocity trends (weekly/monthly/quarterly)
- **Estimation Accuracy**: Compare estimates vs actuals, identify systematic bias
- **Dashboard**: Compact one-glance summary for status updates
- **Task Status**: In-progress, not-started, and missing-data visibility
- **Value Summary**: Auto-generate the Value Summary table in tasks.md
- **Cross-Project**: Aggregate across multiple repositories
- **Comparison**: Side-by-side period or project comparison with deltas

## Output Formats

- **terminal**: Aligned tables for quick terminal viewing (default)
- **markdown**: Pipe-delimited tables for PRs, wikis, docs
- **csv**: Standard CSV for spreadsheet import
- **json**: Structured JSON with metadata for programmatic use
- **html**: Self-contained styled HTML for email or browser

## Data Sources

Parses both effort table formats from tasks.md:
- **Format A**: Summary horizontal table at top of tasks.md
- **Format B**: Per-task vertical metric tables under each task header

Time values: `30m`, `1h`, `1h 30m`, `2d`, `1d 4h` (8h/day)

See `references/report_formats.md` for example output.

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/value-reporting/scripts/`.
