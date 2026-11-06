# Build queue policy

This is the SDLC pack's default policy for the build queue. A project adds to it with
its own `.archon/sdlc/policy/build.md`: the queue reads this default first and the
project's file after it, and where the two conflict, the project's line wins.

The queue acts on its own when the case is clear, and asks a maintainer when it is not.

## Clear: the queue acts

- **Launch** a triaged item whose issue body states the problem, why, why now, the
  outcome, the invariants and acceptance. The brief points the run at the body as the
  contract; it does not restate or widen it.
- **Prove a bug first.** Reproduce the symptom on the current base before launching, or
  hold other concrete evidence of it, such as a failing test, a log or a recorded run.
  A bug also needs evidence that it happened in real use, such as a user's report or a
  failing CI run. A reproduction built by planting the fault proves the mechanism, not
  that anyone meets it.
- **Continue** a run that stopped on something the contract already answers:
  - a review finding the implementer can correct;
  - CI red the change caused, or a conflict with the base;
  - a stop whose question a dated scope section of the issue body, the project's
    steering documents or the rulings already answer;
  - a stop that names as a blocker work a later step owns, such as a review, CI or a
    maintainer's merge (a false blocker).

  Any round that would continue is first checked against the contract's shape. A
  correction that adds machinery the contract does not name asks instead, naming the
  subtractive option. A pull request that changed nothing material since its last
  review, no commits or only cosmetic edits, never continues; the round ends as done or ask.

  A change also has a size budget, from the size triage recorded. Lines are counted
  against the merge base, tests included:

  | Size | Budget |
  |---|---|
  | `s` | about 300 lines |
  | `m` | about 800 lines |
  | `l` | about 2,000 lines |

  A change past twice its budget asks before another round: narrow it, or accept the
  larger size.
- **Push** commits a run left committed but unpushed on its pull request's branch.
- **Done** when the pull request's latest review says Ready at its head commit and CI
  marked it ready. When the only thing left is a check no round can run, such as an
  operator check the review deferred, the queue asks once for it at that head instead.

## Unclear: the queue asks

- A body missing one of the six elements that the issue's own comments cannot supply.
- A bug it cannot reproduce and has no other concrete evidence for.
- A bug with no evidence that it happened in real use. Recommend parking it unless the
  failure, if it happened, would be costly, such as lost data, a security hole or a false
  success.
- A change past twice its size budget.
- A stop that asks to relax a constraint the maintainer stated, add scope the contract
  does not name, or choose between designs the documents do not settle.
- A check only a person can make, such as a live round trip with real credentials.
- At the round cap, a latest review that found any blocking finding the review before it
  did not have: ask the scope question instead of running another round.
- Anything that would change a public contract, a persisted schema, authentication or
  the project's direction without a ruling.
