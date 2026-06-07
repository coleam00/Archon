---
title: Archon Curriculum Guide
description: Self-study, workshop, hybrid delivery, assessment, and capstone guidance for learning Archon safely.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 2
---

This curriculum turns the Archon practical tutorial into a repeatable learning
program for both self-study and facilitated workshops. The tutorial remains the
lesson body. This guide tells you how to schedule it, teach it, assess it, and
adapt it without losing the safety posture.

## Reader And Outcome

This guide is for two readers:

- A self-study learner who wants a paced path from first install to supervised
  issue-to-PR workflow.
- A facilitator who wants to run Archon onboarding for a team without inventing
  a workshop plan from scratch.

After using this guide, you should be able to complete or teach the full Archon
learning path, verify learner readiness, and decide what each learner should do
next.

## How To Use This Guide

Choose one track first: self-study, workshop, or hybrid. Then use this guide as
the schedule and assessment layer while the practical tutorial supplies the
lesson content.

For teaching-ready material, use the companion pages:

- [Curriculum Package Map](/learning/package-map/) for a full inventory of the
  learning bundle.
- [Quick-Start Paths](/learning/quick-start-paths/) for short role-specific
  routes through the curriculum.
- [Curriculum Syllabus](/learning/syllabus/) for course-level framing,
  schedule, assessment, and completion requirements.
- [Reading Map](/learning/reading-map/) for role-based navigation through the
  learning materials.
- [Workshop Session Plans](/learning/session-plans/) for agendas, deliverables,
  facilitator checks, and recovery patterns.
- [Sandbox Setup Guide](/learning/sandbox-setup/) for preparing resettable
  training repositories.
- [Curriculum Templates](/learning/templates/) for journals, run reports,
  workflow briefs, approval reviews, PR readiness notes, and preflight records.
- [Capstone Assessment](/learning/capstone-assessment/) for final exercises,
  scoring, and sign-off questions.
- [Learner Workbook](/learning/learner-workbook/) for day-by-day learner notes
  and evidence prompts.
- [Facilitator Evaluation](/learning/facilitator-evaluation/) for scoring,
  red flags, sign-off, and remediation.
- [Cohort Runbook](/learning/cohort-runbook/) for preparing and operating a
  group training.
- [Instructor Notes](/learning/instructor-notes/) for teaching scripts,
  facilitation patterns, and evidence-first questions.
- [Sample Artifacts](/learning/sample-artifacts/) for secret-free examples of
  acceptable learner evidence.
- [Curriculum Glossary](/learning/glossary/) for shared vocabulary.
- [Printable Checklist Pack](/learning/printable-checklists/) for compact live
  session checklists.
- [Knowledge Checks](/learning/knowledge-checks/) for unit questions and
  scenario prompts.
- [Slide Outline](/learning/slide-outline/) for creating workshop decks.
- [Learner FAQ](/learning/faq/) for common learner questions.
- [Publishing Checklist](/learning/publishing-checklist/) before running a live
  cohort.
- [Office Hours Guide](/learning/office-hours-guide/) for structured learner
  support.
- [Remediation Playbook](/learning/remediation-playbook/) for targeted recovery
  when learners miss completion signals.
- [Peer Review Practice](/learning/peer-review-practice/) for learner-to-learner
  evidence review.
- [Graduation Checklist](/learning/graduation-checklist/) for final readiness.
- [Real Repository Transition](/learning/real-repository-transition/) for the
  first supervised real-repository run.
- [Team Adoption Path](/learning/team-adoption-path/) for rollout after
  individual readiness.
- [Learning Outcomes Matrix](/learning/outcomes-matrix/) for mapping skills to
  evidence and remediation.
- [Cohort Report](/learning/cohort-report/) and
  [Curriculum Metrics](/learning/curriculum-metrics/) for post-cohort review.
- [Exercise Bank](/learning/exercise-bank/) for extra practice and remediation.
- [Troubleshooting Labs](/learning/troubleshooting-labs/) for prepared failure
  scenarios.
- [Provider Routing Lab](/learning/provider-routing-lab/) for multi-provider
  practice after a single-provider baseline works.
- [Model Role Recipes](/learning/model-role-recipes/) for practical guided
  coding projects where Claude or Codex plans and reviews while Gemini, Qwen,
  Kimi, Codex, or Claude handles inner development.

For self-study, read the day row, complete the matching tutorial parts, run the
exercise in a sandbox, and write the journal entry before moving on.

For workshops, assign the tutorial parts before each session when possible, then
use live time for setup, labs, evidence inspection, troubleshooting, and review.

For hybrid delivery, move concepts into prework and keep live sessions focused
on the places where learners are most likely to get blocked.

## Curriculum Principles

Teach Archon as a harness, not as one large prompt. Every session should connect
AI work to deterministic process: isolated worktrees, explicit artifacts,
validation commands, logs, and human approval gates.

Keep learners on disposable repositories until they can explain the safety
rules. Real project work comes after the capstone habits are visible.

Prefer supported behavior over transcript-inspired experiments. Transcript
material is useful for imagination, but official documentation and local
validation decide what belongs in a lesson.

## Learning Tracks

| Track | Best for | Pace | Completion signal |
| --- | --- | --- | --- |
| Self-study | Individual users learning Archon locally | Seven focused days or two weekends | Learner completes the supervised GitHub capstone and writes a personal operating checklist. |
| Workshop | Team onboarding, internal enablement, cohort training | Six sessions plus optional capstone lab | Participants can run, inspect, author, validate, and review supervised workflows in a sandbox. |
| Hybrid | Teams with mixed schedules | Self-study prep plus live labs | Learners read concepts alone, then practice risky or confusing steps with a facilitator. |

Use the same tutorial parts for all tracks. Change pacing, discussion, and
assessment, not the underlying safety model.

## Prerequisites

Learners need:

- Basic Git comfort: branches, commits, pull requests, and remotes.
- A local development environment that can run Archon.
- A disposable Git repository for all early exercises.
- Access to the assistants or providers chosen for the class.
- A place to record run notes, decisions, errors, and fixes.

Facilitators additionally need:

- A preflight checklist for each machine or workshop image.
- A known-good sandbox repository that can be reset between sessions.
- A policy for secrets, GitHub tokens, and provider authentication.
- A fallback plan for learners who cannot use one provider during class.

## Safety Contract

Start every track by agreeing to these rules:

- Do not paste API keys, OAuth tokens, provider auth files, or `.env` contents
  into chat or shared notes.
- Use a disposable repository for first runs and capstone rehearsals.
- Use isolated branches or worktrees for any workflow that may change files.
- Validate custom commands and workflows before running them.
- Keep human approval before implementation, PR creation, and any production
  step while learning.
- Review generated pull requests manually. Do not teach autonomous merge as a
  beginner behavior.

If a learner breaks one of these rules, pause the curriculum and recover before
continuing. The recovery is part of the lesson.

## Self-Study Path

The self-study path is designed as a careful first week. Faster learners can
combine days, but should not skip the completion signal for each day.

| Day | Tutorial parts | Focus | Completion signal |
| --- | --- | --- | --- |
| 1 | 0-1 | Harness model, vocabulary, starting path | Learner can explain why Archon uses workflows, artifacts, and approval gates. |
| 2 | 2-3 | Install, verify, create sandbox | CLI and Web UI both work against the disposable repository. |
| 3 | 4-5 | Built-in workflows, worktrees, artifacts, logs | Learner can run a safe workflow and find its run state, worktree, log, and artifact output. |
| 4 | 6-7 | Custom command and custom YAML workflow | Learner validates one command and one workflow. |
| 5 | 8 | Plan-Implement-Validate | Learner can explain which steps are AI reasoning, deterministic validation, and human decisions. |
| 6 | 9-11 | Provider routing and GitHub | Learner can run single-provider workflows first, then prepare or create a supervised PR. |
| 7 | 12-16 | Operations, troubleshooting, capstones, reference | Learner completes one capstone and writes a personal safe operating checklist. |

### Daily Practice Loop

Use this loop every day:

1. Read the assigned tutorial parts.
2. Run the smallest matching exercise in the sandbox.
3. Record what ran, what changed, and what was verified.
4. Fix one failure mode instead of starting over immediately.
5. End by updating the learner's operating checklist.

### Self-Study Journal Prompt

After each day, write:

```text
Today's workflow or command:
What I expected:
What actually happened:
Evidence I inspected:
Safety rule I practiced:
Question to revisit:
```

The journal is not busywork. It creates the habit of treating AI coding output
as evidence to inspect, not magic to trust.

## Workshop Path

The workshop path assumes sessions of 90 to 120 minutes. For shorter sessions,
split each lab from its discussion and assign the reading beforehand.

| Session | Tutorial parts | Live goal | Facilitator checkpoint |
| --- | --- | --- | --- |
| 1. Orientation and safety | 0-1 | Build the shared mental model and choose the safe starting path. | Every participant can explain the safety contract and identify the sandbox repository. |
| 2. Local setup lab | 2-3 | Install, verify, and connect CLI/Web UI to the sandbox. | Everyone reaches a working health check or has a documented blocker. |
| 3. First workflow lab | 4-5 | Run built-in workflows and inspect isolation, logs, and artifacts. | Participants can show evidence from a run without exposing secrets. |
| 4. Authoring lab | 6-7 | Create and validate one command and one YAML workflow. | Each participant has a valid reusable command or workflow in the sandbox. |
| 5. Supervised automation lab | 8-10 | Build or run Plan-Implement-Validate with provider routing. | Participants can describe artifact handoffs and approval decisions. |
| 6. Interfaces and operations | 11-14 | Practice GitHub flow, adapter concepts, deployment boundaries, and troubleshooting. | Participants can distinguish local usage, team usage, and deployment responsibilities. |
| 7. Capstone lab | 15-16 | Complete a supervised issue-to-PR workflow and final checklist. | The PR is reviewed or prepared, not merged automatically. |

### Facilitator Run Of Show

For each live session:

1. State the goal in one sentence.
2. Rehearse the relevant safety rule.
3. Demo the happy path once, using placeholder secrets only.
4. Give learners time to run the lab.
5. Ask learners to inspect evidence before sharing conclusions.
6. Close with one failure mode and how to recover from it.

Keep live demos short. Learners need time with their own terminal, Web UI, logs,
and workflow artifacts.

### Session Lesson Plans

Use these plans as the default workshop script. Each plan assumes learners have
the practical tutorial open and are working in a disposable repository.

#### Session 1 - Orientation And Safety

Goal: learners understand Archon as a harness and can name the safety contract.

Prework:

- Read Parts 0 and 1.
- Bring one real workflow idea, but do not use a real repository yet.

Live agenda:

1. Define harness engineering, workflow, node, provider, artifact, worktree, and
   approval gate.
2. Compare chat-only AI coding with repeatable workflow execution.
3. Walk through the safety contract.
4. Choose or create the sandbox repository.
5. Draft each learner's first operating checklist.

Lab deliverable:

- A three-sentence note explaining what Archon will do, what Git will isolate,
  and what the human will approve.

Facilitator checks:

- The learner does not describe Archon as autonomous merge automation.
- The learner can explain why the first repository is disposable.
- The learner can name at least two kinds of evidence they will inspect after a
  run.

#### Session 2 - Local Setup Lab

Goal: learners install Archon, verify the CLI, and reach the Web UI.

Prework:

- Read Parts 2 and 3.
- Install the local prerequisites for the chosen operating system.

Live agenda:

1. Verify the shell, Git, Bun, and repository location.
2. Install or run Archon from the selected path.
3. Configure the first assistant without sharing secrets.
4. Start the Web UI.
5. Register or open the sandbox repository.

Lab deliverable:

- A setup note containing the interface used, the sandbox path, and the
  verification command output summary.

Facilitator checks:

- The learner never pastes token values into shared chat.
- The CLI and Web UI point at the intended sandbox.
- Any blocked setup has a written next action, not a vague "doesn't work."

#### Session 3 - First Workflow Lab

Goal: learners run a safe workflow and inspect the evidence it produced.

Prework:

- Read Parts 4 and 5.
- Run `archon workflow list` from the sandbox if setup is complete.

Live agenda:

1. Review built-in workflow categories.
2. Run one read-only or low-risk workflow.
3. Inspect workflow status.
4. Inspect worktrees or isolation environments.
5. Inspect logs and artifacts.
6. Write a run report.

Lab deliverable:

- A run report with workflow name, command, run status, files changed, evidence
  inspected, and one safety observation.

Facilitator checks:

- The learner distinguishes "the model said it passed" from actual validation
  evidence.
- The learner can find a run again after terminal output scrolls away.
- The learner can identify whether the workflow changed files.

#### Session 4 - Authoring Lab

Goal: learners create one command and one workflow, then validate both.

Prework:

- Read Parts 6 and 7.
- Bring one narrow repeated task from the sandbox.

Live agenda:

1. Create a custom command for a read-only or validation-oriented task.
2. Run the command in the sandbox.
3. Create a minimal YAML workflow.
4. Add deterministic validation.
5. Validate command and workflow definitions.
6. Record common authoring mistakes.

Lab deliverable:

- One command file, one workflow file, and a short validation note.

Facilitator checks:

- The workflow has a concrete current use case.
- Validation is deterministic where possible.
- The learner does not add provider routing before the single-provider version
  works.

#### Session 5 - Supervised Automation Lab

Goal: learners practice Plan-Implement-Validate with explicit handoffs.

Prework:

- Read Parts 8, 9, and 10.
- Identify one small change the sandbox can safely accept.

Live agenda:

1. Draw the Plan-Implement-Validate shape.
2. Decide which node writes the plan artifact.
3. Decide where human approval belongs.
4. Run a supervised workflow on the sandbox change.
5. Review artifacts before implementation and validation output after
   implementation.
6. Discuss provider routing only after the baseline run works.

Lab deliverable:

- A workflow trace showing plan artifact, approval decision, implementation
  result, validation result, and final human decision.

Facilitator checks:

- The learner can say which steps are AI work, deterministic work, and human
  review.
- Artifact handoffs are explicit.
- Provider choices are attached to node responsibility, not model hype.

#### Session 6 - Interfaces And Operations

Goal: learners understand GitHub, adapters, deployment boundaries, and recovery
without expanding risk too early.

Prework:

- Read Parts 11, 12, and 14.
- Confirm whether GitHub CLI authentication is available for the lab.

Live agenda:

1. Practice the local issue-to-PR path or prepare the PR steps without pushing.
2. Review Web UI usage and adapter boundaries.
3. Compare local, Docker, and VPS operation.
4. Review secret handling for GitHub, chat adapters, and provider credentials.
5. Troubleshoot one prepared failure.

Lab deliverable:

- A deployment boundary note: where Archon runs, which interfaces are enabled,
  where secrets live, and who approves PRs.

Facilitator checks:

- The learner can separate local CLI use from remote adapter exposure.
- The learner knows which credentials exist and where they must not appear.
- The learner has a recovery path for failed, paused, or unsafe runs.

#### Session 7 - Capstone Lab

Goal: learners prove they can operate safely from request to reviewed outcome.

Prework:

- Read Parts 15 and 16.
- Choose a capstone option and prepare the sandbox.

Live agenda:

1. State the capstone objective and risk boundary.
2. Run or author the required workflow.
3. Inspect artifacts, logs, and validation output.
4. Prepare or create the supervised PR if using the GitHub capstone.
5. Present the evidence and final decision.
6. Update the personal or team operating checklist.

Lab deliverable:

- Final run report, checklist, and reviewed PR or PR-ready branch.

Facilitator checks:

- The learner stops before unsafe merge or deployment.
- The learner can justify approval or rejection from evidence.
- The learner can describe what they would change before using a real
  repository.

### Group Exercises

Use these exercises when the group needs discussion rather than more commands:

- Approval gate review: show a plan artifact and ask whether it should be
  approved, rejected, or revised.
- Artifact handoff review: ask which node should write an artifact and which
  node should consume it.
- Provider routing review: assign each node a provider only after the group
  names the node's job.
- Model-role project review: decide whether Claude/Codex should plan, review,
  or test while Gemini/Qwen/Kimi performs inner implementation, then name the
  artifact handoff between those roles.
- Troubleshooting review: present a failure without secrets and ask what
  evidence should be inspected first.
- PR readiness review: compare "tests ran" with "this PR is ready to merge" and
  make learners name the missing review steps.

## Learner Artifacts

Ask learners to keep these artifacts in a private notebook or a safe shared
training space. Do not include secrets, token values, provider auth files, or
full `.env` contents.

### Run Report Template

```text
Workflow or command:
Repository:
Branch or worktree:
Request:
Run status:
Files changed:
Artifacts inspected:
Logs inspected:
Validation command and result:
Human decision:
Follow-up:
```

### Workflow Design Brief

```text
Workflow name:
Repeated task this solves:
Inputs:
Nodes:
Artifact handoffs:
Deterministic validation:
Approval gates:
Provider choice per node:
Rollback path:
Known limits:
```

### PR Readiness Note

```text
Issue or request:
Branch:
Summary of change:
Validation evidence:
Artifact evidence:
Reviewer concerns:
Secrets checked:
Merge decision:
```

These templates are intentionally short. The habit matters more than the format:
record enough evidence that another person can understand what happened without
trusting a chat transcript.

## Remediation Paths

Use remediation when a learner gets a completion signal wrong. Do not move to a
real repository just because the schedule says the class should be there.

| Gap | Symptom | Remediation exercise |
| --- | --- | --- |
| Safety | Learner wants to run first changes in a real repository. | Repeat Session 1 with a disposable repository and require a written risk boundary. |
| Setup | CLI works but Web UI or project registration is unclear. | Repeat Session 2 using only health checks and project registration; skip AI runs. |
| Evidence inspection | Learner trusts model text without checking files, logs, or artifacts. | Repeat Session 3 and require a run report before discussing conclusions. |
| Authoring | Workflow has too many speculative nodes or options. | Reduce it to one current use case, one command, and one validation step. |
| Approval judgment | Learner approves vague plans. | Run approval gate review with a flawed plan artifact and require a rejection reason. |
| Provider routing | Learner routes by favorite model instead of node responsibility. | Re-run the workflow with one provider, then justify only one provider change. |
| GitHub readiness | Learner equates PR creation with merge readiness. | Complete the PR readiness note and identify at least one manual review concern. |
| Troubleshooting | Learner restarts everything without inspecting evidence. | Use the troubleshooting section to inspect status, logs, artifacts, and config in order. |

Remediation is successful when the learner can explain the correction and repeat
the safer behavior once.

## Hybrid Path

Hybrid delivery works well for teams that cannot spend a full week in live
training. Assign conceptual reading before each session and reserve live time
for setup, authoring, troubleshooting, and review.

| Before live session | Live session focus | After live session |
| --- | --- | --- |
| Read orientation and safety material. | Discuss the safety contract and choose the sandbox. | Write a one-sentence harness goal. |
| Read installation and repository setup. | Verify local setup together. | Capture local setup notes and blockers. |
| Read built-in workflow and isolation sections. | Run and inspect a workflow. | Submit a three-line run report. |
| Read authoring sections. | Build and validate command/workflow artifacts. | Revise artifacts after facilitator review. |
| Read PIV, provider, and GitHub sections. | Complete capstone rehearsal. | Finalize operating checklist. |

## Assessment

Assessment should measure operating judgment, not memorization. A learner is
ready to use Archon on a real project when they can show evidence in these
areas.

| Area | Ready | Strong |
| --- | --- | --- |
| Safety | Uses sandbox work first, protects secrets, and keeps human approval before risky actions. | Can recover from a rejected or unsafe run and explain why the recovery was chosen. |
| Workflow operation | Runs built-in workflows and inspects status, logs, worktrees, and artifacts. | Diagnoses paused, failed, or abandoned runs without guessing. |
| Workflow authoring | Creates and validates a command and workflow. | Designs artifact handoffs and approval gates that match the risk of the work. |
| Provider routing | Starts with one provider and verifies Pi or Gemini routing locally before relying on it. | Assigns providers by node responsibility and avoids hidden chat-memory handoffs. |
| GitHub practice | Creates or prepares a supervised pull request from an issue. | Reviews the PR, records verification, and refuses autonomous merge while learning. |
| Communication | Writes a concise run report. | Teaches another learner how to inspect evidence from a run. |

### Scoring Rubric

Use this rubric for capstone sign-off. A score of 2 in every category is the
minimum for supervised real-repository work. A score of 3 indicates the learner
can help others.

| Category | 1 - Needs practice | 2 - Ready with supervision | 3 - Strong operator |
| --- | --- | --- | --- |
| Safety boundary | Uses the sandbox inconsistently or exposes risky details. | Uses sandbox, protects secrets, and keeps approval gates. | Adjusts safety boundaries based on repository and task risk. |
| Workflow execution | Can run a command only by following exact steps. | Runs workflows and finds status, logs, worktrees, and artifacts. | Diagnoses run state and explains evidence to others. |
| Authoring | Creates unclear commands or workflows that depend on hidden assumptions. | Creates a narrow command and workflow with validation. | Designs clean artifact handoffs and rollback-friendly workflow shapes. |
| Validation | Relies on model summaries. | Runs deterministic checks and records results. | Chooses validation that matches the risk and knows when evidence is incomplete. |
| Approval | Approves or rejects without a clear reason. | Reviews plan and output before moving forward. | Gives actionable revision instructions at approval gates. |
| GitHub practice | Pushes or merges too early. | Prepares or creates a supervised PR and stops for review. | Produces a clear PR readiness note with residual risks. |

### Sign-Off Conversation

Before graduating a learner, ask:

1. What repository would you use next, and why is it low risk enough?
2. Which workflow will you run first, and what could it change?
3. Where will artifacts and logs appear?
4. What validation must pass before you trust the result?
5. Where are secrets stored, and what should never be pasted into chat?
6. What approval gate would make you reject or revise the run?
7. What is your rollback path if the generated change is wrong?

The learner does not need perfect answers. They need evidence-based answers and
a willingness to stop when the evidence is weak.

## Capstone Options

Use the tutorial capstones as the official final exercises. Pick based on the
learner's target usage:

- Local operator: run a built-in workflow, inspect logs and artifacts, and write
  a run report.
- Workflow author: build a supervised Plan-Implement-Validate workflow with at
  least one approval gate.
- Provider router: route work across providers only after single-provider runs
  are verified.
- Model-role project operator: plan and review with Claude or Codex, implement
  with a verified Gemini, Qwen, Kimi, Codex, or Claude route, and validate
  deterministically.
- GitHub operator: prepare or create a supervised pull request from an issue and
  stop before merge.
- Team remote operator: run or simulate a deployed/server workflow with one
  exposed adapter, health checks, logs, rollback, and no production deployment.

For a workshop, assign one shared capstone and one individual variation. The
shared capstone keeps discussion focused; the variation proves transfer.

### Capstone Deliverables

Every capstone should produce:

- A run report.
- The command or workflow definition used, if custom.
- The relevant artifact paths or summaries.
- Validation evidence.
- A human decision: approve, reject, revise, or defer.
- One checklist update based on what the learner discovered.

For the GitHub capstone, also require:

- Issue or request reference.
- Branch name.
- PR link or PR-ready branch note.
- Manual review notes.
- Explicit statement that no autonomous merge was performed.

## Facilitator Preflight

Before teaching, verify:

- The installation path used in class works on the target operating systems.
- The sandbox repository can be recreated quickly.
- The selected assistant/provider setup is available to all learners or has a
  fallback.
- GitHub authentication is optional until the GitHub session.
- The Web UI is reachable locally.
- No shared slides, notes, or recordings contain secrets.
- The curriculum's default branch, workflow names, and provider notes still
  match the current repository documentation.

### Facilitation Supplies

Prepare these before a cohort starts:

- A resettable sandbox repository with one intentionally small issue.
- A second sandbox with a deliberately failing test for troubleshooting.
- A sample plan artifact that should be approved.
- A sample plan artifact that should be rejected.
- A sanitized run log excerpt.
- A sanitized PR readiness note.
- A shared parking lot for questions that need source verification.

Keep all examples secret-free. Use fake tokens only when showing where a value
would go.

## Adaptation Guide

For a solo developer, keep the full safety contract and reduce group exercises
to journal prompts.

For a small team, require each learner to complete the first four sessions, then
let people specialize in provider routing, GitHub, adapters, or deployment.

For an advanced team, shorten orientation but keep the sandbox, artifact, and
approval exercises. Experienced developers are still new to this harness.

For a production-facing rollout, add a separate policy session for secrets,
access control, audit logs, deployment boundaries, and incident recovery before
any real repository work.

## Completion Checklist

The curriculum is complete when the learner or cohort can:

- Explain Archon as a harness for repeatable AI coding workflows.
- Install and verify Archon locally.
- Run a safe workflow in a disposable repository.
- Inspect run status, worktrees, logs, and artifacts.
- Create and validate one command and one workflow.
- Explain a supervised Plan-Implement-Validate flow.
- Route providers intentionally after verifying each one.
- Use GitHub to prepare or create a supervised PR.
- Troubleshoot common failures without exposing secrets.
- Maintain a personal or team operating checklist.

## Next Steps

After this curriculum, choose one path:

- Personal productivity: turn the safest capstone workflow into a reusable
  workflow for a real but low-risk repository.
- Team onboarding: require new users to complete the capstone before they run
  Archon on shared repositories.
- Workflow engineering: design a narrow workflow for one repeated team process,
  validate it, and document its approval gates.
- Operations: review adapter exposure, deployment boundaries, access control,
  and incident recovery before remote usage.

Do not graduate by removing safety gates. Graduate by knowing which gates are
still needed and why.
