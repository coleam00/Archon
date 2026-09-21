# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- `none_failed_min_one_success` now blocks dependencies skipped because of an upstream failure (`upstream_failed`), even when another dependency succeeded. This fix applies by default, including across chains and includes; there is no opt-in. Joins previously admitted after a failure now skip and retain the original failed node in their skip cause. Condition skips and optional timeout skips (`on_timeout: skip`) remain admissible with a successful dependency. `all_success`, `one_success`, `all_done`, and `if_skipped` binding behavior are unchanged. (#3156)

## [0.10.1] - 2026-08-30

**This patch release contains a breaking change.** Built-in model tiers now ship for `claude` and `codex` only. If your install runs `pi`, `copilot`, or `opencode` and you have never configured `tiers:`, bundled workflows will refuse to load until you set them — read the Breaking section before upgrading. Everyone else gets a smaller review bill and four fixes.

### Breaking

- **Built-in model tiers ship for `claude` and `codex` only, at the provider's default reasoning effort.** Tier defaults previously existed for five providers, and the entries for providers Archon does not actively curate pinned third-party model IDs that rot invisibly — a `pi` or `opencode` install silently resolved `small`/`medium`/`large` to models nobody chose. Those entries are gone.

  **What breaks:** an install whose provider is `pi`, `copilot`, or `opencode` and which has no configured tiers now fails at workflow load with an error naming every fix surface. Nothing is silently downgraded and no run starts, so no provider is called and no money is spent — but the workflow does not run.

  **The fix, once:** `archon ai tier set <small|medium|large> <provider> <model>` for each tier, or set them in console AI Settings, or add a `tiers:` block to `config.yaml`. See the configuration reference for the full shape.

  **Codex tiers also changed.** They now resolve to `gpt-5.6-luna` (small), `gpt-5.6-terra` (medium), and `gpt-5.6-sol` (large), replacing the old `gpt-5.5` plus `minimal`/`medium`/`high` effort ladder. That ladder was removed rather than ported: a configured tier replaces the built-in wholesale, so the effort settings only ever survived on installs that never touched a tier. Effort is now an explicit per-tier choice — add `effort` to a tier if codex `large` reasons less than you want.

  `archon setup` now shows what the three tiers resolve to on claude and codex and asks you to confirm, and warns when the selected provider ships no built-ins. Accepting the defaults writes nothing, so future default bumps still reach existing installs on upgrade. Installs with configured tiers are unaffected. (#3007)

### Changed

- The bundled `sdlc` review workflow runs its agent nodes on the `medium` tier instead of `large`. Review is the pack's widest fan-out, so it is where tier spend concentrates. Installs that want deeper review reasoning rebind `medium` or give it an `effort`, rather than the pack hardcoding the top tier. (#3005)

- The seams review lens reports a hand-synced pair — two declarations kept in agreement by nothing but a comment — as an Important finding the moment it exists, instead of waiting for the copies to drift apart. It also traces a discriminant dispatch back to the table that defines it. (#3003)

### Fixed

- The tier-resolution error reached chat users as a generic "Try /reset" because the error formatter length-gated messages over 100 characters. The guidance now survives to the user verbatim. (#3007)

- `archon ai tier unset` claimed the tier would fall back to a built-in default even for providers that ship none. It now names the actual fallback, or says none exists and how to set one. (#3007)

- The console Model Tiers panel hinted "built-in default" for unset rows on providers without built-ins. (#3007)

- SQLite vintage fixtures were stale after the v0.10.0 tag, failing the `schema-upgrade` check on every dev-based pull request. (#3008)

## [0.10.0] - 2026-08-30

This is the largest release since Archon became a workflow engine, and it changes three things you will notice on day one.

**The bundled coding workflows have a successor.** A new `sdlc` pack takes a work item from an open question to a reviewed, CI-green, ready-to-merge pull request, composed from eight reusable primitives instead of one monolithic prompt. The twenty pre-rewrite `archon-*` workflows still run exactly as before, but they have moved to `.archon/workflows/defaults/legacy/`, they now announce their deprecation on every run, and they will be deleted in an upcoming release. Copy the YAML into your own `.archon/workflows/` if you want to keep one.

**Talking to a paused run now means what you said.** Any plain message at an approval gate used to be recorded as an approval — including an objection. The open gate is now handed to the chat agent, which resolves it through confirm-gated `approve`/`reject` verbs: a clear approval approves, a clear objection rejects with your own words as the reason, and an ambiguous message resolves nothing and asks you a question back. The slash commands remain the deterministic path.

**Values stop degrading as they move.** A structured node result now keeps its type through persistence, resume, `with:` bindings, child runs, and fan-out aggregates, and `command:`/`script:` nodes bind upstream values by name instead of passing them through artifact files. Alongside that: workflows can pause durably for a duration, a clock time, or an external event; a run reads its workflow source from a copy it owns rather than from the target repository; a single run can rebind model tiers or load a sparse config layer without touching shared configuration; and `archon workflow wait <run-id>` replaces polling loops.

The CLI also got stricter and smaller. Unknown flags are now a hard error instead of a silent drop, `archon continue` is gone in favour of `--adopt <run-id>`, and the `archon` and `manage-run` skills are replaced by one `archon-cli` skill. Read the Breaking section before upgrading — several previously silent shapes are now load-time errors.

### Breaking

- **A plain message at an approval gate no longer approves it.** While a run was paused at a human gate, any message that did not start with `/` was recorded as an approval — so "no, stop, why is it editing the schema?" resolved the gate as approved, stored the objection itself as the approval comment (and as `$gate.output` under `capture_response: true`), and continued doing the thing the user objected to. There was no interpretation step and no natural-language way to reject. The open gate is now given to the chat agent as context for the turn, and the agent resolves it through the same confirm-gated `approve`/`reject` verbs the slash commands drive: a clear approval approves, a clear objection rejects with the user's own words as the reason, and an ambiguous message resolves nothing and gets a question back. Providers without native tools reach the same verbs over the `archon workflow approve|reject` CLI. Resolving a gate now also continues the run on every chat surface — including `/workflow approve` and `/workflow reject`, which previously told you to "type your response in this conversation to resume" and left the run parked. Deterministic behaviour is still available: use the slash commands. (#2565, #2577)

- **`archon continue <branch>` is removed.** It selected a run by inferring it from a branch name and then injected a hand-assembled prose preamble of git history, PR text, and prior artifacts into the message — a second, hidden continuation route that serialized engine-owned context as a wire format for the agent. Continuation is now identified by exact run id through the central adoption resolver: `archon workflow run <name> --adopt <run-id>`, with prior artifacts reaching the new run as `$ADOPTED_RUN_DIR`. Stale invocations fail from any directory with that pointer, and the continue-only flags are gone. `workflow resume`, `workflow runs --open`, and explicit branch execution are untouched. (#2873)

- **Unknown CLI flags are a hard error.** `archon workflow run` ran with `strict: false` and silently discarded any argument it did not recognize, so a mistyped `--dry-run` still launched a full real run — providers called, worktree created, run row written. Any `-`-prefixed argument the CLI does not recognize now fails naming the offending flag, before anything is created or contacted. Valid invocations, string-option values, and free-text positionals parse exactly as before. (#2778)

- **`interactive:` is now a load-bearing class declaration.** It used to be checked in exactly one place, so `workflow run --detach` and the `manage_run` tool would happily background an interactive workflow that later paused with nobody watching. Now an unattended workflow cannot load with a pause node anywhere in its own DAG, and an interactive workflow is refused by every background-dispatch surface. A workflow that declared the wrong class and got away with it will now fail to load or fail to dispatch. Paused gates gained one drive verb across every surface: `archon workflow respond <run-id> <decision> [text]`. (#2730)

- **A `when:` that compares a whole free-form AI reply to a literal now fails at load.** `when: "$analyze.output == 'BUG'"` invited the model to write `This is a BUG.`, making the byte-for-byte comparison false — the node was skipped with no event and no warning, and the run reached a terminal state looking successful while having quietly done less than the author asked for. Compare a declared field of a structured output instead. The same change teaches `when:` a `$INPUTS.<name>` branch, so a `workflow:` sub-run child can finally branch on an input it could already read. (#2579)

- **A composed workflow runs with the configuration its own file declares.** `include:` used to discard every workflow-level field of the included file with only a warning, so a block declaring `provider: codex` / `model: large` / `effort: high` silently ran on the *parent's* provider and model, and a block declaring nothing inherited the parent's values instead of resolving from config as it would standalone. `include:` now means "run this workflow here", not "borrow this file's nodes" — so a composed block whose declarations differ from its parent's will now run on its own settings. (#2604)

- **`context: shared` on nodes in the same parallel layer is now a load error.** The executor clears the ambient session cursor before dispatching a parallel layer, so those nodes silently started fresh sessions instead of sharing one. Scalar `context: shared` remains the sequential contract; parallel nodes must name an upstream session with `context: { resume: <upstream-node-id> }` or be serialized with dependencies. The rule is structural and applies even when sibling `when:` conditions are mutually exclusive. Workflows that previously got a silent fresh session now fail to load with migration guidance. (#2785)

- **Reading a failed producer's output now throws, everywhere.** A consumer joined past a failed producer through `trigger_rule: all_done` could read that producer's stale last-completed text as if it had succeeded — one observed run flipped a PR to ready on an unreviewed commit while the workflow itself reported `failed`. All four readers — `when:` conditions, inline `$node.output` substitution in `prompt:`/`bash:`/`command:` bodies, plain `with:` values, and the `{ from, if_skipped }` binding directive — now throw uniformly when the referenced producer's state is `failed`, fielded or not. A workflow that was quietly depending on that stale value will now fail loudly at the consumer. (#2710, #2719)

- **Fan-out aggregates are single-encoded.** A fan-out node's `$<id>.output` array used to hold each structured child's result as a JSON *string* — `["{\"v\":1}"]` — forcing collectors to parse twice. A completed child's element is now its logical result value (`[{"v":1}]`); children whose output is plain text still contribute the exact raw string they always did. Because a structured child's slot is now an object, the `join: all_done` failure marker gained a reserved discriminator: a failed/cancelled child's slot is `{ archon_failed: true, error, status }`, and collectors should check `archon_failed === true` rather than the presence of `error`/`status` — a child whose own schema declares those two fields is a result, not a failure. A collector that parsed elements a second time should now parse the aggregate once. (#2637)

- **`effort:` is the one way to ask for more reasoning, on every provider that has one.** Reasoning depth had two workflow-level spellings — cross-provider `effort:` and Codex-only `modelReasoningEffort:` — and an author had to know which one their node's provider wanted, even though the provider can be decided by a tier or an `@alias` rather than written in the YAML. Codex now reads the node-level `effort:` field and translates it internally, the way Claude, Pi and Copilot already did, so `effort:` applies everywhere and can be set per node. Its vocabulary widened to `minimal | low | medium | high | xhigh | max` — the union of what the providers accept — and a provider clamps a rung its model does not offer to the nearest one it does (`max` → `xhigh` on Codex and Copilot, `minimal` → `low` on Claude and Copilot; Pi accepts all six unclamped), so `effort: max` means "as deep as this model goes" whichever provider a node resolves to. Two side effects worth knowing: a Claude node can now ask for `xhigh`, which its SDK has supported for a while and Archon never exposed; and a tier or `@alias` carrying `effort` now reaches Pi and Copilot, where it was previously dropped. Workflow-level `modelReasoningEffort:` is deprecated and is now translated into `effort:` when a workflow is loaded, with a warning naming what it became. Two consequences the warning also states: because `effort:` is cross-provider and the old field was Codex-only, a workflow declaring it now applies that depth to its **non-Codex nodes too**, where it previously applied to none; and declaring both keeps `effort:` and drops the old field. `assistants.<provider>.modelReasoningEffort` in `.archon/config.yaml` is a different setting and is unaffected. (#2556, #2581)

- **A run no longer copies `.archon` into the target checkout.** Archon used to copy the whole `.archon` tree into the worktree so a run could find its commands and scripts, which carried `.archon/.env` and cross-run `state/` along with it and overwrote the target's own tracked files, dirtying `git status`. A run now freezes its own `.archon/{workflows,commands,scripts}` into its artifacts at start and resolves from there; the target receives nothing. Anything that relied on those files appearing in the target checkout must read them from the run's own source instead. A run's executable source cannot change once the run has started — resume executes what the run began with, and the next fresh run picks up authoring edits. (#2660)

- **The bundled `archon` and `manage-run` skills are removed.** They taught the pre-campaign authoring model, hardcoded a workflow-name-to-intent table that the sdlc pack invalidates, and duplicated run-control content across two install targets. One `archon-cli` skill replaces both — a router plus five capability folders (running-workflows, manage-run, setup-and-config, authoring-workflows, prompting-mistakes) — installed to `.claude/skills/archon-cli/` and `.agents/skills/archon-cli/`. It also covers the surfaces the old skills never mentioned: `--model`, `--config`, `workflow respond`, `workflow test`, `doctor`, and the `ai auth`/tier commands. (#2812)

### Added

- **An `sdlc` workflow pack: from an open question to a reviewed, ready-to-merge PR.** Eleven workflows — eight reusable primitives compose into `fix` (check the current truth, optionally plan or investigate, then deliver through implementation, draft PR, bounded review/correction convergence, project validation, CI wait, and ready-for-review handoff), plus two problem-class compositions, `upkeep` for dependency and advisory currency and `stabilize` for flaky-test elimination, reusing the same assess → gate → deliver template. This pack is the reference implementation the legacy `archon-*` workflows no longer are. (#2627)

- **Between-run continuation: adoption, `$ADOPTED_RUN_DIR`, and an open-work inbox.** An unattended run that ended mid-goal used to leave its branch, worktree and artifacts unreachable by any follow-up — no queryable record of what a terminal run left behind, no way for a new run to continue from it, no way to list runs whose work is still unclaimed. `workflow run <name> --adopt <run-id>` now continues from a prior terminal run's branch and worktree, the prior run's artifacts reach the new run as `$ADOPTED_RUN_DIR`, and unclaimed work is listable. (#2792, #2747)

- **`archon workflow test` runs a package's declared dry-run fixtures.** Every bundled package ships fixture files that nothing executed, so running a fixture matrix meant hand-rolling a shell loop that reconstructed each invocation from prose header comments — one such loop silently dropped its `--dry-run` flags and launched sixteen unintended real runs. `workflow test [<pack-or-workflow>] [--json]` discovers declared fixtures, runs each as a genuine dry run, and reports per-fixture pass or fail. (#2793, #2772)

- **Workflows can pause durably for time and events.** A workflow can wait on a duration, an absolute time, or a bounded external event without holding a provider or subprocess slot open. The database owns suspension and resume claims, so process restarts and competing scanners cannot reset a wait, duplicate a continuation, or falsely complete a run; the server resumes runs that come due. Quota-window failures can opt into the same bounded continuation path (off by default). This does not add start triggers or a generic webhook bus. (#2779)

- **A composed block can fan out inside the parent run.** An `include:` node now accepts `fan_out:` (#2512, #2795). Where a `workflow:` node with `fan_out:` gives every item its own governed child run — its own row, artifacts, cost line and gates — an `include:` node with `fan_out:` repeats the statically named block once per item *inside this run*: one `workflow_runs` row, instance-qualified parent events, bounded parallelism, and input-ordered aggregation into `$<id>.output`. Load time resolves and validates the full static block and its packaged resources; runtime decides only its width. The required `as:` binding delivers each item through the block's declared `$INPUTS`, and `returns:` selects each instance's value. The first content-addressed instance snapshot is durably persisted before scheduling and stays authoritative on resume; completed inner nodes are reused, ambiguous started-without-terminal work blocks automatic replay, and aggregate rows cannot double-count cost. Gates and isolation remain invalid inside this in-parent shape, checkout mutation is rejected before spend when concurrency would be unsafe, cancellation stops new items from starting, and loop iteration identity keeps engine-managed artifacts distinct. Existing `workflow:` fan-out behavior is unchanged.

- **Workflow values keep their type across every boundary, and command/script nodes bind them by name.** A structured node result used to be faithfully typed only inside the run that produced it: persistence kept the text, a cold resume re-parsed it, every `with:` value was a string, and a command file or named script could only receive an upstream VALUE through an artifact file the producer wrote and the consumer re-read. Now the logical value rides along everywhere. `node_completed` events persist it beside the text and resume rehydrates it, so a resumed run's `$node.output.field` reads are identical to a fresh run's. `with:` maps and `inputs:` defaults accept any JSON value — `flag: true` reaches the child as a boolean, not `"true"`. A child run's terminal structured value threads back typed to its parent. And `command:`/`script:` nodes accept their own `with:` map, binding upstream values by name through the surfaces those bodies already read (`$INPUTS.<name>` in a command file, `INPUTS_<UPPER_SNAKE>` env vars in a script) — with an explicit `{ from, if_skipped }` form for reading across a skipped branch at an `all_done` join, so a mutually-exclusive-branches join no longer needs a touch-file latch. Bindings fail loudly: an unknown or non-upstream producer is a load error, and a skipped producer without `if_skipped` fails the node naming the fix — never a silent empty string. (#2637, #2692)

- **A loop can terminate on a validated field instead of a string match.** A `loop:` node now accepts `output_format`, and `loop.until_field` names a declared boolean in that schema whose `true` ends the loop. Completion that is genuinely the model's judgment — "is the backlog empty?" — becomes a schema-validated value rather than a sentinel the model could emit by accident while reasoning about its own criteria. The name must be declared, listed in `required`, and typed `boolean`, all checked when the workflow loads, so a typo fails immediately instead of looping to `max_iterations` and reporting the wrong cause. Termination is strict: `true`, never `"true"` or `1`. A loop's structured output also becomes readable downstream — `$loopId.output.field` gets the same strict access every other producer enforces. Per-provider behavior matches every other node: enforced decoding on Claude/Codex/OpenCode, and on Pi/Copilot an invalid payload is re-asked up to three times *within the same iteration* before the node fails rather than degrading into another iteration. `until_field` is deliberately not offered on `loop_group`, where a body node's `output_format` plus `until_bash` already expresses it. (#2563, #2588)

- **Gate nodes produce structured decision output.** A gate that declares `approval.decisions:` resolves with ordinary `{decision, text}` output the moment a human responds, readable via `$<gateId>.output.decision` / `.text` through the same `when:`/substitution wiring every other node uses. Authors wire a rejection's rework path as an explicit `when:` edge instead of relying on the engine's private `on_reject` template. Opt-in: a gate that does not declare decisions behaves exactly as before. (#2721, #2707)

- **A gate can terminate a `loop_group` body.** Load-time guidance and runtime pause/resume make a gate inside a group body work end to end, including restoring `$LOOP_PREV` body outputs on interactive resume. (#2749, #2750)

- **`archon workflow wait <run-id>` blocks instead of polling.** A run started outside a chat thread — `--detach`, the HTTP API — reaches a state it will not leave on its own and nothing told the launcher. `wait` blocks until the run finishes or parks on an unresolved human gate, then prints what it needs. Paired with the `--detach --json` acknowledgement now carrying `runId`, launch-then-wait is expressible end to end, and polling becomes a diagnostic rather than the orchestration contract. (#2872, #2914, #2923)

- **A run can rebind model tiers and aliases without editing shared config.** `--model large=openai/gpt-5.6` changes only `large`; `medium`, `small`, aliases and literal model pins keep their existing resolution. Available on the CLI, the HTTP JSON and multipart APIs, and the workflow console. (#2784)

- **A run can load a sparse config layer.** `archon workflow run x --config ./config.minimax.yaml` applies a file as a run-scoped layer for one fresh run and its descendants — it survives continuation without re-reading caller input, never leaks plaintext config secrets, and rejects a key that cannot affect that run. HTTP callers can supply the same validated layer as inline content. (#2790)

- **A node can resume a named upstream AI session.** Session continuity used to be a single mutable cursor, so a fresh or parallel AI step erased the ability to return to an earlier conversation lineage. Command and prompt nodes can now declare `context: { resume: <upstream-node-id> }` to fork that exact completed upstream session, including after a process restart. Named resume never mutates the source session and never degrades to a fresh, missing, or different-provider one. (#2643)

- **A workflow can declare its own success verdict.** `outcome_field`, declared relative to `returns`, exposes `outcome: succeeded | failed | null` durably beside lifecycle status — so a valid `{ "green": false }` no longer has to appear as `status: completed`. Status remains the sole owner of terminality, resumability, cancellation, filters, telemetry, and CLI exit behavior. (#2652)

- **A run reads its workflow source from a copy it owns, and `--workflow-source <path>` runs an uncommitted workflow against another checkout.** A workflow authored in checkout A and run against worktree B used to look for `B/.archon/...` and find nothing, so running an uncommitted workflow against a separate target meant committing and merging it first. (#2660)

- **The run transcript records what each node and the run cost.** `node_complete` rows carry `cost_usd`, and the `workflow_complete` row carries run totals as `cost_usd` and `tokens`, so reconstructing spend from `~/.archon/workspaces/<project>/logs/<runId>.jsonl` no longer means pricing four token axes by hand — `tokens.input` is gross prompt input, with cache reads and writes as components of it, which is the part that was easiest to get wrong. (#2676)

- **The engine retains what every exec node printed.** Every deterministic subprocess the engine runs — `bash:` nodes, `script:` nodes, and `until_bash` probes in both loop variants — writes one `exec_output` row into the run's transcript, on success and failure alike, so evidence of what an irreversible action actually did survives the run. (#2983)

- **`--detach` works on the control verbs.** `approve`, `reject`, and `resume` used to host the executor in the calling shell, so a reaped shell left the run wedged mid-resume — decision recorded, workflow never continued. The parent now validates read-only and spawns a detached child that owns every state mutation in its own process group. (#2204)

- **Reusable blocks can repeat inside loop groups.** The loader rejected `include:` inside a `loop_group` body, so authors duplicated the block or manually unrolled a fixed number of rounds. A block included in a group body now expands during discovery and its namespaced nodes execute on every iteration; the executor still receives a fully resolved static graph. (#2641)

- **Sparse dry-run fixtures.** `--stubs-init <path>` writes a complete schema-aware fixture, and `--default-stubs` lets a dry run supply only the load-bearing overrides instead of an explicit stub for every reachable flattened node. Explicit stubs always win, generated structured values validate against `output_format`, and strict missing-stub coverage stays the default. (#2639)

- **`mutates_checkout: false` is enforced.** A node could declare itself read-only and still dirty the working tree, silently corrupting later nodes' assumptions. A node that declares it and then modifies the tree is now rewritten to a `failed` result naming the node and the paths it touched, surfaced through the standard `node_failed` event. Nodes without the declaration behave bit-identically. (#2789)

- **A workflow that declares required inputs can be run directly.** Declaring an input a workflow actually needs used to make it uninvokable — `assertWorkflowInputsSatisfiable` refused every top-level run, calling it "a reusable block" only `include:`/`workflow:` could call, so a workflow became callable-only at exactly the moment it became worth composing. (#2560)

- **A dry run resolves declared inputs like a real run.** A workflow declaring `inputs:` could not be simulated at all — the simulator resolved no `$INPUTS.<name>` on any surface and the CLI rejected `--dry-run` with `--input` outright, so every signature-carrying workflow failed its dry run while the identical real run worked. A workflow with defaulted inputs now dry-runs green with no flags, and `--dry-run --input name=value` binds values visibly in the trace. (#2615)

- **Every compiled Archon invocation records its own path and version** in `<ARCHON_HOME>/install.json`, so GUI and service consumers can find the executable without inheriting a login shell or guessing an install path. Explicit consumer configuration stays authoritative, and source/Bun runs never claim the record. (#2409)

- **Pi falls back to the operator's own default model** when neither the workflow node nor `assistants.pi.model` names one, mirroring how the standalone `pi` CLI behaves and keeping Archon free of any hardcoded vendor model. (#2383)

- **`workflow test` can target a whole pack**, by name (`sdlc`) or directory path (`.archon/workflows/sdlc`), matching what `--help` already documented. (#2864)

- **Failed `script:`/`bash:` diagnostics include stdout.** Node errors carried only stderr, so a well-behaved script that printed its failure context to stdout reported "no diagnostic output" and the operator had to re-run it by hand. Both stream tails are now included. (#2865)

- **SDLC delivery gained CI-aware correction rounds, five attributable review lenses, and run-owned PR identity.** Each correction round now opens by reading the concluded check state for the run's own PR, so a failure CI can prove in minutes feeds the fixer instead of surfacing an hour later as a dead run (#2985). Full reviews always run code, seams and tests, with errors conditional and docs automatic for shipped-documentation changes, every finding carrying its contributing lenses (#2904) — and the simplify lens returned with a values frame, a stronger tier, and the ability to block a merge on a proved simplification (#2917). Public PR actions proceed only when the checked-out branch and GitHub PR head match the PR record the run created, rather than rediscovering a PR from ambient branch state (#2950). Terminal reports now surface validated out-of-scope discoveries (#2887), reviews continue from prior findings (#2863), and delivery stays inside its accepted work order (#2855).

### Changed

- **A loop no longer has to invent a completion signal it doesn't use.** `until:` and `until_bash:` are now *at least one of* rather than `until:` unconditionally, so a loop whose completion is deterministic declares only the check — and then has no prose-matching path at all, which is the point: a sentinel the model happens to emit while reasoning about its own exit criteria can no longer end the loop early. Every existing workflow still loads, and no loop's completion verdict changes. What does change: a `loop:` node now skips `until_bash` on an iteration another channel already completed, matching what `loop_group:` has always done — so a side-effecting check runs one time fewer. (#2563, #2583)
- Provider SDKs moved forward: Claude Agent SDK 0.3.247 (#2831), Codex SDK 0.150.1 (#2834), Pi SDK 0.84.2 (#2762). (#2642) also brings Codex configuration handling up to date.
- `Node` is now a discriminated union by body kind, and the failed-producer guard holds by construction rather than by check. (#2716, #2728)
- All five gate pauses share one persist helper, and template traversal is centralized. (#2711, #2936)
- Pi SDK also moved to 0.84.3 (#2832), and dead validation-result parsing was removed after losing its only production caller (#2569).
- Renovate replaces the Dependabot updater, which cannot read `bun.lock`. (#2681)
- Generated web API types are verified in CI. (#2931)
- Project guidance is durable and lives at canonical paths: `.archon/direction.md` is the direction doc (#2773), `.archon/engineering.md` is the engineering-craft sidecar (#2900), and `AGENTS.md` is the agent-guidance channel (#2838). Recorded decisions cover runtime repetition of static bodies (#2636), governed child workflows owning their AI policy (#2638), where Archon stands on isolation (#2661), keeping bash and script execution separate (#2727), destructive verification against scratch databases (#2894), and correcting proved simplifications on the change rather than deferring them (#2913).
- Docs: the schema parity guard's precedence pinning is now stated honestly (#2592), plus recipes for Pi web search and MCP through your own extensions (#2776), previous-loop output conditions (#2951), a warning that hard-deleting a conversation cascades away its runs (#2956), a version disambiguation page (#2023), an explicit AI-bot allowlist in `robots.txt` (#2065), and JSON-LD structured data (#2068).

### Deprecated

- **The twenty pre-rewrite bundled workflows are deprecated and will be removed.** All `archon-*` defaults moved to `.archon/workflows/defaults/legacy/` and carry a new declared `deprecated:` field. Every run announces at the invocation surface — CLI stderr, chat and web message, durable trace event — that the workflow will be removed in an upcoming release, and names both exits: switch to the `sdlc` pack, or copy the YAML into your project or global `.archon/workflows/` to keep using it. Behaviour is otherwise identical: same filenames, same routing, same execution, same output, and the notice never blocks a run. Nothing is deleted in this release. (#2833, #2781)
- **An undeclared native pause node infers `interactive: true` for one release.** The load-time class check (#2730) would otherwise have made every workflow written before the class declaration existed a hard load error, including ones that only ever ran in the foreground and were never unsafe. `parseWorkflow` now infers the class for the rest of that parse and warns once per file in the log plus on every load through `parseWarnings`. Declare `interactive:` explicitly — the grace period ends in an upcoming release. (#2736)
- Workflow-level `modelReasoningEffort:` is deprecated in favour of `effort:` and is translated at load time with a warning. See Breaking. (#2556)

### Removed

- `archon continue` — replaced by `workflow run <name> --adopt <run-id>`. See Breaking. (#2873)
- The bundled `archon` and `manage-run` skills — replaced by `archon-cli`. See Breaking. (#2812)
- The SDLC review-target preflight, in favour of a written guard rule (#2969), and the delivery tail's leftover machinery, with the checks-gate recovery named explicitly (#2988).

### Fixed

- **A run records what it spent even when it fails or is cancelled.** Cost and token totals were previously written only on the success path. (#2608, #2694)
- **A failed terminal status write now fails the run.** Terminal status writes were best-effort, so a failed `completeWorkflowRun`/`failWorkflowRun` could let a finished execution return normally while its row stayed `running` — the run looked live, held its worktree lock, and hid the failed write. (#2921, #2837)
- **Rejecting an approval gate to termination now writes a `workflow_cancelled` event.** The reject path that ends a run flipped the run row to `cancelled` while recording only the `approval_received` audit row, so the durable event log had no terminal transition for a whole class of cancellation — anything reading events rather than the run row silently missed it. The cancellation event is now written in the same transaction as the status flip, matching every other terminal writer, and carries the gate's step name with `reason: approval_rejected`. The rejection text itself stays on the `approval_received` row where it always was. (#2906, #2912)
- **A terminal workflow run can be adopted on SQLite again.** `workflow run <name> --adopt <run-id>` crashed with `createdBefore.toISOString is not a function` on the default SQLite database before creating the continuation run. SQLite stores every workflow-run timestamp as TEXT (UTC "YYYY-MM-DD HH:MM:SS") while the `WorkflowRun` type declares them `Date` — normalization parsed only metadata, so `resolveWorkflowAdoption` handed that raw string to the estate-ownership lookup's cutoff comparison, which calls `.toISOString()`. The row normalizer now hydrates `started_at`, `completed_at`, and `last_activity_at` into real UTC dates for both dialects, preserving the rule that an adopted environment must satisfy `environment.created_at <= run.started_at`. (#2845, #2847)
- **A chat command with leading whitespace is now recognized as a command.** `handleMessage`'s slash-command checks tested the raw inbound message. Slack and Discord already hand it pre-trimmed as a side effect of their bot-mention-stripping regexes, but Telegram, the CLI, and direct API callers pass the message through untouched, so a leading space (e.g. `"   /workflow list"`) silently fell through to the AI instead of running deterministically. Command detection is now anchored to the trimmed message start; the raw message is unchanged everywhere else. (#2547)
- **An explicit `effort:` on a Codex node no longer cancels its tier's reasoning depth.** A node combining a model tier that carries `effort` with its own `effort:` ran with no reasoning effort at all — the explicit value suppressed the tier's, then went to a field Codex did not read. Such a node ran shallower than the same node with the `effort:` line deleted. (#2556)
- **`/reset` is now a real escape hatch.** It used to deactivate the AI session and leave the conversation's execution binding (`cwd` + `isolation_env_id`) and every resumable run untouched, so the next message still resolved to the prior worktree and could silently continue a stale `paused`/`failed` run with its old arguments and completed nodes. `/reset` now nulls the binding and abandons each resumable run tree through the shared abandonment pipeline, preserving `codebase_id` (detaching the project is `/setproject none`'s job) and atomically limiting every reset cancellation to `paused`/`failed` rows. `pending`/`running` work is never touched — those rows may belong to another process entirely. Session, run, and binding cleanup failures are isolated and reported; an incomplete reset asks the user to retry instead of promising that the next message starts fresh. (#2291, #2731)
- **Rate-limited and silently-dead provider streams retry patiently.** A node's own short `maxRetries` exhausted within seconds while the provider's load-shedding window is minutes-scale, and loop iterations had no transient retry at all — one 429 killed the whole loop node. Rate-limited failures now retry up to five times with a flat ~45s ±50% jitter backoff, and loop-node AI iterations survive transient errors, including silent stream death, under the same policy. FATAL failures still fail immediately. (#2798, #2706)
- **`output_format` declared on a `workflow:` node is validated against what the child actually returned**, before any `node_completed` row is written — a schema-mismatched child used to pass silently, with downstream `.field` reads failing late or resolving a declared-but-absent field to `''`. (#2788)
- **A dry run no longer writes inside the simulated repository.** `ARTIFACTS_DIR`/`STATE_DIR` pointed at `<cwd>/.archon/dry-run/`, so every simulation left untracked residue in the user's repo — and nothing created those directories, so a bash node's redirect into `$ARTIFACTS_DIR` failed while the node still reported success, surfacing as a confusing failure two nodes downstream. Simulations are now hermetic. (#2620, #2619, #2617)
- **A transient project-identity lookup failure no longer permanently pins a run's `output_root`** to the `_cwd/<basename>` fallback; a faulted resolution is stamped `metadata.identity_unresolved` so it is distinguishable from a genuinely unregistered project. (#2304)
- **`workflow status` rejects a run ID** instead of misreading it, and `workflow events` accepts run-ID prefixes. (#2625, #2626)
- **A cached prior-success node is invalidated when a dependency re-ran**, so a resumed run cannot reuse a result computed from stale inputs. (#2705)
- **A resumed run's completed nodes no longer report as skipped.** (#2975)
- **A failed `loop_group`'s binding now fails its consumer** instead of handing over the last completed iteration's text. (#2710)
- **Loop artifacts and raw output are preserved per iteration and across resume**, and interactive `loop_group` resume restores `$LOOP_PREV` body outputs. (#2647, #2649, #2750)
- **Loop-group checks can read body outputs**, bash `loop_group` body nodes receive `$LOOP_USER_INPUT`, loop gates name the actual completion channel, `until_bash` fails on unavailable output refs, quoted loop-group output refs warn, and a `loop_group` warns when its pause escalation cannot reach a nested interactive loop. (#2630, #2733, #2635, #2808, #2811, #2754)
- **Silent loop watchdog retries are gone.** (#2902)
- **A wait-terminated `loop_group` no longer completes on a still-pending probe.** Node-output values in `bash:` and `until_bash` are already shell-quoted, so a hand-quoted comparison compared the wrong thing; the quoted-ref warning above (#2811) now catches the authoring shape that caused it. (#2799, #2794)
- **A staged source capture is adopted at the rename site**, so a failed rename inside `executeWorkflow` no longer orphans the staged directory under `~/.archon/staged-source/` until the hourly sweep reaps it — now portable to Windows. (#2758, #2755, #2690)
- **Composition fixes:** skipped composed blocks stay airtight (#2628), nested `include:` input bindings are preserved (#2634), and a composed `command:` node keeps its own `with:` binding (#2981).
- **Dry-run tolerates a missing stub on an `all_done` join and on an `all_done` loop node.** (#2958, #2979)
- **A faulted codebase lookup no longer pins a run to an empty fallback location.** (#2720)
- **Oversized output spills are isolated per run**, and `script:` node output is capped and resume-safe on both runtimes. (#2640, #2732)
- **Adopted runs stay on their original branch.** When an adopted run's worktree had been cleaned up, Archon treated its branch as ancestry for a new generated branch, splitting continuation from the existing pull-request branch. Explicit adoption now reuses the prior worktree or rematerializes the exact historical local branch, and one persisted `working_path` is the mutable checkout for every agent, bash, script, source-capture, resume, and audit path. (#2809)
- **`--adopt` accepts run-id prefixes.** (#2948)
- **A detached run that fails fast is not reported as a launch failure.** (#2925)
- **Detached workflow runs can actually be stopped.** (#2766)
- **A Windows cancel no longer fails for a run whose process tree already stopped.** (#2953)
- **`archon serve` can no longer hang extracting the web UI on Windows.** (#2928)
- **A folder project registered by the CLI is found again by every other command.** On Windows, a project registered by `workflow run --folder` was stored under a different string than the lookup asked for, so `workflow get`, `wait`, `cancel`, `runs`, `resume`, `approve` and `reject` all refused with `Error: Not in a git repository` — which was never true. (#2929)
- **Linked worktrees keep their registered project identity.** (#2633)
- **Explicit worktree branch names are preserved.** (#2930)
- **`/worktree remove` refuses to destroy a worktree owned by a live run**, `--force` included, matching isolation cleanup. (#2919)
- **Isolation cleanup is pinned by live runs, not conversation history.** (#2879)
- **`archon complete` works after a squash merge and for never-pushed branches with no unique commits.** A GitHub-deleted branch ref was treated as unpushed work, and a branch byte-identical to its base was treated as a blocker; both forced `--force` on an operator just cleaning up. Cleanup still only proceeds when the content is proven to be on the default branch, and an unverifiable case still fails closed. (#2949, #2433, #2703)
- **HTTP approve/reject/resume now advance CLI-launched runs.** (#2712)
- **The web adapter persists message category, matching the CLI.** (#2701)
- **Streaming run logs stay pinned to the tail**, unrecognised workflow sources are surfaced verbatim, and builder node reference validation matches the engine. (#2655, #2717, #2631) The builder also stopped rejecting `when:` conditions the engine accepts (#2591), settled on one definition of a node id — its previous four copies used `\w`, which excludes the hyphen and so validated none of the hyphenated node ids the bundled workflows actually use (#2570) — and the chat UI now reads the server's message category instead of guessing from a leading emoji, which had made the live view and the reloaded conversation disagree (#2571).
- **`manage_run`'s reject action, `workflow reject`, and the Slack reject button all default empty text to `Rejected`** instead of recording an empty reason. (#2739, #2741)
- **A chat turn is refused when its worktree or project directory is gone**, rather than silently resolving somewhere else. (#2551, #2665)
- **`/reset`, cancellation, and adoption no longer inherit the previous gate's cache tokens**, and a partial cache total is reported as a floor instead of withheld. (#2675, #2671, #2654)
- **Pi loads native project guidance**, and invalid Pi model references are reported clearly. (#2839, #2918)
- **Codex OAuth refresh errors route to Codex auth guidance** rather than a generic failure (#2702), bare `401`/`403` no longer match Claude's auth patterns (#2743), malformed stored OpenAI OAuth expiry is rejected (#2775), and GitHub Copilot subscription login no longer hangs on the enterprise-domain prompt (#2770).
- **Claude tool-scoped hook activity appears in the audit stream.** `buildBaseClaudeOptions` omitted `includeHookEvents`, so the SDK suppressed `hook_started`/`hook_response` frames for every hook type except SessionStart and Setup — a node-level PreToolUse hook that denied Bash was invisible to the audit stream. (#2723, #2324)
- **`console.log` is piped through `writeStdout`**, so a slow reader gets the whole payload. (#2704)
- **`workflow test` reports load errors, resolves paths from the caller's cwd, and suggests only workflows that carry fixtures.** (#2920, #2952, #2862)
- **Exec-code fixtures execute in a scratch worktree, not the caller's tree**, and keep `PWD` there. (#2861, #2932)
- **`SqliteAdapter` finalizes prepared statements so `close()` releases the database file.** (#2878)
- **The nothing-to-resume fallback captures fresh source.** (#2700)
- **Running `validate` with a nested worktree no longer fails**, and cold lint stays within Node's default heap. (#2658, #2858)
- **The reported workflow path is derived once, with forward slashes.** (#2957)
- **SDLC pack corrections:** red-cause gating, failed-run discoveries and lens-gate re-evaluation (#2942); a `red_cause` schema Codex rejected, which killed every deliver run at the first turn (#2944); a correction round with nothing left to change no longer kills the delivery (#2977); the delivery tails report the PR from the run's record rather than the checkout (#2980); optional reviews follow the classified scope (#2840); the delivered-fixture bar is restored after the review-complete join (#2867); and `archon-fix-issue` stops asking questions nobody can answer (#2257).
- **Test-suite and CI stabilization.** Roughly two dozen changes removed wall-clock dependence, accidental subprocesses, real database opens, and temp-directory cleanup races from the suites, and added SQLite upgrade verification against every released schema vintage. (#2823, #2824, #2826, #2852, #2853, #2854, #2866, #2874, #2876, #2877, #2881, #2883, #2886, #2911, #2915, #2916, #2922, #2943, #2984, #2685, #2829, #2903, #2880, #2987, #2402, #2603, #2605, #2780)

### Security

- **Credentials are redacted from container exec failures.** Container-isolated deterministic nodes pass environment variables through `docker exec -e NAME=value`, and on failure Bun includes the command and subprocess output in the rejected error — so a credential echoed in argv, stdout, or stderr could reach workflow events, platform messages, and detached-run logs. Deterministic subprocess failures now redact every exact Archon-delivered credential value from `message`, `stack`, and `cmd`. (#2431)
- **`ws` pinned past two advisories** covering the hoisted `8.19.0` that `discord.js` uses for its live gateway socket, including a high-severity memory-exhaustion DoS reachable from remote frame traffic on any install running the Discord adapter. (#2659)
- **Better Auth upgraded to 1.6.30** from a `~1.6.22` floor, clearing the full listed advisory set; PostgreSQL users and sessions survive the upgrade and unauthenticated protected `/api/*` requests still return 401. (#2765)
- **Pi SDK 0.84.2** clears the vulnerable `undici@8.5.0` (six advisories, one high) that the old pin held under `pi-coding-agent`. (#2762)
- **`sharp` bumped to the patched 0.35.0 line**, clearing the libvips advisories the docs build's image pipeline inherited. (#2752)
- **Custom Pi providers resolve their configured keys and headers from project/request env** through Pi's own provider contract, instead of being handed the full merged env — which would have let a custom provider select credentials Archon injected for another provider or for GitHub. (#2656)

## [0.9.0] - 2026-08-17

Workflows become properly composable: a workflow can now declare the arguments it takes and the result it returns, ship as one self-contained folder, and be simulated end to end without contacting a provider. Alongside that, a workflow node's capabilities become what its YAML declares rather than whatever happens to be configured on the operator's machine — see Breaking before upgrading.

### Breaking

- **Claude workflow nodes no longer inherit ambient skills and MCP servers.** A Claude node now sees exactly the skills and MCP servers its YAML declares, plus the native tools Archon injects for the run. User, project, and plugin MCP configuration on the operator's machine no longer reaches workflow nodes: a node that relied on an ambiently configured server must declare it with `mcp:`, and one that relied on an ambient skill must list it under `skills:`. Declared skills are now also checked before spend — a skill that is installed but unreachable from the node's enabled `settingSources` fails up front instead of silently going missing, while built-in and plugin-qualified (`plugin:skill`) names warn and are left for the SDK to resolve. Direct Claude chat, `CLAUDE.md`, and built-in, filesystem, and inline agents are unchanged. (#2535)
- **An included command body must resolve, and may only reference its own workflow.** `command:` and `loop.command` files inside an `include:` block are now resolved, validated, namespaced, and input-bound during load-time composition, recursing through nested `loop_group` bodies. Two previously tolerated shapes now fail: a body that references a node id outside the included workflow (it could bind whatever the caller happened to have) is rejected, and a body that cannot be resolved or read fails a fresh execution instead of warning and being skipped. Declare an input and pass it with `with:` instead of reaching outward. A paused loop still resumes from its persisted prompt snapshot even if its command file is later deleted. Included command bodies gained the other half of this trade: they can now use `$INPUTS.<name>`, which Phase 1 rejected outright. (#2534, #2532)

### Added

- **Workflow signatures — `inputs:`, `returns:`, and `with:` on sub-runs.** A workflow can declare the named arguments it accepts and which node's output is its result, and a `workflow:` sub-run node can bind those arguments by name with `with:` instead of passing a single opaque `input:` string. Values arrive as `$INPUTS.<name>` in prompts and command bodies, and as `INPUTS_<UPPER_SNAKE>` in `bash:`/`script:` node environments. Missing required inputs and undeclared arguments are rejected before any worktree, clone, or provider cost, and `returns:` gives a stable author-chosen result channel in place of guessing the terminal sink. Workflows without `inputs:` keep their existing passthrough behavior byte for byte. (#2523)
- **`archon workflow run <name> --dry-run` simulates a workflow without spending anything.** An in-memory simulator walks the DAG — routing, `when:` conditions, strict `$node.output` references, gates, and loops — and prints a deterministic human or `--json` trace. No provider is contacted and nothing is persisted: no run row, events, sessions, or worktrees. Node outputs can be stubbed, approval behavior chosen, and code nodes actually executed with `--exec-code` (they are stubbed by default). (#2530)
- **Packaged workflows — one folder holds a workflow and everything it uses.** `.archon/workflows/<pack>/<workflow>/` is discovered as a package in both repo and home scope, and bare `command:` / `script:` references in that workflow's YAML bind to its own `commands/` and `scripts/` directories instead of the shared trees. Copying a workflow to another repo is now copying one folder rather than a scavenger hunt across three. Packaged resources are embedded in binary builds, and the Web API's workflow GET/PUT/DELETE lifecycle preserves the layout. Flat and one-level grouped YAML layouts are unaffected. (#2528)

### Changed

- **Codex workflow nodes no longer advertise ambient skills automatically.** Workflow commands and prompts now invoke installed Codex skills explicitly with `$skill-name`, an empty `skills: []` declaration is valid, and unsupported YAML fields warn honestly instead of implying support. Direct Codex chat is unchanged. This is a behavioral guard rather than filesystem isolation, and Codex MCP configuration remains additive to ambient servers. (#2498, #2533)
- **A malformed `settingSources` entry can only narrow Claude's scope, never widen it.** An unrecognized entry previously left the key unset, falling through to the permissive `['project', 'user']` default — so `settingSources: [projct]`, written to lock a node to project scope, silently granted full user-scope ambient access. Unrecognized entries are now dropped and logged, and workflow validation shares one parser with execution so the two can no longer disagree about a node's effective sources. (#2535)
- **Agent instructions live in one file.** `AGENTS.md` — which Codex, Pi, and OpenCode read natively — had drifted about six months behind `CLAUDE.md`. It is now the canonical instruction file, with `CLAUDE.md` reduced to a one-line pointer that Claude Code resolves as an import. No rule changed in the move. (#2497)

### Fixed

- **A schema upgrade can no longer crash-loop on an index that predates its column.** An index or `COMMENT ON COLUMN` placed beside its table body names a column that does not exist yet on an upgrade, because `CREATE TABLE IF NOT EXISTS` is a no-op there and the column only arrives in the later additive `ALTER TABLE` block. Since the schema applies in one transaction and re-throws, a single such statement aborted the whole apply and crash-looped every boot — on Postgres this broke startup and every CLI invocation for installs upgrading past #2414, and on SQLite it meant `new SqliteAdapter(...)` simply could not open a database created before `parent_conversation_id` existed. Every index and column comment now sits below the additive block. A new `check:schema-upgrades` CI job proves the current schema applies cleanly on top of every schema vintage ever released, re-applies idempotently, and lands on exactly the fresh-install shape. (#2513, #2552)
- **Workflow-level `modelReasoningEffort:` and `webSearchMode:` reach Codex.** Both had been schema-declared, loader-validated, and documented as working workflow-level options since March, but the executor never read them off the workflow definition — a workflow declaring either parsed cleanly, warned about nothing, and ran at the `config.yaml` or SDK default. Declaring either on a non-Codex node now produces the same loud capability-mismatch warning every other unsupported field produces. (#2559)
- **The container write-back no longer mis-decodes hostile or merely unusual filenames.** The two overlay walk scripts — the one place a container run writes the live root — decoded each entry by forking `basename`, `dirname`, and `sed`, which produced three reachable defects: a whiteout marker under a `-`-prefixed directory was planted as a literal `.wh.*` file instead of deleting its target (no adversary required, just a leading dash); a whiteout whose name ended in a newline deleted a different, innocent file and could write outside the live root while reporting success; and a TAB inside a filename or symlink target forged the positionally-decoded fields after it, presenting an escaping symlink to the approval gate as safe. Shell parameter expansion replaces the forks, closing all three and cutting forks per entry from 8 to 4 for a regular file and 6 to 1 for a whiteout. (#2561)
- **Archon no longer guesses the default branch.** `getDefaultBranch` ended its fallback chain by checking whether `<remote>/main` merely existed and returning it if so. On a repository shaped like this one — `dev` is the default and `main` is the release branch — a run silently cut its worktree from `main` and targeted its pull request at `main`, with nothing erroring at the moment it happened. When `<remote>/HEAD` is not a symbolic ref it now throws, naming `--base`, `worktree.baseBranch`, and the codebase `default_branch` field. (#2503)
- **`WORKFLOW_ID` is delivered to `bash:` and `script:` node subprocesses.** It substituted into the node body but was missing from the environment bag, unlike `ARTIFACTS_DIR`, `STATE_DIR`, and `LOG_DIR` sitting beside it — so a heredoc'd `python3` or `node` block reading `os.environ` failed inside the nested interpreter with a bare `KeyError` and no hint that its siblings worked fine. The `e2e-deterministic` fixture that demonstrated the wrong way to consume an output reference was corrected too. (#2511)
- **A dry run of the state migration no longer creates a database.** `scripts/migrate-state-dir.ts` consulted the codebase registry unconditionally, and the SQLite adapter connects lazily and applies the full schema on first use — so a read-only run wrote a 704 KB database while printing `Dry run — nothing was moved`. (#2557)

## [0.8.0] - 2026-08-06

Run output moves out of the repository for good — see Breaking below before upgrading. Alongside it, workflow composition grows up: sub-run nodes can now fan out over a runtime list and take their own worktree, and include blocks accept parameters. Plus a batch of fixes for failures that were previously silent.

### Breaking

- **Repo-local `.archon/state/` is no longer read, and is never migrated automatically.** Cross-run state now lives at `$STATE_DIR` (`~/.archon/workspaces/<project>/state/`). A run that finds a legacy directory emits exactly one warning containing the literal `mv` command and then proceeds with an empty state directory — so a workflow depending on prior state will not error, it will behave as though it is running for the first time. **Move it before upgrading, or on the first warning.** From a source checkout, `bun run scripts/migrate-state-dir.ts` reports what would move (dry run by default) and `--apply` performs it; binary installs should use the `mv` printed in the warning. (#2299)
- **Runs in an unregistered directory no longer write artifacts and logs into `<cwd>/.archon/`.** The engine's fallback previously placed its own output inside the working directory — inside a user's repository, where it was stageable. Output now resolves under `~/.archon/workspaces/` for every run. Anything reading run artifacts from a repo-relative path must be repointed at `$ARTIFACTS_DIR`. (#2299)
- **`GET /api/runs/:runId/artifacts` returns 404 instead of an empty list** when a run's project storage cannot be resolved. It previously answered HTTP 200 with `{ files: [] }` for folder projects and local repos without a remote, which was indistinguishable from a run that wrote nothing. Consumers treating an empty list as "no artifacts" must now also handle 404. (#2299)

### Added

- **Dynamic fan-out for `workflow:` sub-run nodes.** `fan_out: { items, max_parallel, join }` expands one governed child run per item of a runtime list, bounded by a sliding concurrency window and joined by `all_done` (default) or `all_success`. Results aggregate as a JSON array in item order and thread back as `$nodeId.output`. Previously a sub-run node was strictly 1:1 with its width fixed in YAML, so the orchestrator-worker pattern had no encoding short of a `bash:` dispatcher spawning detached children with hand-rolled polling — out of process, with no native await, cost roll-up, or run tree. (#2224)
- **Per-child worktree isolation for `workflow:` sub-run nodes.** A sub-run node may declare `isolation: worktree` to get its own checkout and branch instead of sharing the parent's. Isolation is explicit-only and never inferred from `fan_out` — concurrent children on a shared checkout are refused by a spawn-time preflight rather than silently given a worktree. (#2223)
- **Parameterised include blocks.** `with:` on an `include:` node plus the `$INPUTS.<name>` macro let one shared sub-DAG be reused with different values instead of forked. Substitution resolves entirely at load time, so the executor still sees a flat static DAG and load-time validation, resume, and the audit trail are unaffected. An unsupplied input fails the load rather than substituting silently. (#2467)
- **`$STATE_DIR` for cross-run state.** A per-project directory alongside `$ARTIFACTS_DIR`, pre-created by the executor and living outside the repository. It replaces the `.archon/state/` convention, which had no engine support at all — prompts did `mkdir -p .archon/state` relative to cwd, so inside an isolated run the "cross-run memory" wrote to the worktree and died at cleanup, and in a user's repo it was stageable. A legacy directory produces one warning with the exact `mv` and is never moved. (#2299)

### Changed

- **One resolver now backs every run-output path.** The identity-to-storage-path rule had been implemented three times at three levels of correctness — the executor, the CLI's `continue`, and the two HTTP artifact routes — which is what allowed the artifact routes to silently fail for two of the three project kinds Archon can register. A single `resolveProjectStorageKey` in `@archon/paths` now backs all four call sites. (#2299)
- **Run artifacts stay addressable across a project rename.** A durable `output_root` pointer is recorded once at run start and never rewritten on resume, so historical runs keep resolving to the tree they actually wrote to even if the codebase is later renamed. (#2299)
- **Unknown YAML keys are reported instead of silently stripped.** Unrecognised keys now surface as non-blocking warnings across every surface an author looks at — `archon validate workflows` (human and `--json`), chat, the console workflow picker, and the API — each naming the node and the key, and persisted to the audit trail as a `workflow_parse_warnings` event. Warn rather than reject, so workflows that load today keep loading. (#2455)

### Fixed

- **A declared `output_format` no longer silences an unparseable output.** "No parseable object at all" was treated as a declared-optional field and resolved to empty on the declared-schema path while the schemaless path threw — so declaring `output_format` made a broken producer quieter than declaring nothing. It bit hardest on `workflow:` sub-run nodes, where a child returning prose instead of JSON turned every declared field into an empty string with no error or warning. Both paths now fail. Genuine leniency is untouched: a field missing from a payload that actually parsed still resolves to empty. (#2460)
- **The issue-fix workflow stops when its specification is missing.** A run that had already lost its specification would spend a large-model implement node plus four review-tail nodes and then post a public comment on the issue announcing it was blocked — an AI node that *declines* still exits 0, and the one cheap deterministic precondition check only warned. The check now fails, and the investigate step runs its command directly instead of delegating to an ambient skill that routed on the leading verb of the input. Applied to both the experimental and bundled default workflows. (#2499, #2500)
- **Archon telemetry stays out of target-repo pull requests.** Repo-local `.archon/artifacts/`, `.archon/logs/`, and `.archon/state/` are documented as never belonging in git, but no bundled default told the agent to ignore them or refuse to stage them. Every "never stage" blocklist in the bundled defaults now lists them, and runs that create or modify a `.gitignore` must include them. (#2199)
- **Truncation is named correctly in clipped-output errors.** The truncation marker was matched against the exact tail, so a single trailing newline was enough to report the generic "not a JSON object" error instead of naming the truncation. (#2493)
- **Include-expander warnings are visible to tests again.** The expander cached its logger at module scope behind a comment stating the deferral existed so test mocks could intercept it — the cache defeated exactly that, and three loader tests failed whenever they shared a process with the expander's own tests. CI had been protected only by the accident of running them in different batches. (#2461)
- **Installer environment-variable documentation corrected**, along with the release tooling's changelog commit boundary. (#2437)

## [0.7.1] - 2026-08-04

Workflow runs now record what they actually resolved to — assistant, model, effort, isolation, base branch — so two runs can be told apart after the fact. Plus retry classification for transient Codex failures, and a batch of installer and CLI repairs.

### Added

- **Per-dispatch `--base` override** — `archon workflow run --base <branch>` sets the branch the worktree is cut from and the PR targets, for that run only. Base resolution was static per codebase (`worktree.baseBranch` → `default_branch` → git auto-detect), all of which describe the repo rather than the run, so fanning out parallel dispatches against one repo with different bases had no encoding short of editing repo config. (#2203)
- **`archon-parse-user-request`** replaces `extract-issue-number`, parsing the operator's message into structured fields — the verbatim request, issue number, repo shorthand, and repo URL — instead of a number alone. (#2420)
- **Compact node summaries in verbose JSON** — `--verbose --json` returns ordered node summaries including `startedAt` by default, with stable ordering for tied timestamps, so machine consumers no longer have to recreate the CLI's node-state fold or filter tool-event noise. (#2414)

### Changed

- **Run start events snapshot the resolved configuration.** `workflow_started` previously carried only the workflow name, forcing consumers to reconstruct run context from other records. It now records the resolved assistant/provider/model, isolation mode, base branch, and persisted user/input context, so a run is classifiable from a single durable event. (#2428)
- **Tool lifecycle events can be correlated.** `tool_called` and `tool_completed` now carry the resolved `tool_call_id`, a structured `tool_outcome`, and an optional `exit_code` through persistence, SSE, and CLI — so repeated or interleaved tool calls can be paired, and per-invocation latency and failures are traceable. (#2421)
- **Resolved effort is recorded on node start.** Effort was applied to node execution but discarded before `node_started` was persisted, leaving two runs indistinguishable when effort was their only material difference. (#2415)
- **`archon complete` counts only commits reachable solely from the refs being deleted.** Dev-based worktree branches holding no unique work are no longer blocked behind `--force`, which would also have bypassed unrelated safety checks. (#2416)
- **Bash node stdout previews are retained** after a successful run, so gate verdicts stay auditable. (#2388)
- **Planning treats issue comments as authoritative** — comments outrank the issue body, and linked issues count as part of the input. (#2404, #2411)
- Documentation points GUI callers at the native CLI. (#2387)

### Fixed

- **Transient Codex availability failures retry again.** `classifyError` tested `FATAL_PATTERNS` first, and that list held the bare substring `auth error` — so Codex's circuit-breaker text `auth error: 503` classified FATAL and never reached the transient check two lines below. Because FATAL is an absolute veto, `on_error: all` did not rescue it either; there was no author-side escape hatch. Classification is now three-tier: decisive fatal evidence (explicit credentials, authorization, quota and limit windows) first, transient second, and the ambiguous `auth error` wrapper last. Separately, `Selected model is at capacity` matched neither list and fell through to `UNKNOWN`; it is now transient. (#2434, closes #2386 and #2425)
- **SQLite upgrades no longer break on `event_order`** — the index and trigger ran before the `ALTER` that adds the column. (#2418)
- **Issue URLs keep their repository identity.** A bare issue number no longer resolves against whatever checkout the run happens to be in; this also unblocks fixes that target `.archon/` itself. (#2417)
- **Piped `--json` output no longer truncates** mid-stream. (#2389)
- **`workflow resume` guidance in the CLI is correct.** (#2422)
- **Detached workflow startup acknowledgement.** (#2390)
- **Codex tool duration reporting.** (#2378)
- **Git repositories without remotes no longer error.** (#2380)
- **The PowerShell installer fails when its version check exits non-zero**, instead of reporting a successful install. (#2391)
- **Incompatible x64 quick installs are rejected** rather than installing a binary that cannot run. (#2379)
- **`archon doctor` honors the `claudeBinaryPath` config fallback.** (#2275, #2263)
### Added

- **Pi model-default fallback** — when no model is set on a workflow node or in `.archon/config.yaml`, the Pi provider now falls back to the operator's own Pi default (`defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json`, as written by the `pi` CLI). This keeps Pi workflows model-agnostic — no vendor model hardcoded — so setups whose catalog drifts (e.g. a LiteLLM proxy) work without pinning a specific model, mirroring how the standalone `pi` CLI boots. Falls through to the existing explicit "requires a model" error when no default is configured.

## [0.7.0] - 2026-08-01

Runtime sub-runs (`workflow:`), the connected Studio builder, usage accounting you can trust, a repaired `curl | bash` install path, and a security batch across cloning, transport, and path resolution.

### Added

- **`workflow:` runtime sub-run node** — run another workflow as a governed **child** run with its own `workflow_runs` row, artifacts, approval gates, cost line, and audit trail. The child's terminal output threads back as `$<nodeId>.output`, and a child gate pauses the whole tree (approve the child by run id; the parent auto-resumes on completion). Slice 1 is sequential composition in a shared checkout — dynamic fan-out, per-child worktrees, `first_success` racing, and `with:` parameter mapping are reserved in the schema and rejected fail-fast. (#2121, #2169)
- **Archon Studio connected mode** — `/console/builder[/:name]` loads, saves, creates, renames, and deletes real workflows through the existing CRUD endpoints, with a project picker, explicit Save behind a dirty + navigation guard, server-tier validation surfaced in the issue panel, and bundled → Save-as. (#2051)
- **Evidence gate** — optional workflow-level `evidence_policy: { required: true }` refuses terminal `completed` unless `$ARTIFACTS_DIR/evidence.json` exists; the run is marked `failed` with a structured note, an `evidence_validation_failed` event, and the expected path named. The engine gates on file **presence** only — what counts as valid evidence is produced by the workflow's own bash/script nodes. (#2230, #2235)
- **Configurable git remote** — `worktree.remote` in `.archon/config.yaml` plus auto-detection (`origin` if present → sole remote → actionable error on ambiguity), threaded through worktrees, workspace sync, PR-state lookup, forge detection, and cleanup. A repo whose only remote isn't named `origin` previously could not use isolation at all. (#2234)
- **Database schema vintage** — installs record the schema version they were created at, and the additive-only migration rule is stated in the codebase and checkable. (#2317)
- **Forge detection** — `detectForge()` in `@archon/git` resolves a remote to GitHub / GitLab / Gitea, including self-hosted instances via `GITHUB_URL` / `GITEA_URL` / `GITLAB_URL`. Lands as the reviewed foundation for forge-agnostic adapters; no consumers wired yet, by design. (#2210)
- Per-node `settingSources` override for Claude nodes. (#2216)
- `DISCORD_REQUIRE_MENTION` lets the Discord adapter respond without an @mention. (#2209)
- Opt-in Docker root fallback (`ARCHON_ALLOW_ROOT_FALLBACK`) for macOS bind mounts. (#2228)
- Published container images carry provenance and SBOM attestations. (#2297)
- Marketplace: `archon-resolve-mr-conflicts`. (#1687)

### Security

- **Clone hardening.** Both clone paths now pass `GIT_TERMINAL_PROMPT=0`, so a clone with missing or invalid credentials fails fast instead of hanging indefinitely on an interactive prompt. The credential sanitizer gains `GITLAB_TOKEN` / `GITEA_TOKEN`, and URL redaction is generalized from `@github.com`-only to the userinfo of any `scheme://user[:pass]@host` form — closing a path where a failed GitLab/Gitea clone could surface an embedded token to chat platforms and logs. (#2221)
- Codebase names shaped like SSH URLs are rejected during worktree path resolution. (#1583)
- The bundled-defaults generator refuses to embed untracked files from `defaults/`, so an uncommitted local file cannot silently ship inside a binary. (#2237)

### Changed

- **Per-node token usage is persisted, and cumulative totals survive a resume.** Token counts are recorded per node as they are produced, and a resumed run no longer under-reports its totals by roughly the work completed before the resume. (#2347, #2353)
- **Resolved model metadata is recorded per node** — what actually ran, not only what was requested. (#2337)
- Tool timing is completed at the result boundary rather than left open. (#2336)
- `tool_result` payloads are bounded at 16 KiB at the SSE emit and message-hydration boundaries, so a multi-megabyte tool output no longer costs every viewer a full parse and full cache residency. Database writes keep the **full** output — the DB and logs remain the authoritative record. (#2244)
- Message queries carry an id tie-breaker so `LIMIT` windows are deterministic. (#2220)
- Owner/repo identity resolution is unified on `@archon/paths`. (#2231)
- The generated provider capability matrix surfaces per-cell caveats. (#2222)

### Fixed

- **`curl -fsSL https://archon.diy/install | bash` was broken for every user and is repaired**, along with the PowerShell mirror, which had drifted from it. Installer tests now run in CI to keep the two in sync, and Rosetta architecture detection on macOS no longer selects the wrong binary. (#2340, #2335, #2330)
- **Chat resume prefers a paused run over a newer failed one**, so approving from chat resumes the run actually waiting on you. (#2292)
- **Stale errors are cleared on resume**, so a run that succeeds after resuming no longer carries the previous failure's error text. (#2348)
- A node whose AI prompt substitution fails emits `node_failed` instead of failing quietly. (#2205)
- New conversations resolve the configured default assistant. (#2245)
- Pi sessions authenticated with an Anthropic subscription receive a default system prompt. (#2243)
- SQLite/Postgres schema parity checks compare columns, not only table names. (#2346)
- "Open in IDE" resolves correctly for workflow runs and under WSL2. (#2003, #1504)
- Workflow invocations split across message chunks parse correctly. (#1542)
- Detached re-invoke drops Bun's single-file-executable virtual `argv[1]`. (#2273)
- Bundled defaults pin `gh pr create` to the origin repo. (#2229)
- The console composer and approval input guard IME composition, so committing a candidate no longer submits the message. (#2217)
- `archon-fix-issue` no longer stops on the dirty run worktree it is expected to be working in: the clean-tree requirement is scoped to the base-branch case, and the checkout is classified with `git-dir` vs `git-common-dir` rather than `git worktree list`, which cannot distinguish them. (#2358)
- Docs: the docs build is repaired and guarded against silent rot, cloud Docker auth setup is clarified, `llms.txt` coverage is improved, and the workflow constitution is clarified as governing the YAML surface rather than prompt content. (#2301, #2259, #2066, #2067, #2300)
- Test hygiene: unit tests no longer reach the live network or a real database, and adapter tests no longer write to a real `ARCHON_HOME`. (#2303, #2307, #2310)

## [0.6.0] - 2026-07-20

Folder projects, opt-in Docker container isolation, three new workflow-composition primitives (`include:`, `loop_group`, `loop.command`), the Archon Studio builder preview, and a large security + reliability batch spanning gates, providers, Windows, Docker, and the console.

### Added

- **Folder projects** — register non-git workspaces and multi-repo roots as projects; they run in place with named `_folder/<slug>/` storage. Non-git local paths auto-register instead of erroring. (#2055)
- **Container isolation for folder projects (opt-in, Docker)** — kind-routed backend seam, per-run overlay containers, pause/resume, and approval-gated write-back to the live root; bundled e2e smoke workflow + CI job. Zero impact unless enabled. (#2145, #2153, #2160, #2158, #2161)
- **`include:` workflow primitive** — load-time inlining of another workflow's nodes as a flattened, namespaced sub-DAG. (#2129)
- **`loop_group:` node** — repeat a multi-node sub-DAG until a signal, `until_bash`, or `max_iterations`. (#2032)
- **`loop.command:`** — loop nodes can load their per-iteration prompt from a command file (exactly-one-of with inline `prompt:`), with the body snapshotted per run so pause-time file edits can't change a running loop. (#1759, #1789)
- **Archon Studio visual workflow builder (preview, PR-2)** on the console. (#2015)
- **Per-user default chat model** — `default_model` per user, written atomically with the provider; `archon ai default <provider> [<model>]` CLI + console support, plus a default-chat-model step in `archon setup`. (#2082, #2087)
- **Cross-invocation artifact scope + cold-resume pointer recovery** — resumed runs can locate prior-invocation artifacts by reference. (#2081)
- Portable per-node Pi extension posture in workflow YAML, and planning-mode extensions no longer leak into non-planner nodes. (#2144, #2124)
- `archon doctor` now checks the Codex binary and the OpenCode embedded runtime. (#2151)
- Base branch falls back to the codebase default branch when auto-detection fails; CLI run-addressing commands accept short run-id prefixes. (#2092, #2109)
- Workflow language constitution (design charter for the YAML surface) and a provider capability matrix generated from the runtime capability constants. (#2128, #2171)

### Security

- **Script nodes receive user-controlled variables via the subprocess environment instead of source splicing.** `$ARGUMENTS`, `$USER_MESSAGE`, `$CONTEXT`, `$LOOP_*`, and `$REJECTION_REASON` are no longer interpolated into executable script source — read them via `process.env.X` (bun) / `os.environ['X']` (python). Custom workflows referencing them in script bodies get an empty value plus a one-release migration warning. `$nodeId.output` refs are unchanged. (#2168)
- **Compiled binaries embed the web-dist tarball hash at build time**, so `archon serve` verifies downloads against a hash a compromised release cannot alter; dev installs keep the remote-checksum path. (#1246, #1251)
- Duplicate GitHub webhook deliveries are dropped at ingest (bounded dedup keyed on delivery identity), preventing double workflow runs from redeliveries and dual subscriptions. (#1951, #1987)
- Artifact API routes validate project names through the shared `parseOwnerRepo` helper (defense-in-depth against traversal shapes). (#1243)

### Changed

- **Session/usage-limit errors are FATAL — never retried.** A run hitting "Claude session limit reached" fails on the first occurrence with the reset time in the error instead of burning its retry budget inside the same quota window; chat surfaces an actionable "AI usage limit reached (resets …)" message instead of suggesting `/reset`. (#2181, #1761)
- **`CLAUDE_API_KEY` is mirrored to `ANTHROPIC_API_KEY`** for the Claude subprocess. Note: a host using subscription login that also carries a stray `CLAUDE_API_KEY` in `.env` now bills to that key — explicit `ANTHROPIC_API_KEY`, OAuth tokens, and per-user credentials still win. (#1941)
- Interactive-loop gates: `signal_completes`, finalize-on-bare-approve, honest agent-steerable gate semantics, and cross-gate session continuity restored. (#2126, #2046, #2074)
- Strict structured-output refs: `$node.output.field` on unknown nodes or undeclared fields fails loudly (including `$LOOP_PREV` refs and after resume). (#2143, #2165, #2093)
- Codex SDK 0.144.5 with GPT-5.6 support; Claude Agent SDK 0.3.209; Pi 0.80.6; stale GPT model references swept to the 5.6 lineup. (#2162, #2105, #2149)

### Fixed

- **Windows reliability:** mid-run deaths stopped (system keep-awake + a real detaching `--detach`), and `bash`/`until_bash` resolve the Git-Bash binary correctly instead of the WSL launcher (with `ARCHON_BASH_PATH` override). (#2063, #1326, #1808, #1779)
- **Docker:** image builds and container starts no longer spend 20–50 minutes in recursive `chown`; ownership is fixed only where wrong. (#1943, #1970, #1981)
- **Console:** run detail now shows chat-dispatched runs' messages (previously "0 messages" for every chat-started run); timestamps render in the viewer's local timezone; model picker no longer truncates model names; abandoned in-flight loads resubscribe correctly; store cache released on last unsubscribe. (#2048, #2188, #1990, #2189, #2031, #2187, #2101, #2148, #1933, #1938)
- **Approval-gate integrity:** approve/reject double-resolution closed with a compare-and-swap; gate rejection keeps runs paused instead of staging a fake `failed`; CLI `workflow approve` no longer marks paused runs failed on process exit; WebUI-dispatched runs honor `worktree.enabled: false`. (#2113, #2146, #2112, #1123, #2191, #1368, #2192)
- Claude API errors surfaced as text now fail the node instead of completing it; transient "tool use concurrency" 400s retry as rate limits (narrowly scoped, policy documented in `UNTYPED_TRANSIENT_PATTERNS`). (#2125, #1341, #2175)
- Pi provider: `text_delta` chunks coalesce (no more fragmented output), the Bedrock backend loads in compiled binaries, and extension-registered models resolve on later DAG nodes. (#2173, #2174, #2111)
- Conversation titles generate with the `small` tier instead of a hardcoded Codex model that 400s on ChatGPT-plan accounts. (#1855, #2190)
- Workflows stored as `.yml` resolve on the by-name GET/DELETE routes (deleting removes both extension twins); namespaced workflow names (`dir/name`) work over the HTTP launch/read routes; conversation IDs containing `/`/`#` URL-encode in PATCH/DELETE. (#1711, #2007, #2047, #1657)
- `retry:` is honored on bash/script nodes; loop nodes wait for live background Agent tasks, keep a full audit trail, and check cancellation mid-stream; `loop_group` body lifecycle events are namespaced. (#2088, #2096, #2134, #2136, #2090, #2098)
- Skill validation uses the same search roots as the execution resolver (no more false "skill not found" warnings); the bundled workflow-builder saves generated YAML into the live checkout instead of a throwaway worktree. (#2178, #2179, #1220, #2183)
- Marketplace auto-review no longer crashes on submissions missing `sourceUrl`/`sha`. (#1691)
- Assorted: `/setproject` binds by conversation DB id; project-scoped conversation cwd resolution; `manage_run` get on SQLite timestamps; failed runs abandonable via HTTP; resume resolves the covering codebase instead of re-registering the worktree; folder projects skip base-branch auto-detection; no-remote repos' logs/artifacts route under `_local/<basename>`; session ids no longer thread across provider boundaries; Codex receives `systemPrompt` by prompt-prepending; `requires: [github]` enforced on the CLI run path; unknown `allowed_tools`/`denied_tools` names warn at validation. (#1937, #1994, #2106, #2140, #2141, #2164, #2150, #2120, #2118, #2095, #2108)

## [0.5.0] - 2026-06-26

Per-user AI credentials (API keys + subscription OAuth) with a zero-config
encryption vault, the run-centric Console as the default UI, opt-in web login,
model tiers/aliases with per-user overrides, and broad workflow reliability work.

### Added

- **Per-user AI-provider credentials.** Connect API keys and subscriptions (Claude
  Pro/Max, ChatGPT/Codex, GitHub Copilot) per user; credentials are encrypted at
  rest and injected into the acting user's runs/chat at execution time. Vendor-
  canonical credential catalog derived from provider registrations, per-agent
  credential cards in the console, and an Archon-owned PKCE flow for ChatGPT/Codex
  subscription login (#1899, #1911, #1921, #1958, #1962, #1973).
- **Zero-config credential vault.** The credential vault now works out of the box —
  an encryption key is auto-provisioned at `~/.archon/credential-key` (0600) when
  `TOKEN_ENCRYPTION_KEY` isn't set, so `archon ai login`/`ai key set` work on a
  plain CLI/SQLite install. Additive: an unconnected user's ambient API keys are
  untouched (#2040).
- **Console is the default UI.** The run-centric console replaces the classic UI
  (re-rooted under `/legacy`): chat restyle, run provenance, workflow-completion
  cards, per-node cost/turns, agent-aware model pickers, settings panels, GitHub
  identity panel, and chat file uploads (#1915, #1819, #1881, #1885, #1890, #1896,
  #1903, #1907, #1916, #1964).
- **Opt-in web login** via Better Auth (PostgreSQL) with a user-identity seam, a
  server-side API gate, and safe-by-default signup posture; per-user GitHub
  identity via device flow (#1841, #1823).
- **Model tiers, aliases, and per-user AI preferences.** `small`/`medium`/`large`
  tiers and `@custom` aliases resolve provider+model+options across providers;
  per-user tiers/aliases/default-assistant overrides; an AI Settings UI and full
  `archon ai tier|alias|default` CLI parity (#1867, #1873, #1926, #1948).
- **CLI tier transparency.** Workflow run output now shows each AI node's resolved
  `provider/model (← tier)`, plus a one-time notice when a run uses tiers you
  haven't configured (#2038).
- **Cross-provider run management** from the CLI — `workflow get/runs --json`,
  `--detach`, a `manage-run` skill, and a native `manage_run` tool for Claude/Pi;
  live console updates for out-of-process (CLI) runs via a DB-tail poller +
  Postgres LISTEN/NOTIFY (#1853, #1861).
- **Workflow engine:** typed artifacts (`output_type` sidecars), reliable
  cross-provider structured output (validate + repair + reask + fail-fast),
  per-node provider session persistence (`persist_session`), recommended workflows
  pinned per project, and a model-alias resolver wired into execution (#1851,
  #1883, #1889, #1790, #1929).
- **`/setproject`** command to bind a conversation to a registered codebase (#1917).
- **Session-resume outcome** (`resumed`) surfaced with a warning on cold resume
  (#1842); **unpushed work** in `source/` surfaced after chat turns (#1978); SDK
  lifecycle events (tasks + hooks) forwarded to the Web UI (#975).
- **Anonymous telemetry** schema v3/v4: server heartbeat, chat turns, failure
  taxonomy, activation funnel, and usage totals (tokens/cost) (#1944, #1949).
- **Archon Studio** builder data model + node variants (PR-1) and a marketing
  landing page above the docs site (#1870, #1829).

### Changed

- **Bumped `@anthropic-ai/claude-agent-sdk` to 0.3.193** (#2037) and migrated the
  Pi SDK to `@earendil-works` (#1800); standardized on zod v4 (#1813).
- PostgreSQL schema is auto-applied on startup; workspace sync is now
  non-destructive by default (#1810, #1864).
- `DEFAULT_AI_ASSISTANT` is treated as a fallback default, not a hard override
  (#1919).

### Fixed

- DAG nodes no longer silently complete when `idle_timeout` fires before any
  output — they fail with a clear, actionable error (#1807, #1812).
- Direct chat now resolves credentials from the message sender and delivers Claude
  subscriptions to Pi in chat; clarified Claude auth posture on per-user installs
  (#1982, #1984, #2002).
- Concurrency-safe workflow resume/cancel (CAS guards); Codex session resume
  captures the thread id; the loader stops dropping workflow-level
  effort/thinking/fallbackModel/betas/sandbox (#1830, #1840, #1799).
- SQLite parity for `remote_agent_user_ai_prefs`; the Pi extension loader is
  reused per process to stop 2nd-session hangs (#2033, #1877).

### Removed

- The stale `CLAUDECODE=1` nested-session warning and the
  `ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING` env var — running the CLI inside a
  coding agent is a supported, normal path now (#2039).

## [0.4.1] - 2026-05-28

Hotfix for the v0.4.0 upgrade path.

### Fixed

- **Upgrading from v0.3.x to v0.4.0 left every operation broken with `Error: no such column: user_id`.** The v0.4.0 SQLite schema initializer (`createSchema()`) added two `CREATE INDEX` statements referencing `user_id` on `conversations` and `workflow_runs`, but the columns themselves are added by `migrateColumns()` — which runs after `createSchema()`. On any database created before v0.4.0, `CREATE INDEX` aborted the entire init block, the `SqliteAdapter` constructor threw, and every subsequent DB call failed. New users with a fresh `~/.archon/archon.db` were unaffected because the columns are present from table creation. The fix moves both index creations into `migrateColumns()` so they run after the matching `ALTER TABLE`. A regression test seeds a pre-v0.4.0 schema and asserts the upgrade path now completes cleanly (#1792).

## [0.4.0] - 2026-05-28

GitHub App auth for the bot, multi-user attribution, Slack UX overhaul, experimental `/console`, two new community providers (OpenCode and GitHub Copilot), Codex MCP support, and broad workflow/provider hardening.

### Added

- **GitHub App authentication for the bot**: replaces the shared `GITHUB_TOKEN` PAT with a GitHub App + multi-installation routing. Each repo resolves to the installation that owns it; tokens are minted on demand, cached per installation, refreshed before expiry, and never persisted. Includes a loopback-only `/internal/git-credential` endpoint (with a hard `127.0.0.1` bind check, opt-out via `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1`) so long-running workflow `git` operations can transparently refresh installation tokens via a `git-credential-archon` helper installed into the worktree's `.git/config` (#1788).
- **Per-user attribution**: `user_id` is now plumbed from chat and forge adapters through the orchestrator into `conversations`, `messages`, `workflow_runs`, and `isolation_environments`. New `users` and `user_identities` tables map platform identities (Slack U-id, Telegram chat id, Discord snowflake, GitHub login) to an Archon-internal user, created lazily on first sight (#1783).
- **Slack UX upgrade**: interactive buttons, status reactions, and native slash commands replace the previous text-only flow. Approval gates, run status, and errors are now surfaced through Slack's UI primitives (#1757).
- **Experimental run-centric console UI** at `/console`, mounted as an isolated in-repo spike under `packages/web/src/experiments/console/`. Lint-guarded against importing production web modules so it can be dropped in or deleted cleanly (#1747).
- **`assistants.opencode` provider**: community provider that runs OpenCode as an embedded runtime, with per-node agent materialization, multi-agent sessions, structured output, token usage, and multi-agent MCP tool execution (#1384).
- **GitHub Copilot community provider**: registered as a `builtIn: false` provider in the registry (#1505).
- **Codex MCP nodes**: MCP server support for Codex workflow nodes via the shared `loadMcpConfig` module — pass `mcp: <path>` on a Codex node and the config is translated to Codex's `mcp_servers` overrides at runtime. MCP client errors are surfaced to the workflow author as `system` chunks when MCP is explicitly configured for the node (#1459).
- **`always_run` node opt-out for resume caching**: opt-out for nodes that must re-execute on every resume rather than being skipped as "already completed" (closes #1391, #1730).
- **Pi deferred extension model resolution** so Pi workflows can reference models that are only available after extension loading (#1509).
- **Brand foundation page** at https://archon.diy/brand/, sourced from `packages/docs-web/src/content/docs/brand/` (#1745).
- **New marketplace workflows**: `piv-system-evolution` and `archon-comprehensive-mr-review`.

### Changed

- **Streaming chat continuity**: typing indicators and message boundaries are more readable; rapid successive chunks no longer fragment visually (#1617).
- **Web chat bubbles** wrap long unbreakable strings instead of overflowing (fixes #1738, #1742).
- **Web DAG builder** recognizes `loop` and `approval` node types and renders them correctly (#1744).
- **Web execution graph** surfaces workflow-definition fetch errors instead of silently rendering an empty graph (#1683, #1698).
- **Web copy-message button** handles clipboard failures gracefully (#1564).
- **Telegramify-markdown** bumped to 1.3.3 for correct blockquote escaping (#1340).
- **Webhook clones** are placed in the workspace `source/` subdirectory to match the standard workspace layout (#1554).
- **Global workflows** are now editable through the Web UI builder (#1557).
- **`safeSendMessage`** consolidated into `executor-shared` to remove duplication across executor variants (#1496).
- **Direction docs**: community-providers policy section added (#1736).

### Fixed

- **`workflow approve/resume/reject` no longer fail with "Workflow not found" when the run's working path is a worktree or workspace clone.** Resume, approve, and reject now use `codebase.default_cwd` for workflow YAML discovery, falling back to `working_path` when no codebase record is found. Fixes #1663 (#1743).
- **Resume interactive workflows on chat platforms**: previously failed because the resume code path assumed web; now works for Slack and Telegram (#1756).
- **Web approve/reject responses** surface the CLI resume command so users can copy it directly instead of having to look it up (#1523).
- **`DEFAULT_AI_ASSISTANT`** is now read in `createCodebase` so the env var actually controls the default assistant for newly registered codebases (fixes #1703, #1746).
- **Marketplace `decide` node** hardened against non-JSON ai-review output so a prose-prefixed verdict doesn't crash the workflow.
- **MCP config env vars** now expand `${VAR_NAME}` brace syntax in addition to `$VAR_NAME` (#1728).
- **`archon-refactor-safely`** persists read-only node outputs via bash bridges so downstream nodes can reference them (#1734).
- **Workflow builder** injects `$ARGUMENTS` into generated YAMLs so user arguments reach the first node (#1733).
- **Codex provider**: removed stale `attemptController.abort()` that crashed after SDK cleanup (#1735, #1739); fresh `AbortController` per retry attempt so a previously-aborted controller can't kill the new attempt (#1266, #1371).
- **Claude provider** rejects directory paths in `claudeBinaryPath` and expands npm platform-package directories (e.g. `@anthropic-ai/claude-code-darwin-arm64`) to the bundled binary (#1723, #1737).
- **Default assistant resolution**: now consults config + per-folder detection on every codebase registration, not just the first (#1729).
- **Large node outputs** are written to a temp file and referenced rather than inlined into bash substitution, preventing argument-list corruption on big payloads (fixes #1717, #1718).
- **Forge clone auth** resolves credentials via configured `*_URL` env vars rather than assuming `github.com` (fixes #1704, #1706); non-GitHub forge URLs authenticate via `GITLAB_TOKEN` / `GITEA_TOKEN` (fixes #1655, #1658).
- **DAG multi-resume**: completed node state is now preserved across multiple resume cycles instead of being recomputed (#1530).
- **Bash node variables**: user-controlled variables are passed via env vars, not shell substitution, to avoid quoting bugs and injection edge cases (#1651).
- **Scripts**: `ARCHON_STATE_JSON` marker extraction uses line-anchored regex so embedded marker-like strings in script output don't confuse the parser (#1695).
- **Workflows**: `condition_json_parse_failed` is now surfaced as a workflow error instead of silently skipping the conditional branch (#1673, #1694).

## [0.3.12] - 2026-05-14

Orchestrator prompt-cache fix, SDK termination edge cases, marketplace expansion, and broad workflow fixes.

### Added

- **New marketplace workflow `archon-idea-to-wo`**: interactive 8-node workflow that turns a raw idea into BKM-format Work Orders through four AI phases with approval gates between each. Authored by @lamachine, published via the community marketplace registry (closes #1647).

### Changed

- `maintainer-review-pr`: dropped the direction/scope gate node. The gate used Pi/Minimax to return a structured JSON verdict that the DAG branched on, but Pi intermittently wrapped the JSON in markdown fences or preamble prose, silently skipping every downstream review. In practice the gate returned "review" on every hand-picked PR (13/13 runs over two days), adding no signal. Workflow now reviews all PRs directly (#1675).

### Fixed

- **Claude `stop_sequence` terminations no longer fail as "SDK returned success"**: the Claude Agent SDK's `SDKResultSuccess` declares `is_error: boolean` (not literal `false`), and stop-sequence terminations carry `is_error: true` alongside `subtype: 'success'` — its encoding of "non-default termination, not a failure". The Claude provider now normalises this pair to a clean success at the provider boundary, with defense-in-depth guards in `dag-executor` (main + loop branches) and `orchestrator-agent` (direct chat) so a third-party `IAgentProvider` forwarding the raw SDK pair can't reintroduce the bug. Workflows using `output_format` (which implies a stop sequence) — including the `archon-fix-github-issue` `classify` → `synthesize` pipeline — now complete cleanly instead of throwing `Node 'X' failed: SDK returned success`. Closes #1425 (#1662).
- **Orchestrator prompt caching restored**: static system context (projects, workflows, routing rules) was embedded in the per-turn `prompt`, forcing the Anthropic API to rebuild the cache prefix on every request (high `cache_creation_input_tokens`, zero `cache_read_input_tokens`). Moved into `systemPrompt.append`, which extends the Claude Code preset and is part of the cacheable system prefix. Fixes #1591 (#1634).
- **Native Claude tools no longer stripped when `skills:` is set without `allowed_tools:`**: the AgentDefinition wrapper previously defaulted `tools` to `['Skill']` only, removing Read/Bash/Write/etc. Now omits `tools` when not explicitly set, letting the SDK provide its full default tool set; `Skill` is still appended when `allowed_tools` is explicit (#1605, #1661).
- **SSH repo URLs from non-GitHub hosts**: the SSH-to-HTTPS converter only matched `git@github.com:` literally, so custom SSH host aliases, GitHub Enterprise, Gitea, GitLab, and Bitbucket SSH URLs produced workspace paths containing literal `git@<host>:` segments — `ENOTDIR` on Windows, malformed owner extraction on Unix. Now uses a generic `git@([^:]+):(.+)` regex at both call sites. Closes #1614 (#1656).
- **`$node.output.field` for Pi/Minimax structured output**: provider-parsed fence-wrapped or preamble-prefixed JSON was captured locally but never persisted onto `NodeOutput`. Downstream `substituteNodeOutputRefs` and `condition-evaluator` consumers then `JSON.parse`d the original prose-prefixed text, threw, and resolved `$node.output.field` to empty. `structuredOutput` is now persisted on `NodeOutput` (single-shot + loop-terminal-iteration success paths) and both consumers prefer the parsed object. Closes #1571 (#1654).
- **Marketplace auto-review CI**: workflow now triggers on `ready_for_review` (was missed by default `pull_request_target` event list); `gh pr review --approve` falls back to `gh pr comment` when GitHub Actions lacks approve permission, so PR authors still receive the review even without "Allow GitHub Actions to create and approve pull requests" enabled.

## [0.3.11] - 2026-05-12

Workflow marketplace, expanded setup wizard, and broad Pi/workflow engine fixes.

### Added

- **Workflow marketplace v0**: browse and install community workflows via `archon workflow search [query]` and `archon workflow install <slug>` (#1624). Includes an automated marketplace PR review-and-merge workflow that runs schema validation, security scanning, and AI review on submissions (#1638), plus a `video-generic` entry as the first published workflow.
- **`archon setup` overhaul**: full interactive credential and config wizard, plus `archon doctor` to verify Claude binary, gh auth, DB, and adapters end-to-end (#1566). Pi is now a first-class provider option in the wizard (#1609).
- **`archon skill install`**: install the bundled Archon skill into `.claude/skills/archon` from the CLI without needing the source tree (#1445).
- **Pi/Minimax variants** of the maintainer workflows: `repo-triage-minimax` (#1562) joins `maintainer-standup-minimax` for daily triage when nested-Claude-Code sessions block the Claude variants.
- **Public roadmap page** at `/roadmap` on the docs site (#1570).
- Docker: `/home/appuser` is now persisted by default via the `archon_user_home` named volume, so user-installed Claude Code skills/commands/agents/hooks, Codex/Pi auth, `~/.gitconfig`, and shell history survive container rebuilds. Set `ARCHON_USER_HOME=/host/path` in `.env` to bind-mount a host path instead (#1517, #1518).

### Changed

- Claude provider default `settingSources` changed from `['project']` to `['project', 'user']`, so skills, commands, agents, and `CLAUDE.md` from `~/.claude/` are now loaded by default in all environments — not just Docker. Without this, the new `/home/appuser` persistence would not actually surface user-installed Claude resources. Set `assistants.claude.settingSources: ['project']` in `.archon/config.yaml` to restore the previous project-only behavior (#1518).
- `.env.example`, `docker-compose.yml`, `deploy/docker-compose.yml`, and `reference/configuration.md` now document that `ARCHON_HOME` is silently overridden inside Docker and `ARCHON_DATA` is a Compose-only host token never read by source. The Docker entrypoint emits a one-line stderr warning when either is set in the container env (#1517).
- Bump `hono` to ^4.12.16 and `@hono/node-server` to ^1.19.13 (closes #1484, #1499).
- Pi provider now loads user settings files (`~/.pi/agent/auth.json` etc.) as the session baseline (#1559).

### Fixed

- **Resume is now explicit**: `archon workflow run` no longer silently auto-resumes the previous failed run for the same `(workflow_name, cwd)` pair. The implicit `findResumableRun` call inside `executeWorkflow` was the cause of cross-invocation state leaks — completed-node outputs from a prior failed run would bleed into the next invocation of the same workflow at the same path. Use `archon workflow run --resume`, `archon workflow resume <id>`, or the web UI resume button to opt in. `executeWorkflow`'s trailing positional args are consolidated into an options bag and a new `prepareResumedRun` / `hydrateResumableRun` pair handles resume preparation at call sites. Closes #1392 (#1646).
- **Pi multi-chunk slash commands**: Pi agent can now successfully use `/invoke-workflow` and `/register-project` when the assistant streams the command across multiple chunks. The orchestrator continues accumulating assistant text past prefix detection until the full command is parsed (#1581).
- **Pi concurrency + error surfacing**: SDK error messages now surface to the user instead of being masked, and Pi concurrency is capped to prevent cascade failures (#1572).
- Chat hydration shows newest messages instead of oldest (#1532).
- `GET /api/workflows/:name` now resolves home-scoped (`~/.archon/workflows/`) workflows that were previously invisible to the Web UI builder (#1405).
- `GET /api/workflows` no longer returns an empty array when no `cwd` query param is provided and no codebases are registered — bundled and home-scoped workflows now surface correctly on first run, making the workflow picker functional on first launch before any project is registered (#1173).
- `archon workflow run` propagates `$ARTIFACTS_DIR`, `$LOG_DIR`, `$BASE_BRANCH` to script-node subprocesses (#1640).
- `archon-assist` now runs in the live checkout (`worktree.enabled: false`) — closes #1546 (#1555).
- Bundled `opus[1m]` implement nodes now set `provider: claude` explicitly (#1622).
- DAG executor no longer leaves zombie workflow runs behind when Pi cleanup hangs (#1563).
- Workflow runs no longer sweep scratch artifacts from `git add -A` sites in the live checkout (#1506).
- `$nodeId.output` substitution stringifies array/object fields as JSON (#1482).
- `archon doctor` and `archon setup` no longer interleave `[archon] loaded N keys` boot lines and Pino info JSON with their checklist output. Set `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL=debug` to restore the boot lines; pass `--verbose` to re-enable structured Pino logs for those commands (#1608).
- `archon --version`, `-V`, `-version`, and lone `-v` are now all treated as version requests (#1444).
- Docker: resolve Claude binary to the glibc variant on Debian images (#1521).
- Docker: `git config --global --add safe.directory` in the entrypoint now de-duplicates entries before adding, preventing unbounded growth of `~/.gitconfig` now that `/home/appuser` is persisted (#1518).
- Docker: `setup-auth` now warns at startup when `CODEX_*` env vars are absent but a persisted `~/.codex/auth.json` from a previous run still exists, so operators don't accidentally use stale or revoked credentials (#1518).
- Orchestrator creates `~/.archon/workspaces` before spawning an AI provider (#1529).
- Marketplace auto-review pipeline hardening: pin glibc Claude binary in CI and handle multi-line diff values (#1641), import `@archon/workflows/loader` by relative path (#1642), validate-schema exits 0 so decide can route invalid submissions (#1643), silence loader Pino logs (#1644), and only validate workflow-shaped YAMLs while registering providers (#1645).

## [0.3.10] - 2026-04-29

Maintainer workflow suite, loop output variables, and broad workflow engine fixes

### Added

- Bundled maintainer workflow suite: `maintainer-standup` for daily PR/issue triage (#1428), contributor-reply surfacing (#1457), `maintainer-review-pr` for automated code review (#1430), cross-workflow review memory (#1458), and a Pi/Minimax variant of standup (#1480).
- `$LOOP_PREV_OUTPUT` substitution variable in loop node prompts, giving each iteration access to the cleaned output of the previous pass (#1367).
- `mutates_checkout` flag on workflow nodes to permit concurrent runs against a live checkout without requiring worktree isolation (#1438).
- Explicit `tags` field in workflow YAML for categorization and filtering (#1190).
- Pi provider `ModelRegistry` support for custom model slugs and automatic auth bypass for unmapped providers (#1284).
- Autodetection of canonical Claude and Codex binary install paths so explicit config is not required on standard installations (#1361).

### Changed

- Model validation delegated entirely to provider SDKs; Archon no longer rejects unknown model strings at workflow load time, so new vendor models work immediately without an Archon update (#1463).
- Claude Agent SDK updated to 0.2.121 and Codex SDK to 0.125.0 (#1460).
- Default Opus model pin switched to the `opus[1m]` alias (#1395).

### Fixed

- PR-creating workflows now correctly target `$BASE_BRANCH` instead of a hardcoded branch name (#1479).
- Markdown code blocks inside `$nodeId.output` values no longer trigger false DAG validation errors (#1478).
- `CLAUDE_BIN_PATH` environment variable now honoured in dev mode on hosts with libc mismatches (#1481).
- Orchestrator clears stale session IDs on `error_during_execution` to prevent infinite failure loops (#1294).
- Bash and script node failure messages shortened and made more actionable (#1393).
- Pi provider structured-output parser now tolerates prose preamble before the JSON payload (#1440).
- Docker bind-mount restarts now register `safe.directory` for all repos, not only the primary one (#1307).
- CLI commands such as `--version` and `--help` no longer crash when bundled skill source files are absent (#1394).
- `--no-env-file` flag no longer incorrectly passed to the native Claude binary in dev mode (#1461).
- `$nodeId.output` references now substituted correctly inside approval gate messages (#1426).
- `ARTIFACTS_DIR`, `LOG_DIR`, and `BASE_BRANCH` now exported into bash node subprocess environments (#1387).
- Approval gate no longer bypassed after a reject-with-redraft on workflow resume (#1435).
- Discord login failure now contained so it does not crash the server process (#1365).
- Pi provider package-directory shim installed in compiled binary so Pi workflows run correctly outside a source checkout (#1360).

### Added

- **`$LOOP_PREV_OUTPUT` workflow variable (loop nodes only)** — exposes the previous iteration's cleaned output (after `<promise>` tag stripping) to the current iteration's prompt. Empty on the first iteration and on the first iteration after resuming from an interactive approval gate. Enables `fresh_context: true` loops to reference what the prior pass said or did without carrying full session history. (#1367)

### Changed

- **Provider/model resolution: trust the SDK, drop allow-lists.** Removed `inferProviderFromModel` and `isModelCompatible` entirely. Provider is now resolved via a flat explicit chain — `node.provider ?? workflow.provider ?? config.assistant` — and never inferred from the model string. Model strings pass through to the SDK unchanged; the SDK validates them at request time. Codex's stream loop now matches Claude's contract (every terminal close emits exactly one `result` chunk; `error` events without a recovering `turn.completed` synthesize `result.isError` with subtype `codex_stream_incomplete`; `turn.failed` becomes `codex_turn_failed`). AI nodes that exit the streaming loop with empty assistant text and no structured output now fail loudly with `dag.node_empty_output` instead of completing as silent zero-output successes. Provider-id typos (workflow-level and per-node) are caught at YAML load time. **Migration**: workflows that previously relied on cross-provider model inference (e.g. `model: gpt-5.2-codex` with no `provider:`, expecting Archon to pick `codex` because Claude's allow-list rejected the string) must now set `provider:` explicitly. Workflows that already set both `provider:` and `model:` — and workflows that set only `model:` matching `config.assistant` — keep working unchanged. (#1463)

### Fixed

- **Bash and script node failures no longer leak the inline script body into user-visible errors and logs.** When a `bash:` or `script:` DAG node failed, the error string interpolated `err.message` from Node's `ExecFileException`, which begins with `Command failed: bash -c <body>` (or `bun -e <body>`) — embedding the entire substituted script body. Pino's default error serializer compounded this by writing `err.message`, `err.stack`, and `err.cmd` separately, producing three copies of the body per failure across the CLI, Web UI, and `node_failed` event payload. Diagnostic output (e.g. `Expected ")" but found "x" at [eval]:4:241`) was buried at the end. A new `formatSubprocessFailure()` helper now strips the `Command failed:` prefix line, prefers `stderr` over the message body, tail-caps at 2 KB, and exposes a controlled `{exitCode, killed, stderrTail}` log subset — never the raw error. Timeout / ENOENT / EACCES branches now also log through the sanitized helper, so the body cannot leak via the timeout path either. (#1389)
- **Claude provider crashed in dev mode with `error: unknown option '--no-env-file'`.** The Claude Agent SDK switched from shipping `cli.js` to per-platform native binaries (via optional deps) in the 0.2.x series. Archon's `shouldPassNoEnvFile` predicate kept emitting the Bun-only `--no-env-file` flag in dev mode (when the SDK resolves its bundled binary), which the native binary rejects. Tightened the predicate to only emit the flag for explicitly-configured Bun-runnable JS entry points (`.js`/`.mjs`/`.cjs`). Target-repo `.env` isolation is unchanged — `stripCwdEnv()` at process boot remains the primary guard, and the native Claude binary does not auto-load `.env` from its cwd. (#1461)
- **Pi structured-output now tolerates reasoning-model prose preamble.** `tryParseStructuredOutput` previously returned `undefined` whenever the assistant text wasn't pure JSON, even when the JSON object was clearly emitted at the end of a "Let me evaluate..." preamble. Reasoning models — observed on Minimax M2.7 — routinely "think out loud" before emitting structured output despite explicit JSON-only prompts. The parser now falls back to a forward-scan from the first `{` when the clean parse fails, recovering the structured output without changing the success path for fully compliant models. (#1440)
- **`CLAUDE_BIN_PATH` is now honored in dev mode.** Previously the env var was silently ignored when running from source (`BUNDLED_IS_BINARY=false`) — `resolveClaudeBinaryPath()` early-returned `undefined` before reading it, leaving glibc Linux contributors with no working escape hatch when the Claude SDK's bundled-binary auto-resolution picked the musl variant first. The env-var check now runs in both modes; config-file path (`assistants.claude.claudeBinaryPath`) remains binary-mode-only since it's a per-repo, not per-machine setting. Env-loading and target-repo `.env` isolation are unchanged — same `stripCwdEnv()` boot-time guard and same `shouldPassNoEnvFile()` predicate run downstream. (#1481)

## [0.3.9] - 2026-04-22

First release with working compiled binaries since v0.3.6. Both v0.3.7 and v0.3.8 were tagged but neither shipped release assets — v0.3.7 was blocked by two genuine binary-runtime bugs (Pi SDK's module-init crash + Bun `--bytecode` producing broken output), and v0.3.8 was blocked by an unrelated CI smoke-test regression where `release.yml`'s Claude resolver test required an `origin` remote that the fresh `git init` test repo didn't have. Both superseded tags remain for history; their GitHub Releases were deleted at the time of tagging so `releases/latest` fell back to v0.3.6 throughout, keeping `install.sh` and Homebrew safe. v0.3.9 is what users actually install.

### Fixed

- **Release binary smoke test no longer fails on the fresh `git init` test repo.** The Claude resolver smoke in `release.yml` ran `archon workflow run archon-assist` against a tempdir with no `origin` remote; as of #1310's worktree auto-sync logic this fails with "neither origin/HEAD nor origin/main exist" before the resolver is reached, so the CI assertion (`"Claude Code not found"` in output) never matched and the linux-x64 build aborted — taking the entire release matrix down via fail-fast. Adding `--no-worktree` to both the negative and positive resolver tests skips isolation, which is what the tests actually want: they exercise the Claude resolver path, not worktree setup. (#1357)

## [0.3.8] - 2026-04-22

Tagged but never released. Intended as the hotfix for v0.3.7's binary-runtime crashes; the code fixes shipped in v0.3.9 actually originated here (Pi SDK module-init lazy-load, Bun `--bytecode` removal). v0.3.8's own release CI aborted on an unrelated smoke-test assertion in `release.yml` and no binaries were uploaded. The GitHub Release was deleted; the tag remains for history. See v0.3.9 for the release users actually install.

### Fixed

- **Compiled archon binaries no longer crash at startup when the Pi provider is bundled.** `@mariozechner/pi-coding-agent/dist/config.js` runs `readFileSync(getPackageJsonPath(), 'utf-8')` at module top-level, which inside a compiled binary resolves to `dirname(process.execPath) + '/package.json'` — a path that doesn't exist next to `/usr/local/bin/archon`, making every archon command (including `archon version`) crash with ENOENT before it ran. The Pi SDK and all Pi-dependent helper modules are now dynamically imported inside `PiProvider.sendQuery()`; registering Pi and instantiating the provider no longer touches Pi's module-init side effects. A regression test (`provider-lazy-load.test.ts`) walks the same `registerCommunityProviders()` + `getAgentProvider('pi')` path the CLI and server take and asserts neither SDK package was resolved. Claude and Codex providers keep their static import style — their SDKs have no equivalent module-init side effect. Unblocks the v0.3.7 release binaries that could not ship because of this bug. (#1355)
- **Release binary compile no longer silently produces broken bytecode.** `scripts/build-binaries.sh` dropped the `--bytecode` flag: Bun 1.3.11's bytecode step failed with `Failed to generate bytecode for ./cli.js` against the 0.3.7 module graph and fell through to producing a binary that crashed at module instantiation with "Expected CommonJS module to have a function wrapper". Windows was already excluded; this removes the flag everywhere. Release parity preserved via `--minify`. (#1354)

## [0.3.7] - 2026-04-22

Pi community provider, home-scoped workflows/commands/scripts, worktree policy, Web UI approval-gate auto-resume, three-path env model, and a breaking change to Claude Code binary resolution for compiled binary users.

### Added

- **Pi community provider (`@mariozechner/pi-coding-agent`).** First community provider under the Phase 2 registry (`builtIn: false`). One adapter exposes ~20 LLM backends (Anthropic, OpenAI, Google, Groq, Mistral, Cerebras, xAI, OpenRouter, Hugging Face, and more) via a `<pi-provider-id>/<model-id>` model format. Reads credentials from `~/.pi/agent/auth.json` (populated by running `pi /login` for OAuth subscriptions like Claude Pro/Max, ChatGPT Plus, GitHub Copilot) AND from env vars (env vars take priority per-request). Per-node workflow options supported: `effort`/`thinking` → Pi `thinkingLevel`; `allowed_tools`/`denied_tools` → filter Pi's 7 built-in coding tools; `skills` → resolved against `.agents/skills`, `.claude/skills` (project + user-global); `systemPrompt`; codebase env vars; session resume via `sessionId` round-trip. Unsupported fields (MCP, hooks, structured output, cost limits, fallback model, sandbox) trigger an explicit dag-executor warning rather than silently dropping. Use in workflow YAML: `provider: pi` + `model: anthropic/claude-haiku-4-5`. (#1270)
- **Inline sub-agent definitions on DAG nodes (`agents:`).** Define Claude Agent SDK `AgentDefinition`s directly in workflow YAML, keyed by kebab-case agent ID. The main agent can spawn them in parallel via the `Task` tool — useful for map-reduce patterns where a cheap model (e.g. Haiku) briefs items and a stronger model reduces. Removes the need to author `.claude/agents/*.md` files for workflow-scoped helpers. Claude only; Codex and community providers that don't support inline agents emit a capability warning and ignore the field. Merges with the internal `dag-node-skills` wrapper set by `skills:` on the same node — user-defined agents win on ID collision (a warning is logged). (#1276)
- **Home-scoped commands at `~/.archon/commands/`** — personal command helpers now reusable across every repo. Resolution precedence: `<repoRoot>/.archon/commands/` > `~/.archon/commands/` > bundled defaults. Surfaced in the Web UI workflow-builder node palette under a dedicated "Global (~/.archon/commands/)" section.
- **Home-scoped scripts at `~/.archon/scripts/`** — personal Bun/uv scripts now reusable across every repo. Script nodes (`script: my-helper`) resolve via `<repoRoot>/.archon/scripts/` first, then `~/.archon/scripts/`. Repo-scoped scripts with the same name override home-scoped ones silently; within a single scope, duplicate basenames across extensions still throw (unchanged from prior behavior).
- **1-level subfolder support for workflows, commands, and scripts.** Files can live one folder deep under their respective `.archon/` root (e.g. `.archon/workflows/triage/foo.yaml`) and resolve by name or filename regardless of subfolder. Matches the existing `defaults/` convention. Deeper nesting is ignored silently — see docs for the full convention.
- **`'global'` variant on `WorkflowSource`** — workflows at `~/.archon/workflows/` and commands at `~/.archon/commands/` now render with a distinct source label (no longer coerced to `'project'`). Web UI badges updated.
- **`getHomeWorkflowsPath()`, `getHomeCommandsPath()`, `getHomeScriptsPath()`, `getLegacyHomeWorkflowsPath()`** helpers in `@archon/paths`, exported for both internal discovery and external callers that want to target the home scope directly.
- **`discoverScriptsForCwd(cwd)`** in `@archon/workflows/script-discovery` — merges home-scoped + repo-scoped scripts with repo winning on name collisions. Used by the DAG executor and validator; callers no longer need to know about the two-scope shape.
- **Workflow-level worktree policy (`worktree.enabled` in workflow YAML).** A workflow can now pin whether its runs use isolation regardless of how they were invoked: `worktree.enabled: false` always runs in the live checkout (CLI `--branch` / `--from` hard-error; web/chat/orchestrator short-circuits `validateAndResolveIsolation`), `worktree.enabled: true` requires isolation (CLI `--no-worktree` hard-errors). Omit the block to let the caller decide (current default). First consumer: `.archon/workflows/repo-triage.yaml` pinned to `enabled: false` since it's read-only.
- **Per-project worktree path (`worktree.path` in `.archon/config.yaml`).** Opt-in repo-relative directory (e.g. `.worktrees`) where Archon places worktrees for that repo, instead of the default `~/.archon/workspaces/<owner>/<repo>/worktrees/`. Co-locates worktrees with the project so they appear in the IDE file tree. Validated as a safe relative path (no absolute, no `..`); malformed values fail loudly at worktree creation. Users opting in are responsible for `.gitignore`ing the directory themselves — no automatic file mutation. Credits @joelsb for surfacing the need in #1117.
- **Three-path env model with operator-visible log lines.** The CLI and server now load env vars from `~/.archon/.env` (user scope) and `<cwd>/.archon/.env` (repo scope, overrides user) at boot, both with `override: true`. A new `[archon] loaded N keys from <path>` line is emitted per source (only when N > 0). `[archon] stripped N keys from <cwd> (...)` now also prints when stripCwdEnv removes target-repo env keys, replacing the misleading `[dotenv@17.3.1] injecting env (0) from .env` preamble that always reported 0. The `quiet: true` flag suppresses dotenv's own output. (#1302)
- **`archon setup --scope home|project` and `--force` flags.** Default is `--scope home` (writes `~/.archon/.env`). `--scope project` targets `<cwd>/.archon/.env` instead. `--force` overwrites the target wholesale rather than merging; a timestamped backup is still written. (#1303)
- **Merge-only setup writes with timestamped backups.** `archon setup` now reads the existing target file, preserves non-empty values, carries user-added custom keys forward, and writes a `<target>.archon-backup-<ISO-ts>` before every rewrite. Fixes silent PostgreSQL→SQLite downgrade and silent token loss on re-run. (#1303)
- **`getArchonEnvPath()` and `getRepoArchonEnvPath(cwd)`** helpers in `@archon/paths`, plus a new `@archon/paths/env-loader` subpath exporting `loadArchonEnv(cwd)` shared by the CLI and server entry points.
- **`registerCommunityProviders()` aggregator** in `@archon/providers`. Process entrypoints (CLI, server, config-loader) now call one function to register every bundled community provider. Adding a new community provider is a single-line edit to this aggregator rather than touching each entrypoint — makes the Phase 2 "community providers are a localized addition" promise real.
- **`contributing/adding-a-community-provider.md` guide** — contributor-facing walkthrough of the Phase 2 registry pattern using Pi as the reference implementation.
- **`CLAUDE_BIN_PATH` environment variable** — highest-precedence override for the Claude Code SDK `cli.js` path (#1176)
- **`assistants.claude.claudeBinaryPath` config option** — durable config-file alternative to the env var (#1176)
- **Release-workflow Claude subprocess smoke test** — the release CI now installs Claude Code on the Linux runner and exercises the resolver + subprocess spawn, catching binary-resolution regressions before they ship

### Changed

- **Claude Code binary resolution** (breaking for compiled binary users): Archon no longer embeds the Claude Code SDK into compiled binaries. In compiled builds, you must install Claude Code separately (`curl -fsSL https://claude.ai/install.sh | bash` on macOS/Linux, `irm https://claude.ai/install.ps1 | iex` on Windows, or `npm install -g @anthropic-ai/claude-code`) and point Archon at the executable via `CLAUDE_BIN_PATH` env var or `assistants.claude.claudeBinaryPath` in `.archon/config.yaml`. The Claude Agent SDK accepts either the native compiled binary (from the curl/PowerShell installer at `~/.local/bin/claude`) or a JS `cli.js` (from the npm install). Dev mode (`bun run`) is unaffected — the SDK resolves via `node_modules` as before. The Docker image ships Claude Code pre-installed with `CLAUDE_BIN_PATH` pre-set, so `docker run` still works out of the box. Resolves silent "Module not found /Users/runner/..." failures on macOS (#1210) and Windows (#1087).
- **Home-scoped workflow location moved to `~/.archon/workflows/`** (was `~/.archon/.archon/workflows/` — a double-nested path left over from reusing the repo-relative discovery helper for home scope). The new path sits next to `~/.archon/workspaces/`, `archon.db`, and `config.yaml`, matching the rest of the `~/.archon/` convention. If Archon detects workflows at the old location, it emits a one-time WARN per process with the exact migration command: `mv ~/.archon/.archon/workflows ~/.archon/workflows && rmdir ~/.archon/.archon`. The old path is no longer read — users must migrate manually (clean cut, no deprecation window). Rollback caveat: if you downgrade after migrating, move the directory back to the old location.
- **Workflow discovery no longer takes a `globalSearchPath` option.** `discoverWorkflows()` and `discoverWorkflowsWithConfig()` now consult `~/.archon/workflows/` automatically — every caller gets home-scoped discovery for free. Previously-missed call sites in the chat command handler (`command-handler.ts`), the Web UI workflow picker (`api.ts GET /api/workflows`), and the orchestrator's single-codebase resolve path now see home-scoped workflows without needing a maintainer patch at every new call site. Closes #1136; supersedes that PR (credits @jonasvanderhaegen for surfacing the bug class).
- **Dashboard nav tab** now shows a numeric count of running workflows instead of a binary pulse dot. Reads from the existing `/api/dashboard/runs` `counts.running` field; same 10s polling interval.
- **Workflow run destructive actions** (Abandon, Cancel, Delete, Reject) now use a proper confirmation dialog matching the codebase-delete UX, replacing the browser's native `window.confirm()` popups. Each dialog includes context-appropriate copy describing what the action does to the run record.

### Fixed

- **Web UI approval gates now auto-resume.** Previously, clicking Approve or Reject on a paused workflow from the Web UI only recorded the decision — the workflow never continued, and the user had to send a follow-up chat message (or use the CLI) to resume. Three fixes: (1) orchestrator-agent now threads `parentConversationId` through `executeWorkflow` for every web dispatch, (2) the `POST /approve` and `POST /reject` API handlers dispatch `/workflow run <name> <userMessage>` back through the orchestrator when `parent_conversation_id` is set and points at a web-platform parent (mirrors `workflowApproveCommand`/`workflowRejectCommand` on the CLI; non-web parents skip the auto-resume to prevent cross-adapter misrouting), and (3) the during-streaming status check in the DAG executor tolerates the `paused` state so a concurrent AI node in the same topological layer finishes its own stream rather than being aborted when a sibling approval node pauses the run. The Web UI reject button uses the proper `ConfirmRunActionDialog` with an optional reason textarea (was `window.confirm` in the chat card, and lacked a reason input on the dashboard) — the trimmed reason propagates to `$REJECTION_REASON` in the workflow's `on_reject` prompt. Credits @jonasvanderhaegen for surfacing and diagnosing the bug in #1147 (that PR was 87 commits stale on a dev that had since refactored the reject UX; this is a fresh re-do on current `dev`). Closes #1131.
- **Server startup no longer marks actively-running workflows as failed.** The `failOrphanedRuns()` call has been removed from `packages/server/src/index.ts` to match the CLI precedent (`packages/cli/src/cli.ts:256-258`). Per the new CLAUDE.md principle "No Autonomous Lifecycle Mutation Across Process Boundaries", a stuck `running` row is now transitioned explicitly by the user: via the per-row Cancel/Abandon buttons on the dashboard workflow card, or `archon workflow abandon <run-id>` from the CLI. (`archon workflow cleanup` is a separate command that deletes OLD terminal runs for disk hygiene — it does not handle stuck `running` rows.) Closes #1216.
- **`MCP server connection failed: <plugin>` noise no longer surfaces in workflow runs.** The dag-executor now loads the workflow node's `mcp:` config file once and filters the SDK's failure message to only the servers the workflow actually configured. User-level Claude plugin MCPs (e.g. `telegram` inherited from `~/.claude/`) that fail to connect in the headless subprocess are debug-logged as `dag.mcp_plugin_connection_suppressed` instead of being forwarded to the conversation. Other provider warnings (⚠️) surface unchanged. Credits @MrFadiAi for reporting the issue in #1134 (that PR was 9 days stale and conflicting; this is a fresh re-do on current `dev`).
- **`archon setup` no longer writes to `<repo>/.env`.** Prior versions unconditionally wrote the generated config to both `~/.archon/.env` and `<repo>/.env`, destroying user-added secrets and silently downgrading PostgreSQL configs to SQLite when re-run in "Add" mode. The write side now targets exactly one archon-owned file (home or project scope via `--scope`), merges into existing content by default, and writes a timestamped backup. `<repo>/.env` is never touched — it belongs to the user's target project. (#1303)
- **CLI and server no longer silently lose repo-local env vars.** Previously, env vars in `<repo>/.env` were parsed, deleted from `process.env` by `stripCwdEnv()`, and the only output operators saw was `[dotenv@17.3.1] injecting env (0) from .env` — which read as "file was empty." Workflows that needed `SLACK_WEBHOOK` or similar had no way to recover without knowing to use `~/.archon/.env`. The new `<cwd>/.archon/.env` path + archon-owned log lines make the load state observable and recoverable. (#1302)
- **Bumped transitive `axios` to `^1.15.0` via root `overrides` to clear CVE-2025-62718** (NO_PROXY bypass via hostname normalization → potential SSRF). Archon pulls `axios` transitively through `@slack/bolt` and `@slack/web-api`; both semver ranges (`^1.12.0` and `^1.13.5`) accept the override cleanly, so no API surface changes. Credits @stefans71 for identifying and reporting the vulnerability in #1153. Closes #1053.
- **Stale workspace symlink no longer reported as "not in a git repository" by the CLI.** When `archon workflow run` (or `--resume`) is invoked from a valid git repo whose `~/.archon/workspaces/<owner>/<repo>/source` symlink points somewhere else (common after moving/renaming the checkout), auto-registration fails but the repo is fine. Previously both the worktree-creation and resume paths fell through to the generic `Cannot create worktree: not in a git repository` / `Cannot resume: Not in a git repository` errors — a lie that sent users down the wrong diagnostic path. Both sites now preserve the registration error and throw `Cannot {create worktree,resume}: repository registration failed.` with the original cause and a concrete cleanup hint (`Remove the stale workspace entry at <path> and retry`) when the failure matches the `createProjectSourceSymlink()` shape. Credits @Bortlesboat for identifying the root cause and the parser approach in #1157. Closes #1146.
- **Cross-clone worktree isolation**: prevent workflows in one local clone from silently adopting worktrees or DB state owned by another local clone of the same remote. Two clones sharing a remote previously resolved to the same `codebase_id`, causing the isolation resolver's DB-driven paths (`findReusable`, `findLinkedIssueEnv`, `tryBranchAdoption`) to return the other clone's environment. All adoption paths now verify the worktree's `.git` pointer matches the requesting clone and throw a classified error on mismatch. `archon-implement` prompt was also tightened to stop AI agents from adopting unrelated branches they see via `git branch`. Thanks to @halindrome for the three-issue root-cause mapping. (#1193, #1188, #1183, #1198, #1206)

### Removed

- **`globalSearchPath` option** from `discoverWorkflows()` and `discoverWorkflowsWithConfig()`. Callers that previously passed `{ globalSearchPath: getArchonHome() }` should drop the argument; home-scoped discovery is now automatic.
- **`@anthropic-ai/claude-agent-sdk/embed` import** — the Bun `with { type: 'file' }` asset-embedding path and its `$bunfs` extraction logic. The embed was a bundler-dependent optimization that failed silently when Bun couldn't produce a usable virtual FS path (#1210, #1087); it is replaced by explicit binary-path resolution.

## [0.3.6] - 2026-04-12

Web UI workflow experience improvements, CWD environment leak protection, and bug fixes.

### Added

- Workflow result card now shows status, duration, node count, and artifact links in chat (#1015)
- Loop iteration progress display in the workflow execution view (#1014)
- Artifact file paths in chat messages are now clickable (#1023)

### Changed

- CWD `.env` variables are now stripped from AI subprocess environments at the `@archon/paths` layer, replacing the old `SUBPROCESS_ENV_ALLOWLIST` approach. Prevents accidental credential leaks from target repo `.env` files (#1067, #1030, #1098, #1070)
- Update check cache TTL reduced from 24 hours to 1 hour

### Fixed

- Duplicate text and tool calls appearing in workflow execution view
- `workflow_step` SSE events not handled correctly, causing missing progress updates
- Nested interactive elements in workflow UI causing React warnings
- Workflow status messages not splitting correctly in WorkflowLogs
- Incorrect `remainingMessage` suppression in stream mode causing lost output
- Binary builds now use `BUNDLED_VERSION` for the app version instead of reading `package.json`

## [0.3.5] - 2026-04-10

Fixes for `archon serve` process lifecycle and static file serving.

### Fixed

- **`archon serve` process exits immediately**: the CLI called `process.exit(0)` after `startServer()` returned, killing the server. Now blocks on SIGINT/SIGTERM so the server stays running (#1047)
- **Web dist path existence check**: server logs a warning at startup if the web dist directory is missing, instead of silently serving 404s
- **Favicon route**: added explicit `/favicon.png` route for the web UI

## [0.3.4] - 2026-04-10

Binary env loading fix and release infrastructure improvements.

### Added

- **Docs site redesign**: logo, dark theme, feature cards, and enhanced CSS (#1022)

### Changed

- **Server env loading for binary support**: removed redundant CWD `.env` stripping — `SUBPROCESS_ENV_ALLOWLIST` and the env-leak gate already prevent target repo credentials from reaching AI subprocesses. Server now loads `~/.archon/.env` with `override: true` for all keys (not just `DATABASE_URL`), skips the `import.meta.dir` `.env` path in binary mode, and defaults `CLAUDE_USE_GLOBAL_AUTH=true` when no explicit credentials are set (#1045)
- **Workspace version sync**: all `packages/*/package.json` versions now sync from the root `package.json` during releases via `scripts/sync-versions.sh`

### Fixed

- **`archon serve` crash in compiled binaries**: the CWD env stripping + baked `import.meta.dir` path caused all credentials to be lost, triggering `no_ai_credentials` exit on every startup
- **CLI `version` command reading stale version**: dev mode now reads from the monorepo root `package.json` instead of the CLI package's own version field
- **Release CI web build**: fixed `bun --filter` syntax and added missing `remark-gfm` transitive dependencies for Bun hoisting

## [0.3.3] - 2026-04-10

Binary distribution improvements, new workflow node type, and a batch of bug fixes.

### Added

- **`archon serve` command**: one-command way for compiled binary users to start the web UI server. Downloads a pre-built web UI tarball from GitHub releases on first run, verifies SHA-256 checksum, caches locally, then starts the full server (#1011)
- **Automatic update check**: binary users see a notification when a newer version is available on GitHub. Non-blocking, cached for 24 hours (#1039)
- **Script node type for DAG workflows**: `script:` nodes run inline TypeScript/Python or named scripts from `.archon/scripts/` via `bun` or `uv` runtimes. Supports `deps:` for dependency installation and `timeout:` in milliseconds (#999)
- **Codex native binary auto-resolution**: compiled builds now locate the Codex CLI binary automatically instead of requiring a manual `CODEX_CLI_PATH` override (#995, #1012)

### Fixed

- **Workflow reject ignores positional reason**: `archon workflow reject <id> <reason>` now correctly passes the reason argument to the rejection handler
- **Windows script path separators**: normalize backslashes to forward slashes in script node paths for cross-platform compatibility
- **PowerShell `Add-ToUserPath` corruption**: installer no longer corrupts `PATH` when only a single entry exists (#1000)
- **Validator `Promise.any` race condition**: script runtime checks no longer fail intermittently due to a `Promise.any` edge case (#1007, #1010)
- **Interactive-prd workflow bugs**: fixes to loop gate handling, variable substitution, and node ordering (#1001, #1002, #1003, #1005)
- **Community forge adapter exports**: added explicit export entries for Gitea and GitLab adapters so they resolve correctly in compiled builds (#1041)
- **Workflow graph view without codebase**: the web UI workflow graph now loads correctly even when no codebase is selected (#958)

## [0.3.2] - 2026-04-08

Critical hotfix: compiled binaries could not spawn Claude. Also fixes an env-leak gate false-positive for unregistered working directories.

### Fixed

- **Claude SDK spawn in compiled binaries**: the Claude Agent SDK was resolving its `cli.js` via `import.meta.url` of the bundled module, which `bun build --compile` freezes at build time to the build host's absolute `node_modules` path. Every binary shipped from CI carried a `/Users/runner/work/Archon/...` path that existed only on the GitHub Actions runner, and every `workflow run` hit `Module not found` after three retries. Now imports `@anthropic-ai/claude-agent-sdk/embed` so `cli.js` is embedded into the binary's `$bunfs` and extracted to a real temp path at runtime (#990).
- **Env-leak gate false-positive for unregistered cwd**: pre-spawn scan now skips cwd paths that aren't registered as codebases instead of blocking the workflow (#991, #992).

## [0.3.1] - 2026-04-08

Patch release: SQLite migration fix for existing databases and release build pipeline fix.

### Fixed

- **SQLite migration for `allow_env_keys`**: add the missing `allow_env_keys` column to the `codebases` schema and a migration so databases created before v0.3.0 upgrade cleanly instead of erroring on first query (#988).
- **Release workflow binary builds**: wire `.github/workflows/release.yml` back to `scripts/build-binaries.sh` so tagged releases actually produce platform binaries and `checksums.txt` (#986, #987).

## [0.3.0] - 2026-04-08

Env-leak gate hardening, SSE reliability fixes, isolation cleanup smarter merge detection, build/version improvements, and deploy hardening.

### Added

- **Env-leak gate (target repo `.env` keys)**: scan auto-loaded `.env` filenames for 7 sensitive keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) and refuse to register or spawn into a codebase whose `.env` would silently re-inject keys into Claude/Codex subprocesses. Default is fail-closed (`allow_env_keys = false`). Includes a per-codebase consent column, registration gate, pre-spawn check in both Claude and Codex clients, and a 422 API error with web UI checkbox (#1036).
- **CLI `--allow-env-keys` flag** for `archon workflow run` — grant env-leak-gate consent during auto-registration without needing the Web UI. Audit-logged as `env_leak_consent_granted` with `actor: 'user-cli'` (#973, #983).
- **Global `allow_target_repo_keys` flag** in `~/.archon/config.yaml` — bypass the env-leak gate for all codebases on this machine. Per-repo `.archon/config.yaml` `allow_target_repo_keys: false` re-enables the gate for that repo. The server emits `env_leak_gate_disabled` once per process per source the first time `loadConfig` resolves the bypass as active (#973, #983).
- **`PATCH /api/codebases/:id`** endpoint to flip `allow_env_keys` on existing codebases without delete/re-add. Audit-logged at `warn` level on every grant and revoke, including a `scanStatus` field that distinguishes "scanned" from "scan failed" so audit reviewers can tell empty key lists apart (#973, #983).
- **Settings → Projects per-row toggle** to grant or revoke env-key consent retroactively, with an "env keys allowed" badge and inline error feedback if the PATCH fails (#973, #983).
- **Startup env-leak scan**: when `allow_target_repo_keys` is not set, the server emits one `startup_env_leak_gate_will_block` warn per registered codebase whose `.env` would block the next spawn. Skipped entirely when the global bypass is active (#973, #983).
- **Squash-merge and PR-merge detection** for `isolation cleanup --merged`. Unions three signals (ancestry via `git branch --merged`, patch equivalence via `git cherry`, and PR state via `gh`) to safely clean up worktrees whose branches were squash-merged. Adds `--include-closed` flag to also remove worktrees whose PRs were closed without merging (#1027).
- **Git commit hash in `archon version`** output. Read at runtime via `git rev-parse` in dev or from a build-time constant in compiled binaries; falls back to `unknown` (#1035).

### Changed

- **Env-leak gate error messages** are now context-aware: separate remediation copy for Web Add-Project, CLI auto-register, and pre-spawn-of-existing-codebase paths. Previously every error pointed at the Web UI checkbox even from the CLI (#973, #983).
- **SSE event buffer TTL** raised from 3s to 60s and capacity from 50 to 500 events, fixing dropped `tool_result` events during the 5s reconnect grace window that left tool cards perpetually spinning. Cleanup timer now resets on each new event so the buffer is held for TTL past the most recent event, not the first one. Buffer overflow and TTL expiration now log at `warn` level for observability (#1037).
- **Binary build detection** moved from runtime env sniffing (`import.meta.dir` / `process.execPath`) to a build-time `BUNDLED_IS_BINARY` constant in `@archon/paths`. Logger uses `pino-pretty` as a destination stream on the main thread instead of a worker-thread transport, eliminating the `require.resolve('pino-pretty')` lookup that crashed inside Bun's `$bunfs` virtual filesystem in compiled binaries. Same code path runs in dev and binaries — no environment detection (#982).
- **Cloud-init deployment script** hardened: dedicated `archon` user (docker group, no sudo) with SSH keys copied from the default cloud user, 2GB swapfile to prevent OOM during docker build on small VPSes, `ufw allow 443/tcp` and `443/udp` for HTTP/3 QUIC, fail-fast on network errors, and clearer setup-complete messaging (#981).

### Fixed

- **Env-leak gate worktree path lookup**: pre-spawn consent check now falls back to `findCodebaseByPathPrefix()` when the exact path lookup misses, so workflow runs in `.../worktrees/feature-branch` correctly inherit consent from the source codebase (#1036).
- **`EnvLeakError` FATAL classification** in the workflow executor now checks `error.name === 'EnvLeakError'` directly instead of pattern-matching the message, immune to message rewording (#1036).
- **Scanner unreadable-file handling**: distinguishes `ENOENT` (skip) from `EACCES` and other errors so unreadable `.env` files surface as findings instead of silently bypassing the gate (#1036).

### Security

- The default `allow_env_keys` per codebase is `false` (fail-closed). Codebases with sensitive keys in their auto-loaded `.env` files (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) are blocked at the next workflow run. **Remediation paths** (any one): (1) remove the key from `.env`, (2) rename to `.env.secrets`, (3) toggle "Allow env keys" in Settings → Projects, (4) `archon workflow run --allow-env-keys ...`, (5) set `allow_target_repo_keys: true` in `~/.archon/config.yaml`. See `docs/reference/security.md` for full details (#1036, #973, #983).


## [0.2.12] - 2026-03-20

Chat-first navigation redesign, DAG graph viewer, per-node MCP and skills, and extensive bug fixes across the web UI and workflow engine.

### Added

- **Chat-first layout redesign** with top-level tab navigation replacing sidebar nav (#666, #673)
- **DAG workflow graph viewer** with split-panel layout for visual workflow inspection (#712)
- **Per-node MCP servers** for DAG workflows — configure MCP server files per node with env var expansion (#688)
- **Per-node skills** for DAG workflows — preload skills via AgentDefinition wrapping (#689)
- **Default worktree isolation** for CLI workflows with auto-detected base branch (#692)
- **Mission Control cards** with richer grouping by parent chat (#673)
- **Tool result capture** via PostToolUse hook streamed live to Web UI
- **Zustand state management** for workflow store, replacing manual state (#693)
- **Welcoming empty chat state** with suppressed disconnected/no-project noise (#670)
- Issue context details in workflow startup log events (#737)
- Running workflow count in health endpoint (#718, #719)
- Prerequisites section added to README quickstart

### Changed

- README restructured with content extracted to `/docs` directory
- Shared executor infrastructure extracted from monolithic executor (#685)
- Workflow discovery split into its own module for cleaner loading
- Duplicated helpers extracted across executor, command-handler, and cleanup-service (#633)
- Worktree-per-codebase limit removed
- Deduplicated `setConversationDbId` pattern across adapters (#651)

### Fixed

- SSE race condition causing loading indicators to break after first workflow invocation
- Tool call cards not rendering during live SSE streaming in chat (#754)
- Standalone active workflows not grouped into shared grid (#755)
- Conversation list not scrollable in sidebar (#747, #750)
- Duplicate tool calls in WorkflowLogs from SSE+DB merge conflicts (#705, #720, #721)
- Ghost DB entries in CLI isolation commands
- Tool output lost across periodic flush in workflow logs
- `conversationId` not URL-encoded in SSE EventSource for forge adapters (#658)
- Claude SDK crash when invoked as root (#733)
- Worktree sharing across conversations and web workers (#716)
- Orphan conversation cleanup and rename error surfacing (#726)
- Query error states missing from sidebar and context components (#727)
- localStorage guard and background polling issues (#725)
- Workflow builder black screen and DAG log filtering (#675)
- Idle timeout not detecting stuck tool calls during execution (#649)
- `commitAllChanges` failing on empty commits (#745)
- Explicit base branch config now required for worktree creation (#686)
- Subprocess-level retry added to CodexProvider (#641)
- Validate `cwd` query param against registered codebases (#630)
- Server-internal paths redacted from `/api/config` response (#632)
- SQLite conversations index missing `WHERE deleted_at IS NULL` (#629)

## [0.2.11] - 2026-03-16

Git workflow and release automation.

### Added

- **Dev branch workflow** — `dev` is now the working branch; `main` is the release branch. All feature work branches off `dev` (#684)
- **`/release` skill** — stack-agnostic release automation that generates changelog entries, bumps version, and creates a PR to main

### Changed

- GitHub default branch changed from `main` to `dev`

## [0.2.10] - 2026-03-16

CLI-Web observability overhaul, comprehensive test coverage, and per-node hooks.

### Added

- **CLI-Web observability overhaul** — DAG visualization, cancel support, metadata display, and progress tracking across CLI and Web UI
- **Per-node SDK hooks** for DAG workflows — attach static hook callbacks to individual Claude nodes for tool control and context injection (#634)
- **Multi-layer transient error retry** for SDK subprocess crashes with exponential backoff (#639)
- **Comprehensive test coverage** across all packages — postgres adapter, clone handler, orchestrator agent, error formatter, API routes (#645)
- **Windows test compatibility** — resolved 33 Windows-specific test failures (#644)

### Changed

- Tool call persistence decoupled from web adapter for cleaner architecture (#642, #652)
- Loop and DAG executors now emit structured SSE events for live tool cards (#656)

### Fixed

- Loading indicator race condition and workflow tool call duration display (#654, #655, #657)
- DAG node cancel detection during streaming and UTC timestamp elapsed time
- Idle timeout excluded from post-loop cancel classification
- Flaky message-cache test caused by `Date.now()` drift

## [0.2.9] - 2026-03-13

DAG hardening, security fixes, validate-pr workflow, and worktree lifecycle management.

### Added

- **`archon complete <branch>` command** for worktree lifecycle cleanup — removes worktree + local/remote branches (#601)
- **`--json` flag for `workflow list`** — machine-readable workflow output (#594)
- **`archon-validate-pr` workflow** with per-node idle timeout support (#635)
- **Typed SessionMetadata** with Zod validation for safer metadata handling (#600)
- **`persistSession: false`** in ClaudeProvider to avoid disk pollution from session transcripts (#626)
- **DAG workflow for GitHub issue resolution** with structured node pipeline

### Changed

- Claude Agent SDK updated to v0.2.74 (#625)

### Fixed

- **Shell injection via `$nodeId.output` in bash nodes** — output is now properly escaped (#591)
- DAG `when:` parse errors now fail-closed (skip node) instead of fail-open (#590)
- Unknown `$nodeId.output` refs warn instead of silently returning empty string (#593)
- Isolation resolver no longer swallows errors or leaks partial state (#597)
- `extractOwnerRepo` no longer silently produces `undefined` path segments (#592)
- Chat stuck states after failed message send (#578, #589)
- DAG node events properly wired to frontend (#577, #602)
- Worktree creation no longer moves canonical repo HEAD (#572)
- Conversation DELETE/PATCH now use platform ID instead of internal DB ID (#575)
- DAG workflow duration computed once for consistency (#570, #573)
- SSE gaps from ordered lock events and retract preserving tool calls (#581)
- Sidebar delete now clears selection and guards localStorage (#582)
- Git fetch errors classified in syncRepository (#574)
- `DATABASE_URL` loaded from `~/.archon/.env` for CLI/server parity
- API returns 400 when `conversationId` is provided in POST `/api/conversations` (#595)

## [0.2.8] - 2026-03-06

Skills system overhaul and workshop documentation.

### Added

- **Archon-dev skill** with routing to 10 specialized cookbooks (research, plan, implement, review, debug, commit, PR, issue)
- **Rulecheck skill** — autonomous agent that scans for CLAUDE.md rule violations, creates PRs with fixes, and notifies via Slack
- **Triage skill** — upgraded from command to skill with custom agent for GitHub issue labeling
- **Save-task-list skill** — upgraded from command to skill with SessionStart hook for task restoration
- **Replicate-issue skill** for systematic GitHub issue reproduction
- **Workshop documentation** — part 1 and part 2 guides, combined rundown, and feature coverage matrix

### Changed

- Default AI assistant switched from Codex to Claude
- Skills upgraded from `.claude/commands` to `.claude/skills` with dedicated directories

## [0.2.7] - 2026-02-26

Monorepo deep extraction and visual workflow builder.

### Added

- **Visual workflow builder** with React Flow for drag-and-drop workflow creation (#471)
- **AI-generated conversation titles** + CLI-to-Web UI integration (#515)
- **Workflow Command Center** — unified dashboard for cross-project workflow observability with pagination and filtering
- **`@archon/paths` package** extracted from `@archon/core` — path resolution and logger with zero internal deps (#483)
- **`@archon/git` package** extracted from `@archon/core` — git operations with branded types (#492)
- **`@archon/isolation` package** extracted from `@archon/core` — worktree isolation with provider abstraction (#492)
- **`@archon/adapters` package** extracted from `@archon/server` — platform adapters for Slack, Telegram, GitHub, Discord (#499)
- **`@archon/workflows` package** extracted from `@archon/core` — workflow engine with loader, router, executor, DAG (#507)

### Changed

- Backward-compat re-exports removed from `@archon/core` — use direct package imports (#512)

### Fixed

- Workflow dispatch history loss, cancel, and streaming UX (#475, #480)
- Workflow summary duplicate on chat navigation (#490)
- Text buffer flushed before workflow_dispatch SSE events (#491, #498)
- SQLite adapter RETURNING test fixture (#508)
- Mock restoration in 3 test files to prevent cross-file pollution (#509, #510)
- Windows path fixes for Archon directories

## [0.2.6] - 2026-02-21

DAG workflow engine, orchestrator agent, and per-node tool restrictions.

### Added

- **DAG workflow engine** with parallel execution, conditional branching, and `$nodeId.output` substitution (#450)
- **Orchestrator agent** that routes natural language to workflows and passes prompts through (#452)
- **Per-node and per-step tool restrictions** — `allowed_tools` and `denied_tools` for Claude nodes (#454)
- **Workflow builder backend APIs** (Phase A) — validate, fetch, save, and delete workflows (#471)
- **Session retention policy** for automatic cleanup of old sessions (#306)
- **Failed workflow resume** from prior artifacts on same branch (#440)

### Changed

- Claude Agent SDK upgraded to 0.2.45 and Codex SDK to 0.104.0 (#448)
- Workflow step lifecycle logs promoted from debug to info (#469)

### Fixed

- Router bypass when AI uses tools instead of `/invoke-workflow` (#449)
- Cancelled workflow status handled in frontend (#458)
- Workflows always run in isolated worktree regardless of registration method (#457)
- `--branch` and `--no-worktree` conflict in CLI (#545)
- `/invoke-workflow` chunk suppressed before streaming to frontend (#486)
- Idle timeout added to streaming loops to prevent executor hang (#552)
- Codex model access errors surfaced with actionable guidance (#438)

## [0.2.5] - 2026-02-17

Web UI launch, structured logging, and major stabilization.

### Added

- **Archon Web UI** — React frontend with SSE streaming, workflow events, and conversation management
- **Pino structured logging** replacing console.log across all packages (#388)
- **Project-centric `~/.archon/` layout** — workspaces organized by `owner/repo` (#382)
- **Session deactivation reasons** stored in database for audit trail (#303, #385)
- **Remote branch cleanup** when PR is merged
- **Workflow log duration, tokens, and validation events** (#417)
- **Save-task-list command** for persisting task lists across sessions

### Changed

- `~/.archon/` restructured to project-centric layout (#382)
- Database command templates deprecated in favor of filesystem commands (#425)
- SQLite-first documentation with Postgres as optional (#418)
- `transitionSession` wrapped in database transaction for atomicity (#408)
- Codex SDK bumped to 0.101.0

### Fixed

- `.env` resolution in worktrees with credential error guidance (#404)
- CLI picking up `DATABASE_URL` from target repo `.env` (#389)
- PRs targeting wrong base branch instead of configured one (#387)
- Client error handling and GitHub self-triggering (#223, #240, #407)
- Handler bugs: JSON parsing, dotenv worktree, error messages (#392-#395, #406)
- Model selection and Codex options wiring (#428)
- SQLite busy timeout to prevent database locks (#418, #420)
- Workflow load errors and router failures surfaced to users (#410)
- WorkflowInvoker crash from workflows API type mismatch (#436)
- `getCodebaseCommands()` returning mutable reference (#379, #384)

## [0.2.4] - 2026-02-05

SQLite as default database and simplified CLI setup.

### Added

- **SQLite as default database** — zero-config setup with `~/.archon/archon.db`, no PostgreSQL required
- **Simplified CLI setup** — streamlined first-run experience on macOS/Linux

### Fixed

- Combined SQL schema syntax error (extra comma)
- Post-install configuration for Ubuntu VPS deployments

## [0.2.3] - 2026-01-31

Archon CLI skill, workflow routing improvements, and configuration fixes.

### Added

- **Archon CLI skill** for Claude Code — run workflows from within Claude Code sessions (#331, #332, #333)
- **Interactive setup wizard** and config editor for the Archon skill
- **`/workflow run` command** for direct workflow invocation from CLI
- **`archon-plan-to-merge` workflow** for end-to-end plan execution (#346)
- **Workflow error visibility** — `/workflow list` and `/workflow reload` show per-file load errors (#260, #263, #264)
- **Case-insensitive workflow routing** — router falls back to case-insensitive match (#263)

### Changed

- Workflow artifacts standardized with workflow-scoped paths (#352)
- Resilient workflow loading — one broken YAML no longer aborts loading all workflows (#260)
- `baseBranch` config option wired up for worktree creation (#330, #334)

### Fixed

- Config parse errors surfaced to users instead of silently failing (#284, #286)
- Workflow router prioritizes user intent over context (#365)
- Issue context passed to workflows for non-slash commands (#215)
- Cross-platform path splitting for worktree isolation (#245)
- WorktreeProvider error handling and silent failures (#276)
- Router error feedback with available workflow names (#263)
- Metadata serialization failure when `github_context` present (#262)
- Consecutive unknown errors tracked in workflow executor (#259)
- Thread inheritance error handling with logging and tests (#269)
- Isolation environments partial index replaces full unique constraint (#239)

## [0.2.2] - 2026-01-22

Documentation improvements and bug fixes.

### Added

- **CLI documentation** - User guide and developer guide with architecture diagrams (#326)
- **Private repo installation guide** using `gh` CLI for authenticated cloning
- **Manual release process** documentation for when GitHub Actions unavailable

### Changed

- **Repository ownership** migrated from `raswonders` to `dynamous-community`

### Fixed

- Dockerfile monorepo workspace structure for proper package resolution

## [0.2.1] - 2026-01-21

Server migration to Hono and CLI binary distribution infrastructure.

### Added

- **CLI binary distribution** - Standalone binaries for macOS/Linux with curl install and Homebrew formula (#325)
- **Bundled defaults** - Commands and workflows embedded at compile time for binary builds (#325)
- **Runtime default loading** - Load default commands/workflows at runtime instead of copying on clone (#324)
- **Default opt-out** - Config options `loadDefaultCommands` and `loadDefaultWorkflows` (#324)
- **Version command enhancements** - Shows platform, build type (binary/source), and database type (#325)

### Changed

- **Express to Hono migration** - Replaced Express with Hono for improved performance and Bun integration (#318)
- **Default port** changed from 3000 to 3090
- **ESLint zero-warnings policy** enforced in CI (#316)
- **CLAUDE.md consolidation** - Removed duplications and streamlined documentation (#317)

## [0.2.0] - 2026-01-21

Monorepo restructure introducing the CLI package for local workflow execution.

### Added

- **Monorepo structure** with `@archon/core`, `@archon/server`, and `@archon/cli` packages (#311)
- **CLI entry point** with `workflow list`, `workflow run`, and `version` commands (#313)
- **Database abstraction layer** supporting both PostgreSQL and SQLite (#314)
- **SQLite auto-detection** - uses `~/.archon/archon.db` when `DATABASE_URL` not set (#314)
- **Isolation commands** - `isolation list` and `isolation cleanup` for worktree management (#313)

### Fixed

- Surface git utility errors instead of swallowing silently (#292)

## [0.1.6] - 2026-01-19

Provider selection and session audit trail.

### Added

- **Config-based provider selection** for workflows - choose Claude or Codex per workflow (#283)
- **Session state machine** with immutable sessions for full audit trail (#302)
- **Workflow status visibility** - track running workflows per conversation (#256)
- Codex sandbox/network settings and progress logging (#290)

### Changed

- Comprehensive isolation module code review (#274)

### Fixed

- Stale workspace: sync before worktree creation (#287)
- Add defaults subdirectory to command search paths (#289)

## [0.1.5] - 2026-01-18

Major stability release with comprehensive bug fixes and test coverage.

### Added

- **Worktree-aware automatic port allocation** for parallel development (#178)
- **GitHub thread history** - fetch previous PR/issue comments as context (#185)
- **Cloud deployment support** for `with-db` profile (#134)
- Integration tests for orchestrator workflow routing (#181)
- Concurrent workflow detection tests (#179)
- Comprehensive AI error handling tests for workflow executor (#176)

### Changed

- Deep orchestrator code review refactor (#265)
- Improve error handling and code clarity in server entry point (#257)

### Fixed

- Workflows should only load from `.archon/workflows/` (#200)
- PR worktrees use actual branch for same-repo PRs (#238)
- GitHub adapter parameter bug causes clone failures (#209)
- Auto-detect Claude auth when `CLAUDE_USE_GLOBAL_AUTH` not set (#236)
- Worktree provider cleans up branches when worktrees are deleted (#222)
- Extract port utilities to prevent test conflicts with running server (#251)
- Workflows ensure artifacts committed before completing (#203)
- Worktree creation fails when orphan directory exists (#208)
- Add logging to detect silent updateConversation failures (#235)
- Auto-sync `.archon` folder to worktrees before workflow discovery (#219)
- Consolidate startup messages into single workflow start comment (#177)
- Show repo identifier instead of server filesystem path (#175)
- Check for existing PR before creating new one (#195)
- Use empty Slack token placeholders in .env.example (#249)

## [0.1.4] - 2026-01-15

Developer experience improvements and worktree stability.

### Added

- **Auto-copy default commands/workflows** on `/clone` (#243)
- **Pre-commit hook** to prevent formatting drift (#229)
- **Claude global auth** - `CLAUDE_USE_GLOBAL_AUTH` for SDK built-in authentication (#228)

### Changed

- Update README with accurate command reference and new features (#242)

### Fixed

- Copy `.archon` directory to worktrees by default (#210)
- Stale workflow cleanup and defense-in-depth error handling (#237)
- Cleanup service handles missing worktree directories gracefully (#207)
- Worktree limit blocks workflow execution instead of falling back to main (#197)
- Bot self-triggering on own comments (#202)
- Remove unnecessary String() calls in workflow db operations (#182)

## [0.1.3] - 2026-01-13

Workflow engine improvements with autonomous execution and parallel steps.

### Added

- **Ralph-style autonomous iteration loops** for plan-until-done execution (#168)
- **Parallel block execution** for workflows - run multiple steps concurrently (#217)
- **Workflow router** with platform context for intelligent intent detection (#170)
- **Emoji status indicators** for workflow messages (#160)
- Tests for logger filesystem error handling (#133)

### Changed

- Make `WorkflowDefinition.steps` readonly for immutability (#136)

### Fixed

- Detect and block concurrent workflow execution (#196)
- RouterContext not populated for non-slash commands on GitHub (#173)
- Workflow executor missing GitHub issue context (#212)
- Skip step notification for single-step workflows (#159)
- Remove redundant workflow completion message on GitHub (#162)
- Add message length handling for GitHub adapter (#163)
- Use code formatting for workflow/command names (#161)

## [0.1.2] - 2026-01-07

Introduction of the YAML-based workflow engine.

### Added

- **Workflow engine** for multi-step AI orchestration with YAML definitions (#108)
- Improve workflow router to always invoke a workflow (#135)

### Changed

- Improve error handling in workflow engine (#150)

### Fixed

- Add ConversationLock to GitHub webhook handler (#142)
- Bot no longer responds to @mentions in issue/PR descriptions (#143)
- Copy git-ignored files to worktrees (#145)
- `/repo <name>` fails due to owner/repo folder structure mismatch (#148)
- Load workflows from conversation.cwd instead of server cwd (#149)
- Revert to Bun native YAML parser and add Windows CI (#141)
- Wrap platform.sendMessage calls in try-catch in executor (#132)
- Cloud database pooler idle disconnects gracefully (#118)

## [0.1.1] - 2025-12-17

Isolation architecture overhaul and Bun runtime migration.

### Added

- **Bun runtime migration** - replaced Node.js/npm/Jest with Bun (#85)
- **Unified isolation environment architecture** with provider abstraction (#87, #92)
- **Scheduled cleanup service** for stale worktree environments (#94)
- **Worktree limits** with user feedback (#98)
- **Force-thread response model** for Discord (#93)
- **Archon distribution config** and `~/.archon/` directory structure (#101)
- User feedback messages for GitHub worktree operations (#90)
- Required SDK options for permissions and system prompt (#91)
- Test coverage for PR worktree creation (#77)

### Changed

- Drop legacy isolation columns in favor of new architecture (#99)
- Use `isolation_env_id` with fallback to `worktree_path` (#88)

### Fixed

- Fork PR support in worktree creation (#76)
- Multi-repository path collision bug (#78)
- Status command displays `isolation_env_id` (#89)
- Worktree path collision for repos with same name (#106)

## [0.1.0] - 2025-12-08

Initial release of the Remote Agentic Coding Platform.

### Added

- **Platform Adapters**
  - Telegram adapter with streaming support and markdown formatting
  - Slack adapter with Socket Mode for real-time messaging (#73)
  - Discord adapter with thread support
  - GitHub adapter with webhook integration for issues and PRs (#43)
  - Test adapter for HTTP-based integration testing

- **AI Assistant Clients**
  - Claude Code SDK integration with session persistence
  - Codex SDK integration as alternative AI assistant

- **Core Features**
  - PostgreSQL persistence for conversations, codebases, and sessions
  - Generic command system with user-defined markdown commands
  - Variable substitution ($1, $2, $ARGUMENTS, $PLAN)
  - Worktree isolation per conversation for parallel development (#43)
  - Session resume capability across restarts

- **Workflow Commands** (exp-piv-loop)
  - `/plan` - Deep implementation planning with codebase analysis
  - `/implement` - Execute implementation plans
  - `/commit` - Quick commits with natural language targeting
  - `/create-pr` - Create PRs from current branch
  - `/merge-pr` - Merge PRs with rebase handling
  - `/review-pr` - Comprehensive PR code review
  - `/rca` - Root cause analysis for issues
  - `/fix-rca` - Implement fixes from RCA reports
  - `/prd` - Product requirements documents
  - `/worktree` - Parallel branch development
  - `/worktree-cleanup` - Clean up merged worktrees
  - `/router` - Natural language intent detection (#59)

- **Platform Features**
  - Configurable streaming modes (stream/batch) per platform
  - Platform-specific authorization (whitelist users)
  - Configurable GitHub bot mention via environment variable (#66)

- **Developer Experience**
  - ESLint 9 with flat config and Prettier integration
  - Jest test framework with mocks
  - Docker Compose for local development
  - Builtin command templates (configurable via LOAD_BUILTIN_COMMANDS)

### Fixed

- Shared worktree cleanup preventing duplicate removal errors (#72)
- Case-sensitive bot mention detection in GitHub adapter
- PR review to checkout actual PR branch instead of creating new branch (#48)
- Template commands treated as documentation (#35, #63)
- Auto-load commands in /clone like /repo does (#55)
- /status and /repos codebase active state inconsistency (#60)
- WORKSPACE_PATH configuration to avoid nested repos (#37, #54)
- Shorten displayed paths in worktree and status messages (#33, #45)
- Create worktrees retroactively for legacy conversations (#56)

### Security

- Use commit SHA for reproducible PR reviews (#52, #75)
- Add retry logic to GitHub API calls for transient network failures (#64)
