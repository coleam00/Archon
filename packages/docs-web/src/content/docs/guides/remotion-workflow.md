---
title: Remotion Video Generation Workflow
description: Use AI to generate Remotion video compositions with per-node skills and bash render nodes.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 10
---

The `archon-remotion-generate` workflow uses AI to create Remotion video compositions.
It generates React/TypeScript code, renders preview stills, renders the full video,
and summarizes the output — all as a DAG workflow with per-node skills.

## Quick Start

### 1. Create a Remotion project

```bash
npx create-video@latest my-video
cd my-video
npm install
```

### 2. Install the Remotion skill (recommended)

```bash
npx skills add remotion-dev/skills
```

This installs the official `remotion-best-practices` skill (35 rule files covering
animations, audio, transitions, charts, 3D, and more). The workflow's generate node
preloads this skill to produce higher-quality Remotion code.

### 3. Run the workflow

```bash
# From your Remotion project directory:
bun run cli workflow run archon-remotion-generate "Create a 5-second countdown from 5 to 1 with bouncy spring animations and a glowing effect"
```

Output lands in `out/video.mp4`.

## How It Works

The workflow is a 5-node DAG:

```
[check-project] → [generate] → [render-preview] → [render-video] → [summary]
     bash           agentic         bash               bash          agentic
                   + skill
```

| Node | Type | What It Does |
|------|------|-------------|
| `check-project` | bash | Verifies Remotion project structure exists (`src/index.ts`, `src/Root.tsx`) |
| `generate` | agentic + skill | AI writes/modifies the composition code. Preloads `remotion-best-practices` skill. |
| `render-preview` | bash | Renders 3 preview stills (early, mid, late frames) via `npx remotion still` |
| `render-video` | bash | Renders the full MP4 via `npx remotion render` with H.264 codec |
| `summary` | agentic (haiku) | Reads code + stills, describes what was created |

### Why per-node skills matter here

The `generate` node has `skills: [remotion-best-practices]`. This preloads the official
Remotion skill into the agent's context, teaching it:

- Use `useCurrentFrame()` + `interpolate()`/`spring()` for all animations
- Never use CSS transitions, `Math.random()`, `setTimeout`
- Use `<Img>` from `remotion` instead of native `<img>`
- Use `<Sequence>` for scene timing, `<Series>` for auto-stacking
- Use `<TransitionSeries>` with `fade()`, `slide()` for transitions
- Animation recipes for text, charts, Ken Burns zoom, staggered lists
- Audio integration patterns with `<Audio>` from `@remotion/media`

Without the skill, the agent would write generic React code that may not render
correctly in Remotion (CSS animations don't work, `Math.random()` causes flickering, etc.).

### Why bash nodes for rendering

Render nodes are deterministic bash nodes, not agentic. This means:

- The LLM cannot skip or fake the render step
- Render errors are real errors, not hallucinated
- Render time is predictable (no token cost)
- The output file either exists or it doesn't — no ambiguity

This is the "blueprint pattern" from Stripe Minions — interleave deterministic gates
with agentic nodes to keep the pipeline reliable.

## Project Structure

The workflow expects a standard Remotion project:

```
my-video/
├── src/
│   ├── index.ts          # registerRoot(Root)
│   ├── Root.tsx           # <Composition> registration
│   └── MyVideo.tsx        # Your composition (AI modifies this)
├── public/                # Static assets (images, audio, fonts)
├── out/                   # Rendered output (created by workflow)
│   ├── preview-early.png  # Still at frame 1
│   ├── preview-mid.png    # Still at midpoint
│   ├── preview-late.png   # Still at 75% mark
│   └── video.mp4          # Final rendered video
└── package.json
```

## Prompt Tips

Good prompts describe the visual result, not the code:

```bash
# Good — describes what to see
bun run cli workflow run archon-remotion-generate "A 10-second animated bar chart showing monthly revenue growing from $10K to $100K, with each bar sliding up with a spring animation"

# Good — specific visual style
bun run cli workflow run archon-remotion-generate "Dark background, white text. Three slides: title card with company name, bullet points sliding in one by one, closing CTA with a pulse animation"

# Less good — too vague
bun run cli workflow run archon-remotion-generate "make a video"
```

## Adding MCP Servers

Combine skills with MCP for richer workflows. For example, add the Remotion docs
MCP server so the agent can look up API details:

```json
// .archon/mcp/remotion.json
{
  "remotion-docs": {
    "command": "npx",
    "args": ["@remotion/mcp@latest"]
  }
}
```

Then create a custom workflow that adds both skill and MCP:

```yaml
name: remotion-with-docs
description: Generate video with Remotion docs MCP access
nodes:
  - id: generate
    prompt: "Create a video: $ARGUMENTS"
    skills:
      - remotion-best-practices
    mcp: .archon/mcp/remotion.json
    allowed_tools:
      - Read
      - Write
      - Edit
      - Glob
      - mcp__remotion-docs__*
```

## Customization

### Change output format

Fork the default workflow and modify the `render-video` bash node:

```yaml
  - id: render-video
    bash: |
      COMP_ID=$(npx remotion compositions src/index.ts 2>&1 | grep -E '^\S' | head -1 | awk '{print $1}')
      # GIF output:
      npx remotion render src/index.ts "$COMP_ID" out/video.gif --codec=gif
      # ProRes (high quality):
      npx remotion render src/index.ts "$COMP_ID" out/video.mov --codec=prores --prores-profile=hq
      # WebM:
      npx remotion render src/index.ts "$COMP_ID" out/video.webm --codec=vp9
```

### Add a review+refine loop

Extend the workflow with a review node that checks the stills and conditionally
loops back for refinement:

```yaml
  - id: review
    prompt: |
      Review the rendered preview stills at out/preview-early.png, out/preview-mid.png,
      out/preview-late.png.

      Check:
      1. Is there visible content (not just a blank/black screen)?
      2. Does the content match the original request: $ARGUMENTS?
      3. Are animations visible (different content across frames)?

      Respond with only a JSON object.
    depends_on: [render-preview]
    output_format:
      type: object
      properties:
        pass:
          type: boolean
        issues:
          type: array
          items:
            type: string
      required: [pass, issues]
    allowed_tools:
      - Read

  - id: refine
    prompt: |
      The video review found issues. Fix the composition code.
      Issues: $review.output.issues
      Original request: $ARGUMENTS
    depends_on: [review]
    when: "$review.output.pass == false"
    skills:
      - remotion-best-practices
    allowed_tools:
      - Read
      - Write
      - Edit
```

## Limitations

- **Requires a Remotion project** — the workflow modifies existing files, it doesn't
  scaffold a project from scratch. Run `npx create-video@latest` first.
- **Local rendering only** — uses `npx remotion render` (headless Chromium). For
  serverless rendering, use Lambda directly.
- **No audio generation** — the workflow generates visual compositions. For AI-generated
  voiceover or music, add the `remotion-media-mcp` server.
- **Skill must be installed** — the `remotion-best-practices` skill must be installed
  via `npx skills add remotion-dev/skills`. Without it, the workflow still runs but
  code quality may be lower.

## Related

- [Per-Node Skills](/guides/skills/) — how `skills:` works on DAG nodes
- [Per-Node MCP Servers](/guides/mcp-servers/) — how `mcp:` works on DAG nodes
- [Remotion Documentation](https://www.remotion.dev/docs) — official Remotion docs
- [Remotion Skills](https://github.com/remotion-dev/skills) — official skill repository
