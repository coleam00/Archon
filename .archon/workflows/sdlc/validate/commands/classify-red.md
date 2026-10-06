# Classify a red gate

The project's gate ran and at least one check failed. `$ARTIFACTS_DIR/validation.md` is the record: every check that ran, its group, its exit status, each failing check's output tail, and the path of each check's full output log. Decide why the failed checks failed, judging every one the record names. You fix nothing and change nothing in the checkout; a re-run you make is evidence, never a way to turn the gate green.

## Declare

- `red_cause` — why the gate is red; when several checks failed, the cause that most needs action (`introduced` over `inherited` over `environment`):
  - `introduced` — the change under validation caused the failure.
  - `inherited` — the same check was already failing at the base this branch came from.
  - `environment` — the machine caused it, not any code: a database or port a parallel process holds, a missing credential, a network fault, a process killed for memory, or a test that failed in a file the change does not touch and passes when re-run alone on this same tree.
- `summary` — a few sentences: every failing check by name, what failed in each, and the evidence for each cause. A fixer reads this first.

## Evidence

Classifying red never makes it green. But `inherited` and `environment` let delivery continue, so neither is the comfortable answer: declaring one commits you to evidence. Name the exact failing check and the concrete reason the change under validation cannot have caused it — the same failure on the exact base revision, or a resource another process demonstrably holds. Disjoint changed paths alone do not prove independence; a check can read a path another change moves. `$ARTIFACTS_DIR/implementation.md` may already record the same red; corroborate it against the recorded output rather than repeating it. Without that evidence the cause is `introduced`.

To show a failure is inherited, reproduce the narrowest failing piece — the single failing test or file, not the whole gate — at the base revision, in a separate temporary worktree that you remove afterwards. Never check out another revision in the run's own checkout. A failure that passes at the base is not yet `introduced`: re-run the same narrowest piece on this tree too. When it fails here, it is `introduced`; when it passes here as well, in a file the change does not touch, and the change alters nothing that test shares with the rest of the run (a mock, a fixture, global or shared test state), the gate's run was disturbed and the cause is `environment`, with both runs as the evidence.
