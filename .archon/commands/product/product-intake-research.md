---
description: Research and classify a product request before PRD drafting
argument-hint: <feature, bug, customer request, or product idea>
---

# Product Intake Research

**Input**: $ARGUMENTS

---

## Mission

Turn the request into grounded product context. Do not invent requirements. If information is missing, mark it as `TBD - needs product answer`.

## Phase 1: Load

- Read the issue, PR, or user request in `$ARGUMENTS`.
- Identify the requesting stakeholder, target user, problem, urgency, and source evidence.
- Search the repo for related functionality, docs, commands, workflows, APIs, UI, and configuration.

**PHASE_1_CHECKPOINT:**

- [ ] Request understood
- [ ] Related repo areas identified
- [ ] Unknowns listed

## Phase 2: Analyze

Classify the request as one of:

- `bug`
- `feature`
- `experiment`
- `customer-request`
- `tech-debt`
- `support-escalation`
- `incident-followup`

Then assess:

- User and business impact
- Current workaround
- Risks and constraints
- Product questions that must be answered before build

**PHASE_2_CHECKPOINT:**

- [ ] Request classified
- [ ] Impact summarized
- [ ] Constraints and unknowns captured

## Phase 3: Artifact

Create `$ARTIFACTS_DIR/product/requirements.md` with:

```markdown
# Product Intake Research

## Request

[Original request summary]

## Classification

- Type:
- Priority recommendation:
- Confidence:

## User And Problem

- Target user:
- Problem:
- Why now:
- Current workaround:

## Evidence

- Source:
- Supporting signals:
- Repo findings:

## Constraints

- Product:
- Technical:
- Security:
- Operational:

## Required Product Answers

- [ ] Question 1
- [ ] Question 2

## Recommended Next Step

[Create PRD / reject / defer / request more information]
```

## Output

Report the artifact path and the recommended next step.
