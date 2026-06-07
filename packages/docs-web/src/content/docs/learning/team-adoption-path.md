---
title: Team Adoption Path
description: How teams can adopt Archon after completing the curriculum.
category: learning
audience: [operator, user]
status: current
sidebar:
  order: 28
---

Use this path when moving from individual training to team usage. Team adoption
should be gradual, supervised, and evidence-based.

## Adoption Principles

- Start with low-risk repositories.
- Use one workflow before many workflows.
- Keep approval gates visible.
- Require run reports for early real work.
- Review generated PRs manually.
- Treat provider routing as an advanced optimization.
- Treat remote/server operation as a separate rollout stage, not a side effect
  of local success.
- Record operating decisions where the team can find them.

## Phase 1: Individual Readiness

Entry criteria:

- Learner completed the capstone.
- Learner has a graduation checklist.
- Learner can inspect evidence without facilitator prompting.

Team action:

```text
Assign one low-risk repository.
Assign one reviewer.
Choose one workflow.
Define required validation.
Define stop conditions.
```

Exit criteria:

- Learner completes one supervised real-repository run.
- Reviewer confirms evidence and decision quality.

## Phase 2: Shared Workflow Trial

Entry criteria:

- At least two learners are ready with supervision.
- A repeated team task has been identified.

Team action:

```text
Choose one repeated task:
Write or select one workflow:
Define allowed repositories:
Define approval gates:
Define validation:
Define reviewer rotation:
```

Exit criteria:

- The workflow produces useful results in at least three supervised runs.
- The team records known limits and rollback.

## Phase 3: Team Operating Checklist

Create a shared checklist:

```text
Allowed workflows:
Allowed repositories:
Required branches or worktrees:
Required approval gates:
Required validation:
Provider limits:
Model-role rules:
GitHub limits:
Secret-handling policy:
Incident or rollback path:
```

Review the checklist after every meaningful workflow change.

## Phase 4: Model-Role Trial

Entry criteria:

- The shared workflow has at least three supervised successful runs.
- The baseline single-provider version still works.
- The team has one real reason to route a node to a different provider.

Team action:

```text
Planner provider:
Inner-development provider:
Reviewer provider:
Verified model IDs:
Artifact handoffs:
Fallback provider or stop condition:
Cost or rate-limit boundary:
Validation:
```

Exit criteria:

- The routed workflow improves quality, speed, cost, or reviewer confidence
  without weakening validation or approval gates.
- The team records where Claude, Codex, Gemini, Qwen, Kimi, local models, or
  other Pi routes are allowed.

## Phase 5: Remote Or Server Trial

Entry criteria:

- Local usage is stable.
- The team has a reason for always-on or remote triggering.
- A maintainer has reviewed adapter exposure and secrets.

Team action:

```text
Runtime location:
Database choice:
Enabled adapter:
Allowed users:
Webhook or chat secret:
Provider credential location:
Health checks:
Log location:
Artifact location:
Rollback:
Incident contact:
```

Exit criteria:

- Health checks pass.
- One sandbox request succeeds through the selected interface.
- Logs and artifacts are inspectable.
- Access boundaries are documented.
- Rollback and incident response are understood.

Do not expose more than one new interface during the first remote trial.

## Phase 6: Broader Rollout

Broader rollout is appropriate when:

- Workflows have clear owners.
- Validation is reliable.
- Reviewers know what evidence to inspect.
- Secrets policy is understood.
- Adapter exposure is reviewed separately.
- Server health checks, logs, artifacts, and rollback are owned by a named
  operator when remote usage is enabled.
- A rollback path exists.

Do not expand because the first runs felt exciting. Expand because the evidence
is repeatable.

## Team Review Cadence

Suggested cadence:

| Cadence | Review |
| --- | --- |
| Weekly during rollout | Runs, failures, approval decisions, checklist updates |
| Monthly after rollout | Workflow usefulness, safety issues, provider/model changes, adapter exposure |
| On release | Version review and source-backed curriculum updates |

## Team Retrospective

```text
Which workflow saved time:
Which workflow created confusion:
Which evidence was most useful:
Which validation was weak:
Which approval gate prevented risk:
Which model-role decision helped or hurt:
Which adapter or server boundary needs tightening:
Which repository should remain off-limits:
Which curriculum page should be improved:
```

## Adoption Anti-Patterns

Avoid:

- Giving everyone broad access before capstones.
- Running advanced workflows before simple ones are understood.
- Treating PR creation as done.
- Adding remote adapters before local usage is stable.
- Letting model preference drive workflow design.
- Routing implementation to Gemini, Qwen, or Kimi without a verified model ID
  and fallback.
- Removing approval gates to prove adoption is working.
- Treating a reachable server as a production-ready service before access,
  logging, recovery, and rollback are tested.
