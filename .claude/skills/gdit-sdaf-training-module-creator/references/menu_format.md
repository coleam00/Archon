# MENU.yaml Step Format Reference

MENU.yaml is the single source of truth for all training module content. The
interactive skill session reads it directly. The HTML companion page is generated
from it by `build_html.py`. Both paths use the same prompt text — no rewording.

## Top-Level Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | string | Module display name |
| `description` | Yes | string | One-line module description |
| `version` | Yes | string | Semantic version (e.g., "1.0") |
| `steps` | Yes | list | Ordered list of step objects |

## Step Fields

### Required

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (kebab-case, e.g., `framework-overview`) |
| `title` | string | Display title with step number (e.g., `"1. Framework Overview"`) |
| `prompt` | string | Full AI prompt — the instruction students paste into their AI session |
| `variations` | list | Shorter prompt alternatives (see Variation Structure below) |
| `expect` | string | "What to Expect" callout — describes what the AI will produce |
| `concept` | string | "Key Concept" callout — the takeaway for this step |

### Optional

| Field | Type | Description |
|-------|------|-------------|
| `time` | string | Estimated duration (e.g., `"10 min"`) — shown in sidebar |
| `summary` | boolean | When `true`, renders a module completion callout on this step |
| `code` | list of strings | Code blocks rendered with Copy buttons |
| `spec` | list of objects | Spec file preview callouts (see Spec Structure below) |

## Variation Structure

Each variation is an object with:

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Display label (convention: `"Concise"` for first, `"Minimal"` for second) |
| `prompt` | string | The shorter prompt text |

At least one variation is required per step.

## Spec Structure

Each spec preview is an object with:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Spec file name (e.g., `"requirements.md"`) |
| `content` | string | Excerpt of the spec file to display |

## Complete Example

```yaml
name: My Training Module
description: Hands-on workshop for learning feature X
version: "1.0"

steps:
  - id: introduction
    title: "1. Introduction"
    time: "10 min"
    prompt: |
      Give me an overview of feature X. Cover the architecture,
      key components, and how they interact. Use a concrete example
      called "hello-world" to illustrate the workflow.
    variations:
      - label: Concise
        prompt: |
          Overview of feature X with a hello-world example.
      - label: Minimal
        prompt: |
          Explain feature X.
    expect: "The AI will explain the architecture and walk through a hello-world example. This takes 2-3 minutes."
    concept: "Feature X operates at the component level. It manages the how, not the what."

  - id: hands-on
    title: "2. Hands-On Exercise"
    time: "20 min"
    prompt: |
      Create a spec for a simple greeting function.
      Generate requirements.md with acceptance criteria.
    variations:
      - label: Concise
        prompt: |
          Create a greeting function spec with acceptance criteria.
      - label: Minimal
        prompt: |
          Create requirements for a greeting function.
    expect: "The AI creates requirements.md with user stories and acceptance criteria."
    concept: "Each acceptance criterion becomes a test case."
    code:
      - "python3 scripts/validate.py .kiro/specs/greeting/"
    spec:
      - title: requirements.md
        content: |
          ## REQ-1: Greeting Function
          As a user, I want to greet by name.
          Acceptance Criteria:
          - greet("Alice") returns "Hello, Alice!"
          - greet() returns "Hello, World!"

  - id: wrap-up
    title: "3. Wrap-Up"
    time: "5 min"
    prompt: |
      Show the results and key takeaways.
    variations:
      - label: Concise
        prompt: |
          Show results and takeaways.
    expect: "The AI summarizes what was accomplished."
    concept: "Specs before code. Compliance as byproduct."
    summary: true
```
