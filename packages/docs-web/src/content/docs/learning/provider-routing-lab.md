---
title: Provider Routing Lab
description: A safe lab for teaching single-provider baselines before multi-provider Archon workflows.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 11
---

Use this lab after learners can run a single-provider workflow and inspect its
evidence. Do not start provider routing by comparing model hype. Start from node
responsibility.

After this lab, use [Model Role Recipes](/learning/model-role-recipes/) to turn
the routing decision into a full guided coding project.

## Learning Goal

Learners should be able to:

- Run a single-provider baseline first.
- Identify the job of each node.
- Route a provider only when the node responsibility justifies it.
- Verify provider setup privately.
- Record fallback behavior.
- Explain whether Claude, Codex, Gemini, Qwen, Kimi, or a local model belongs
  in planning, implementation, validation, or review.

## Safety Rules

- Do not paste provider tokens or auth files into chat or shared notes.
- Do not guess model IDs.
- Do not use a multi-provider workflow until the single-provider version works.
- Do not let provider routing replace explicit artifacts.

## Lab Setup

Use a sandbox task with three responsibilities:

```text
Plan a tiny change.
Implement the change.
Validate the change.
```

The baseline provider should be whichever assistant is already working for the
learner.

## Step 1: Run The Baseline

Task:

```text
Run the workflow with one provider only.
Record the plan artifact, implementation result, and validation output.
```

Evidence:

```text
Provider:
Workflow:
Plan artifact:
Changed files:
Validation command:
Validation result:
Human decision:
```

Completion signal:

- The workflow works before routing is introduced.

## Step 2: Classify Node Responsibility

For each node, write:

```text
Node:
Job:
Needs broad reasoning: yes / no
Needs code-editing reliability: yes / no
Needs deterministic execution: yes / no
Needs external tool access: yes / no
Artifact produced:
Artifact consumed:
```

Completion signal:

- Provider choice is tied to a node job, not to a favorite model.

## Step 3: Choose One Routing Change

Choose at most one provider change for the first routed run.

Good reasons:

- A planning node needs stronger reasoning.
- An implementation node works better with a specific coding assistant.
- A review node should be independent from the implementation provider.

Weak reasons:

- The model is new.
- The model is popular.
- The learner wants to try everything at once.

Decision note:

```text
Node to route:
Original provider:
New provider:
Reason:
Expected benefit:
Fallback if unavailable:
```

## Step 4: Verify Provider Setup

Privately verify:

```text
Provider installed:
Provider authenticated:
Model ID verified:
No credentials in notes:
Single-provider fallback available:
```

Completion signal:

- The learner can prove the provider exists without sharing secrets.

## Step 5: Run The Routed Workflow

Task:

```text
Run the routed workflow in the sandbox.
Compare output with the baseline.
Inspect artifacts and validation.
```

Evidence:

```text
Baseline result:
Routed result:
Artifact difference:
Validation difference:
Provider-specific failure:
Human decision:
```

Completion signal:

- The learner can say whether routing improved the workflow, made no difference,
  or added risk.

## Debrief Questions

1. Which node actually benefited from routing?
2. Which artifact crossed provider boundaries?
3. What would have failed if the second provider was unavailable?
4. Did validation change?
5. Would you keep this routing in a real workflow?

## Facilitator Notes

If learners want to route every node, return to the baseline. Multi-provider
workflows are useful when responsibilities differ. They are not a substitute for
clear artifacts, deterministic checks, and human review.
