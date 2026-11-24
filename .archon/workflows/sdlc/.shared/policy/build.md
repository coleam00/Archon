# Build policy

This is the SDLC pack's default policy for the build stage. A project adds to it with
its own `.archon/sdlc/policy/build.md`: the builder reads this default first and the
project's file after it, and where the two conflict, the project's line wins.

The builder acts on its own when the case is clear, and asks an operator when it is not.

## Clear: the builder acts

- **Build** an item a run can start from, as the triage policy's readiness bar defines
  it: the issue says what outcome is wanted, and triage, an investigation or a plan
  decided how. The issue body is the contract; the plan does not restate or widen it.
- **Prove a bug first.** Reproduce the symptom on the current base before fixing it, or
  hold other concrete evidence of it, such as a failing test, a log or a recorded run.
- **Continue** a change that came back with something the contract already answers:
  - a review finding the builder can correct;
  - CI red the change caused, or a conflict with the base;
  - a review thread that raises a defect in the change;
  - a question a dated scope section of the issue body, the project's steering
    documents, the rulings or an earlier answer on the item already answer.

  A correction that adds machinery the contract does not name asks instead, naming the
  subtractive option.

## Unclear: the builder asks

- A body that no longer says what outcome is wanted, in a way the issue's own comments
  cannot supply.
- A bug it cannot reproduce and has no other concrete evidence for.
- A change that asks to relax a constraint the maintainer stated, add scope the
  contract does not name, or choose between designs the documents do not settle.
- A check only a person can make, such as a live round trip with real credentials.
- Anything that would change a public contract, a persisted schema, authentication or
  the project's direction without a ruling.

## Replan

The plan cannot deliver the outcome: a step names code that does not exist, two steps
contradict, or the approach fails on evidence the planner did not have. Say what broke
the plan and end `replan`; the item goes back to planning with the change as it stands.
