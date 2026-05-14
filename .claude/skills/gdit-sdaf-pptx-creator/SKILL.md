---
name: pptx-creator
description: Create professional presentations from YAML content files. Use when users want to create a presentation, build a deck, make slides, or generate a PowerPoint/PPTX. Supports ideation (audience, message, source files), YAML content generation, and conversion to .pptx. Works with any topic — reads project files to extract data points and metrics.
---

# PPTX Creator

Generate presentations through a three-phase workflow: Ideate → Generate Content → Generate Presentation.

## Workflow

1. **Ideate** — Structured conversation to align audience, message, tone, and source material
2. **Generate Content** — AI produces a YAML content file from the ideation brief
3. **Generate Presentation** — Script converts YAML to .pptx

The YAML file is the artifact you edit. The script is a generic converter.

## Slide Types

- `title` — Opening/closing slides with title, subtitle, tagline
- `content` — Header bar + bullet list (most common)
- `two-column` — Side-by-side comparison (light/dark styles)
- `metrics` — Metric boxes + supporting bullets
- `grid` — N-column grid of cells (compliance frameworks, feature lists)
- `call-to-action` — Closing slide with column highlights

## Quick Reference

```bash
# Convert YAML to PPTX
python3 ~/.kiro/skills/pptx-creator/scripts/yaml_to_pptx.py content.yaml

# Specify output path
python3 ~/.kiro/skills/pptx-creator/scripts/yaml_to_pptx.py content.yaml -o deck.pptx
```

## Schema

See `references/schema.md` for the full YAML schema with all fields and examples.

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/pptx-creator/scripts/`.
