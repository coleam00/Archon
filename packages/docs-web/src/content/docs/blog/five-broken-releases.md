---
title: "Why v0.3.2 Is the First Working Archon Binary"
description: A post-mortem on the five releases before v0.3.2, the bug onion we peeled to get here, and the smoke test that finally caught everything.
category: blog
audience: [user, contributor]
date: 2026-04-08
sidebar:
  order: 1
---

Archon ships as a pre-compiled binary via Homebrew and a curl install script. That's been the pitch since v0.2.0: "one command to install, one command to run". **Until v0.3.2, shipped a few hours before this post was written, it was not actually true.**

Every release from v0.2.13 through v0.3.1 was broken in at least one way that prevented the binary from doing its job. Most of them were broken in multiple ways at once, with each failure masking the next. The bugs looked like a single mystery for months because nobody had a test that exercised the full chain end-to-end against a real installed binary on a clean machine.

This is the story of those five releases, what was wrong with each, why none of the standard tests caught it, and what we changed so it stops happening. It's also a case study in a specific kind of bug — the kind where each layer of fix reveals the next layer, and where the reason you never noticed is that your dev environment is subtly different from what users actually install.

## The bug onion

When a system has multiple bugs along the same code path, and each bug prevents execution from reaching the next one, they stack like the layers of an onion. You fix the outermost bug, the next one surfaces, you fix that one, the next one surfaces, and so on. It looks like you're making progress — and you are — but the progress is purely revealing older bugs, not fixing new ones.

For Archon, the code path in question is:

```
brew install coleam00/archon/archon
  → archon workflow run assist "hello"
  → spawn Claude subprocess
  → return response
```

Six different bugs could prevent that chain from working. For every release before v0.3.2, at least one was active. Here they are in the order they were encountered and fixed:

## v0.2.13 — the pino-pretty crash

**Symptom**: every TTY invocation of `archon` crashed on startup with `error: unable to determine transport target for "pino-pretty"`.

**Root cause**: Archon uses Pino for structured logging. When stdout is a TTY and NODE_ENV isn't "production", Pino installs `pino-pretty` as a **transport** — a worker thread that formats log lines into colored human-readable output. The transport worker does a dynamic `require.resolve('pino-pretty')` at initialization to find the transport package on disk.

In a `bun build --compile` binary, everything lives inside Bun's virtual filesystem at `/$bunfs/`. The transport worker's `require.resolve` can't navigate that path. It fails immediately, and the entire binary crashes before any user code runs. **Every TTY invocation, on every platform, on every release before v0.2.14.**

**Fix**: switch from pino-pretty as a transport (worker thread) to pino-pretty as a destination stream (synchronous, main thread). The destination-stream API doesn't spawn a worker, doesn't call `require.resolve`, and works identically in dev and compiled-binary modes. Shipped in PR [#982](https://github.com/coleam00/Archon/pull/982).

This bug was originally identified by a community contributor in PRs [#962](https://github.com/coleam00/Archon/pull/962) and [#963](https://github.com/coleam00/Archon/pull/963), which fixed it via runtime detection heuristics (two different signals for two different Bun compile modes). We rewrote the fix to use build-time constants instead ([#979](https://github.com/coleam00/Archon/issues/979)) and the destination-stream pattern instead of transport detection. Different architecture, same outcome: no more pino crash.

## v0.3.0 — the version command crash

**Symptom**: the binary installed, didn't crash on startup anymore, but `archon version` returned:

```
Error: Failed to read version: package.json not found (bad installation?)
```

**Root cause**: after fixing the pino crash, the binary got far enough to execute commands. The `version` command checks `isBinaryBuild()` to decide whether to report the embedded version or fall back to reading `package.json` from disk. The check was implemented via runtime detection of Bun's virtual filesystem path — but Bun has **two** compile modes (ESM and CJS bytecode), and the detection only worked for one of them. The release workflow used `--bytecode` on Linux/macOS builds, which was the mode where detection silently returned `false`. The version command then fell into the dev-mode code path, tried to read `package.json` from disk, couldn't find it inside the virtual FS, and errored.

**Fix**: replace runtime detection entirely with a **build-time constant** written by `scripts/build-binaries.sh` before compilation. `BUNDLED_IS_BINARY = true` gets baked into the binary at build time; no runtime detection, no edge cases, no compile-mode fragility. Shipped in PR [#982](https://github.com/coleam00/Archon/pull/982), same PR as the pino fix.

The new pattern matches the existing `BUNDLED_VERSION` / `BUNDLED_GIT_COMMIT` constants, which already used the same approach. It was the obvious design, and we should have done it from the beginning.

## v0.3.0 also — the release workflow never ran the build script

**Symptom**: after merging PR #982, a local build via `bash scripts/build-binaries.sh` worked perfectly. A smoke test on the locally-built binary passed all checks. We merged with confidence and cut v0.3.0.

The released v0.3.0 binary still had the version bug.

**Root cause**: the build script writes `BUNDLED_IS_BINARY = true` into `packages/paths/src/bundled-build.ts` before calling `bun build --compile`, then restores the file via an EXIT trap. Local builds run the script. **The release workflow did not.**

`.github/workflows/release.yml` had its own inline `bun build --compile` command that bypassed the script entirely. No constant rewrite, no file restore, no EXIT trap — just a direct call to the compiler against whatever `bundled-build.ts` happened to look like at checkout time (which was the dev placeholder with `BUNDLED_IS_BINARY = false`).

The build-time constant approach was correct. The implementation was correct. The test was correct. **Nobody had verified that the release workflow actually called the script the fix depended on.** Both code paths — local and CI — were supposed to produce identical binaries; they drifted because they were two independent implementations instead of one canonical entry point.

**Fix**: refactor `scripts/build-binaries.sh` to support a single-target mode via `TARGET` and `OUTFILE` env vars, then update `.github/workflows/release.yml` to call the script instead of running `bun build --compile` inline. Now there's one canonical build command, and both local and CI call it the same way. Shipped in PR [#987](https://github.com/coleam00/Archon/pull/987).

This fix also added **two post-build smoke tests** to the release workflow: one that runs `archon version` on the freshly-built Linux binary and asserts it reports `Build: binary`, and one that runs `archon workflow list` and asserts the bundled workflows are embedded. Both would have caught #987's regression before publishing if they had existed earlier. They would not have caught any of the remaining bugs in this post, because they don't spawn an AI subprocess — a limitation we're tracking in [#996](https://github.com/coleam00/Archon/issues/996).

## v0.3.0 also — the SQLite schema missed a column

**Symptom**: Cole's deployed Archon server started returning 500 on every "add project" request with:

```
Failed to add codebase: table remote_agent_codebases has no column named allow_env_keys
```

**Root cause**: PR [#983](https://github.com/coleam00/Archon/pull/983) — the env-leak gate polish sweep — added an `allow_env_keys` column to the `remote_agent_codebases` table. The PR updated the PostgreSQL migration path (`migrations/000_combined.sql` and a new `021_*.sql`) correctly. It did not touch `packages/core/src/db/adapters/sqlite.ts`, which has its own independent schema bootstrap code.

Archon supports both PostgreSQL and SQLite. PostgreSQL uses the `migrations/*.sql` files. SQLite uses a dedicated adapter that generates the schema via `CREATE TABLE IF NOT EXISTS` statements inline in TypeScript, and runs column migrations via `ALTER TABLE` calls in a separate `migrateColumns()` function. These are two completely different code paths for the same logical schema.

**When the env-leak gate polish added `allow_env_keys`, it updated one path and not the other.** PostgreSQL users were fine. SQLite users — which is every deployment using the default setup, including Cole's VPS — had a schema mismatch. Fresh installs got the broken schema. Existing installs upgraded without getting the new column via `migrateColumns()` because that function had no handler for the codebases table.

**Fix**: two edits to `sqlite.ts`. Add `allow_env_keys INTEGER DEFAULT 0` to the `CREATE TABLE` block (for fresh databases), and add a new try/catch block in `migrateColumns()` that PRAGMA-checks the codebases table and ALTERs it if missing (for existing databases). Shipped in PR [#988](https://github.com/coleam00/Archon/pull/988).

This was the "gotcha that SQLite has two schema paths" bug. The review of #983 didn't catch it because the review focused on the env-leak gate logic, not on the schema plumbing. Worth adding as a checklist item for future PRs touching DB schema: "did you update BOTH the PostgreSQL migration AND the SQLite adapter?"

## v0.3.1 — the SDK cli.js had the CI runner's path baked in

**Symptom**: after merging the pino fix, the version fix, the release workflow refactor, and the SQLite migration, we cut v0.3.1. The binary installed. `archon version` worked. `archon workflow list` worked. `archon isolation list` worked.

Then we ran `archon workflow run assist "say hello"` and got:

```
Module not found "/Users/runner/work/Archon/Archon/node_modules/.bun/
  @anthropic-ai+claude-agent-sdk@0.2.89+27912429049419a2/node_modules/
  @anthropic-ai/claude-agent-sdk/cli.js"
```

**On every user's machine**, the binary was trying to open a file at a path that only existed on the GitHub Actions runner during the build.

**Root cause**: `@anthropic-ai/claude-agent-sdk` spawns `cli.js` as a child process when you call `query()`. The SDK internally resolves the path to `cli.js` like this:

```javascript
const dir = path.dirname(fileURLToPath(import.meta.url));
pathToClaudeCodeExecutable = path.join(dir, "cli.js");
```

In a `bun build --compile` binary, `import.meta.url` of a bundled module is **frozen at build time** to the absolute path where that module lived on the build host. On the GitHub Actions runner, that's `/Users/runner/work/Archon/Archon/node_modules/.bun/...`. The compile step baked that literal string into the binary. Every shipped binary carried it. Every user who ran `workflow run` on their own machine got "Module not found" because that path doesn't exist on their filesystem.

**Fix**: the SDK ships a dedicated `@anthropic-ai/claude-agent-sdk/embed` entry point specifically for this case. It uses `import ... with { type: 'file' }` (a Bun-specific import attribute) so the bundler embeds `cli.js` into the binary's virtual filesystem at build time, then `extractFromBunfs()` copies it to a real temp path at runtime so a child process can actually exec it. Archon's claude client had to import that entry point and pass the returned path as `options.pathToClaudeCodeExecutable`. Five lines of code. Shipped in PR [#990](https://github.com/coleam00/Archon/pull/990).

The fix was documented in the SDK's own `embed.js` file as the recommended pattern for compiled-binary consumers. We had just never done it.

## v0.3.1 also — the env-leak gate fired on every conversation

**Symptom**: Cole's deployed server started blocking every conversation creation, not just attempts to add a new project. Users couldn't chat.

**Root cause**: the env-leak gate from [#1036](https://github.com/coleam00/Archon/issues/1036) added a pre-spawn scan inside `ClaudeClient.sendQuery()` that looks up the codebase for the current cwd and runs a scanner if it hasn't been granted consent. The predicate was:

```typescript
const codebase = await lookupCodebaseByCwd(cwd);
if (!codebase?.allow_env_keys) {
  // scan and throw if findings
}
```

When `codebase` is `null` (no codebase registered for the current cwd), `codebase?.allow_env_keys` is `undefined`, and `!undefined === true`. The scanner branch was entered for unregistered paths — which was never the intent. The gate was meant as a **safety net for already-registered codebases without explicit consent**, not a primary gate for unregistered paths. Registration is the primary gate, and it scans at the moment of registration.

The title generator calls `sendQuery` on every new conversation to generate a title. Title generation passes through whatever `cwd` the orchestrator resolved, which may be `/workspace` (a fallback for conversations without a codebase), or an isolation worktree path, or the literal string `conversation.cwd` which may be anything. None of these need to be registered codebases. **Every conversation creation was hitting the pre-spawn gate with an unregistered cwd, running the scanner against whatever that path contained, finding any `.env` with sensitive keys, and throwing.**

**Fix**: change the predicate to `if (codebase && !codebase.allow_env_keys)`. Unregistered paths skip the pre-spawn scan entirely; registration remains the canonical gate. Three lines per file, two files. Shipped in PR [#992](https://github.com/coleam00/Archon/pull/992).

The architectural cleanup — why `sendQuery` ever gets called with an unregistered cwd in the first place, and how to change the contract so it's explicit instead of inferred from lookup — is tracked separately in [#993](https://github.com/coleam00/Archon/issues/993).

## v0.3.2 — every bug fixed, tested end to end

v0.3.2 is the first release where all six bugs are fixed. The pino crash is fixed. The version command works. The release workflow builds with constants correctly. The SQLite schema has the missing column and migrates existing databases. The Claude SDK spawns correctly because the cli.js is extracted from the virtual FS at runtime. The env-leak gate correctly scopes itself to registered codebases.

Every prior release was broken for at least one of these reasons. Most were broken for two or three at once. The specific order in which they appeared to us is an artifact of the order we ran the tests, not the order they were introduced. The pino bug was present in every release from the beginning. The SDK path bug was present in every release from the beginning. They had always been there; we had just never gotten far enough down the chain to see them.

## Why dev mode hid all of this

For most of Archon's development, contributors ran via `bun link` — a symlink from the global `archon` command to the live TypeScript source in the clone. In that mode:

- Pino loads `pino-pretty` via normal node module resolution, no `$bunfs/` virtual FS, no crash
- The `version` command reads `package.json` from disk because it's not a compiled binary, so the dev fallback works
- The SDK resolves `cli.js` via normal node resolution because the package is unpacked in `node_modules/`, so the path is real
- The build script never runs because nobody is building a binary — there's no compile step at all
- SQLite is always initialized fresh (because dev databases get recreated often), so migration bugs don't surface
- The env-leak gate might fire, but dev-mode testing usually happens against clean repos, so there are no sensitive keys to find

**Every single bug was masked by dev mode.** The entire bug chain was invisible to anyone not running the actual released binary. And nobody was running the actual released binary, because:

1. Core contributors use `bun link` and edit source all day
2. Release verification happened by checking that CI was green, not by installing the released binary
3. Locally-built binaries via `scripts/build-binaries.sh` also worked — they baked the contributor's *own* laptop path into the SDK resolution, so the binary was broken but only for anyone *other* than the person who built it
4. The Homebrew formula in the tap repo had stale SHAs for v0.3.0, so nobody successfully installed v0.3.0 via brew

Point (3) is the most insidious one. When you build a binary on your own machine and run it, **it works**, because `cli.js` really does exist at the path that was baked in — your own `node_modules/.bun/...`. The binary only breaks when it's distributed to another machine. A local build passes every test you throw at it.

Point (4) is almost funny in retrospect. The reason nobody noticed the SDK path bug in v0.3.0 is that the v0.3.0 Homebrew formula was broken in a *different* way — we updated the version field without updating the SHAs, so every `brew install` failed a checksum check before the binary was even unpacked. Users never got to the bug because they never got past the checksum. The v0.3.0 Homebrew formula failure hid the v0.3.0 SDK path failure.

## The smoke test that finally caught everything

The thing that eventually broke this pattern is a skill file called `test-release`, committed to `.claude/skills/test-release/SKILL.md`. It automates the five-minute procedure of:

1. Install Archon via a specific path (Homebrew, curl, or a remote VPS)
2. Capture the SHA256 of the installed binary
3. Run `version`, `workflow list`, `workflow run assist "say hello"`, a leaky-env test, and `isolation list`
4. Uninstall cleanly
5. Produce a pass/fail report

The skill runs **against the actually installed binary**, not against a locally-built one. It runs from a clean working directory, not from the dev clone. It exercises the full chain, not just the commands that don't spawn subprocesses. It's the opposite of every other test we had.

We built it during the v0.3.1 release flow, specifically to validate the release-skill additions for the Homebrew sync and the post-release formula update. We didn't expect it to find bugs. It found six.

Each release cycle went:

1. Fix the bug we knew about
2. Run `test-release`
3. Find out there was a new bug behind the old one
4. Fix that one
5. Go to 2

v0.3.2 is where the loop finally ran cleanly. All five tests passed, end to end.

## The lesson

Unit tests validate individual functions. Integration tests validate system components. Neither of these caught the bugs in this post because the bugs weren't in the functions or the components — they were in the **seams between components**: the build script vs. the release workflow, the SDK vs. its runtime environment, the SQLite adapter vs. the PostgreSQL adapter, the pre-spawn gate vs. the registration gate, the dev mode vs. the binary mode, the contributor's laptop vs. the CI runner vs. the user's machine.

The test that catches seam bugs is the one that reproduces the user's full experience against an actual artifact in an environment you didn't build. For CLI tools that ship binaries, that means installing the released binary on a clean system and running real commands. Nothing else — not CI success, not dev-mode smoke tests, not local binary builds, not test suites — substitutes for it.

The corollary is uncomfortable: **if you don't do this, you ship broken releases.** Not sometimes. Every release. The dev environment is subtly different from the user's environment in ways that hide specific classes of bugs by default. You need a test that lives in the user's environment, not yours.

## What changed

### The `test-release` skill is now the release validation

The release skill (`.claude/skills/release/SKILL.md`) has new steps after the tag is created and binaries are built:

- Wait for the release workflow to finish publishing assets
- Fetch `checksums.txt` from the published release
- Regenerate `homebrew/archon.rb` with the new version and real SHAs in a single atomic commit
- Sync the formula to the `coleam00/homebrew-archon` tap repository
- **Run `test-release brew` and `test-release curl-mac`** against the just-published release
- If any of those fail, mark the release as broken and do not announce

The skill now explicitly forbids announcing a release that failed `test-release`. Previous releases got announced by cutting a tag and hitting publish; future releases have to pass the smoke test first.

### A CI smoke test for workflow run is planned

`test-release` is still a manual skill invoked by a human. The obvious next step is to run the equivalent inside the release workflow itself, so every build automatically gets smoke-tested before the release is published. This requires a throwaway API key for Claude (to make a real subprocess call), a small CI budget for the per-release API cost, and some workflow plumbing. It's filed as [#996](https://github.com/coleam00/Archon/issues/996).

Once that lands, the release pipeline will be: build binary → upload to release → run smoke test against the uploaded binary → mark release as "verified" if it passes or "broken" if it fails → `/release` refuses to update the Homebrew formula unless the release is verified.

### Build constants are now build-time, not runtime

The broader lesson from the version command bug is that **runtime detection of environment characteristics is fragile**. We replaced it with build-time constants (`BUNDLED_IS_BINARY`, `BUNDLED_VERSION`, `BUNDLED_GIT_COMMIT`) written by a single canonical build script. Any future "is this a binary?" check should follow the same pattern.

### Test releases run on a cheap cloud VPS

For the manual smoke test, we've set up a dedicated Hetzner instance with archon installed via the curl script. Release verification now happens on that VPS, not on a contributor's Mac. This catches Linux-specific bugs (which most users hit because most deployments are Linux servers) and guarantees the test environment is clean and isolated from dev state.

## What's still open

- **`@openai/codex-sdk` has the same class of bug**, plus an additional problem: the Codex CLI is a Rust-compiled native binary, not a bundled JavaScript file, so even if we fix the path resolution we can't embed it the same way as Claude's `cli.js`. Codex does not currently work from compiled Archon binaries, and we're tracking the fix options in [#995](https://github.com/coleam00/Archon/issues/995).
- **The `sendQuery` contract** — which assumes "the cwd corresponds to a registered codebase" — is still implicit rather than explicit. At least four upstream code paths violate the assumption. The shallow fix in #992 handles the symptoms; the architectural cleanup is tracked in [#993](https://github.com/coleam00/Archon/issues/993).
- **CI smoke test for `workflow run`** ([#996](https://github.com/coleam00/Archon/issues/996)) — the automated version of the manual skill.
- **The `/workspace` fallback in `orchestrator.ts`** is suspicious on its own and probably should fail loudly instead of silently returning a bogus path string. Filing separately.

## A note on blame

Several of the bugs in this post were introduced by choices I (or someone I was arguing with) defended as "cleaner" or "more principled". The build-time constants refactor that hid the release workflow bug was my call. The SQLite schema that missed the column was a gap in a PR I reviewed. The pre-spawn gate predicate that fired on unregistered paths was a subtle `!undefined === true` thing that's obvious in retrospect but shipped in code I touched.

The lesson isn't "be more careful". The lesson is that code review and careful thinking can't substitute for a test that runs the actual artifact in the actual user environment. You cannot reason your way out of "it works on my machine". Either you have a test that runs on a machine that isn't yours, or you don't; and if you don't, every release cycle you're rolling dice.

## Closing

v0.3.2 is the first Archon binary release where `brew install coleam00/archon/archon && archon workflow run assist "hello"` actually works. It took us ~eight hours of focused debugging across two sessions to get from "v0.3.1 is broken" to "v0.3.2 is live and verified". Five of those hours were spent discovering each successive bug; three were spent fixing them.

If you're installing Archon today, install v0.3.2 or later. Prior releases are broken in documented ways — we've left them up for historical reference but don't recommend them.

If you're building a CLI tool that ships as a pre-compiled binary and you haven't written a test that installs the released artifact on a clean machine and runs an actual command, write one before your next release. Save yourself the five hours. You will have bugs that only surface there, and they will keep shipping until you test for them directly.
