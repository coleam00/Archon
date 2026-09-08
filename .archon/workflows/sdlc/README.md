# Working in the SDLC pack

Conventions for this pack specifically. Project-wide judgment lives in
[`AGENTS.md`](../../../AGENTS.md); the YAML surface is governed by
[`.archon/workflow-language-constitution.md`](../../workflow-language-constitution.md).

## Public operations

Command nodes judge PR content and public review findings. Script nodes call the
engine's forge CLI with JSON on stdin; content never becomes shell code. The
forge schema owns the qualified PR record and the plugin owns target validation,
write/read-back and retry reconciliation. Pack scripts do not copy that schema.
The PR node declares only an object output format to persist the validated JSON
beside its `pull-request` output type for native CI wakeups.

The PR publisher pushes the exact checked-out SHA to the named origin branch.
It fetches the exact chosen base from origin and pins its remote-tracking commit
for the ahead check, even when no local base branch exists. Missing bases and
dirty or changed source checkouts fail before the push. An existing PR retains
its base; for new PRs, explicit run authorization precedes repository defaults.
Origin is also the PR's base repository, including in fork clones. Delivery retains
the recorded ref and branch identity through correction pushes, body sync and
ready. The native checks.complete wait and bounded deadline probes remain in place.
The final ready gate selects the required checks subset when available, otherwise
the full set, and compares the checks SHA with the checkout before the forge write.

Review prepares a public report separately from local review/discovery artifacts.
The deterministic publisher sends only that report to the captured qualified PR,
using one marker comment across rounds. Working-diff mode records a null target.
Local artifact paths, credentials and private evaluator content belong only in
local artifacts. The agent must omit them from all proposed public content.

A lost response is not success. The forge reports an uncertain write with the
possible leave-behind state. Retry the same request to reconcile; duplicate marker
comments require operator reconciliation. No public artifact is automatically deleted.

## Evidence never carries credentials

The engine retains script output and forge audit events. Scripts capture git
output without exposing credential-bearing remotes. Forge dispatch passes only
the selected credential and the process environment allowlist to plugins, and
redacts that credential from responses and diagnostics. Never echo raw remote URLs.

## The engineering-conventions sidecar

A repository may declare its engineering conventions in an `engineering.md`
(root, or a config directory such as `.archon/`). Prompts that write code read
it before coding — `implement` carries the line today — the same way any
workflow may read a repository's direction sidecar. The check is conditional on
the file existing, so the pack stays portable: a repository without one loses
nothing. A new pack workflow that writes code carries the same line.

## A node's streams are the operator's channel

Retention is not the only reader. Anything a node writes to stderr is sent to the
operator as the run happens, even when the node succeeds — and that copy is not
redacted. So a node speaks for itself: capture what the commands inside it print,
and let only your own authored messages reach the streams. Re-emit a command's
output when it failed and its words are the diagnostic; drop it when it is just a
tool narrating itself. Capture a value's stderr separately rather than merging it,
too; a vendor update notice merged into a read becomes the value.
