# Classify a red gate

The project's gate ran and a check failed. `$ARTIFACTS_DIR/validation.md` is the record: every check that ran, its exit status, the failing check's output tail, and the path of each check's full output log. Decide why the failed check failed. You fix nothing, re-run nothing to make it pass, and change nothing in the checkout.

## Declare

- `red_cause` — why the gate is red:
  - `introduced` — the change under validation caused the failure.
  - `inherited` — the same check was already failing at the base this branch came from.
  - `environment` — the machine caused it, not any code: a database or port a parallel process holds, a missing credential, a network fault, a process killed for memory.
- `summary` — a few sentences: the failing check by name, what failed in it, and the evidence for the cause. A fixer reads this first.

## Evidence

Classifying red never makes it green. But `inherited` and `environment` let delivery continue, so neither is the comfortable answer: declaring one commits you to evidence. Name the exact failing check and the concrete reason the change under validation cannot have caused it — the same failure on the exact base revision, or a resource another process demonstrably holds. Disjoint changed paths alone do not prove independence; a check can read a path another change moves. `$ARTIFACTS_DIR/implementation.md` may already record the same red; corroborate it against the recorded output rather than repeating it. Without that evidence the cause is `introduced`.

To show a failure is inherited, reproduce the narrowest failing piece — the single failing test or file, not the whole gate — at the base revision, in a separate temporary worktree that you remove afterwards. Never check out another revision in the run's own checkout. If you cannot reproduce it at the base, the cause is `introduced`.
