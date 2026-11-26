---
groups:
  - name: Intake
    blurb: Order, triage, split and link
    kind: intake
    stages: [order, triage, split, link, complexity]
  - name: Plan and build
    blurb: Plan, then build
    kind: build
    stages: [plan, stage-build, attend]
  - name: Checks
    blurb: Checks, CI and PR reviews, and catching up
    kind: check
    stages: [stage-check, stage-host, catchup]
  - name: Landing
    blurb: Gate, merge, and what follows the merge
    kind: merge
    stages: [landgate, land, landed, discoveries, close]
words:
  round: check round
  rounds: check rounds
  sentBack: sent back
  parked: Parked
  workOrder: work order
  workOrders: work orders
exit: landed
---
# How the factory works

Work comes in as a work order, or as an issue someone adds the `factory` label to. Agents also find work while they do other work. Triage decides whether it is worth building. The link stage places it among the project's other work. Plan writes down how to build it. Build writes the change and opens a draft pull request. Three checks read it, then the project's own CI and the reviews on the pull request. The land gate lets it land or asks you, and the change lands on its branch.

You are asked only when a decision is yours. Each ask comes with its options, what each costs, and a recommendation when the stage has a basis for one.

## How work gets in

- **A work order.** Handed to the factory by an operator: one item, or several that belong together.
- **An issue.** Someone adds the `factory` label to it.
- **Found by agents.** Noticed outside their own task, and filed as new work after a change lands.

## Triage

Triage reads a new item and decides what should happen to it, the way the project's maintainers would.

- **The item.** A work order, a labelled issue or a finding.
- **Judge.** Decides what happens, as maintainers would.
- **The call.** Build, narrow, split, shape, park or close. A call that does not start a build is shown to you; nothing is closed behind your back.

## Link

Link decides whether the item can be built now.

- **Place it.** Sets it among the project's other open work and records what it depends on.
- **Wait.** An item that cannot be built before another lands waits, and goes on by itself when that one lands.
- **You.** Asked when what it waits on will not land: keep waiting, start anyway, or drop it.

## Plan

Plan reads the project and writes down how to build the item. It changes nothing. When it asks you, your answer starts it again with the answer in hand.

- **Read the project.** Code, rules and history.
- **Weigh the ways.** The smallest, the complete, and any other.
- **The plan.** What a builder needs, with no questions left.
- **You.** Asked when the choice is yours.

## Build

Build writes the change in its own checkout and opens a draft pull request. What the checks and CI find comes back to the same builder to fix. A plan that cannot be built as written goes back to Plan.

- **Build the change.** Writes and tests it in its own checkout.
- **Draft pull request.** The change, ready to be read.
- **What comes back.** Findings from the checks and from CI.

## Checks

Three checks read every change. The verdict approves it, sends it back to the same builder with what they found, or sends it back to Plan when it needs a different approach. After three rounds it asks you.

- **Review.** Reads the code.
- **Tests.** Judges the tests the change adds.
- **Product.** Tries what a user sees.
- **Verdict.** Approve, send back, or replan.

## CI and reviews

The host round reads what the project's own CI and the reviewers on the pull request say, and sends what must change back to the builder.

## Landing

- **Land gate.** Decides whether the change lands without asking you. With no land policy it asks every time.
- **Land.** Merges the change into its landing branch: the project's base branch, or the branch its work order names.
- **Landed check.** Looks at the branch after the landing, and starts a fix when the change broke it.
- **Discoveries.** What the agents noticed along the way becomes new work.
- **Close.** A change you dropped is closed with your reason; one you sent back to shaping is closed too, its branch kept, and the item waits to be shaped again.

## You

Answer what the factory asks. An answer is a decision: it starts what comes next and reaches that stage as already made.

---

The explainer this page grew from was written by Cole Medin for the factory's first Console view.
