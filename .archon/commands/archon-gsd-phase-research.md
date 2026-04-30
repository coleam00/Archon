---
description: Always research a GSD roadmap phase before plan generation
argument-hint: <phase number and optional focus>
---

# GSD Phase Research

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Research the target phase before planning so plans do not rely only on base-model knowledge.

## Required process

1. Read `$ARTIFACTS_DIR/phase-planning-context.md`.
2. Read relevant phase CONTEXT.md files if present.
3. Inspect local dependencies and version files before consulting external docs.
4. Use available documentation or web research tools for framework, library, API, and architecture details that affect implementation.
5. Inspect existing codebase patterns enough to plan concretely.
6. Write `$ARTIFACTS_DIR/phase-research.md`.

## Required output file

`$ARTIFACTS_DIR/phase-research.md` must include:

- Target phase
- Current codebase patterns
- Version-aware external findings
- Recommended implementation approach
- Risks and mitigations
- Test strategy implications
- Sources consulted or explicit source notes

## Final response

Return the path to `$ARTIFACTS_DIR/phase-research.md` and the key recommendations for planning.
