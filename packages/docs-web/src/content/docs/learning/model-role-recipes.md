---
title: Model Role Recipes
description: Practical Archon model-routing recipes for guided vibe coding projects.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 12
---

Use these recipes after a single-provider workflow works. They turn model
routing into a practical project pattern instead of a model comparison game.

## Core Rule

Assign models by workflow responsibility:

- Planning and test strategy need careful reasoning.
- Inner development needs reliable file editing and fast iteration.
- Validation should be deterministic whenever possible.
- Review should be independent from implementation when risk is meaningful.

Do not route by hype, novelty, or preference. Route only when the node's job
justifies a different provider.

## Default Guided Project Shape

Use this shape for personal and team vibe coding projects:

```text
request
  -> clarify scope
  -> plan with Claude or Codex
  -> approve plan
  -> implement with Gemini, Qwen, Kimi, Codex, or Claude
  -> run deterministic validation
  -> review with Claude or Codex
  -> approve final result
  -> prepare PR or stop with run report
```

Every model boundary should pass through an artifact, not hidden chat memory.

## Recommended Role Split

| Role | Good default | Why |
| --- | --- | --- |
| Scope clarification | Codex or Claude | Keeps the request, repository, and risk boundary precise. |
| Planning | Claude or Codex with stronger reasoning settings | Produces file-aware plans, validation strategy, and rollback notes. |
| Inner development | Gemini, Qwen, Kimi, Codex, or Claude after local verification | Handles implementation iterations once the plan is explicit. |
| Deterministic validation | `bash:` or `script:` node | Avoids trusting an assistant summary for pass/fail. |
| Review and test critique | Claude or Codex, preferably not the implementer | Gives an independent read of the diff, tests, risks, and PR readiness. |
| PR creation | Existing Archon PR command or GitHub workflow | Keeps repository publication explicit and reviewable. |

## Provider Mapping

Archon provider names are not the same thing as model brands.

| Desired model family | Typical Archon route | Notes |
| --- | --- | --- |
| Claude | `provider: claude` or `provider: pi` with an Anthropic model | Use `provider: claude` when you need Claude-specific hooks, MCP, skills, or sub-agents. |
| Codex | `provider: codex` | Good default for planning, repository exploration, implementation, and review. |
| Gemini | `provider: pi`, model like `google/<verified-model-id>` | Verify the exact model ID locally; do not invent Gemini model strings. |
| Qwen | `provider: pi`, often local/custom or OpenRouter | Examples may look like `openrouter/qwen/qwen3-coder` or a local Pi model ID. |
| Kimi | `provider: pi`, often OpenRouter or custom OpenAI-compatible endpoint | Verify the provider and model ID in Pi before committing workflow YAML. |
| Local models | `provider: pi` with local/custom provider registration | Register in `~/.pi/agent/models.json` and keep a cloud or Codex fallback. |

## Recipe 1: Personal Local Feature

Use this for a solo developer working locally in a sandbox or low-risk repo.

```text
Planner:
Claude or Codex writes `$ARTIFACTS_DIR/plan.md`.

Approval:
Human approves, revises, or rejects the plan.

Inner developer:
Gemini, Qwen, Kimi, Codex, or Claude implements only the approved plan.

Validation:
`bash:` runs the project test command.

Reviewer:
Claude or Codex reviews the diff and validation output.

Final decision:
Human decides whether to keep the branch, revise, or discard it.
```

Completion evidence:

```text
Plan artifact:
Approved scope:
Implementation provider:
Changed files:
Validation command:
Review artifact:
Final human decision:
Rollback path:
```

## Recipe 2: Team GitHub Issue To PR

Use this after the learner has completed the GitHub capstone in a disposable
repository.

```text
Issue intake:
Codex or Claude summarizes the issue and names risk.

Plan:
Claude or Codex writes a plan with files, tests, rollback, and stop conditions.

Approval:
Reviewer approves the plan before implementation.

Implementation:
Gemini, Qwen, Kimi, Codex, or Claude implements in an isolated worktree.

Validation:
`bash:` or `script:` runs deterministic checks.

Independent review:
Claude or Codex reviews the diff, tests, artifacts, and PR readiness.

PR:
Archon prepares or creates a PR, then stops before merge.
```

Team evidence:

```text
Issue:
Branch:
Reviewer:
Plan approval:
Implementation provider and fallback:
Validation:
Review decision:
PR link or PR-ready note:
No autonomous merge:
```

## Recipe 3: Frontend Guided Build

Use this when one model is stronger at product planning and another is stronger
at UI iteration.

```text
Content and acceptance criteria:
Claude or Codex names user goal, states, edge cases, and validation.

UI implementation:
Gemini, Qwen, Kimi, Codex, or Claude builds the interface.

Build validation:
`bash:` runs lint, type-check, tests, or build.

Visual review:
Human inspects the Web UI. Use browser testing when the app is local and
interactive.

Code review:
Claude or Codex reviews integration, accessibility, and test gaps.
```

Do not accept a frontend result only because it looks good. The build and
integration checks still decide whether the implementation is usable.

## Recipe 4: Server Or Deployed Team Operation

Use this after local workflows are reliable.

```text
Deployment boundary:
Human defines where Archon runs, which adapters are enabled, where secrets live,
and who can trigger workflows.

Operator setup:
Docker or VPS environment starts with health checks.

Remote trigger:
GitHub webhook or chat adapter receives a sandbox request.

Workflow:
Plan, approve, implement, validate, review, and prepare PR.

Recovery:
Operator inspects logs, artifacts, health endpoints, and rollback path.
```

Required boundary note:

```text
Runtime location:
Database:
Enabled adapters:
Allowed users:
Secrets location:
Health checks:
Log location:
Artifact location:
Rollback:
Incident contact:
```

## Minimal YAML Sketch

Use this as a sketch, not a copy-paste promise. Replace provider names and model
IDs with values verified in your environment.

```yaml
name: guided-feature-routing
description: Plan with a reasoning model, implement with a verified inner-dev model, validate deterministically, and review independently.
interactive: true
provider: codex

nodes:
  - id: plan
    prompt: |
      Write an implementation plan for: $ARGUMENTS
      Include files, validation command, risks, and rollback.
      Save the plan summary in your response.

  - id: approve-plan
    depends_on: [plan]
    approval:
      prompt: Review the plan. Approve only if files, validation, risks, and rollback are clear.
      capture_response: true

  - id: implement
    depends_on: [approve-plan]
    provider: pi
    model: openrouter/qwen/qwen3-coder
    prompt: |
      Implement only the approved plan.
      Plan:
      $plan.output
      Approval note:
      $approve-plan.output

  - id: validate
    depends_on: [implement]
    bash: npm test

  - id: review
    depends_on: [validate]
    provider: codex
    prompt: |
      Review the implementation and validation result.
      Identify bugs, missing tests, secret exposure, and PR readiness gaps.
      Validation:
      $validate.output
```

## Fallback Rules

Before a routed workflow reaches a real repository, write:

```text
Primary inner-development provider:
Verified model ID:
Fallback provider:
What to do if provider auth fails:
What to do if output quality drops:
What to do if validation fails:
```

Fallbacks should be explicit. A provider failure should pause or reroute the
workflow; it should not silently broaden permissions or skip validation.

## Completion Checklist

You are ready to use role-based routing when:

- The same task works with one provider first.
- Every extra provider is installed, authenticated, and model IDs are verified.
- Planning and implementation communicate through artifacts or explicit node
  outputs.
- Deterministic validation runs after implementation.
- Review is independent for team or higher-risk work.
- The workflow stops before merge or deployment unless a separate team policy
  explicitly allows it.
