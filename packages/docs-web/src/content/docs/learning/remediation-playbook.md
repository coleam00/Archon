---
title: Remediation Playbook
description: Targeted remediation paths when Archon curriculum learners miss completion signals.
category: learning
audience: [operator, user]
status: current
sidebar:
  order: 25
---

Use remediation when a learner misses a completion signal. Remediation should be
small, specific, and evidence-based. Do not repeat the whole course when one
skill is missing.

## Remediation Rule

Repeat the smallest exercise that proves the missing skill.

Good remediation:

```text
Repeat the approval gate drill and reject a vague plan with a concrete revision request.
```

Weak remediation:

```text
Redo the whole workflow and try harder.
```

## Remediation Record

```text
Learner:
Gap:
Evidence of gap:
Assigned exercise:
Required evidence:
Reviewer:
Due date:
Result: pass / revise / defer
```

## Safety Gap

Symptoms:

- Learner wants to start in a production repository.
- Learner shares or nearly shares secrets.
- Learner removes approval gates for speed.

Remediation:

1. Re-read the safety contract.
2. Complete the sandbox boundary prompt.
3. Write a risk boundary for the proposed real repository.
4. Name approval gates, validation, and rollback.

Required evidence:

```text
Repository risk boundary:
Secrets policy:
Approval gate:
Validation:
Rollback path:
Decision to stay in sandbox or proceed with supervision:
```

## Evidence Inspection Gap

Symptoms:

- Learner quotes only the assistant summary.
- Learner cannot find logs or artifacts.
- Learner cannot say what changed.

Remediation:

1. Complete the Evidence Hunt exercise.
2. Write a run report.
3. Have a peer verify the report from the same evidence.

Required evidence:

```text
Run status:
Logs inspected:
Artifacts inspected:
Changed files:
Validation output:
Human decision:
```

## Authoring Gap

Symptoms:

- Command or workflow is too broad.
- Workflow lacks deterministic validation.
- Workflow depends on hidden chat memory.

Remediation:

1. Reduce to one current sandbox task.
2. Define one input, one artifact, and one validation command.
3. Validate the command or workflow before running it.

Required evidence:

```text
Narrow task:
Command or workflow path:
Artifact:
Validation command:
Validation result:
Known limit:
```

## Approval Judgment Gap

Symptoms:

- Learner approves vague plans.
- Learner cannot explain rejection criteria.
- Learner treats confidence as evidence.

Remediation:

1. Review one acceptable sample artifact.
2. Review one flawed plan.
3. Write an approval review that rejects or revises the flawed plan.

Required evidence:

```text
Decision:
Missing files:
Missing validation:
Missing risk or rollback:
Revision request:
```

## Provider Routing Gap

Symptoms:

- Learner routes by model preference.
- Learner uses multiple providers before a baseline works.
- Learner guesses model IDs.

Remediation:

1. Run a single-provider baseline.
2. Classify each node responsibility.
3. Route at most one node with a written reason.
4. Record fallback behavior.

Required evidence:

```text
Baseline provider:
Baseline result:
Node routed:
Routing reason:
Provider verified privately:
Fallback:
```

## GitHub Readiness Gap

Symptoms:

- Learner equates PR creation with merge readiness.
- Learner skips diff inspection.
- Learner wants autonomous merge while learning.

Remediation:

1. Write a PR readiness note.
2. Inspect the diff.
3. Inspect validation evidence.
4. Name one manual review concern.
5. Stop before merge.

Required evidence:

```text
Branch:
Diff summary:
Validation:
Artifact evidence:
Reviewer concern:
Merge decision:
```

## Passing Remediation

Remediation passes when the learner:

- Shows the required evidence.
- Explains what changed in their behavior.
- Updates their operating checklist.
- Can repeat the safer action once without prompting.
