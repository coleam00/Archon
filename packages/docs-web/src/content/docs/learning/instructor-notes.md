---
title: Instructor Notes
description: Teaching notes, talk tracks, timing advice, and facilitation patterns for the Archon curriculum.
category: learning
audience: [operator]
status: current
sidebar:
  order: 15
---

Use these notes while teaching the Archon curriculum. They are written for
facilitators who need crisp explanations, useful prompts, and recovery language
during live sessions.

Companion teaching assets:

- [Knowledge Checks](/learning/knowledge-checks/) for end-of-unit questions.
- [Slide Outline](/learning/slide-outline/) for workshop deck structure.
- [Sample Artifacts](/learning/sample-artifacts/) for evidence examples.
- [Learner FAQ](/learning/faq/) for consistent answers.
- [Office Hours Guide](/learning/office-hours-guide/) for between-session
  support.
- [Peer Review Practice](/learning/peer-review-practice/) for structured
  learner-to-learner review.

## Core Teaching Frame

Repeat this frame often:

```text
Archon does not make AI coding safe by trusting the model more.
Archon makes AI coding safer by making the process inspectable:
workflows, worktrees, artifacts, logs, validation, and human approval.
```

The learner should leave each session with a stronger evidence habit.

## Terms To Reinforce

Harness:

: The process around the assistant: workflow steps, isolation, artifacts,
  deterministic checks, and approval gates.

Artifact:

: A file produced by one workflow step so another step or human can inspect it.
  Artifacts are safer than hidden chat memory.

Worktree:

: A separate Git working directory where modifying work can happen without
  touching the main checkout.

Approval gate:

: A deliberate human decision point. Approval should depend on evidence, not
  vibes.

Validation:

: A deterministic command or inspection that checks whether the work is
  acceptable. Validation is not the same as an assistant summary.

## Teaching Moves

Use these moves when learners get stuck.

| Situation | Teaching move |
| --- | --- |
| Learner trusts a summary | Ask, "What evidence would convince someone who never saw this chat?" |
| Learner wants to use a real repo | Ask, "What is the rollback path if the workflow edits the wrong file?" |
| Learner approves a vague plan | Ask, "Which files, commands, risks, and rollback steps are missing?" |
| Learner wants multi-provider immediately | Ask, "Which node responsibility changed after the baseline worked?" |
| Learner wants to merge | Ask, "What review evidence is still missing?" |
| Learner reruns without inspecting | Ask, "What did the last run prove?" |

## Session Opening Script

```text
Today we are practicing supervised AI workflow operation.
The goal is not to make Archon do everything.
The goal is to make every important step inspectable.
We will use a sandbox, protect secrets, inspect evidence, and stop before unsafe merge or deployment.
```

## Session Closing Script

```text
Before we close, write down:
what ran,
what changed,
what evidence you inspected,
what decision you made,
and what checklist item changed.
```

## Demo Guidance

Keep demos short. A good demo is:

- One narrow request.
- One visible command.
- One evidence inspection.
- One explicit decision.

Avoid:

- Debugging provider setup live for too long.
- Showing real secrets.
- Running a complex workflow before learners understand run evidence.
- Treating the assistant's final message as the whole result.

## Handling Setup Problems

When setup blocks a learner:

1. Record the blocker.
2. Assign an owner.
3. Move the learner to a fallback exercise.
4. Fix setup outside the main teaching flow.

Fallback options:

- Pair with another learner for evidence inspection.
- Use the docs to design a workflow on paper.
- Complete workbook prompts.
- Review sample artifacts.
- Practice approval decisions.

## Handling Unsafe Suggestions

If a learner suggests unsafe automation, respond calmly and convert it into a
boundary exercise.

```text
That might be possible later. For this curriculum, let's name the safety gates
that would need to exist before it becomes acceptable.
```

Then ask:

- What could this change?
- Who approves it?
- What validation must pass?
- Where are artifacts and logs?
- What is the rollback path?

## Evidence-First Questions

Use these questions throughout the course:

1. What repository did this run use?
2. What branch or worktree did it use?
3. What files changed?
4. What artifact was written?
5. What log did you inspect?
6. What validation ran?
7. What did the assistant claim?
8. Which claim did evidence confirm?
9. Which claim remains uncertain?
10. What decision follows from the evidence?

## Common Timing Adjustments

If the group is ahead:

- Add an exercise from the [Exercise Bank](/learning/exercise-bank/).
- Add one [Troubleshooting Lab](/learning/troubleshooting-labs/).
- Ask learners to critique a sample artifact.

If the group is behind:

- Skip provider routing.
- Skip GitHub PR creation and write a PR-ready note instead.
- Keep deployment conceptual.
- Finish with the operating checklist instead of a full capstone.

## Instructor Self-Check

After each session, write:

```text
What learners could do:
What learners could explain:
What evidence they inspected:
Where they got stuck:
Which safety rule needed repetition:
What to change next time:
```
