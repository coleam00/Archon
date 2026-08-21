# Marketplace Submission is a server-assisted GitHub operation

**Status:** accepted

PR-4 lets a user submit a builder workflow to the community marketplace in one assisted flow.
We decided Submit acts on GitHub *for* the user — server-side — rather than just pointing them at
the manual fork-and-PR docs. This is a deliberate break from the console experiment's "zero
backend / zero production blast radius" rule that PR-1 through PR-3 held: Submit adds new server
endpoints and a GitHub-publish service, and it performs git/GitHub writes.

## What Submit does

> The sections below describe what Submit does **today**. Two dated amendments at the end of this
> file record where the shipped implementation revised the original decision and why — they are the
> history, this is the current behavior.

1. Hosts the workflow in the **project's own GitHub repo** (the project the workflow already lives
   in). It assembles a directory bundle at `.archon/marketplace/<slug>/` (the workflow YAML plus any
   `command:`/`script:`-referenced files), creates a commit on the default branch and advances that
   branch's ref through the **GitHub Git Data API** (no local `git push` — see Amendment 2026-07-03
   §1), and pins that commit SHA. Blocks if the project repo is private or has no GitHub origin.
2. Runs **pre-flight gates mirroring the marketplace CI** (schema-validate, security-scan,
   slug-policy, SHA-resolves, version-compat) so a submitted PR can never bounce on CI.
3. Forks `coleam00/Archon`, adds or updates the `MarketplaceEntry` in
   `packages/docs-web/src/data/marketplace.ts`, and opens the PR.

## Key sub-decisions

- **Credential:** resolve the caller's per-user GitHub identity first, else the install-level
  `GITHUB_TOKEN`, else block with a connect-GitHub guide. Mirrors Archon's existing run-credential
  resolution; works on both solo (PAT) and multi-user installs.
- **Bundled resources:** detect `command:`/`script:` references and bundle them into the directory
  layout, so an installed workflow is never missing its files.
- **Re-submission:** if the slug exists under the caller's own GitHub login, Submit updates that
  entry's `sha` and the SHA embedded in `sourceUrl` in place (`MarketplaceEntry` has no `version`
  field); a different author's slug is a hard collision and blocks.

## Considered alternatives

- **Docs pointer / copy-paste only** (the superseded `workflow-studio-integration.prd.md` scope):
  rejected as too thin to be worth a PR.
- **A central Archon-hosted community workflows repo:** rejected — changes the marketplace's
  decentralized author-hosted model and is a maintainer-policy decision, not a builder one.

## Consequences

- The "builder is a pure web experiment" boundary no longer holds for PR-4. New server surface must
  carry the usual auth/secret-handling discipline (never echo tokens; mask in logs).
- Submit writes new files (`.archon/marketplace/<slug>/`) into the user's project repo on their
  default branch — a visible, persistent side effect they must understand and consent to.
- Bulletproofness depends on pre-flight and CI sharing their check logic rather than reimplementing
  it. That reuse is the in-process `@archon/workflows/marketplace-checks` functions, which the CI
  scripts (`.archon/scripts/marketplace-*.ts`) and server pre-flight both call — see Amendment
  2026-08-06.

## Amendment (2026-07-03) — implementation spikes revised two decisions

Executable and read spikes run against this checkout during PR-4 implementation retired every
load-bearing unknown in the draft plan and forced two changes to the decisions above. Both are
transport/reuse-mechanism changes only — the original decisions (bundle in the project's own repo
on its default branch, pinned SHA; reuse the CI scripts as the pre-flight gates) are fully honored.

1. **Project-repo bundle commit: GitHub Git Data API, not local `git commit` + `git push`.**
   `@archon/git` has no push helper, and the available local-commit primitive
   (`commitAllChanges`) is `git add -A` — on a user's live checkout that would sweep unrelated
   uncommitted files into the marketplace commit. The user's checkout may also sit on a feature
   branch, be behind origin, or have a stale clone-time token embedded in `remote.origin.url`.
   Instead, the publish service commits via `git.getRef` → `git.createBlob` (per bundle file) →
   `git.createTree` → `git.createCommit` → `git.updateRef` on the project repo's default branch —
   one atomic commit, zero local git mutation, no push-credential delivery problem. The same
   Octokit client authenticates this AND the fork/PR leg. Branch protection rejecting `updateRef`
   surfaces as a block-and-guide error, not a crash.
2. **`lint-marketplace.ts`'s field checks are replicated in pure code, not shelled.** The script
   (`packages/docs-web/scripts/lint-marketplace.ts:7`) statically imports `marketplaceEntries`
   from the checked-out `../src/data/marketplace` — it lints whatever is committed in the
   *server's own* checkout, not an arbitrary edited text under construction. Shelling it for real
   reuse would require mutating the server process's own working tree or maintaining a scratch
   clone of Archon, which is a bigger footgun than duplicating six small, stable checks (unique
   slug, slug pattern, non-blank required fields, `sha` format, `tags.length >= 1`, `sourceUrl`
   host allowlist) in `entry-edit.ts`. The schema-validate and security-scan CI scripts genuinely
   have no such static-import constraint and ARE shelled exactly as CI runs them, per the original
   decision.

Two smaller corrections, same rationale (implementation-time verification, not a design change):
the registry PR targets upstream **`dev`** (the upstream default branch, confirmed via
`git remote show upstream`), not `main`; and `MarketplaceEntry` has no `version` field, so an
update touches only `sha` (+ the sha embedded in `sourceUrl`), not a version bump.

## Amendment (2026-08-06) — pre-flight gates moved in-process, closing the compiled-binary gap

The original pre-flight design shelled the real CI scripts (`bun <script-path>`) with their paths
resolved from the **server process's own git checkout** (`findRepoRoot(serverCwd)`). That works for
a source install but always blocks for a compiled-binary-only install (no source tree on disk) —
flagged as a residual, undecided risk in the PR-4 code review and left unfixed pending this
follow-up.

The fix: `marketplace-validate-schema.ts` and `marketplace-security-scan.ts`'s core logic moved
into `@archon/workflows/marketplace-checks` as two pure, exported functions
(`validateMarketplaceWorkflowFiles`, `scanMarketplaceFilesForSecurityIssues`) operating on an
in-memory file list. Both CI scripts are now thin wrappers — read `$ARTIFACTS_DIR/source/`, call
the shared function, print the identical JSON shape — and `preflight.ts` calls the **same
functions directly, in-process**, on the bundle's in-memory files. No scratch directory, no
`execFileAsync`, no server-checkout dependency.

This is a stronger reuse guarantee than shelling out was: CI and pre-flight now call the literal
same function object (compiled into whichever build, source or binary), not just "the same script
file resolved two different ways." Verified byte-identical output against the original scripts'
documented degenerate-case contract (`no source directory` / `no yaml files found` / `no workflow
yaml files` / OS-native `files[].name` behavior — the last one simplifies to always-forward-slash
now that there's no filesystem `path.relative` call in the server's in-process path; still purely
informational, never parsed, so this is a no-op for any consumer).
