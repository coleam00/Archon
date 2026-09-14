# Merge queue

`archon-merge-queue` accepts `prs` (1-5 explicit PR URLs), required `evidence`,
`merge_method=merge|squash|rebase`, and `mode=preview|approve|auto`. An empty
method is resolved only by mandatory project guidance or a repository with one
enabled method. Supply evidence as an external ordinary validation/review report
path, or a JSON array of qualified record references `{path, sha256}`. An external
report is judged once and sealed before planning. Already qualified references
skip that agent. Neither a nonempty file nor `ready=true` qualifies on its own.

Ordinary code/docs PRs need no runtime scenario. A runtime contract supplies both
`scenario` and `holdout`, and requires lifecycle records with those independent
roles. Forward the same `validation_scope` and `validation_context` used by the
producer. The schema rejects missing roles and changed inputs. External reports
must identify the exact PR heads/base, applicable checks and independent review;
additional files used by the judge are retained as explicit hashes.

Effective required-check policy, current check results, and applicable validation
evidence are independent facts. A repository with no required hosted CI may
proceed with qualified evidence. Unknown policy, missing or stale evidence, and
required checks that are pending, failing, missing, or unreadable hold the batch.
Classic branch protection and applicable rulesets are combined. Full protection
can explicitly require reviews without CI. The legacy contexts and richer app-bound
checks describe overlapping requirements; they do not imply separate channels.
When both a check run and commit status exist for a required name, both must pass.
App-bound requirements still need a run from that app.

If REST policy is unavailable, a complete GraphQL read of the exact branch ref
and inherited rulesets can resolve it. The ref must match the live base commit.
Nonempty GraphQL rulesets still require effective REST rules; an uninspected list,
partial response, pagination gap or unknown policy holds. Check-run, commit-status,
review and comment reads are paged.

Approval covers the recorded batch, evidence fingerprint, method, reviews, base,
and heads. Auto explicitly authorizes that batch without a human pause, subject to
repository guidance. Processing is sequential. The exact approved method becomes
the sole `gh` method flag and every request uses the approved head through
`--match-head-commit`. Changed heads, base or review material, disabled methods,
stale validation after an earlier merge, unresolved findings, conflicts and
pending checks hold the remaining work. GitHub-native queues remain queued until
read-back confirms merging. No admin bypass is used. Live-base reads detect
movement but are not an atomic base lock; GitHub protection remains authoritative.

Held and preview runs make no GitHub write. Their typed result and
`merge-hold.md` preserve classified reasons and assessed heads for the caller.
A new assessment replaces this local feedback, including clearing resolved holds.
Review and assessment still read historical `archon-merge-hold` PR comments and
check whether their reasons apply to the current head. Assessment no longer
publishes or edits those comments; the typed return and local report own current
feedback, so an old comment cannot perpetually block a resolved condition.

This workflow does not synthesize multi-PR commits, alter worktree ownership, or
add an engine API. GitHub branch protection owns atomic server-side merge checks.
The returned `merged` value is confirmed by read-back and a queued request remains
`merged=false`.

Records live under the run's `qualified-evidence/<attempt>/` directory. The plan
binds their paths/hashes, source checkout, relevant validation inputs, PR heads,
base, review content, evaluator files and semantic report. Execution checks those
bytes after native approval and again immediately before each write, while
refreshing volatile GitHub facts. Approval alone does not restart qualification.
The checkout must remain clean; all evidence artifacts belong outside it.

The TypeScript implementation is compiled into self-contained packaged scripts
by `bun run generate:bundled`. Captured sources and binary installs use those
scripts without monorepo imports. `qualified-evidence.test.ts` exercises real
validation/capture producers through the production merge executor with a fake
GitHub transport; `merge-queue.test.ts` covers policy and held CLI paths.
