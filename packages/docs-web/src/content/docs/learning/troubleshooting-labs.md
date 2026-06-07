---
title: Troubleshooting Labs
description: Prepared failure scenarios for teaching evidence-based Archon troubleshooting.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 10
---

Use these labs to teach learners to inspect evidence before restarting,
rerunning, or changing configuration. Keep all examples secret-free.

Use [Sandbox Setup Guide](/learning/sandbox-setup/) to create the prepared
failure sandbox used in these labs.

## Troubleshooting Order

Use this order unless the error clearly points somewhere else:

1. Confirm the intended repository and branch.
2. Inspect workflow status.
3. Inspect logs.
4. Inspect artifacts.
5. Inspect changed files.
6. Inspect configuration.
7. Decide whether to rerun, resume, abandon, revise, or defer.

## Lab 1: Wrong Repository

Scenario:

The learner expected Archon to inspect the sandbox, but output describes the
Archon source repository.

Prepared cause:

- The command was run from the wrong working directory.

Learner task:

```text
Identify the repository Archon actually used.
Find the intended sandbox path.
Write the corrected command with --cwd or by changing directories.
```

Evidence to inspect:

- Current shell path.
- Git remote or repository root.
- Workflow run request.

Completion signal:

- Learner can explain how to prevent the same mistake next time.

## Lab 2: Missing Initial Commit

Scenario:

A workflow that expects Git isolation fails or behaves oddly in a brand-new
sandbox.

Prepared cause:

- The sandbox repository was initialized but never committed.

Learner task:

```text
Check git status.
Create an initial safe commit.
Rerun the smallest safe workflow.
```

Evidence to inspect:

- `git status`
- `git log --oneline -1`
- Workflow status after rerun.

Completion signal:

- Learner can explain why worktree workflows need a real Git baseline.

## Lab 3: Vague Plan Rejected

Scenario:

An approval gate pauses on a plan that does not name files, validation commands,
or rollback steps.

Prepared cause:

- The prompt was too broad or the planning node produced a weak artifact.

Learner task:

```text
Reject the plan.
Write revision instructions.
Require files, validation, risks, and rollback.
Resume or rerun according to the workflow.
```

Evidence to inspect:

- Plan artifact.
- Approval decision.
- Revised plan artifact.

Completion signal:

- Learner rejects the plan for evidence-based reasons instead of approving it
  because it sounds plausible.

## Lab 4: Validation Failed

Scenario:

The implementation completed, but deterministic validation failed.

Prepared cause:

- The sandbox contains a deliberately failing test or command.

Learner task:

```text
Find the validation output.
Identify whether the failure is from the generated change or the prepared test.
Decide whether to revise, rerun validation, or defer.
```

Evidence to inspect:

- Validation command.
- Validation output.
- Changed files.
- Relevant artifact.

Completion signal:

- Learner records the failure without claiming the run passed.

## Lab 5: Provider Not Available

Scenario:

A provider-routed workflow fails before useful work starts.

Prepared cause:

- The provider is not authenticated or the model ID is not verified locally.

Learner task:

```text
Identify which node requested the provider.
Verify the provider setup privately.
Replace the workflow with a single-provider baseline if needed.
Record the fallback.
```

Evidence to inspect:

- Workflow YAML.
- Provider configuration.
- Logs with secrets removed.
- Single-provider baseline result.

Completion signal:

- Learner does not guess model IDs or paste credentials into shared notes.

## Lab 6: PR Created Too Early

Scenario:

A branch has a PR-ready change, but the learner wants to merge immediately.

Prepared cause:

- Learner equates PR creation with completion.

Learner task:

```text
Write a PR readiness note.
Inspect the diff.
Inspect validation evidence.
Name at least one manual review concern.
Stop before merge.
```

Evidence to inspect:

- Diff.
- Validation output.
- Run report.
- PR readiness note.

Completion signal:

- Learner can explain why merge waits for human review.
