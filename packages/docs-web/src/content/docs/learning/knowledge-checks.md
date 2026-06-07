---
title: Knowledge Checks
description: Quiz questions and discussion prompts for assessing Archon curriculum understanding.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 18
---

Use these checks after each unit or before the capstone. They are designed to
test operating judgment, not trivia.

## How To Use

For self-study:

- Answer without looking first.
- Then compare against the expected answer.
- Repeat the related exercise if the answer is weak.

For workshops:

- Ask one or two questions at the end of each session.
- Require evidence-based answers.
- Let learners discuss before revealing the expected answer.

## Unit 1: Orientation And Safety

Question:

```text
Why is Archon described as a harness instead of a bigger prompt?
```

Expected answer:

```text
Because Archon structures the process around the assistant: workflow steps,
worktrees, artifacts, logs, validation, and approval gates. The assistant still
does AI work, but the process is repeatable and inspectable.
```

Question:

```text
What should a learner avoid during the first week?
```

Expected answer:

```text
Production repositories, autonomous merge, production deployment, secrets in
chat, and broad modifying workflows without an approval gate.
```

## Unit 2: Setup

Question:

```text
What evidence proves setup is ready enough for the first workflow?
```

Expected answer:

```text
The Archon CLI works, the Web UI or chosen interface is reachable, the intended
sandbox has an initial commit, the selected provider is configured privately,
and health checks or equivalent setup checks pass.
```

Question:

```text
Where should secrets not appear?
```

Expected answer:

```text
Secrets should not appear in chat, shared notes, Git diffs, workflow artifacts,
logs shared publicly, command files, workflow files, or full environment file
copies.
```

## Unit 3: First Workflow

Question:

```text
The assistant says "tests passed." What should you inspect before trusting that?
```

Expected answer:

```text
The actual validation command and output, changed files, workflow status, logs,
artifacts, and Git status or branch state.
```

Question:

```text
When is --no-worktree acceptable while learning?
```

Expected answer:

```text
For read-only tasks where the learner does not expect file edits. Modifying work
should use an isolated branch or worktree.
```

## Unit 4: Authoring

Question:

```text
What makes a good first custom workflow?
```

Expected answer:

```text
It solves one current sandbox task, has a narrow input, uses explicit artifacts
for handoffs, includes deterministic validation, and avoids speculative provider
routing.
```

Question:

```text
Why are artifacts safer than hidden chat memory?
```

Expected answer:

```text
Artifacts can be inspected by humans and later workflow nodes. Hidden chat
memory is harder to audit, reproduce, or hand off safely.
```

## Unit 5: Supervised Automation

Question:

```text
What should make you reject a plan artifact?
```

Expected answer:

```text
Missing files, missing validation commands, vague implementation steps, no risk
boundary, no rollback path, or a plan that does not match the request.
```

Question:

```text
What is the difference between AI work, deterministic validation, and human decision?
```

Expected answer:

```text
AI work reasons, writes, reviews, or summarizes. Deterministic validation runs
checks whose result does not depend on model opinion. Human decision approves,
rejects, revises, defers, or stops based on evidence.
```

## Unit 6: GitHub And Operations

Question:

```text
Why is PR creation not the same as merge readiness?
```

Expected answer:

```text
A PR is a review artifact. Merge readiness also requires human review,
validation evidence, diff inspection, secret checks, and residual risk
assessment.
```

Question:

```text
What should an operator know before enabling remote adapters?
```

Expected answer:

```text
Where Archon runs, which interfaces are exposed, where secrets live, who is
authorized, how logs and artifacts are handled, and who approves risky actions.
```

## Unit 7: Capstone

Question:

```text
What evidence should a capstone include?
```

Expected answer:

```text
A run report, changed files or PR-ready branch, artifacts, logs, validation
output, human decision, safety boundary, and operating-checklist update.
```

Question:

```text
What is a valid capstone outcome besides "pass"?
```

Expected answer:

```text
Revise or defer. If evidence is incomplete or risk is unclear, stopping is the
correct behavior.
```

## Scenario Prompts

Use these for group discussion.

```text
A workflow changed files in the main checkout. What do you inspect first?
```

```text
The plan artifact is persuasive but names no validation command. What decision
do you make?
```

```text
A learner wants to route every node to a different provider. What baseline do
you require first?
```

```text
A PR exists and tests passed. What evidence is still needed before merge?
```

```text
A provider fails because the model ID is unknown. What should not happen next?
```

## Passing Standard

A strong answer:

- Names concrete evidence.
- Distinguishes assistant claims from validation.
- Protects secrets.
- Preserves human approval.
- Names a rollback or stop condition.

A weak answer:

- Trusts the assistant summary alone.
- Treats speed as the reason to skip gates.
- Cannot identify repository, branch, or changed files.
- Guesses provider details.
- Treats PR creation as completion.
