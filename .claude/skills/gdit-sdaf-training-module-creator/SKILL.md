---
name: training-module-creator
description: Create training modules for modular training platforms. Use when users want to create a training module, build a course, scaffold a new training track, or generate an HTML companion page. Triggers - create training module, training module creator, new training module, build course HTML, validate training module.
license: MIT
compatibility: Python 3.12 or later, no external dependencies
---

# Training Module Creator

Create drop-in training modules that follow the modular training skill pattern.
Each module is a self-contained skill folder with SKILL.md, MENU.yaml, and an
HTML companion page that students can use to navigate the course independently.

## Quick Start

1. **Create**: `python3 ~/.kiro/skills/training-module-creator/scripts/init_module.py --name my-module --path /target/modules/`
2. **Author**: Edit the generated MENU.yaml — add steps with prompts and variations
3. **Build HTML**: `python3 ~/.kiro/skills/training-module-creator/scripts/build_html.py --module /target/modules/NN-my-module/`
4. **Validate**: `python3 ~/.kiro/skills/training-module-creator/scripts/validate_module.py /target/modules/NN-my-module/`

## Module Structure

Each generated module follows this pattern:

```
NN-module-name/
├── SKILL.md          # Metadata (name, description, license, compatibility)
├── MENU.yaml         # Steps with prompts, variations, and presentation fields
├── course.html       # Generated HTML companion page (from build_html.py)
└── scripts/          # Module-specific scripts (if any)
```

## MENU.yaml Step Format

MENU.yaml is the **single source of truth** for all module content. The HTML
companion page is generated from it. The interactive skill session reads it
directly. Both paths use the same prompt text.

### Required Fields Per Step

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Unique step identifier (kebab-case) |
| `title` | string | Display title with step number |
| `prompt` | string | Full AI prompt — pasted into a GDIT framework session |
| `variations` | list | Shorter prompt alternatives (label + prompt) |
| `expect` | string | "What to Expect" callout text |
| `concept` | string | "Key Concept" callout text |

### Optional Fields

| Field | Type | Purpose |
|-------|------|---------|
| `time` | string | Estimated duration (e.g., "10 min") |
| `summary` | boolean | Renders module completion callout |
| `code` | list of strings | Code blocks with Copy buttons |
| `spec` | list of {title, content} | Spec file preview callouts |

For the complete field reference with examples, see `references/menu_format.md`.

## HTML Companion Page

The HTML page (`course.html`) lives inside the module folder, making the module
portable and drop-in ready. It provides:

- Sidebar navigation with progress tracking
- Copy-pasteable prompt blocks matching MENU.yaml exactly
- Collapsible prompt variations (Concise/Minimal)
- "What to Expect" and "Key Concept" callouts
- Responsive design with print-friendly CSS

Regenerate after any MENU.yaml change: `python3 ~/.kiro/skills/training-module-creator/scripts/build_html.py --module <dir>`

## Prerequisites

This skill requires GDIT-SDAF to be set up. Run once per machine:

```
archon workflow run gdit-sdaf-setup
```

After setup, scripts are available at `~/.kiro/skills/training-module-creator/scripts/`.
