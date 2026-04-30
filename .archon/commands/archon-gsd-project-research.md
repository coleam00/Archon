---
description: Research project context before generating GSD planning artifacts
argument-hint: <project idea or path to source document>
---

# GSD Project Research

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Research the project enough that the roadmap and requirements do not rely only on base-model knowledge.

## Required process

1. Read `$ARTIFACTS_DIR/project-intake.md` and `$ARTIFACTS_DIR/repo-inspection.md`.
2. Identify domain, framework, library, integration, and architecture areas that need current knowledge.
3. Use available documentation or web research tools where appropriate for current API and ecosystem details.
4. Inspect local package/config files to prefer versions actually used by the repository.
5. Write `$ARTIFACTS_DIR/project-research.md`.

## Required output file

`$ARTIFACTS_DIR/project-research.md` must include:

- Current stack and version-relevant findings
- Domain findings
- Implementation risks
- Architecture constraints
- Suggested phase structure implications
- Sources consulted or explicit note when no external source was needed for a point

## Final response

Return the path to `$ARTIFACTS_DIR/project-research.md` and the top research conclusions.
