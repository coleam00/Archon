---
description: Generate a lightweight threat model for high-risk features
argument-hint: <feature, PRD, or implementation plan>
---

# Security Threat Model

**Input**: $ARGUMENTS

---

## Mission

Create a lightweight threat model for a high-risk feature or change.

## Process

1. Read the PRD, design brief, implementation plan, and security review if present.
2. Identify assets, actors, trust boundaries, data flows, abuse cases, and controls.
3. Write `$ARTIFACTS_DIR/security/threat-model.md`.

## Artifact Format

```markdown
# Threat Model

## Scope

## Assets

## Actors

## Trust Boundaries

## Data Flows

## Threats

| Threat | Impact | Likelihood | Mitigation |
|--------|--------|------------|------------|

## Required Controls

## Open Security Questions
```

## Output

Return the threat model path and blocking questions.
