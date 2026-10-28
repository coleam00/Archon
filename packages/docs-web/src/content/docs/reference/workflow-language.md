---
title: Workflow language
description: Every workflow field, node type and engine behavior an Archon workflow YAML file can declare.
category: reference
area: workflows
audience: [user]
status: current
sidebar:
  order: 4
---

This page describes the workflow YAML language: the fields a workflow and its nodes declare, and what the engine does with them. To build a workflow step by step, start with [Build your first workflow](/getting-started/first-workflow/). Commands, the markdown files a `command:` node loads, are described in [Authoring commands](/guides/authoring-commands/).

A workflow is a YAML file that declares a graph of nodes. Each node runs an agent, a command file, a shell or script step, a loop, a pause, or another workflow. Nodes declare what they depend on; nodes without a dependency between them run in parallel.

```yaml
name: fix-issue
description: Investigate an issue, then fix it in a fresh session

nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

The bundled `sdlc` pack in [`.archon/workflows/sdlc/`](https://github.com/coleam00/Archon/tree/dev/.archon/workflows/sdlc) is the largest working example. To start from it, copy the whole pack folder: its workflows include each other and share modules in `sdlc/.shared/`. A same-named workflow in your `.archon/workflows/` overrides the bundled one.

## File Location

Workflows live in `.archon/workflows/` relative to the working directory:

```
.archon/
├── workflows/
│   └── my-pack/                 # Author-chosen pack name
│       └── release/             # Author-chosen workflow folder
│           ├── release.yaml
│           ├── commands/
│           │   └── prepare.md
│           └── scripts/
│               └── publish.ts
```

The two directories form a fixed package boundary: `.archon/workflows/<pack>/<workflow>/`. A packaged workflow contains exactly one YAML definition; bare `command:` and named `script:` references resolve only from its own `commands/` and `scripts/` directories, with no shared or cross-scope fallback. Included workflows retain their own resource folder, so two workflows may reuse names such as `review.md` without collisions.

Scripts from different workflows in one pack can import modules from `<pack>/.shared/`. That directory is reserved for modules and `.md` documents, not workflow definitions or `script:` targets. Bun and Python use the same pack-relative layout in source checkouts and binary builds. See [Share code within a pack](/guides/script-nodes/#share-code-within-a-pack) for import examples.

The same tree works under `~/.archon/workflows/` for home-scoped workflows. Existing flat `.archon/workflows/foo.yaml`, one-level grouped YAML, shared `.archon/commands/`, and shared `.archon/scripts/` remain supported for compatibility.

> **Global workflows:** For workflows that apply to every project, place them in `~/.archon/workflows/`. Global workflows are overridden by same-named repo workflows. See [Global Workflows](/guides/global-workflows/).

> **CLI vs Server:** The CLI reads workflow files from wherever you run it, including uncommitted changes. The server uses the registered project's saved checkout path, which can be your local checkout or a subdirectory of it. A new webhook registration creates a managed clone at `~/.archon/workspaces/owner/repo/source/`, or at a suffixed path such as `owner/repo-2/source/` when that project name is taken; changes made in another checkout must be committed and pushed for that clone to receive them when it syncs. Existing-registration webhook readiness does not sync your local checkout. Worktree runs use files in their worktree.

## Workflow fields

| Field | Description |
|-------|-------------|
| `name` | Required. The name you run the workflow by. |
| `description` | Required. Shown by `archon workflow list` and read by the chat assistant when it picks a workflow, so say what the workflow does, when to use it and when not to. |
| `nodes` | Required. The node list; see [Node fields](#node-fields). |
| `provider`, `model` | Default provider and model for AI nodes. See [Model configuration](#model-configuration). |
| `effort`, `fallbackModel`, `betas`, `sandbox` | Defaults for the matching node options. See [Provider options](#claude-sdk-advanced-options). |
| `webSearchMode` | Codex web search: `disabled`, `cached` or `live`. Workflow level only. See [Codex options](#codex-specific-options). |
| `worktree.enabled` | `false` always runs in the live checkout, and `--branch` or `--from` is an error. `true` always uses a worktree, and `--no-worktree` is an error. Omit it to let the caller decide; the default is a worktree. |
| `container` | `enabled` and `write_back` (`approve` or `auto`) for container runs of folder projects. |
| `mutates_checkout` | `false` asserts that runs of this workflow never write to their checkout, so the engine skips the path lock and several runs can share one checkout. Default `true`. See [Running sub-runs side by side](#running-sub-runs-side-by-side). |
| `budget` | Ceiling on the run's total work and spend. See [Run budgets](#run-budgets). |
| `persist_sessions` | Default for every AI node's `persist_session`. See [Persistent sessions](#persistent-sessions-across-re-runs). |
| `requires` | `[github]` refuses the run before any work unless the triggering user has connected a GitHub identity. Enforced only when per-user GitHub is enabled (GitHub App mode with `TOKEN_ENCRYPTION_KEY`). `github` is the only value. |
| `inputs`, `returns`, `outcome_field` | The workflow's signature. See [Workflow signature](#workflow-signature-inputs-returns-and-inputs). |
| `evidence_policy` | `{ required: true }` fails a run that finishes without `$ARTIFACTS_DIR/evidence.json`. See [Deterministic checks, authored outcomes, and evidence markers](#deterministic-checks-authored-outcomes-and-evidence-markers). |
| `tags` | Free-form labels carried on the parsed workflow. The engine gives them no meaning. |
| `deprecated` | `{ message }` announces removal at every run start. See [Deprecating a workflow](#deprecating-a-workflow). |

Some fields are retired. Workflow-level `interactive:` loads with a warning and has no effect. `modelReasoningEffort:` is applied as `effort:` with a warning. The old sequential `steps:` format fails to load, and so does `thinking:` on a workflow, node, tier or alias, with an error pointing at `effort:`.

### Execution order

A node without `depends_on` starts in the first layer. A node starts when every node it depends on has settled and its `trigger_rule` and `when:` allow it. Nodes in the same layer run concurrently, with two exceptions: a [loop body settles ordinary work before interactions](/guides/loop-nodes/#how-it-works), and a layer that mixes checkout-guarded nodes with other nodes runs one node at a time (see `mutates_checkout` below). A skipped node passes its skipped state to the nodes that depend on it.

## Node Fields

**Node types**: exactly one required per node (mutually exclusive):

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Command name. Packaged workflows resolve it only from their own `commands/`; legacy workflows use shared repo → home → bundled lookup. Optional `with:` binds upstream values by name into the file's `$INPUTS.<name>` surface. See [Binding values into command and script nodes](#binding-values-into-command-and-script-nodes) |
| `prompt` | string | Inline prompt string |
| `bash` | string | Shell script (no AI). Stdout captured as `$nodeId.output`; successful stdout is also stored in `node_completed.data.node_output` as an audit preview capped at 32 KiB (UTF-8 bytes). Optional `timeout` (ms; without one the node runs until it exits); `on_timeout: skip` makes a timeout skipped instead of failed |
| `script` | string | TypeScript/JavaScript (via `bun`) or Python (via `uv`): inline code or named reference. Packaged workflows resolve named scripts only from their own `scripts/`; legacy workflows use shared script directories. Stdout captured as `$nodeId.output`. Requires `runtime: bun` or `runtime: uv`. Optional `deps` (uv only) and `timeout` (ms; without one the node runs until it exits); `on_timeout: skip` makes a timeout skipped instead of failed; optional `with:` binds upstream values by name into `INPUTS_<UPPER_SNAKE>` env vars. See [Binding values into command and script nodes](#binding-values-into-command-and-script-nodes). See [Script Nodes](/guides/script-nodes/) |
| `loop` | object | Iterative AI prompt until a declared completion condition is met. See [Loop Nodes](/guides/loop-nodes/) |
| `loop_group` | object | Multi-node sub-DAG body repeated per iteration until a declared completion condition is met. See [Cross-Node Loops](/guides/loop-nodes/#cross-node-loops-with-loop_group) |
| `approval` | object | **Deprecated.** Use `wait: { attention: <message>, form: approval }` instead. See [Migrating from approval gates](/guides/approval-nodes/#migrating-from-approval-gates) |
| `wait` | object | Durably pauses the run until a time, bounded external event, or an answer to an attention wait. See [Durable waits](#durable-waits) |
| `cancel` | string | Terminates the workflow run with a reason string. Uses existing cancellation plumbing. In-flight parallel nodes are stopped |
| `include` | string | Name of another workflow whose nodes are inlined into this DAG at load time as a namespaced sub-DAG. Optional `with:` (named inputs → the block's `$INPUTS.<name>`) and, to fan the composed body out over a runtime list **inside this run**, `fan_out`. See [Composing Another Workflow](#composing-another-workflow-with-include) and [Fanning out a composed block](#fanning-out-a-composed-block-inside-the-run-include--fan_out) |
| `workflow` | string | Name of another workflow to run as a governed **child sub-run** at execution time, with its own run record, gates, artifacts, and cost. Optional `input` (untyped data string → child's `$ARGUMENTS`) **or** `with:` (named inputs → child's `$INPUTS.<name>`; mutually exclusive with `input`), `isolation` (`'inherit'` \| `'worktree'`), and `fan_out` (one child per item of a runtime list; optional `as:` names the per-item `$INPUTS` channel). See [Launching a Separate Governed Run](#launching-a-separate-governed-run-with-workflow) and [Workflow Signature](#workflow-signature-inputs-returns-and-inputs) |

**Common fields**: apply to all node types:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Unique node identifier. Used in `depends_on`, `when:`, and `$id.output` substitution |
| `depends_on` | string[] | `[]` | Node IDs that must complete before this node runs |
| `when` | string | unset | Condition expression. Node is skipped if false. See [Condition Syntax](#when-condition-syntax) |
| `trigger_rule` | string | `all_success` | Join semantics when multiple upstreams exist. Distinct from a fan-out node's [`fan_out.join`](#the-four-fields), which reduces one node's N children and defaults to `all_done` |
| `context` | `'fresh'` \| `'shared'` \| `{ resume: node-id }` | unset | `fresh` = new session; `shared` = inherit the ambient prior session in a sequential layer; `resume` = fork the exact completed upstream node's session. Parallel layers require named resume or fresh context |
| `idle_timeout` | number | unset | Kill node after this many milliseconds without a provider chunk. Any chunk counts as progress, thinking included. Reported live background work suspends the timer |
| `retry` | object | unset | Per-node retry configuration. See [Retry Configuration](#retry-configuration) |
| `mutates_checkout` | boolean | unset | `false` asserts this node leaves the git checkout untouched. The engine compares before/after Git status and content fingerprints of Git-visible dirty and individually listed untracked paths, excluding the run's artifacts, state, and log directories. It fails the node naming changed paths, including edits to already-dirty files and additions inside already-untracked directories. Dirty checkout cost scales with the visible dirty/untracked bytes read. This observation does not prevent writes or detect changes restored before the final snapshot; ignored paths and recursive submodule contents are not fingerprinted. Enforced on `command`, `prompt`, `bash`, and `script` nodes; the check is skipped outside a git repository or when Git or required filesystem reads fail. This includes Git status output exceeding the subprocess buffer limit (1 MiB on stdout or stderr); a large untracked tree can skip the entire assertion, even when those paths would be excluded from fingerprinting. A layer whose parallel nodes all declare it still runs in parallel, and a violation there also names the guarded siblings that ran in the same layer, since the change may not be the failing node's alone. Since one snapshot covers the whole checkout, every guarded node running when the write lands fails, not only the writer. A layer that mixes guarded nodes with any node that isn't checkout-guarded (a node of another kind, or one without `mutates_checkout: false`) runs one node at a time, so a sibling's write is never blamed on a guarded node. Distinct from the workflow-level [`mutates_checkout`](#running-sub-runs-side-by-side), which controls the path lock |
| `always_run` | boolean | `false` | Not a scheduling field: it does not change whether the node runs in a normal pass (use `when:` and `trigger_rule` for that). It opts the node out of the resume cache, so on resume it is evaluated again instead of replaying a prior completion, and still runs only if its `when:` and `trigger_rule` allow it. See [Opting Out of Resume Caching](#opting-out-of-resume-caching) |
| `output_type` | string | unset | Semantic label for this node's output (e.g. `'plan'`, `'findings'`, `'code'`). When set, the executor writes a typed output + metadata pair after the node completes (best-effort). Top-level nodes use `$ARTIFACTS_DIR/nodes/<id>.md` + `<id>.meta.json`; loop-body executions use [iteration-specific paths](#the-artifact-chain). |

**AI node options**: apply to `command` and `prompt` nodes:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | inherited | Per-node provider override (any registered provider, e.g. `'claude'`, `'codex'`) |
| `model` | string | inherited | Per-node model override |
| `output_format` | object | unset | JSON Schema for structured output. SDK-enforced on Claude/Codex/OpenCode; best-effort on Pi (answered through a `structured_output` tool call, with JSON extracted from the reply as the fallback) and Copilot (schema appended to prompt, JSON extracted + repaired). The parsed output is validated against the schema (every provider); a node that declares `output_format` but returns no schema-valid output **fails** rather than degrading silently. Also valid on `bash:`/`script:` nodes, where the node's own stdout is the payload being certified. See [Result contracts](#result-contracts). |
| `allowed_tools` | string[] | unset | Whitelist of built-in tools. `[]` = no tools. All providers except Codex |
| `denied_tools` | string[] | unset | Tools to remove. Applied after `allowed_tools`. All providers except Codex |
| `hooks` | object | unset | Per-node SDK hook callbacks. Claude only. See [Hooks](/guides/hooks/) |
| `mcp` | string \| `{ path, optional }` | unset | Path to MCP server config JSON file: checkout first, then the declaring home workflow YAML's directory (its captured copy for captured runs). Other scopes use only the checkout. Claude/Codex/Copilot. Any other provider fails the run before it starts, unless the declaration is `{ path: ..., optional: true }`, which runs the node without the servers when the provider lacks MCP or the file is missing. See [MCP Servers](/guides/mcp-servers/#optional-servers) |
| `skills` | string[] | unset | Exact Claude-native skill selection (omission/`[]` selects none); skill declarations for Pi/Copilot. Codex workflow commands/prompts invoke installed skills explicitly with `$skill-name` instead; a non-empty list on Codex or OpenCode fails the run before it starts. See [Skills](/guides/skills/) |
| `plugins` | string[] | unset | Exact plugin ids (`name@marketplace`) the node loads; omission/`[]` loads no user-installed plugin. Claude and Codex; any other provider fails the run before it starts. See [Plugins](#plugins) |
| `agents` | object | unset | Inline sub-agent definitions keyed by kebab-case ID. Claude only. See [Inline sub-agents](#inline-sub-agents) |
| `effort` | `'minimal'`\|`'low'`\|`'medium'`\|`'high'`\|`'xhigh'`\|`'max'`\|`'ultra'`\|`'persistent'` | unset | Reasoning depth. Every provider with a request-level reasoning control: Claude/Codex/Pi/Copilot. Codex accepts all eight; the others clamp unsupported rungs down to the nearest weaker value. OpenCode configures reasoning in `opencode.json`. Also settable at workflow level |
| `maxBudgetUsd` | number | unset | USD cost cap; node fails if exceeded. Claude only. Per-node only. For a ceiling across the whole run, see [Run budgets](#run-budgets) |
| `systemPrompt` | string | unset | Set system instructions for this node (Claude/Codex/Pi/Copilot/OpenCode). Replaces the default `claude_code` prompt on Claude. Per-node only |
| `fallbackModel` | string | unset | Model to use if primary model fails. Claude only. Also settable at workflow level |
| `betas` | string[] | unset | SDK beta feature flags (e.g., `'context-1m-2025-08-07'`). Claude only. Also settable at workflow level |
| `sandbox` | object | unset | OS-level filesystem/network restrictions for the Claude subprocess. Claude only. Also settable at workflow level |
| `settingSources` | (`'project'`\|`'user'`)[] | inherited | Which filesystem setting sources a capable provider discovers (for Claude: CLAUDE.md, skills, commands, agents). Workflow `skills:` remains the exact active skill set. Overrides the assistant-level default; unset everywhere = `['project', 'user']`. `[]` loads none. Requires the provider's `settingSources` capability. Per-node only |

### Bash and script node timeouts

When a host `bash:` or `script:` node reaches its `timeout`, Archon signals the node's
process tree, including work behind a wrapper such as `bun run` or `uv run`.
On Windows it runs `taskkill /T /F` on the node's process. On macOS and Linux, foreground
CLI commands and `archon serve` start each node in its own process group and send that
group `SIGTERM`. Detached CLI runs now use separate node groups too.
`until_bash` checks end only their own process. A container node's timeout ends only the
local `docker exec` client, so the command inside the container may keep running.

For a detached POSIX node, Archon signals the group only while its leader is unreaped,
then inspects the process table to confirm the group is gone before reporting an ordinary
timeout. It never sends a delayed group signal after the leader exits. If members remain,
inspection fails, or termination fails, the node fails with a cleanup error instead of
taking `on_timeout: skip`. If the leader ignores `SIGTERM`, Archon can kill that unreaped
leader by exact PID; it does not escalate the group after reaping.

Foreground and serve timeouts do not confirm group disappearance or send a later group
`SIGKILL`. A process that handles or ignores `SIGTERM` can outlive their reported timeout;
when that process is the node's own process, timeout reporting waits for its exit.
A process that deliberately leaves the node's group, for example with `setsid`, escapes
group cleanup. Background jobs left by an already-completed node are outside this cleanup.

If a tree cannot be ended, the node fails with the termination error instead of timing
out. Dependents follow their `trigger_rule` as for any failed node.

Cancelling a run that `archon serve` executes ends the process tree of each of that run's
running host `bash:` and `script:` nodes and `until_bash` checks within about a second
(`SIGKILL` to the node's process group on macOS and Linux, `taskkill /T /F` on Windows), and
records the node failed as cancelled. Other runs' processes are not touched. A process that
left the node's group with `setsid` escapes. On Windows, background work whose node process
already exited is not reached. A container node's command is not reached.
On macOS and Linux, detached cancellation first stops unfinished node groups whose leaders
are still unreaped, then stops the owner group and confirms those groups are gone.
Archon never signals a group whose leader was already reaped. If a node's output pipes
remain held after safe group signals, cancellation still ends the run and warns in the
cancel result and run event that some process outside the run's process group holds the
output and was not signalled. Archon does not identify that holder. Use `lsof` on the run's
checkout to find it before reusing or removing the checkout.
Background jobs of already-completed nodes are excluded from automatic signalling.
For POSIX host commands that started or completed, cancellation reports possible untracked
background work in the cancel result and run event, including after continuation under a
new detached owner. Neither a survivor nor cleanup is confirmed. Inspect checkout processes
with `lsof`, verify ownership, and stop leftovers before checkout reuse or removal.
Owner-stop warnings retain owned checkouts for inspection.
Detached POSIX commands rely on
explicit cancellation; abrupt owner death does not run their group cleanup.
On Windows, cancellation ends the
owner's Job Object, which also holds node processes whose parent already exited.

### Addressable session ancestry

Dependency edges determine execution and `$node.output` carries data. When a later command or prompt must continue one particular AI conversation instead of the latest ambient session, name that completed upstream node:

```yaml
provider: claude
nodes:
  - id: scope
    prompt: Scope the work

  - id: lens-a
    prompt: Review one aspect of $scope.output
    context: fresh
    depends_on: [scope]

  - id: lens-b
    prompt: Review another aspect of $scope.output
    context: fresh
    depends_on: [scope]

  - id: synthesize
    prompt: Synthesize $lens-a.output and $lens-b.output
    context:
      resume: scope
    depends_on: [lens-a, lens-b]
```

`synthesize` forks the exact provider session produced by `scope`; the parallel lenses do not change that ancestry. The source must be a transitively upstream command, prompt, or plain `loop:` node, and the consumer must be a command or prompt node. Inside a `loop_group` body, the source takes one of two forms:

- **An enclosing ancestor** that completes before entry into the group: a command, prompt, or plain `loop:` node outside the body. The first owner turn forks that source; later iterations continue the private branch with the same session ID. Fresh reviewers and `fresh_context: true` leave that branch intact. Terminal body attention waits and other durable waits, and the deprecated interactive gates and terminal body approvals, restore its provider-tagged cursor. A missing cursor snapshot, lost session, or changed session ID fails rather than silently starting over. Failure resume still restarts the group at iteration 1. See [Named owner sessions](/guides/loop-nodes/#named-owner-sessions) for an example.
- **An upstream node in the same body**: each iteration's consumer forks that iteration's session of the source. It never continues an earlier iteration's branch. A nested group's pause between the source and the consumer resumes within the paused iteration, which re-runs the source, so the consumer forks the re-run source. A terminal body attention wait compares the question on the first answer and may ask again in the same iteration; after one re-ask, it accepts the next answer even if the question changes again. Once an answer is accepted, `until_bash` determines whether the group completes or starts the next iteration. See [Same-iteration sessions](/guides/loop-nodes/#same-iteration-sessions).

Scalar `context: shared` is only for ambient session threading through a sequential layer. It is rejected on a node in a structurally parallel layer because there is no single unambiguous ambient lineage there. Use named resume as above, or add dependencies to serialize the nodes. This remains a structural rule when sibling `when:` conditions appear mutually exclusive: Archon constructs the parallel layer before evaluating those conditions.

This is an exact, immutable fork contract:

- Source and consumer must resolve to the same provider.
- Claude, Codex and Pi support immutable forks. A provider that omits the fork capability does not.
- A missing source handle, unavailable prior context, missing branch handle, or provider that reuses the source session fails the node. Named resume never falls back to a fresh session.
- Two parallel consumers may name the same source; each receives its own branch while the source remains unchanged.
- Run resume restores these private handles for completed nodes, so a pause or process restart does not lose declared ancestry. Each node's full session ID is recorded on its node record; transcripts and logs carry at most an eight-character preview.

This is separate from `persist_session`: `{ resume: source }` selects ancestry within one governed run, while `persist_session` continues the same node across separate workflow invocations. If both apply to a consumer, the named source wins for the current invocation and the resulting branch is still saved for its next invocation.

### Claude SDK Advanced Options

These node options pass through to the provider. `effort`, `fallbackModel`, `betas` and `sandbox` can also be set at the workflow level as defaults; a node's own value wins. `maxBudgetUsd`, `systemPrompt` and `settingSources` are per node only (`settingSources` also has an assistant-level default in `.archon/config.yaml`). A provider that does not support an option warns and ignores it.

**effort** is the one reasoning-depth field, on every provider that has a request-level reasoning control (Claude, Codex, Pi, Copilot):

```yaml
- id: thorough-review
  command: review
  effort: high   # minimal | low | medium | high | xhigh | max | ultra | persistent
```

The ladder is the union of every provider's vocabulary. Codex accepts all eight rungs. Other providers clamp an unsupported rung to the nearest weaker value, and use the shallowest stronger value only when no weaker one exists. For example, `persistent` and `ultra` become `max` on Claude, Pi and Copilot, while `minimal` becomes `low` on Claude and Copilot. OpenCode configures reasoning in `opencode.json`, so `effort:` there warns and is ignored.

**systemPrompt** replaces Claude's `claude_code` preset. Codex includes the instructions in the user prompt, and Copilot appends them to its foundation prompt.

**sandbox** adds OS-level filesystem and network restrictions to the Claude subprocess, on top of worktree isolation:

```yaml
- id: untrusted-code-analysis
  command: analyze-external
  sandbox:
    enabled: true
    network:
      allowedDomains: []
      allowManagedDomainsOnly: true
    filesystem:
      denyWrite: ['/etc', '/usr']
```

**settingSources** controls which filesystem setting sources a capable provider discovers. For Claude these are the project's `CLAUDE.md` and `.claude/` skills, commands and agents, and the user-level `~/.claude/`. For skills it controls eligibility, not activation: `skills:` selects the exact active set, and each declared skill must exist under an enabled source. Fewer sources give a leaner context and a faster node start:

```yaml
- id: lean-review
  command: review
  settingSources: []              # no setting sources; skills must be omitted or []

- id: implement
  command: implement
  settingSources: ['project']     # project sources only, skip ~/.claude/
```

Omitting the field inherits `assistants.<provider>.settingSources` from `.archon/config.yaml`; if that is unset too, the default is `['project', 'user']`. Providers without the `settingSources` capability warn and ignore the field. Validation checks host skill paths, so a skill found only in a host user directory may be unavailable in container execution. Provider preflight checks the run's actual scope.

### Plugins

A Claude workflow node loads none of the Claude Code plugins installed on the machine: no plugin subagents, hooks, LSP servers, commands, skills or MCP servers. Your own settings, hooks, permissions and `CLAUDE.md` still load, and so do the plugins built into Claude Code (`@builtin`). A node that needs a plugin names it by its exact id, as `claude plugin list` prints it:

```yaml
- id: triage
  prompt: Find the noisiest error groups from the last day.
  plugins: [posthog@claude-plugins-official]
  skills: [posthog:investigating-error-issue]   # a plugin's skills are still selected one by one
  mcp: .archon/mcp/posthog.json                 # and its MCP servers are declared like any other
```

A named plugin brings its agents, hooks, LSP servers and commands. Its skills reach the node only when `skills:` names them, and its MCP servers only through `mcp:` (see [MCP Servers](/guides/mcp-servers/#servers-that-ship-in-a-claude-plugin)).

The node fails before its first model turn when a named plugin is not installed, or when Claude Code reports a loaded plugin the node did not name, for example one synced from claude.ai or loaded by another route.

A Codex workflow node works the same way. It loads none of the user's Codex plugins and no ChatGPT apps, while the user's `config.toml` settings, hooks and `AGENTS.md` still load. A node names a plugin by the id `codex plugin list` prints, such as `github@openai-curated`. A named Codex plugin brings its skills, which the node body invokes as `$<plugin>:<skill>`, and its hooks. Its MCP servers reach the node only through `mcp:` (see [MCP Servers](/guides/mcp-servers/#servers-that-ship-in-a-codex-plugin)), and its apps stay off. A named plugin is turned on for the node even if you turned plugins off globally in Codex. The node fails before its turn starts when a named plugin is not installed in the Codex home in use.

`plugins:` on a provider that cannot load exactly the named plugins fails the run before any node starts, and `archon validate workflows` reports it as an error. A required `mcp:` and a non-empty `skills:` follow the same rule on a provider without that capability. An `mcp:` declared `optional: true` runs the node without its servers instead and records why (see [Optional Servers](/guides/mcp-servers/#optional-servers)).

**Workflow-level defaults** (inherited by all Claude nodes unless overridden per-node):

```yaml
name: my-workflow
effort: high         # All Claude nodes use high effort by default
fallbackModel: claude-haiku-4-5-20251001
betas: ['context-1m-2025-08-07']
sandbox:
  enabled: true

nodes:
  - id: step1
    command: step1
    # Inherits workflow-level effort, fallbackModel, betas, sandbox

  - id: step2
    command: step2
    effort: low      # Per-node override — ignores workflow-level effort
```

### `trigger_rule` Values

| Value | Behavior |
|-------|----------|
| `all_success` | Run only if all upstream deps completed successfully (default) |
| `one_success` | Run if at least one upstream dep completed successfully |
| `none_failed_min_one_success` | Run if at least one dependency succeeded and none failed or skipped because of an upstream failure (`upstream_failed`) |
| `all_done` | Run when all deps are in a terminal state (completed, failed, or skipped), except an interaction in a loop body after a body failure (see [loop failure behavior](/guides/loop-nodes/#how-it-works)) |

`none_failed_min_one_success` blocks failure-cascade skips by default, including
across dependency chains and includes. The skipped join retains the original failed
node in its `upstream_failed` cause. Condition skips and optional timeout
skips (`on_timeout: skip`) remain admissible when another dependency succeeds.

A dependency skipped by its own `when:` provides neither a success nor a failure.
When a `none_failed_min_one_success` node has a single dependency and that
dependency has a `when:`, the node skips every time the condition is false. The
loader warns about this shape, naming the node; both `archon validate workflows`
and run loading report the warning. Joins over several conditional dependencies
are not flagged, since they are usually branches where one always runs.

To run after an optional gate, also depend on an unconditional node that runs before it.
That node's success satisfies the success requirement when the gate is
condition-skipped, while a failed gate still blocks the join:

```yaml
name: optional-gate
description: Run the next step whether the optional gate ran or skipped
nodes:
  - id: review
    bash: echo ready
  - id: gate
    depends_on: [review]
    when: "$review.output != 'ready'"
    wait:
      attention: "Review found issues. Approve to continue."
      form: approval
  - id: stop
    depends_on: [gate]
    when: "$gate.output.decision == 'reject'"
    cancel: "Review issues were not approved"
  - id: next
    depends_on: [review, gate, stop]
    trigger_rule: none_failed_min_one_success
    bash: echo continue
```

A rejection is an answer, so `gate` completes either way. `next` also depends on
`stop`, which cancels the run on a rejection before `next` can start.

Use `all_done` instead only when the next step should run even after the gate fails.

`all_success`, `one_success`, and `all_done` keep their existing behavior.
`if_skipped` supplies a value for a skipped output binding; it does not make a
blocked node eligible to run or permit binding a failed output.

:::note[`trigger_rule` is not `fan_out.join`]
They share value names and have **different defaults**, so it is worth keeping straight:

- **`trigger_rule`** (any node) decides whether *this* node runs, given the states of the
  nodes it `depends_on`. Default `all_success`: don't run if an upstream failed.
- **[`fan_out.join`](#the-four-fields)** (fan-out nodes only) reduces the outcomes of one
  node's N children into that node's single outcome. Default `all_done`: children are
  independent, so one failing still yields the others.

Upstream dependencies are steps you chose to sequence; fan-out children are N instances of
one step. Hence the different defaults.
:::

### `when:` Condition Syntax

Conditions gate whether a node runs based on upstream node outputs.

**String operators** (value compared as string):
```yaml
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"
when: "$nodeId.output.field == 'VALUE'"    # JSON dot notation for output_format nodes
```

**Numeric operators** (the right-hand side must be a number; a non-numeric output at run time skips the node):
```yaml
when: "$nodeId.output > '80'"
when: "$nodeId.output >= '0.9'"
when: "$nodeId.output < '100'"
when: "$nodeId.output <= '5'"
when: "$nodeId.output.score >= '0.9'"      # dot notation + numeric comparison
```

**Compound expressions** (`&&` binds tighter than `||`):
```yaml
when: "$a.output == 'X' && $b.output != 'Y'"
when: "$a.output == 'X' || $b.output == 'Y'"
when: "$score.output > '80' && $flag.output == 'true'"
# Precedence: (A && B) || C
when: "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'"
```

To express `A && (B || C)`, expand it to `A && B || A && C`:
```yaml
when: "$a.output == 'x' && $b.output == 'y' || $a.output == 'x' && $c.output == 'z'"
```

**Declared inputs** (see [Workflow Signature](#workflow-signature-inputs-returns-and-inputs)):
```yaml
when: "$INPUTS.mode == 'fast'"              # branch on a caller's `with:` value
when: "$INPUTS.mode == 'fast' && $check.output.ok == 'true'"
```

**Previous loop iteration**: only in a `loop_group` body:
```yaml
when: "$LOOP_PREV.run-tests.output.verdict == 'red'"
```

`$LOOP_PREV.<nodeId>.output[.field]` reads that body node's typed output from the
previous iteration; it is a condition reference, not text substitution. On iteration 1,
there is no prior output, so it resolves to `''` and the non-empty equality above is false.

- `$nodeId.output` references the full output string of a completed node
- `$nodeId.output.field` accesses a JSON field (for `output_format` nodes)
- `$nodeId.output.a.b` accesses nested object fields, checked against every declared schema
  segment. Paths stop at arrays; indexing, wildcards, and expressions are unsupported.
- A field used in a scalar condition must resolve to a string, number, boolean, or null. A present object or array fails the gated node; expose a scalar decision field or inspect structured data in a script node.
- `$INPUTS.<name>` references a declared input supplied by a caller's `with:` (or a direct
  run's `--input`). A name this run does not carry **fails the node**: it never quietly
  becomes an empty string. `INPUTS` is a reserved scope: a node cannot be given that id
  (the loader rejects it), so `$INPUTS.x` always means an input.
- Invalid or unsupported expression syntax is rejected when workflows load and by `archon validate workflows`.
- A numeric operator (`<`, `>`, `<=`, `>=`) needs a number on the right-hand side, quoted or bare; any other literal is rejected at load. If the left-hand value is not a number at run time, the node is skipped (fail-closed).
- Grouping parentheses are not supported. Use AND/OR precedence or compute a decision in a `script:` node and gate on its scalar output.
- Skipped nodes propagate their skipped state to dependants
- A **failed** producer's output is never evaluated, fielded or whole-text. A `when:`
  joined past a failure via `trigger_rule: all_done` must branch on a different node's
  output; referencing the failed producer's own output fails the condition's node loudly
  (see [Reading across a skipped branch](#reading-across-a-skipped-branch))

:::danger[Current-node whole AI output comparisons are rejected]
A `when:` that uses `$nodeId.output` to compare the **entire output** of a `prompt:`, `command:`, or `loop:` node with no
`output_format`, or of any `loop_group:` node, against a literal is
**rejected at load time**:

```yaml
# REJECTED — $analyze is an AI node with no output_format
- id: analyze
  prompt: "Is this a bug or a feature?"
- id: decide
  depends_on: [analyze]
  when: "$analyze.output == 'BUG'"
```

This loader rule does not reject previous-iteration `$LOOP_PREV.<nodeId>.output` comparisons.

The model writes `This is a BUG.` and the byte-for-byte comparison is false, so the node
is skipped with no error and the run finishes looking successful having quietly done less
than you asked. Declare the shape you are branching on instead:

```yaml
- id: analyze
  prompt: "Is this a bug or a feature?"
  output_format:
    type: object
    properties:
      status: { type: string, enum: [BUG, FEATURE] }
    required: [status]
- id: decide
  depends_on: [analyze]
  when: "$analyze.output.status == 'BUG'"
```

Unaffected: `bash:` and `script:` producers keep whole-output comparison
(`when: "$check.output == 'true'"`) because their stdout is author-controlled and exact by
construction, and so do deprecated `approval:` captures (typed by whoever answered) and `workflow:` sub-run
results (the callee owns that contract). A scalar field access (`$analyze.output.status`) is
allowed.

**A `loop:` opts out the same way a `prompt:` node does**: declare `output_format` on it
and the loop's output becomes the validated JSON document, so `$loop.output.field` is
available to gate on. (Before #2563 the field was dropped at parse and this was a no-op.)

**A `loop_group:` still has no opt-out.** It keeps the field, but the group's output is the
*last iteration's raw text* and a schema never replaces it with the JSON document the way it
does on a `prompt:` or `loop:` node. The group never calls the provider itself. Compute the
decision in a `bash:`/`script:` node, or an `until_bash` check, and gate on that node's
output instead.
:::

### `$node_id.output` Substitution

In node prompts and commands, reference the output of any upstream node:

```yaml
nodes:
  - id: classify
    command: classify-issue

  - id: fix
    command: implement-fix
    depends_on: [classify]
    # The command file can use $classify.output or $classify.output.field
```

Standard variables (`$WORKFLOW_ID`, `$USER_MESSAGE`, `$ARTIFACTS_DIR`, etc.) and node output
references resolve in one pass over the template. A substituted value is inserted as written
and never scanned again, so a message or an upstream output that quotes `$nodeId.output`
reaches the node unchanged. See [Substitution Order](/reference/variables/#substitution-order).

Output references can follow nested object fields. For example, this wait asks
`Proposed: add` when `review` emits `{"proposal":{"action":"add"}}`:

```yaml
nodes:
  - id: review
    prompt: Propose an action
    output_format:
      type: object
      properties:
        proposal:
          type: object
          properties:
            action: { type: string }
          required: [action]
      required: [proposal]
  - id: gate
    depends_on: [review]
    wait:
      attention: "Proposed: $review.output.proposal.action"
    when: "$review.output.proposal.action == 'add'"
```

A whole-value binding such as `with: { proposal: "$review.output.proposal" }`
preserves its object value. `$LOOP_PREV.review.output.proposal.action` uses the same
path rules for a prior loop iteration (empty on the first iteration). Paths contain
object field names only: no array indexing, wildcards, or expressions. `when:` still
requires a scalar, and `$node.field` shorthand cannot nest.

A reference to a **failed** producer (fielded or whole-text) fails the node doing the
substitution instead of splicing in the failed producer's leftover output; a `bash:`/
`prompt:`/`command:` body must not assume a dependency succeeded just because it was
allowed to run (`trigger_rule: all_done`).

:::caution[Assign output references, then quote the variable in shell bodies]
In `bash:` and `until_bash:`, Archon injects `$nodeId.output`, `$nodeId.output.field`, and `$LOOP_PREV.nodeId.output[.field]` using two forms:

- Small string outputs are single-quoted inline, such as `'a b   c *'`.
- Outputs exceeding 32,768 UTF-16 code units (JavaScript `string.length`) spill to the run-owned `$ARTIFACTS_DIR/.archon/node-output-spills/<write-id>.<node>[.<field>].nodeoutput` file and become `$(cat '<path>')`. These files follow the [run-artifact retention lifecycle](/reference/archon-directories/#user-level-archon).

A bare argument such as `printf '%s' $emit.output` works with the inline form, but the unquoted command substitution in the spill form splits words and expands globs. Wrapping the reference in double quotes breaks the inline form instead: `value="$emit.output"` becomes `value="'a b   c *'"`, preserving the single quotes as data. Single quotes around a reference also produce the wrong value.

**Rule: assign, then quote the variable.** Keep the reference as the whole, unquoted assignment value; quote the shell variable wherever you use it:

```bash
value=$emit.output
printf '%s' "$value"

status=$emit.output.status
[ "$status" = "ok" ]
```

Assignments suppress word splitting and glob expansion in both regimes. `export value=$emit.output` and `local value=$emit.output` are also safe. Numeric and boolean fields are injected raw, but use the same idiom so a change to a string value remains safe.

`archon validate workflows` warns about quoted references and bare references outside complete assignments. Heredoc bodies remain outside this check.
:::

### `output_format` for Structured JSON

Use `output_format` to enforce JSON output from an AI node. For Claude, the schema is passed via the SDK's `outputFormat` option and `structured_output` is used directly. For Codex, the schema is sent as the turn's `outputSchema` and the agent's final JSON message is used. Both ensure clean JSON for `when:` conditions and `$nodeId.output` substitution:

`archon validate workflows` warns when an enforced object schema declares `properties`
but has neither a non-empty `required` array nor `additionalProperties: false`. Such a
schema can accept missing fields or a schema-echo response, leaving downstream field
references empty and skipping gated work. Require the fields downstream nodes need;
use `additionalProperties: false` to reject undeclared fields, and string `enum` values
to constrain decisions. The warning leaves runtime semantics unchanged: intentionally
optional fields and open-record maps remain supported. Codex strict-mode errors take
precedence over this warning.

> **Codex strict-mode normalization.** OpenAI's Structured Outputs validator rejects any object schema that doesn't set `additionalProperties: false`. Archon normalizes Codex schemas before sending them, injecting `additionalProperties: false` on every object node automatically, so write portable schemas and you won't notice. One caveat: an open-record `additionalProperties: { type: 'string' }` (or `additionalProperties: true`) is **replaced** with `false`, closing the object. OpenAI would reject the open form regardless, but the rewrite is logged (`codex.output_format_open_record_closed`) so it isn't silent. Open-record maps aren't supported for Codex structured output.
>
> **Codex strict-mode object schemas.** OpenAI's Structured Outputs validator rejects an object schema that omits `properties`, or where a key declared in `properties` is absent from `required`. Unlike `additionalProperties`, Archon does NOT normalize these cases for you: it cannot infer a bare object's intended shape, and filling `required` would silently change an optional field into a required one. Instead, the launch preflight and `archon validate workflows` report the node and exact schema path before any run starts. Declare every object's properties and include every property key in `required`. To express an *optional* value, give its type an absent-value form: a `["string","null"]` or `["object","null"]` union, or an enum with a sentinel like `"none"`: the field is then always "present" in the output, carrying the absent value when not applicable.

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
        severity:
          type: string
          enum: [low, medium, high]
      required: [type, severity]
```

- The output is captured as a JSON string and available via `$classify.output` (full JSON) or `$classify.output.type` (field access)
- Use `output_format` when downstream nodes need to branch on specific values via `when:`
- **Validated + reask + fail-fast.** The parsed output is validated against your schema for *every* provider (a net for refusals / `max_tokens` truncation that bypass even SDK enforcement). On a miss, best-effort providers (Pi/Copilot) re-ask up to 3× with the schema errors appended; enforced providers fail immediately. A node that declares `output_format` but still has no schema-valid output **fails**: it no longer completes-with-prose and silently feeds `''` downstream.
- **Field access is strict at every depth.** Each segment in `$classify.output.details.type` must be an explicit `properties` entry. An undeclared segment, at any depth, fails workflow validation when the local schema is known, and fails the consumer at runtime otherwise. Arrays, `additionalProperties`, `$ref`, and schema combinators do not authorize nested properties. Declared missing/null fields or parents resolve to `''`, after the entire path is checked. A schemaless `bash:`/`script:` producer must emit every nested key and every intermediate value must be an object. Child workflow results carry the selected producer's declared paths through completion and resume; a child result recorded before nested paths carries only its top-level fields, so a nested read from it fails as undeclared until the producer reruns. See [node output references](/reference/variables/#node-output-references).

`output_format` is not AI-only, and it is not only a branching aid: it is how *any* producing node declares the shape of the value it hands downstream, including a workflow's own result. [Result contracts](#result-contracts) is the one description of that ownership: who declares a schema, what an `include:` alias and a `workflow:` sub-run each guarantee, and how a small result points at a large file.

### `allowed_tools` and `denied_tools` for Tool Restrictions

Restrict which built-in tools a node can use without relying on prompt instructions. Restrictions are enforced at the Claude SDK level.

```yaml
nodes:
  - id: review
    command: code-review
    allowed_tools: [Read, Grep, Glob]   # whitelist — only these tools available

  - id: implement
    command: implement-feature
    denied_tools: [WebSearch, WebFetch] # blacklist — remove these tools

  - id: mcp-only
    command: mcp-command
    allowed_tools: []                   # empty list = disable all built-in tools
```

- `allowed_tools: []` disables all built-in tools (useful for MCP-only nodes). Use the `mcp` field on a node to attach per-node MCP servers. See [Node Fields](#node-fields)
- If both are set, `denied_tools` is applied after `allowed_tools`
- `undefined` (field absent) and `[]` have different semantics: absent means use default tool set, `[]` means no tools
- Supported on all providers except Codex: Codex nodes/steps emit a warning and continue (Codex doesn't support per-call tool restrictions)

### Inline sub-agents

Define Claude sub-agents directly in the workflow YAML, without authoring `.claude/agents/*.md` files. The main agent can spawn them in parallel via the `Task` tool, useful for map-reduce patterns where a cheap model (e.g. Haiku) briefs items and a stronger model reduces.

```yaml
nodes:
  - id: triage
    prompt: |
      Fetch open issues via `gh issue list ...`. For each issue, spawn the
      brief-gen sub-agent in parallel (one message, multiple Task tool calls)
      to produce a 2-3 sentence brief. Then cluster briefs for duplicates.
    model: sonnet
    allowed_tools: [Bash, Read, Write, Task]
    agents:
      brief-gen:
        description: Summarises a single GitHub issue in 2-3 sentences
        prompt: |
          You are concise. Read the issue provided in the caller's prompt.
          Return JSON { summary, primarySymptom, affectedArea }.
        model: haiku
        tools: [Bash, Read]
```

Keys:

- Agent IDs must be **kebab-case** (`^[a-z0-9]+(-[a-z0-9]+)*$`)
- Each definition requires `description` and `prompt`; `model`, `tools`, `disallowedTools`, `skills`, and `maxTurns` are optional
- Map is merged with any SDK-level agents and composes independently with native Claude `skills:` selection
- Claude only. Codex and community providers that don't support inline agents emit a warning and ignore the field

**When to use `agents:` vs `.claude/agents/*.md` files:**

- **`agents:` (inline)**: use when the sub-agent is specific to ONE workflow's needs. Keeps the workflow self-contained in a single YAML file; travels cleanly in PRs and forks.
- **`.claude/agents/*.md` (on-disk)**: use when the sub-agent is shared across multiple workflows OR the whole project (for example, a `triage-agent` used by several maintenance workflows). On-disk agents live outside workflow YAMLs and are picked up automatically by the Claude Agent SDK.

Both sources coexist: inline agents and on-disk agents are both available to `Task(subagent_type=...)` at runtime.

## Durable waits

A `wait:` node records its condition in the workflow run, changes the run to `paused`, and returns the worker slot. Time and event waits carry an absolute deadline and resume through the ordinary DAG resume path when it arrives, enforced by the process that owns the run (see below). An attention wait has no deadline: it needs attention until someone answers it, and the answered run continues on its own. Restarting Archon preserves every kind.

Declare exactly one condition:

```yaml
nodes:
  - id: cool-down
    wait:
      duration_ms: 3600000

  - id: maintenance-window
    depends_on: [cool-down]
    wait:
      until: "2026-08-25T22:00:00Z"

  - id: checks
    depends_on: [maintenance-window]
    wait:
      event: checks.complete
      deadline_ms: 86400000

  - id: rerun-checks
    depends_on: [checks]
    wait:
      attention: >-
        Re-run the failed external check, then answer with what you found.
```

- `duration_ms` starts once, then persists the resulting absolute time. An early manual resume pauses again against the same time; it does not restart the duration.
- `until` accepts an ISO-8601 timestamp after `$node.output` substitution.
- `event` requires `deadline_ms`. If no matching signal arrives by the deadline, the node completes with `status: expired`; event waits cannot remain open forever.
- `attention` is a non-empty question the run needs answered. The message can reference node outputs, enclosing loop scopes (`$LOOP_PREV`) and `$INPUTS`; other workflow variables such as `$ARTIFACTS_DIR` stay literal. It takes an optional `form` and, for some forms, `options`; see [Attention waits](#attention-waits).
- `duration_ms` and `deadline_ms` are capped at 1000 years so their persisted RFC3339 timestamps always remain executable.

A satisfied time or event wait produces the fixed structured output `{ status, waited_ms, event?, payload? }`. `status` is `satisfied` or `expired`. An attention wait's output is its answer, in the shape its form fixes. Downstream `when:` or `until_bash` wiring can branch without parsing prose. `output_format`, `retry`, and `always_run` cannot be set on a wait; the engine owns its output and continuation lifecycle.

### Attention waits

An attention wait pauses until someone answers it, in the form it declares. For several independent questions in one pass, [fan out one child per question](#several-independent-questions). Archon does not route the question or care who answers: a person in the console, an agent through the CLI, or a handler workflow all use the same answer channel.

```yaml
  - id: ask
    depends_on: [plan]
    wait:
      attention: "$plan.output.question"
      form: select                       # message (default) | approval | select | multi_select
      options:                           # select and multi_select only
        - { id: use-main, label: "Base on main" }
        - { id: use-dev }
      labels:                            # optional; values may use runtime references
        about: "$plan.output.topic"
```

| Form | Answer accepted | The next node reads |
|---|---|---|
| `message` | free text, which may be empty | `{ text }` |
| `approval` | `approve` or `reject`, plus optional text | `{ decision, text }` |
| `select` | exactly one declared option id, plus optional text | `{ decision, text }` |
| `multi_select` | one or more distinct declared option ids, plus optional text | `{ decisions, text }` |

- `options` is required for `select` and `multi_select` and a load error on the other forms. Option ids are unique and kebab-case; `label` is display text only.
- `options` may instead be one whole reference to an upstream output, `options: "$plan.output.options"`. It is read when the wait pauses and must pass the same rules: an array of `{ id, label? }` with unique kebab-case ids and at least one entry. If it does not, the wait node fails with an error naming the producer; it never pauses with options nobody can answer. When the producer declares `output_format`, the loader also checks that the field is an array of `{ id, label? }`.
- `form` is always a literal, because it fixes the node's output contract, so a strict `$ask.output.decision` reference is checked at load time.
- An undeclared option is refused on every surface. In the `approval` form `reject` is an answer like any other and never cancels the run; wire `cancel:` with `when: "$ask.output.decision == 'reject'"` if a rejection should end it.
- `labels` is an optional flat map of strings, resolved when the wait pauses. The engine gives labels no meaning; your own handler workflows select items in the [attention queue](/getting-started/operate/) by them.

Answer with [`archon workflow answer`](/reference/cli/#workflow-answer), `POST /api/workflows/runs/<run-id>/answer`, or the console. `approve`, `reject` and `respond <option>` work as shorthand on every surface: `approve [text]` answers a `message` wait with its text, and otherwise each verb chooses the option of the same id. An answer that names its occurrence is refused if it targets an earlier pause of the same run. For HTTP `/approve`, `/reject` and `/respond`, include the optional `expectedGate` using the [gate identity instructions in the API reference](/reference/api/#approve--reject-a-paused-run); omitting it answers the current pause. The answer is recorded with the surface it came through and the time (`answeredVia`, `answeredAt` on the wait, and a `wait_answered` event). The run stays `paused` until a continuation host (`archon serve`, or `archon workflow wake`) continues it; answering through the CLI without `--json` continues it in that process.

On the first answer, an attention wait compares its current message, form, and options with the question it paused on. If they changed, it discards the old answer and asks a fresh question. After this one re-ask, the next answer is accepted without comparing the question again, even if it changed. This bound prevents a question built from a value that changes on every resume from blocking the run forever. Loop-owned questions use the paused iteration's body outputs and saved loop reference values without repeating body work. Older loop waits without saved loop references can still resume when their question does not use those references; otherwise validation fails with a restart explanation. An older Archon binary can strip the saved references when writing the wait, so keep the newer binary for runs using this protection.

A wait paused before attention waits took answers has no pause id. It reads as a `message` wait, takes no answer, and continues with `archon workflow resume <run-id>`. A bare resume also completes any `message` wait, with empty text; the other forms refuse it until they are answered.

Before forms existed, an attention wait produced `{ status, waited_ms }`. It now produces only its answer, so a workflow that reads `status` or `waited_ms` from an attention wait fails to load; read `text` instead. A run paused at such a wait usually resumes from the workflow source it captured, which still reads the old fields, so it cannot resume: abandon it and start a fresh run of the edited workflow.

Signal one exact run through the authenticated API:

```bash
curl -X POST http://localhost:3090/api/workflows/runs/<run-id>/signal \
  -H 'Content-Type: application/json' \
  -H 'X-Archon-User: <trusted-user-id>' \
  -d '{"event":"checks.complete","occurrence":"<metadata.wait.pauseId>","payload":{"conclusion":"success"}}'
```

Use a Better Auth session cookie instead of `X-Archon-User` when browser authentication is enabled. The header is only for a trusted reverse proxy or loopback client; an auth-disabled local install can omit it. The event name must match the run's open wait. The signal and its audit event are committed together; duplicate or wrong-run signals do nothing.

The process that owns the run enforces a `duration_ms`/`until`/`event` deadline itself: a foreground `archon workflow run` and the child started by `--detach` stay alive through the wait and re-execute the run when its deadline arrives, so a CLI-only install needs no server. If the owner has exited, [`archon workflow wake`](/reference/cli/#workflow-wake) resumes due waits without a server; a running `archon serve` performs the same scan automatically. The same scan continues a gate or attention wait that was answered without being resumed, for example through `--json`. A run can always be advanced by hand with `archon workflow resume <run-id>`. The `/signal` endpoint above requires the server; [`archon workflow signal`](/reference/cli/#workflow-signal) signals the same exact event occurrence from the CLI.

Read `metadata.wait.pauseId` from the run and pass it as `occurrence` (`--occurrence` in the CLI). A stale occurrence cannot signal a later wait, even when event and deadline repeat. `resumeAt` (`--resume-at`) remains accepted for compatibility; without an occurrence it cannot distinguish waits with the same event and deadline. When both selectors are supplied, both must match. Persisted waits without a `pauseId` can still be signaled by deadline and remain resumable. Slot release and automatic continuation also check `pauseId`, a fresh UUID for each new deadline wait.

A wait may be the sole terminal sink in a `loop_group` body. Archon then escalates the persisted cursor to the group and rechecks the group's completion condition after the wait completes. `max_iterations` still bounds uninterrupted autonomous iterations, but continuing past a terminal `attention` wait (an answer, or a resume of a wait from before answers) permits one fresh iteration even after that bound; each further probe needs another answer. The next iteration reads the answer as `$LOOP_PREV.<wait-id>.output`. A non-terminal body wait, or a non-terminal deprecated `approval:` gate, is rejected because resuming a partial iteration would otherwise require replaying already-completed sibling work. A terminal `attention` wait is read past for the group's output, so `$group.output` is the work the wait depends on; see [Pausing to ask inside the body](/guides/loop-nodes/#pausing-to-ask-inside-the-body). Waits below more than one nested `loop_group` boundary are not supported.

Durable waits are not supported in container-isolated workflows. The server cannot reconstruct the CLI-owned container context needed for an automatic continuation, so Archon rejects this combination before creating the run. Automatic quota-window continuation is likewise skipped for container runs.

YAML declares the engine-visible coordination condition; computation stays in a `bash:`, `script:`, or `prompt:` node whose structured output can feed the wait.

## Retry Configuration

**AI nodes** (`command:`, `prompt:`) and each `loop:` iteration automatically retry on **transient** errors (failures the provider reports as transient, rate-limited or overloaded, and timeouts) using a default configuration: **2 retries** (3 total attempts), **3 s base delay** with exponential backoff. You will see a platform notification before each retry attempt.

**Deterministic nodes** (`bash:`, `script:`) do **not** auto-retry: they run exactly once unless you add an explicit `retry:` block. This keeps side-effectful scripts (deploys, `gh` mutations, external CLIs) from being silently re-run on a transient-looking failure; opt in per node when re-running is safe. `loop_group:` does not accept `retry:`; configure retries on its body nodes.

A `loop:` policy retries the failed iteration, without advancing `max_iterations` or replaying earlier iterations. Its retry budget resets after each successful iteration. Without a declaration, it keeps the same defaults as other AI nodes. Loops accept only omitted `on_error` or `transient`; `on_error: all` is rejected, so unknown and fatal failures and output-contract failures never gain retries.

To enable or customise retry, add a `retry:` block:

```yaml
nodes:
  - id: flaky-node
    command: flaky-command
    retry:
      max_attempts: 3       # 3 retries = 4 total attempts
      delay_ms: 5000
      on_error: transient

  - id: aggressive-retry
    prompt: "Summarise the output"
    retry:
      max_attempts: 4       # 4 retries = 5 total attempts
      on_error: all         # Retry even non-transient errors (use with caution)

  - id: iterate
    retry:
      max_attempts: 1
      delay_ms: 0            # No wait for ordinary transient failures
    loop:
      prompt: "Finish the task and output <promise>DONE</promise>"
      until: DONE
      max_iterations: 5

  - id: deploy               # bash/script only retry when retry: is set
    bash: "./deploy.sh"
    retry:
      max_attempts: 3
      delay_ms: 5000
      on_error: all
```

### Retry Fields

`retry:` is required to enable retry on `bash:`/`script:` nodes; on `command:`/`prompt:` nodes and `loop:` iterations it customises the defaults below. Whenever `retry:` is declared, `max_attempts` is required.

| Field | Type | Default (AI nodes) | Constraints | Description |
|-------|------|--------------------|-------------|-------------|
| `max_attempts` | number | `2` | 1–5 | Number of retry attempts (not including the initial attempt). `1` = one retry (2 total attempts). No default on `bash:`/`script:`: omitting `retry:` means a single attempt |
| `delay_ms` | number | `3000` | 0–60000 on loops; 1000–60000 otherwise | Base delay in ms before the first retry. Doubles each attempt (exponential backoff) |
| `on_error` | `'transient'` \| `'all'` | `'transient'` | | Which errors trigger a retry. Loops accept only `'transient'` or omission. `'transient'` = transient, rate-limited and capacity failures and timeouts only. `'all'` = also unknown failures, including any non-zero `bash:`/`script:` exit (FATAL failures such as auth, config errors and cancellation are never retried regardless) |

### Error Classification

Archon sorts a failed attempt into one of three buckets before deciding whether to retry. The bucket comes from the kind of failure Archon recorded, never from the error message. For a provider error, the provider picks the bucket through the typed failure class it reports on its result, taken from its SDK's structured signals (error codes, HTTP status fields, typed exceptions), never from the error text:

| Bucket | Provider failure classes | Retried by default? |
|--------|--------------------------|---------------------|
| **FATAL** | `auth`, `quota_exhausted`, `budget_exceeded`, `misconfigured` | Never (even with `on_error: all`) |
| **TRANSIENT** | `transient`, `rate_limited`, `overloaded` (rate limits and capacity get longer retry budgets) | Yes |
| **UNKNOWN** | `unknown` | No (unless `on_error: all`) |

A `quota_exhausted` failure is never retried in the same window, but when the provider reports when the limit resets, the run [waits until that reset](/reference/configuration/#workflow-attention-and-continuation-settings) instead of failing.

`misconfigured` means the setup must change before the node can succeed: a bad proxy URL, a missing or too-old CLI, an unknown model, an unreadable checkout or provider MCP config file, or a declared MCP server that cannot connect. Fix the configuration and run again. A host-local read failure in captured home MCP config pauses the existing run for continuation on a host that can read it; see [MCP servers](/guides/mcp-servers/).

Capacity failures (`overloaded`) get at least five retries: six provider attempts with delay centers of 45, 90, 180, 300 and 300 seconds. Each delay has ±50% jitter; the 300-second cap applies before jitter, so a wait can reach 450 seconds. The nominal total wait is 15 minutes 15 seconds, excluding provider execution time. Node `delay_ms` does not change this schedule, including a loop policy with zero delay. The larger budget applies only while the current failure is capacity; ordinary transient failures keep their own budget. Rate limits keep their existing five-retry minimum and flat 45-second delay with ±50% jitter; once a rate limit occurs, that larger budget remains for the rest of the iteration or node attempt sequence. A rate limit that still refuses the node after those retries does not fail the run: the run pauses on the provider-limit wait (attention queue kind [`usage_limit`](/getting-started/operate/)) and continues from that node by itself.

Each retry wait is logged and recorded as `node_retry_scheduled`, with the node path, class, one-based retry attempt, effective budget and delay; loop retries also record the iteration. Exhaustion preserves the provider failure and message. These are retry delays, not a deadline that ends a run.

Claude's typed `overloaded` code and Codex's `serverOverloaded` map to `overloaded`. Generic server errors and HTTP 503 do not establish capacity. Pi and OpenCode expose no dedicated capacity discriminator on their current failure paths; capacity-looking prose remains `unknown`.

Every built-in provider reports a typed class:

- **Claude** reports every class, from its SDK's error codes, HTTP status, process-exit fields and the reason Claude Code gives when it refuses to start. A sign-in the organization rejects is `auth`. A configuration problem is `misconfigured`: an invalid proxy URL, a CLI below the minimum version, invalid managed settings, a provider the managed settings disallow, an unusable temp or working directory, a missing shell tool, bypass permissions as root, an unknown model, a Claude Code executable that is missing or cannot launch, an unreadable MCP config file, a declared MCP server that cannot connect, a declared skill Claude cannot reach, a named plugin that is not installed or that Claude Code cannot list, or a session whose loaded plugins do not match the node's `plugins:`.
- **Codex** reports a failed turn from Codex's own error code: `auth` for missing or rejected credentials, `quota_exhausted` for a used-up usage limit (with `resetAt` when Codex reports a full window), `rate_limited`, `overloaded` for capacity exhaustion, `transient` for a dropped connection or a Codex process that exits mid-turn, and `budget_exceeded` for Codex's session budget. It reports `misconfigured` when its binary cannot be found or run (a bad `CODEX_BIN_PATH` or `codexBinaryPath`, no binary in a compiled install, a file that is not executable or built for another architecture), when the Codex process exits before answering anything (a binary without `app-server`, or one that rejects a flag; its stderr is the evidence), or when its MCP config file cannot be read. A workflow node is also `misconfigured` when a declared MCP server cannot connect, when a named plugin is not installed, when its `mcp:` file reuses a server name from the Codex config, or when Codex reports a live MCP server the node did not declare. Every other failure is `unknown`, including a thread that can no longer be resumed.
- **Pi** reports `misconfigured` when a node has no model, the model ref is malformed, or the model is not in Pi's catalog, and `auth` when it has no credentials for the model's provider. A failed Pi turn reaches Archon only as a stop reason and message text, so those failures are `unknown`. That includes a used-up usage limit: a Pi run that hits one fails instead of waiting for the reset.
- **OpenCode** reports `auth` (the SDK's `ProviderAuthError`, or HTTP 401/403) and `rate_limited` (HTTP 429). Every other OpenCode failure is `unknown`.
- **Copilot** reports `misconfigured` when its MCP config file cannot be read. Its SDK exposes every other failure only as a message string, so those are `unknown`.

Set `on_error: all` on a node that should retry `unknown` failures.

#### Failures the engine detects

Archon puts a failure it detects itself in a bucket by its kind:

| Failure | Bucket | Retried by default? |
|---------|--------|---------------------|
| A timeout: an AI node's `idle_timeout`, or a `bash:`/`script:` node's `timeout` | TRANSIENT | Yes. Each retry of a hung AI node can wait another full `idle_timeout` |
| An AI provider stream that ends without any output | TRANSIENT | Yes |
| A `bash:`/`script:` node that exits non-zero or cannot start | UNKNOWN | No (unless `on_error: all`). What the script printed does not matter |
| An AI node's structured output that fails its `output_format` after reasks | UNKNOWN | No (unless `on_error: all`) |
| A `bash:`/`script:` node's stdout that fails its `output_format` | no bucket | Never |
| A config error: a missing command file, a bad input reference, an `output_format` that cannot compile | FATAL | Never |
| A cancelled node | FATAL | Never |
| A provider error without a typed class | UNKNOWN | No (unless `on_error: all`) |

A failure recorded before Archon stored failure kinds counts as UNKNOWN.

#### Pi retries inside its own runtime

Pi retries a failed model call itself before Archon sees the failure. Archon reads Pi's settings from `~/.pi/agent/settings.json` and the project's `.pi/settings.json`, and does not change them:

| Pi setting | Default | Effect |
|------------|---------|--------|
| `retry.enabled` | `true` | Pi retries a turn that failed with an error it judges transient (overload, rate limit, server error, network failure, timeout) |
| `retry.maxRetries` | `3` | Retries per turn |
| `retry.baseDelayMs` | `2000` | First delay, doubling each retry (2s, 4s, 8s) |
| `retry.provider.maxRetries` | `0` | A separate HTTP-level retry, in the Anthropic, OpenAI, Azure and Google adapters, that reads the status code and honors `Retry-After`. Off by default |

See Pi's [settings reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#network-and-retries) for the full list. A failure that outlasts Pi's retries reaches Archon as `unknown`, so by default Archon does not retry it again. To add node-level retries on top, set `retry: { on_error: all }` on the node. The attempts then multiply: with Pi's defaults and `max_attempts: 2`, the failing model call can be sent up to 12 times (3 node attempts × 4 Pi attempts each), and each node retry also repeats the model calls the node made before it failed. To leave retrying to Archon alone, set `"retry": { "enabled": false }` in Pi's settings.

### One retry layer

The node retry is the only retry Archon adds, with one exception: when the provider reports that the session a node resumed no longer exists, the engine makes a single fresh-session attempt (see [When a resume can't be restored](#when-a-resume-cant-be-restored)). Each provider makes one attempt per call and reports a typed failure, and the engine decides whether to try again. Before each retry the conversation receives a notice such as ``Node `node-id` failed with transient error (attempt 1/3). Retrying in 3s...``. A vendor's own client may still retry a single API request inside one attempt, such as Claude Code's API retries or Pi's `retry` setting. When every node retry is spent, the run fails; resuming it is your choice (see [DAG Resume on Failure](#dag-resume-on-failure)).

## Run budgets

`budget:` caps how much work and money one run may consume in total. It is not a concurrency
limit: `fan_out.max_parallel` controls how many things run at once, while a budget controls how
much runs overall. There is no default; a workflow without `budget:` runs exactly as before.

```yaml
budget:
  max_work_units: 20   # positive integer
  max_spend_usd: 5     # positive number, USD
```

Declare either ceiling or both. A malformed block, including a misspelt key, is a load error,
so a typo never silently means "no ceiling".

**What counts.** One work unit is one started attempt of a `prompt:`/`command:` node or a
`bash:`/`script:` node. Each retry is another attempt, and so is each approval `on_reject`
rework. Approval gates, waits and `cancel:` nodes do no work and consume nothing. Spend is the
cost the provider reports for each AI attempt; `bash:` and `script:` nodes cost nothing.

**Refusal.** Before an attempt starts, the engine checks the ceilings. Once a ceiling is
reached, it does not start the attempt: the run fails with exit reason `budget_refused`, a
`run_budget_refused` event recording the reason, the refused node, the limits and what was
consumed, and a message naming the node that was not started.

**Bounded overshoot.** The check happens before an attempt, so an attempt already running
finishes. Work units are exact, even across a parallel layer. Spend can exceed `max_spend_usd`
by the cost of the attempts that were already running when the ceiling was crossed.

**Unknown cost is not zero.** With `max_spend_usd`, every AI attempt must report a complete
cost. The run fails as soon as one does not, before later work starts:

- providers that do not report cost (their `costReporting` capability is false);
- Claude after resuming a session that an earlier process created, which reports no cost for
  that query;
- an attempt where only some provider calls reported cost (for example a structured-output
  retry), recorded on the node as `spend.costUsd.partial: true`;
- an attempt that started and never finished, such as one interrupted by a crash or Ctrl-C;
- an attempt that failed with a provider error that reports no cost, such as a Claude rate
  limit, overload or startup timeout. The failed attempt may already have made billed calls,
  so the run fails instead of retrying the node.

Use `max_work_units` alone for providers that do not report cost, or when a failed attempt
should be retried rather than end the run. Unknown cost is still
recorded, but it does not refuse the run.

**Resume.** The totals are rebuilt from the run's own durable records each time the run
resumes, so a resumed run continues from what it already consumed. A run refused for
exhaustion refuses again on resume: the ceiling comes from the run's captured workflow source,
not from the YAML on disk. Start a new run with a higher ceiling to continue.

**Supported shapes.** A budgeted workflow may not contain `loop:`, `loop_group:`, `workflow:`
(with or without `fan_out:`), or `include:` with `fan_out:`, including any reached through
`include:`. The budget does not count their work yet, so the workflow fails to load instead.
An included workflow's own `budget:` is dropped with the run-owned-field warning; the composing
run's budget governs every node.

**Node-level `maxBudgetUsd`** is unchanged and applies alongside a run budget: it caps one
Claude node, while `budget:` caps the whole run.

## DAG Resume on Failure

When a `nodes:` (DAG) workflow fails, the prior run stays in the database as a candidate for resume. Resume is **explicit**: you opt in by flag or button.

**How to resume:**

- **CLI**: `archon workflow run <name> --resume` selects the newest eligible run by start time for `(workflow_name, cwd)`: a failed or paused run, or a `running` run whose last activity timestamp is missing or more than one day old. With a SQL store, a `running` run is excluded while its resource-start request is `admitted`; see [trigger inspection and recovery](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy). See the [CLI reference](/reference/cli/#workflow-resume) for detailed eligibility. Use `archon workflow resume <run-id>` to target a specific failed or paused run; this exact-ID command rejects all `running` runs. Missing or old activity does not prove the owner is gone; verify that before resuming a `running` run.
- **Chat**: Approving or rejecting a _paused_ workflow continues it from where it left off (the platform already knows the run id). For a prior **failed** (or stale `running`) run, `/workflow run <name>` does **not** silently resume: it shows a prompt offering three choices: resume it, abandon it and run fresh, or start fresh anyway. Pass `--force` to skip the prompt: `/workflow run <name> --force <args>` always starts a fresh run.
- **Web UI**: Open the failed run in the console and use **Resume** in the run detail action bar.

**What happens on resume:**

1. The CLI / orchestrator looks up the resumable run, loads its `node_completed` events and private addressable-session handles, then transitions the row back to `running`.
2. Completed nodes are skipped; only failed and not-yet-run nodes are executed. Failed nodes are retried when the failures are what stopped the run: resuming a **failed** run, or continuing after a provider-limit pause or a released source. A run that paused at a node that waits on purpose (an attention, time or event wait, an approval gate, or a child it is blocked on) instead replays the failures from before that pause when it continues, so a node the run had already moved past does not run again.
3. You receive a platform message like: `Resuming workflow — skipping 3 already-completed node(s).`

**Crashed servers / orphaned runs**: Archon does **not** auto-fail `running` rows on server startup, because that would kill workflows actively executing in another process (CLI, adapter). If a server crash leaves a row stuck as `running`, it remains visible in the console run list. To continue it, first verify that its owner is gone. When it meets the eligibility rules above, use `archon workflow run <name> --resume` from its recorded working path; this selects the newest eligible run for that name and path. `archon workflow resume <run-id>` rejects all `running` runs, including stale orphans. Do not cancel or abandon it before resuming: both mark it `cancelled`, which cannot be resumed.

To stop or discard a run instead:

- **Web UI cleanup**: open the run and use **Cancel** in the run detail action bar. When no owner answers, Cancel refuses, shows what the run recorded, and offers **Abandon**; use it to discard the run after verifying the owner is gone.
- **CLI orphan cleanup**: after verifying the owner is gone, use `archon workflow abandon <run-id>` to discard the run.
- **Live detached CLI run**: use `archon workflow cancel <run-id>` (or Cancel on any surface) to stop the exact run's owner before marking it `cancelled`; see the reaped-leader exception under [Bash and script node timeouts](#bash-and-script-node-timeouts).

Plain `archon workflow run` never resumes implicitly.

> Not to be confused with `archon workflow cleanup [days]`, which **deletes** old terminal runs (`completed`/`failed`/`cancelled`) from the database for disk hygiene. It does not transition `running` rows.

**Session context on resume**: Handles required by an explicit `context: { resume: node-id }` selector are restored for completed nodes. The ambient sequential cursor is not reconstructed; a downstream node that relies on implicit inherited context should use an explicit selector or re-read durable artifacts.

**Fresh start**: If zero nodes completed in the prior run, Archon starts fresh (no nodes to skip).

### Opting Out of Resume Caching

By default, resume skips any node that completed successfully in the prior run and feeds its cached output to downstream consumers. That's the right behavior when a node's exit code captures the validity of its output (e.g. AI prompts, scripts that produce structured stdout).

It's the wrong behavior when a node's success status doesn't capture output validity. Typically that is a producer whose exit code reports the side effect (a file written, a service called) but whose downstream consumer parses the side effect's contents on every run. If the producer succeeded but wrote garbage, resume will replay the cached "success" forever without ever re-executing the producer.

Set `always_run: true` on the node to force re-execution on resume, even when the prior run marked it completed:

```yaml
nodes:
  - id: fetch-data
    bash: ./scripts/download.sh > $ARTIFACTS_DIR/data.json
    always_run: true        # Re-fetch on resume; download.sh exit code doesn't validate the JSON

  - id: process-data
    prompt: "Summarize $ARTIFACTS_DIR/data.json"
    depends_on: [fetch-data]
```

On resume, `fetch-data` re-runs regardless of prior success, so `process-data` reads a freshly produced file. Normal cached nodes in the same run are still skipped. `always_run` is per-node.

## Persistent Sessions Across Re-Runs

Different from resuming a failed/paused run or selecting an upstream node with `context.resume`: when you invoke the same workflow *again* with a follow-up prompt, every AI node normally starts fresh and pays to re-establish context. Set `persist_session: true` on a node to make its provider session ID stick across runs, so subsequent invocations continue the prior conversation for that role. Only a provider that can fork a session continues it; with any other provider the node starts fresh on every run (see [Concurrent runs](#concurrent-runs)).

```yaml
name: feature-dev
description: plan → implement → review with cross-run memory
provider: claude
nodes:
  - id: planner
    prompt: "Plan the implementation for: $ARGUMENTS"
    persist_session: true

  - id: implementer
    depends_on: [planner]
    prompt: "Implement: $planner.output"
    persist_session: true

  - id: reviewer
    depends_on: [implementer]
    prompt: "Review the implementation against the plan."
    persist_session: true
```

Run it once with `"add OAuth login"`, again with `"now add MFA"`. Each role continues its prior conversation. The reviewer remembers what it already flagged; the planner remembers it chose Google OAuth.

### Scope

Sessions are keyed by `(workflow_name, node_id, scope_key, provider)`. The scope is the conversation that launched the run, so each chat thread has its own per-node memory. A run the Web UI or REST API starts in the background still belongs to the chat it was launched from, so runs from one chat continue each other's sessions.

A run started without a conversation (for example, by code that calls the workflow engine or store with no origin) has no scope. Its `persist_session` nodes start fresh, save nothing for later runs, and get no scope artifacts. Resuming that run is unaffected: it continues from its own completed nodes like any other run.

The **CLI is different**: `archon workflow run` starts a run without a conversation, so its `persist_session` nodes start fresh on every invocation, and `--conversation-id` does not change that. Resuming a run that a chat launched keeps that chat's scope.

### Concurrent runs

Two runs of the same workflow in the same scope can run at the same time. Neither waits for the other, and they never write into the same provider conversation:

- When a run starts, it reads the scope's persisted sessions once. Each `persist_session` node continues from that copy, not from a session another run saved after this run started.
- The node continues the saved session only when its provider can **fork** it (declares `sessionFork: true`). The fork is a new session with the saved history, so the saved one stays unchanged. Claude, Codex and Pi fork.
- A provider that cannot fork would resume the saved session in place, so two runs could append to one conversation. Instead, the node does not continue it. The run records a `node_session_not_continued` workflow event naming the session it skipped (an 8-character preview) and posts a notice in the conversation. `archon validate workflows` also warns before any run, but only for a node whose provider is written in the workflow file itself; a node from an included block, or one whose provider comes from config defaults or a `model:` alias, is checked only when it runs. OpenCode and Copilot are in this group today, so their `persist_session` nodes do not carry context between runs; pass state between runs through artifacts instead.
- When a node finishes with a session, that session becomes the saved one. With overlapping runs, the run whose node finished last wins. A node that finishes without a session id leaves the saved session as it was.

### Workflow-level default

```yaml
persist_sessions: true   # All AI nodes default to persist_session: true
nodes:
  - id: validator
    persist_session: false   # Opt this node back out
```

### Capability requirement

The resolved provider must declare `sessionResume: true` in its capabilities. The loader rejects workflows that set `persist_session: true` against a non-resume-capable provider at the explicit-provider level; the executor catches the implicit-default-provider case at runtime. Continuing a session across runs also needs `sessionFork: true`; see [Concurrent runs](#concurrent-runs).

### Supported node types

`persist_session` applies to `command:` and `prompt:` nodes only. Other node types skip it:

- **`bash:` / `script:`**: never invoke a provider, so the field is meaningless. Setting it produces a parse warning (shown by `archon validate workflows`) and is ignored.
- **`wait:` / `cancel:` / deprecated `approval:`**: the same. No AI call, no session to persist.
- **`loop:` / `loop_group:`**: have their own per-iteration session threading. Cross-run persistence isn't wired for them in this release; the field is warn-and-dropped on loop and loop_group nodes. Use a `prompt:` node if you need cross-run memory.

When a workflow-level `persist_sessions: true` is combined with any of these node types, the capability check and persistence logic both skip the non-applicable nodes: no false validation errors, no silent runtime mistakes.

To continue a node's conversation outside Archon, read its session id from `archon workflow get <run-id> --verbose` and pass it to the provider's own resume command, such as `claude --resume <id>`. Claude Code finds a session by the directory it ran in, so run that command from the node's working directory: the run's worktree when the run used one.

### `context: fresh` overrides

A node with `context: fresh` skips persistence (and in-run threading). The explicit "always fresh" intent wins over `persist_session`.

`context: { resume: source }` also wins over the consumer's saved cross-run session for that invocation. After the exact named fork succeeds, its new branch is saved normally when `persist_session` applies.

### Clearing memory

| Surface | Command |
| --- | --- |
| Chat | `/workflow reset-sessions <workflow-name> [<node-id>]` (scoped to current conversation) |
| CLI | `archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes]` |
| REST | `DELETE /api/workflows/{name}/node-sessions?scope=<key>&node=<id>` |

Cross-scope resets are guarded so a dropped scope can't silently wipe every conversation's memory: the CLI requires `--yes` when `--scope` is omitted, and REST requires `?confirm=all-scopes`. When conversations are private to their owner (web auth enabled, or `ARCHON_WEB_AUTH_HEADER` set), REST refuses the cross-scope reset with `403`, and `scope` must name an existing conversation: a web or CLI conversation must be one you own, while a chat or forge conversation (Slack, Discord, Telegram, GitHub, GitLab, Gitea) keeps its platform's own access model and needs no ownership. Chat always scopes automatically to the current conversation.

### Cost caveat

Persistent sessions on Pi replay the full rollout on each turn, so token cost grows with iteration depth. Claude auto-compacts. If a workflow's persistent sessions get expensive, reset them and start fresh.

### When a resume can't be restored

If the stored session is gone (for example, a Pi JSONL file was moved), the provider can't resume it. Rather than silently pretending nothing was lost, the provider starts a **fresh** session for that node and the executor surfaces a visible warning:

> ⚠️ Node `planner`: could not resume the prior session — continued with a fresh session, so the earlier context was not restored.

The node still completes on that fresh session, and its new session id is persisted so the *next* run continues from it. The node is **not** re-run: the fresh session is already a clean start, so re-running would only repeat it. Expect this only when a resumed session became unavailable; warm resumes and first-time runs are unaffected.

Claude does not fall back on its own: it rejects a resume whose session transcript no longer exists. When Archon confirms on the host that the transcript is gone and the rejection arrived before any output or tool call, it runs the node once more on a fresh session and shows the same warning. This covers `persist_session` nodes, sessions threaded from an earlier node in the run, and plain `loop:` iterations with `fresh_context: false`, which get a loop-specific notice instead. A second rejection, a rejection after output, or a run inside a container fails the node as before. A named resume (`context: { resume }`) never falls back and fails.

Codex does not fall back: a thread it cannot resume or fork fails the node as `unknown`, with Codex's own error as evidence (for example `no rollout found for thread id …`). Codex reports a missing thread with the same JSON-RPC code as any other invalid request, so Archon cannot tell it apart safely enough to start over on its own. A `persist_session` node on Codex forks the thread an earlier run saved, so once that thread is gone (its rollout under the Codex home was deleted, or the run uses another `CODEX_HOME`) the node fails on every run in that scope. Clear the saved session with [`archon workflow reset-sessions`](/reference/cli/#workflow-reset-sessions) to start the node fresh.

#### By-reference recovery via scope artifacts

A lost session doesn't have to mean lost context. Workflows that use `persist_session` in a run launched from a conversation also get a **stable cross-invocation artifact scope** at `scopes/<workflow>/<scope>/` (a sibling of the per-run `runs/<id>/` directory, under the same artifacts root; the scope is the launching conversation's UUID, the same key sessions use). Whenever a persistence-participating node also declares an `output_type`, the engine mirrors its typed output sidecar (`nodes/<id>.md` + `nodes/<id>.meta.json`) into that scope directory in addition to the run directory.

On a cold resume, the warning then goes further: if the scope directory holds typed artifacts from an *earlier* invocation, the message lists them **by reference** (file paths, never pasted content), so the recovered context can be read on demand:

> Artifacts from the previous invocation are available for recovery (read on demand):
> - plan: `~/.archon/workspaces/acme/widget/artifacts/scopes/feature-dev/<conversation>/nodes/planner.md`

To opt in to recovery, give your `persist_session` nodes an `output_type`:

```yaml
nodes:
  - id: planner
    prompt: "Plan the implementation for: $ARGUMENTS"
    persist_session: true
    output_type: plan   # mirrored to the durable scope → recoverable after a cold resume
```

Notes:

- **Opt-in only.** Workflows without `persist_session` get no scope directory, no mirroring, and no pointer: default behavior is unchanged. Persist nodes without `output_type` keep session continuity but leave nothing behind for recovery.
- **Last writer wins.** Concurrent runs of the same workflow in the same scope write per-node files into the shared scope directory; the most recent run's output for a given node is what a later cold resume sees.
- **CLI caveat.** `archon workflow run` starts a run without a conversation, so it gets no scope directory. This is the same caveat as session persistence itself.

## Binding Values into Command and Script Nodes

A `command:` file and a named `script:` file are opaque to inline substitution: the engine
never rewrites their bodies, so `$producer.output.green` written inside one stays literal
text. Before node-local bindings, the only way to hand such a node a VALUE was an artifact
file: the producer wrote `$ARTIFACTS_DIR/verdict.green`, the consumer re-read and re-parsed
it, and a one-bit boolean traveled through the filesystem.

`with:` on a `command:` or `script:` node replaces that bridge. It binds upstream values by
name into the channels those bodies already read: `$INPUTS.<name>` in a command file,
`INPUTS_<UPPER_SNAKE>` env vars in a script:

```yaml
nodes:
  - id: implement
    command: implement-issue
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]

  - id: record-verdict
    script: record-verdict            # reads process.env.INPUTS_GREEN — no .green file
    runtime: bun
    depends_on: [implement]
    with:
      green: $implement.output.green
```

Values keep their **logical type**: a whole `$node.output[.field]` (or `$INPUTS.<name>`)
reference passes the value itself (a boolean stays a boolean, an object stays an object)
and non-string literals (`retries: 3`, `flag: true`) pass as written. Text delivery uses one
deterministic rule everywhere: strings raw, everything else canonical JSON text, so a bound
object arrives in the env var single-encoded (`{"a":1}`) and is parsed **once**. Any other
string is a template, substituted exactly like `input:`.

### Reading across a skipped branch

When mutually exclusive branches join with `trigger_rule: all_done`, a consumer may need a
value from a producer that was **skipped**. Declare that case per binding with the
`{ from, if_skipped }` directive instead of a file latch:

```yaml
  - id: join
    script: decide-ready
    runtime: bun
    depends_on: [initial-ready, iteration-ready]
    trigger_rule: all_done
    with:
      initial:   { from: $initial-ready.output.ready,   if_skipped: false }
      iteration: { from: $iteration-ready.output.ready, if_skipped: false }
```

`if_skipped` is **data**: the value the binding takes when its producer did not run. The
coalescing decision ("ready if either branch said so") stays in the consuming script, which
is the YAML-coordinates / code-computes split. A skipped producer with **no**
`if_skipped` fails the node with the
binding, producer, and fix named: a binding never silently resolves to `''`.
`if_skipped` is literal data, so reference-looking text there is neither substituted nor
validated as an output reference.

`if_skipped` covers a producer that completed as **skipped**, including an exec node that
ran until an opted-in timeout. A producer that **failed** always fails the binding too,
whether or not `if_skipped` is declared: a
`loop_group`'s failure paths in particular can leave real, non-empty output behind (its last
completed iteration's text), so this is an explicit check, not an accident of empty output.
There is no way to opt a binding out of this: declaring `if_skipped` never papers over a real
failure, and neither `when:` nor an inline `$node.output` reference in a prompt/bash/command
body can substitute for it: every one of them fails the same way against a failed producer,
whether the reference is fielded or whole-text.

Two guarantees the loader enforces: every bound producer must be reachable through
`depends_on` (a binding can never race its producer), and two binding names may not fold to
the same `INPUTS_*` env key. At runtime, node-local bindings are the **nearest** input
layer: they win over a composed block's inputs, which win over the run's `$INPUTS`.

Exec nodes also receive `ARCHON_RUN_ENV_KEYS`, a JSON array of the full run-contract
key list: fixed engine environment keys (including the manifest itself) and generated
input keys from run inputs, composed inputs, and node-local bindings.
Project commands launched outside the run can use this list to remove the run contract
without stripping independently configured `INPUTS_*` settings. Generated
bindings override same-key project settings; removing a generated key does not
restore the shadowed project value.

Bindings carry *values*. For documents (a plan, a findings report, a diff), keep using the
artifact chain below; a path in a binding plus a file on disk is still the right shape for
anything big enough to have structure of its own.

### Reading where a node started: `$node.execution.checkoutStart`

The engine observes the checkout when each invocation of a prompt, command, bash, script,
or loop node starts, and records it on that node's execution record. A binding can read the
observation of an upstream node's invocation:

```yaml
  - id: assert-changed
    script: assert-changed
    runtime: bun
    depends_on: [implement]
    with:
      baseline: "$implement.execution.checkoutStart"   # arrives as INPUTS_BASELINE (JSON)
```

The value is the checkout observation from the start of `implement`'s invocation: the
commit, that commit's tree, and whether the worktree was clean. A dirty start also names a
manifest under `$ARTIFACTS_DIR` listing each path that differed from the commit with Git's
blob id of its content, its mode, and its type. Retries and the turns of a `loop:` node keep
their invocation's first observation; the next invocation (for example, the next iteration
of an enclosing `loop_group`) records a new one. A resumed run reads the same recorded
value. Observation never changes the checkout: no stash, no index write, no `git add`.
The recorded commit is the one `git status` reported comparing the worktree against; if
HEAD keeps moving while the checkout is read, the observation is `unavailable` rather than a
guess.

The reference is valid only as the whole value of a `command:` or `script:` binding, and
only for a producer that executes against the checkout. Anything else is a load error.
Every `bash:` and `script:` node, and the agent's shell in an AI node (see
[Durable state documents](#durable-state-documents) for the provider exception), also
receives its own execution identity, including this attempt's observation, as JSON in the
`ARCHON_NODE_EXECUTION` environment variable. The
implement workflow compares these two observations to decide whether an invocation
changed anything since it started.

## The Artifact Chain

Nodes pass documents to each other as files. Each run gets its own `$ARTIFACTS_DIR` outside the repository; a node writes a file there and a later node reads it. A command that writes an artifact should say where it writes and in what format, and a command that reads one should say where to find it. Values small enough to branch on travel as node output instead; see [`$node_id.output` Substitution](#node_idoutput-substitution) and [Binding values](#binding-values-into-command-and-script-nodes).

### Typed Artifacts (`output_type`)

The chain above relies on each node knowing the exact filename its upstream wrote. To locate an output **by type** instead of by guessed filename, declare `output_type` on a node:

```yaml
nodes:
  - id: planner
    command: plan-feature
    output_type: plan        # tag this node's output
```

When a node sets `output_type`, the executor writes a typed sidecar after the node completes:

- `$ARTIFACTS_DIR/nodes/<id>.md`: the node's output text
- `$ARTIFACTS_DIR/nodes/<id>.meta.json`: metadata (`outputType`, `runId`, `producedAt`, `size`)

That exact layout remains the contract for top-level nodes. A typed node inside a `loop_group`
writes one pair per successful body execution instead: `nodes/loop.<owner-digest>__<body>.md` and
the matching `.meta.json`. The stable digest is derived from the complete original body ID and
outermost-to-innermost loop lineage, so delimiter-shaped IDs and repeated inner iteration numbers
cannot alias another execution. Metadata keeps the readable provenance as
`loopGroupPath: [{ groupId, iteration }, ...]`. A body node expanded from an `include:` retains its
load-time `<include>__<node>` ID in metadata and as the sanitized body suffix.

This works on **every** node type, `bash`/`script` included. The write is **best-effort**: if it fails, the node still succeeds and a warning is logged; the typed sidecar may simply be absent. `output_type` is an open set of labels (`plan`, `findings`, `code`, `summary`, …). Pick a convention and keep casing consistent, since lookup is case-sensitive.

#### Reading typed artifacts by type

Executable nodes receive a typed-artifact listing at `$TYPED_ARTIFACTS_FILE`: a JSON observation file inside the run's artifact directory. Each agent attempt receives a fresh listing before it starts, including transient retries. Plain `loop` structured-output reasks also receive fresh listings. Ordinary agent structured-output reasks (including agents in a `loop_group` body) reuse their attempt's listing. `bash:` and `script:` nodes receive one before execution. Each `until_bash` check receives a separate listing after the iteration's work. It has the shape `{ "runId", "artifactsByType": { "<outputType>": [ …metadata ] }, "errors": [ … ] }`, so a script or agent selects a type without knowing `nodes/`, sidecar names, or loop filename rules. Each entry is the same metadata the sidecar holds (`nodeId`, `outputType`, `path`, `runId`, `producedAt`, `size`, and optional `loopGroupPath`), and `path` is relative to `$ARTIFACTS_DIR`.

```ts
// A script: read the listing the same way in host or container runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const listing = JSON.parse(readFileSync(process.env.TYPED_ARTIFACTS_FILE!, 'utf8'));
if (listing.runId !== process.env.WORKFLOW_ID) throw new Error('listing is for another run');
for (const error of listing.errors) console.error(`unreadable: ${error.path} (${error.kind})`);
for (const gate of listing.artifactsByType['green-gate'] ?? []) {
  const body = readFileSync(join(process.env.ARTIFACTS_DIR!, gate.path), 'utf8');
  console.log(gate.nodeId, body);
}
```

In an agent prompt, point at the listing rather than the layout: "Read `$TYPED_ARTIFACTS_FILE`, select `artifactsByType["plan"]`, and open each entry's `path` under `$ARTIFACTS_DIR`."

Properties worth knowing:

- **Observation, not a ledger.** Entries of a type are ordered by `producedAt` ascending, with ties broken by content path. Each listing freezes the artifacts and metadata observed when it was written; it is not an execution history or a completion-order log, and re-running the same node owner overwrites its sidecar. An agent attempt sees artifacts published **before that attempt started**. Concurrent siblings have no publication-order guarantee; declare `depends_on` to order a producer ahead of its consumer. A plain `loop`'s `until_bash` runs after its agent work, and a `loop_group`'s runs after its body, so each sees the typed artifacts published during that iteration.
- **Failures stay visible.** `errors` lists every record the read could not turn into an artifact (malformed or foreign-run sidecar, unsafe path, missing or unreadable content). A corrupt sidecar has no trustworthy type, so it never disappears into an empty type list. An absent key means no matching readable metadata; `runId` lets a consumer reject a listing handed to it out of scope.
- **Everywhere an invocation runs.** The path is delivered in `bash:` and `script:` nodes (as both `$TYPED_ARTIFACTS_FILE` and the `TYPED_ARTIFACTS_FILE` environment variable), agent prompts, loop attempts, and deprecated `approval.on_reject` rework prompts. A prompt that references it in a context with no listing fails rather than substituting an empty string. A `--dry-run` preview has no artifacts and substitutes an empty string instead, so it cannot detect a reference made from a context that never receives a listing.

Successful bash stdout is retained by default on the completed run as a bounded audit preview in `node_completed.data.node_output`. Output over 32 KiB (32,768 UTF-8 bytes) ends with a truncation marker, and the event also includes `node_output_truncated: true` plus `node_output_original_bytes`. Because stdout is persisted, never print secrets or credentials from bash nodes. This preview is separate from `output_type`: declaring `output_type` opts into a best-effort file sidecar that may contain the full output and is not required for ordinary bash audit retention.

### Retained subprocess evidence

Separately from the value channel above, the engine retains **what each subprocess printed** in
the run's own transcript (`~/.archon/workspaces/<project>/logs/<run-id>.jsonl`), as one
`exec_output` row per subprocess:

Use `archon workflow logs <run-id>` to print the current transcript or add `--follow` to
stay attached while the run executes. The foreground run-start output and `archon workflow
get <run-id>` both expose the resolved local path, so callers do not need to reconstruct the
project storage layout.

| Field | Meaning |
| --- | --- |
| `step` | The node id. An `until_bash` probe uses `<node>-iteration-<n>`. |
| `content` | `<bash>`, `<script>`, or `<until_bash>`. |
| `exit_code` | `0` on success. On failure, the process exit code, or a symbol when there is none: `ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, or the signal name (`SIGTERM`) for a timeout kill. |
| `stdout_tail` / `stderr_tail` | Last 2000 characters of each stream. Absent means that stream was empty. |

This covers every `bash:` and `script:` node and both loop variants' `until_bash` probes, on
success and failure alike, including a probe's *tolerated* non-zero exit, which is otherwise
unrecorded. Workflows do not need to build their own logging to answer "what did this node
actually do?".

Three properties worth knowing:

- **Streams stay separate.** `stderr` is never merged into `stdout`, so a `git` or `gh` warning
  cannot be mistaken for the value a node returned.
- **It is capped; `$nodeId.output` is not.** A tail over 2000 characters is marked in place with
  `…[truncated to last 2000 chars]`. The cap applies only to this evidence copy: a node's output
  still reaches its consumers whole.
- **Credentials are removed on write.** Values the engine put in the subprocess environment
  (keys ending in `TOKEN`/`KEY`/`SECRET`/`PASSWORD`, `DATABASE_URL`, and credentials Archon
  injected) are replaced with `[REDACTED]` before the row is written. This protects the
  transcript, not the `node_output` preview above. The "never print secrets" rule still stands.

## Cross-Run State with `$STATE_DIR`

`$ARTIFACTS_DIR` is scoped to **one run**. When a workflow needs to remember something
*between* runs: a dedup ledger of issues already commented on, a "last processed" cursor,
a nudge log, write it to `$STATE_DIR`:

```yaml
nodes:
  - id: load-state
    runtime: bun
    script: |
      import { readFile } from 'fs/promises';
      const path = `${process.env.STATE_DIR}/triage/seen.json`;
      let seen: string[] = [];
      try {
        seen = JSON.parse(await readFile(path, 'utf-8'));
      } catch {
        // First run — no ledger yet.
      }
      console.log(JSON.stringify({ seen }));
```

`$STATE_DIR` is `~/.archon/workspaces/<project>/state/`, pre-created before the first node
runs, and delivered to `bash:`/`script:` subprocesses as the `STATE_DIR` environment
variable as well.

**It is scoped per project, not per workflow.** Every workflow in the project sees the same
directory. That is deliberate: it is what lets two cooperating workflows (say a triage pair
that must not both comment on the same issue) share one ledger. If you want isolation,
namespace it yourself: `$STATE_DIR/<workflow-name>/`, exactly as you already organize
subdirectories inside `$ARTIFACTS_DIR`.

### Concurrency: no locking, and what that means

The engine does **no** locking on `$STATE_DIR`. Two runs of the same stateful workflow in
one project (each in its own worktree, so the working-path lock does not serialize them)
share one directory, and the failure mode is a lost update:

1. Run A reads `{1, 2}`
2. Run B reads `{1, 2}`
3. Run A writes `{1, 2, 3}`
4. Run B writes `{1, 2, 4}`: A's entry is gone

For a dedup ledger that means an item gets reprocessed on the next run: a duplicate comment,
a repeated nudge. Note that write-then-rename prevents *torn reads* but does **not** prevent
lost updates: the read happened before either write.

This is an **authoring** concern, not an engine one. Options, in order of preference:

- **Durable state documents.** Use `archon state` for concurrent JSON updates with audit history, including multiple hosts sharing PostgreSQL. See below.
- **Append-only file ledger.** Concurrent small `O_APPEND` writes are atomic on POSIX, so each
  run appends its own lines and readers fold the file. This is the fix if lost updates
  matter.
- **Accept last-writer-wins.** Fine when the state is a cache or a cursor that self-corrects.
- **Don't run the workflow concurrently.** A workflow with `worktree: enabled: false` shares
  one working path. With the default `mutates_checkout: true`, direct executor dispatch
  rejects a second run on a held path with "This worktree is in use"; the operator must
  re-run it afterwards. Trigger admission instead queues or skips the request according
  to `overlap`, naming the holding run as its blocker. See
  [trigger admission](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy).
  `mutates_checkout: false` bypasses the executor's path lock, so it does not prevent
  concurrent state writes.

Put the state write in a `script:` node, not in an AI node's Write tool. A `script:` node is
a guarantee; a prompt instructing an AI node to append is a convention it may not follow.

## Durable state documents

Use `archon state` for a standing agent's small JSON ledger, cursor or index when updates
can overlap, need audit history, or run on several hosts. `$STATE_DIR` remains the free-form
file area for caches and non-JSON data, with its existing concurrency limitations.
State documents use the selected store: files, SQLite or PostgreSQL. Container runs are
not supported because the CLI and store are not delivered there.

A document belongs to a project, shared by all its workflows, or to install scope
(`--install`), shared across projects. A node reaches only its run's project and install
scope. Choose names such as `review/acme/123` with slash-separated lowercase letters,
digits, `.`, `_`, or `-` (1–200 characters total); `archon state list --prefix review/`
finds them again. A document is any JSON value, so a markdown note is a JSON string;
`put --raw` and `get --raw` pass it as plain text. Use artifact pointers for large content:
a document's serialized JSON is capped at 64 KiB. Values are fetched explicitly; the engine
adds no state to prompts.

Every revision records its writer: the run and node path for a write from inside a run,
or the surface (`cli`) for any other write. It never records who made the change. If a
document needs to say where an entry came from (a person, an agent, a tool result), keep
that inside the document's own entries.

`put --if-revision 0` creates a document; subsequent whole-document changes must name the
revision read. Concurrent replacements have one winner; losers exit `3`. `patch` applies
JSON Pointer `set`, `remove`, or `append` operations to the latest revision; concurrent
patches serialize instead of racing, though an earlier write can make a later patch invalid.
When a patch was computed from what you read, such as setting a field to a value you
derived from its old one, pass `patch --if-revision <n>` so a concurrent change makes it
exit `3` instead of being silently replaced. Appending an item, or setting a key only you
write, can patch the latest revision without it.
An absent document starts as `{}`; appending to `/seen` creates the array. Invalid patches
or oversized values exit `4` and write nothing. Exit `5` means the CLI opened a different
store than the run's. Exit `1` means usage or storage failure.
The [CLI reference](/reference/cli/#state) describes pointer and tombstone semantics.

Let the agent judge what to remember, then commit its structured output in a script node
when the write must happen. For example, a review agent returns a completed PR identifier;
its dependent host-side node appends that identifier to a ledger:

```yaml
nodes:
  - id: review
    prompt: Review the supplied PR and return its identifier after completing the review.
    output_format:
      type: object
      properties:
        completed_pr: { type: string }
      required: [completed_pr]
  - id: commit-state
    depends_on: [review]
    runtime: bun
    with:
      completed_pr: $review.output.completed_pr
    script: |
      const command: string[] = JSON.parse(process.env.ARCHON_CLI_COMMAND!);
      const child = Bun.spawn([...command, 'state', 'patch', 'review/ledger'], {
        stdin: 'pipe', stdout: 'inherit', stderr: 'inherit',
      });
      child.stdin.write(JSON.stringify({ops: [
        {op: 'append', path: '/seen', value: process.env.INPUTS_COMPLETED_PR},
      ]}));
      child.stdin.end();
      if (await child.exited !== 0) throw new Error('State commit failed');
```

This recipe runs on the host. Container-isolated nodes cannot use `archon state` in
this release: they do not receive the host's `ARCHON_CLI_COMMAND` or access to its store.
Commit state in a host-side step. `$STATE_DIR` remains available for free-form files on
the host, but it also is not mounted into container runs.

Bash/script nodes already receive `WORKFLOW_ID` and `ARCHON_NODE_EXECUTION`; writes
record their run ID and node path. Invoke the JSON argv in `ARCHON_CLI_COMMAND` instead
of assuming `archon` is on PATH. If the nested CLI opens a store that does not know the
run, it refuses the write (exit `5`) instead of writing to another project. Operators can inspect
`archon state log review/ledger` and correct a value using `put --if-revision` or `patch --if-revision`.

An AI node's agent can also write state itself, by running `archon state` from its shell.
On Claude, Codex, Pi and Copilot the agent's shell receives the same `WORKFLOW_ID` and
`ARCHON_NODE_EXECUTION`, and `ARCHON_CLI_COMMAND` on the host (empty in a container run),
so the write records the run and the AI node's path. Configured project env cannot override
these keys. OpenCode runs every node in one shared server that receives no per-node
environment: an OpenCode agent's shell carries whatever identity the process hosting that
server had. Its write is recorded as a CLI write from outside any run when Archon was started
outside a run, and as the launching node when the run was started from another run's node. Commit
through a script node when the run must be recorded. Any process that sets a run's `WORKFLOW_ID` and matching
`ARCHON_NODE_EXECUTION` is recorded as that run: the writer is provenance, not access control.

The ledger prevents lost state updates; it does not make an external review/comment and
the state commit one transaction. Use resource admission to serialize work that must not
repeat an external action. Retention is operator-run: `archon workflow cleanup <days>`
removes old history but retains each latest revision, including tombstones. Keeping the
tombstone prevents a recreated document from reusing an old revision and accepting a stale write.

### When you *want* output in the repository

`$STATE_DIR` and `$ARTIFACTS_DIR` both live outside the repo on purpose: run output should
never land in a user's git history, and inside an isolated run anything written to the
worktree is destroyed at cleanup. Three sanctioned ways to get content into git anyway:

1. **It is repo content.** Documentation, generated code, a committed spec: write it into
   the worktree like any other file and let the workflow commit it normally. This is not an
   exception; it is the normal path for anything that *is* source.
2. **An explicit copy node.** Produce the file in `$ARTIFACTS_DIR`, then add a `bash:` node
   that copies exactly what should be versioned into the worktree, and commit it. The copy
   is visible in the DAG, so "why is this in my repo" has an answer.
3. **Traceability without git.** If you only need to *find* the output later, you do not need
   it in the repo at all: the artifact routes (`GET /api/runs/:runId/artifacts`) and
   `output_type` sidecars address a run's output by run id and by type.

## Composing Another Workflow with `include:`

An `include:` node runs another workflow's nodes as part of this one. This lets you factor a
shared block of nodes (for example a multi-step review flow) into its own workflow file and
reference it from many workflows, instead of copy-pasting the nodes and letting the copies
drift apart.

**A node runs with the configuration its own workflow file declares; the run owns isolation,
interactivity and evidence policy.** That one sentence is the whole rule. A composed workflow
that declares `provider: codex` / `model: large` / `effort: high` runs on exactly those,
whichever workflow composed it, and a composed workflow that declares nothing resolves from
your config, tier presets and personal AI preferences at run time, exactly as it would on its
own. The composing workflow contributes ordering and gates; it does not reach inside.

```yaml
nodes:
  - id: pr
    include: archon-pr

  # Inlines every node from archon-review, attached after pr.
  - id: review
    include: archon-review
    depends_on: [pr]

  - id: summary
    prompt: "Summarize the review findings for the PR author."
    depends_on: [review]   # resolves to the included workflow's terminal node
```

The include target (`archon-review` here) is an ordinary workflow file discovered by
name, honoring the usual precedence (`bundled` < `~/.archon/workflows/` < repo
`.archon/workflows/`).

### What travels, and what belongs to the run

At load time each workflow's **node-affecting** configuration is written onto its own nodes
and then removed from the definition, so nothing can fall back to an outer file's values:

| Field | Composed behaviour |
|---|---|
| `provider`, `model`, `effort`, `fallbackModel`, `betas`, `sandbox`, `persist_sessions` | **Travel** with the workflow, onto its own nodes. A node's own value always wins. |
| `requires` | **Unions** into the composing workflow, so a missing capability refuses the run at invocation instead of failing mid-block. |
| `inputs`, `returns` | **Consumed** by composition: `inputs:` validates the caller's `with:`, `returns:` selects `$includeId.output`. |
| `outcome_field` | **Owned by the workflow being run.** An included workflow's declaration does not propagate to its composer. A top-level composer may declare its own field relative to its own `returns:`; an include alias is rebound before that contract is validated. |
| `worktree`, `container`, `evidence_policy`, `budget` | **Run-owned.** Whoever starts the run decides these; a composed file's values are dropped with a load-time warning. Declare them on the top-level workflow. |
| `mutates_checkout` | **Run-owned.** It is dropped with the same warning, including under `include:` + `fan_out:`, whose instances run inside the composing run. |
| `webSearchMode` | **Dropped, and this one is a real gap.** It is the only workflow-level field with no per-node counterpart, so there is nowhere for it to travel. Set it on the top-level workflow, where it then applies to every node in the run. |

Two consequences worth knowing:

- **A composition can span providers.** Parent on Claude, one composed block on Pi, another
  on Codex, all in one run: each resolves independently. `archon workflow run <name>
  --dry-run` prints each node's effective provider and model and where the value came from.
- **A composed workflow's entry node starts a fresh session**, exactly as it would if you
  ran that file on its own, even when the preceding node used the same provider. Set
  `context: shared` on the entry node if you deliberately want the caller's thread to
  continue into the block.

### How expansion works

Expansion happens at **load time (discovery)**, before the workflow ever runs. By the time
the executor sees the DAG there are no include nodes left: the inlined nodes are ordinary
executable nodes in the include's containing scope, so runs, events, resume, and answers all
behave exactly as if you had written the nodes by hand. A top-level include produces top-level
nodes; an include in a `loop_group` body produces body-local nodes. There is no separate child run.

- **Namespacing.** Each included node `n` receives id `<includeId>__<n.id>` (double
  underscore) within that scope. Including `archon-review` under `id: review` yields
  `review__scope`, `review__code`, `review__synthesize`, and so on. These
  namespaced ids are what appear in the event stream and in `archon workflow get <id>`;
  body-local events additionally carry their enclosing group prefix.
- **Edges and command bodies.** Internal `depends_on` edges and `$id.output` references are
  rewired to the namespaced ids automatically. This includes named `command:` and
  `loop.command` files: discovery resolves their bodies and compiles them into the flat DAG
  before namespacing. Compilation recurses through nested `loop_group` bodies. An unresolved
  included command cannot start a fresh execution because its references cannot be proven safe.
  Command nodes fail composition immediately; loop commands retain a private compilation error
  so a paused loop can still resume from its persisted, validated prompt snapshot.
  The include node's `depends_on` and default `trigger_rule` wire the block's
  **entry** nodes (those with no upstream inside the block). The include's `when:`
  gates the **whole block**, including descendants. Cached nodes on resume are checked
  against the gate again. Inside a `loop_group`, that gate reads `$LOOP_PREV` from the
  loop containing the include, even when a descendant runs inside a nested loop.
  If both the include and an entry define `when:` and either condition contains `||`,
  loading fails because the grammar cannot
  group them without changing precedence; put the gate only on the include or inside the block.
- **Sink asymmetry (a downstream node depending on the include).** A `depends_on:
  [<includeId>]` on a downstream node fans out to **all** of the block's sink nodes (every
  node with no dependents inside the block), so it waits for the whole block to finish.
  But `$<includeId>.output` resolves to only the **primary** sink: the first sink in
  definition order (the same terminal-selection rule `loop_group` uses). For a
  single-sink block like the review block the two coincide; they differ only when a block
  has multiple leaf nodes.
- **Output.** `$<includeId>.output` in another node resolves to the block's primary sink,
  including when it appears in that node's `command:` or `loop.command` file body. In the
  example, `$review.output` is the output of the block's `implement-fixes` node.
- **Inside a `loop_group` body.** An include expands inside that sealed body at load time.
  Its nodes keep the usual `<includeId>__<nodeId>` names, then the loop runtime prefixes
  persisted step names with the group id (for example `fix-loop.review__synthesize`). Every
  iteration re-runs the expanded nodes exactly like equivalent inline body nodes. The group's
  `until_bash` can read `$<includeId>.output` and expansion binds it to the block's declared
  `returns:` node. A `workflow:` node is different: it creates a child run at runtime and
  remains unsupported inside a loop-group body.

### Passing values into an included block

An include can pass an identifier-keyed map of JSON values through `with:`. The included
block uses those values through `$INPUTS.<name>` in its inline text:

```yaml
# parent workflow
nodes:
  - id: plan
    prompt: Plan the requested change.

  - id: review
    include: reusable-review
    depends_on: [plan]
    with:
      plan: $plan.output
      base_branch: main
```

```yaml
# reusable-review workflow
nodes:
  - id: inspect
    prompt: Review $INPUTS.plan against $INPUTS.base_branch.
```

Input names must start with a letter or underscore and may then contain letters, numbers,
underscores, or hyphens. Values may be any JSON value (string, number, boolean, null, array,
object) and are inserted verbatim into prompt text during load-time expansion: they are
**never expressions**: nothing is evaluated, computed, or interpreted. A string value is
spliced in as text exactly as written; a non-string value keeps its logical type wherever the channel
is typed (a nested `with:` value position, `INPUTS_*` env delivery) and splices as its
canonical JSON text into text surfaces. An inserted `$node.output` reference
remains a reference and resolves through the normal runtime output substitution. A missing
input referenced by the block is a load error. Whether **extra** caller keys are allowed
depends on whether the block declares `inputs:` (see
[Workflow Signature](#workflow-signature-inputs-returns-and-inputs)): a block with no
`inputs:` ignores unrecognized keys; a block that declares `inputs:` rejects an undeclared
key at load.

Substitution applies everywhere the value could reach the model, including inside Markdown
code fences and inline code spans: `$INPUTS.<name>` has no documentation-only meaning, so a
fenced occurrence is still a live parameter.

Executable source never receives the value. In an inline `bash:` body and in `loop.until_bash`
or `loop_group.until_bash`, the macro becomes a double-quoted reference to the input's
environment variable: `$INPUTS.base_branch` expands to `"${INPUTS_BASE_BRANCH}"`, so a value
containing `$(...)` or quotes stays data. Write the macro bare: the expansion brings its own
quotes, so `"$INPUTS.base_branch"` becomes `""${INPUTS_BASE_BRANCH}""`, which leaves the
reference unquoted and splits a value containing spaces. Inside single quotes the reference
stays literal, and inside a heredoc its quotes become part of the text; read
`$INPUTS_<UPPER_SNAKE>` directly there. An inline `script:`
body (`bun` or `uv`) has no language-neutral quoting form, so `$INPUTS.<name>` there is a load
error naming the variable to read instead (`process.env.INPUTS_BASE_BRANCH`,
`os.environ["INPUTS_BASE_BRANCH"]`).

#### Command bodies use the same explicit interface

Named `command:` and `loop.command` files are the preferred home for substantial prompts and
can use both workflow-local `$node.output` references and declared `$INPUTS.<name>` values.
For an `include:`, Archon resolves and snapshots the command body during load-time composition,
then applies the same input binding and node-id namespacing as an inline prompt. The authored
workflow stays command-first; the executor receives a deterministic flat DAG.

Every live reference in the command body must belong to the included workflow's lexical node
scope. A direct `$caller.output` reference is rejected whether or not the parent happens to
have a node called `caller`; declare an input and pass it with `with:` instead. Failure to
resolve or read an included command is never a warning or best-effort bypass: a fresh execution
fails before an AI turn. A paused loop remains resumable from its saved prompt snapshot even if
the command is later deleted or made invalid.
Canonical references are live even inside Markdown code fences and inline code because runtime
substitution is syntax-agnostic.

Named `script:` files are different: they are opaque programs, not prompt templates. Archon
does not scan or rewrite their source, so it delivers a composed workflow's declared inputs to
them the same way it delivers everything else user-controlled, as environment variables.
Every `bash:` and `script:` node, and each `loop.until_bash` and
`loop_group.until_bash` completion check (including checks after resume), receives its
workflow's resolved inputs as `INPUTS_<UPPER_SNAKE>` (hyphens fold to underscores, so `base-branch` arrives as
`INPUTS_BASE_BRANCH`), whether the body is inline or a named file:

```bash
# inside the composed workflow's own script, named or inline
echo "reviewing $INPUTS_PLAN against $INPUTS_BASE_BRANCH"
```

The names are the ones the node's **own** workflow declared, at any nesting depth: a block
three files deep still reads its own input names, not the caller's. Values are delivered
through the environment and never spliced into the source, so a value containing shell
metacharacters is data, not syntax. In an included `bash:` or `until_bash` body the
`$INPUTS.<name>` macro is a shorthand for the same variable (see above); an inline `script:`
body must read the variable.

`workflow:` sub-runs deliver the same `INPUTS_<UPPER_SNAKE>` variables, from inputs persisted
in the child's run metadata.

### Limits of `include:`

- **No deep access.** A parent can read `$includeId.output` (the terminal) but not the
  output of an individual node inside the block. The block's internal node names are an
  implementation detail.
- **Literal targets only.** `include:` takes a literal workflow name: no
  `include: $something` and no cross-repo includes.
- **No child runs inside a `loop_group` body.** A `workflow:` node remains unsupported there;
  use `include:` when the reusable nodes should participate in the same run and repeat as
  part of the group's static body.
- **Depth-capped and cycle-checked.** Includes may nest up to 3 levels deep; cycles
  (`A` includes `B` includes `A`) and over-deep chains are load errors that drop only the
  offending workflow: other workflows still load.

A workflow used purely as a building block still appears in
`archon workflow list`. Mark it as a building block in its `description:` so it isn't picked
for a standalone run.

## Workflow Signature: `inputs:`, `returns:`, and `$INPUTS`

A workflow can declare a **structural signature** (what it takes and what it returns) so a
reusable block has an explicit, caller-facing contract instead of relying on positional
accidents. Two workflow-level fields:

```yaml
name: review-block
description: Reviews a diff — composes into a parent, and runs on its own
inputs:
  diff:
    required: true
    description: the diff to review
  style:
    default: strict
returns: synthesize          # the node whose output IS this block's result
outcome_field: green         # required boolean field that authors this run's verdict
nodes:
  - id: gather
    prompt: Gather context for $INPUTS.diff (style $INPUTS.style).
  - id: synthesize
    prompt: Synthesize a review from $gather.output and report whether it is green.
    depends_on: [gather]
    output_format:
      type: object
      properties:
        review: { type: string }
        green: { type: boolean }
      required: [review, green]
  - id: implement-fixes
    prompt: Apply the fixes.
    depends_on: [synthesize]
```

- **`inputs:`**: a map of input name → `{ required?, default?, description? }`. `required: true`
  and `default:` are mutually exclusive (a required input has no default; declaring both drops
  the key at load with a warning). Values come from `with:` on the `include:`/`workflow:` node
  that references this workflow, or, for a direct run, from `--input name=value` on the CLI or
  the run form in the web console (see [Running a workflow that declares
  inputs](#running-a-workflow-that-declares-inputs)). Whichever channel supplies them, the same
  contract applies: a missing **required** input and an **undeclared** key are both rejected, and
  a declared `default:` fills an omitted input. A workflow with **no** `inputs:` keeps the old
  lenient behavior: supplied keys **pass through unvalidated**: they are recorded on the run
  and still resolve as `$INPUTS.<name>` / `INPUTS_<UPPER_SNAKE>`, they are simply never checked
  against a declaration, because there isn't one.
- **`returns:`**: the **node id** whose output IS the workflow's result. It selects by id, so
  it works for any node type and even a **non-sink** node (a node other nodes depend on). For an
  `include:` block, `$blk.output` resolves to the `returns:` node; `depends_on: [blk]` still
  waits on every terminal node. For a `workflow:` sub-run child, the child's terminal output
  (threaded back as `$node.output`) becomes the `returns:` node's output.
- **`outcome_field:`**: an optional, explicit authored verdict relative to `returns:`. The
  selected node must declare an object `output_format` (`type: object`) whose `properties`
  declares the field, whose `required` lists it, and whose field schema sets `type: boolean`;
  otherwise the workflow fails to load.
  It cannot select a `loop_group` (which returns raw text) or a fan-out `workflow:` node
  (which returns an aggregate array); add a structured collector node after either one.
  Exact `true` is persisted as `outcome: succeeded`, exact `false` as `outcome: failed`.
  This is independent from engine lifecycle `status`: a run may be `completed / failed-outcome`,
  `failed / succeeded-outcome`, or `paused / succeeded-outcome`. Status still controls terminality,
  resume, cancellation, filtering, automation, and CLI exit codes. A workflow with no declaration,
  a selected node that has not completed, and historical runs read as `outcome: null`, never as
  failure. Resume preserves an authored outcome until the selected node actually re-executes and
  authors a replacement.

An included workflow's outcome declaration never becomes the composer's outcome, and a
`workflow:` child owns its outcome on its own run row; neither propagates implicitly to a parent.
The REST run list, detail, by-worker, and dashboard JSON expose nullable `outcome` beside `status`.
CLI, console, chat, and adapter result surfaces show a non-null authored outcome separately from
execution status. A foreground CLI execution handoff reports only its observed status, omitting
authored outcome and usage; its zero exit does not prove completion. Use `archon workflow wait <run-id>`
to await a terminal or gate transition and `archon workflow get <run-id>` to inspect the current result.
See [CLI handoff behavior](/reference/cli/#workflow-run-name-message). When `outcome` is null, result
surfaces retain the normal status-only presentation. A dry run
reports the same declaration separately as nullable `authoredOutcome`, derived from the declared
return node's schema-valid stub (a structured value or JSON string), or its schema-certified
`bash:` / `script:` output with `--exec-code`. Its existing `outcome` remains the simulation result
and continues to control CLI exit codes and fixture `expect` checks. Fixtures can independently
assert the authored verdict with `fixture.authored: succeeded` or `failed`. Generated placeholder
stubs, including tolerated `all_done` joins, never author a verdict.

### Deterministic checks, authored outcomes, and evidence markers

These are independent signals:

- A deterministic check is an ordinary `bash:` or `script:` node. Exit zero completes the node;
  any other exit fails it and therefore affects lifecycle status. A named script read from captured
  source is also rejected if the run's full source capture no longer matches its pinned identity.
- `outcome_field` records the workflow author's schema-declared boolean verdict. It does not control
  lifecycle status. A succeeded outcome can remain on a run that later fails, and a failed outcome can
  coexist with a completed run.
- `evidence_policy: { required: true }` is only a terminal file-presence convention. It requires a
  host file at `$ARTIFACTS_DIR/evidence.json` before lifecycle completion. Any contents, including a
  self-asserted or unsupported claim, satisfy it. The marker proves neither that a check ran nor that
  an outcome was authored.

There is no special verification node or verification status. Put a check in a deterministic node
when its execution must govern success, and use `outcome_field` only when the workflow must record its
own conclusion. Use `evidence_policy` only when a conventionally named deliverable must exist.

### Binding time: includes resolve at load, runs at runtime

`$INPUTS.<name>` is delivered by **two deliberately separate paths**, and the difference decides
which surfaces can read it:

| Caller | When `$INPUTS` resolves | Reaches `prompt:`/`bash:`/`script:` | Reaches `command:` file bodies |
|--------|-------------------------|-------------------------------------|--------------------------------|
| `include:` | **Load time** (the block and command bodies are compiled into the flat DAG) | `prompt:` yes; `bash:` as a quoted `INPUTS_<UPPER_SNAKE>` reference; inline `script:` is a load error | **Yes**: resolved command bodies receive the same input binding before execution |
| `workflow:` sub-run | **Runtime** (values become inputs on the child run) | `prompt:` yes; `bash:` and `script:` read `INPUTS_<UPPER_SNAKE>` env vars | **Yes**: command-backed prompts receive runtime substitution |
| direct run (`--input` / console form) | **Runtime**: the same path as a sub-run; supplied values are persisted to the run's own metadata, so inputs reconstitute on a cold resume | `prompt:` yes; `bash:` and `script:` read `INPUTS_<UPPER_SNAKE>` env vars | **Yes**: command-backed prompts receive runtime substitution |

Both composition paths support command-backed prompts; their binding time differs. Includes
snapshot and bind the resolved command body at load time, while sub-runs resolve inputs at
runtime. Sub-run inputs are persisted to the child run's metadata at spawn, so `$INPUTS`
reconstitutes on a cold resume.

### `$INPUTS` in `bash:`/`script:` nodes uses env vars

`$INPUTS.<name>` text is substituted only into non-shell (AI/prompt) surfaces: a sub-run's
input value can derive from AI output, exactly the user-controlled class kept out of shell
source. A `bash:`/`script:` node instead reads each input as an **environment variable** named
`INPUTS_<UPPER_SNAKE>`: hyphens become underscores and the name is upper-cased, so `plan` →
`$INPUTS_PLAN` and `base-branch` → `$INPUTS_BASE_BRANCH`. (Because `-` and `_` both fold to `_`,
two input names that collide on one env key, e.g. `foo-bar` and `foo_bar`, are a load error.)

```yaml
# in a workflow: sub-run child
nodes:
  - id: check
    bash: |
      echo "planning: $INPUTS_PLAN"     # NOT $INPUTS.plan — bash reads the env var
```

### `$INPUTS` in `when:` conditions

A node in a `workflow:` sub-run child, or in a workflow started directly with `--input`,
can **branch** on a declared input, not just read one:

```yaml
inputs:
  mode: { default: thorough }
nodes:
  - id: quick-pass
    prompt: "Do the quick pass"
    when: "$INPUTS.mode == 'fast'"
  - id: full-pass
    prompt: "Do the full pass"
    when: "$INPUTS.mode != 'fast'"
```

The condition resolves the name against the run's inputs at evaluation time; the value is
never spliced into the expression, so an input containing a quote or an operator is
compared as data and can never be re-read as syntax. Present object and array inputs fail
the node loudly rather than stringify-comparing. An `$INPUTS.<name>` the run does not
carry **fails the node**, with the same message the prompt surface gives
(`Unknown input '$INPUTS.mdoe'. Did you mean $INPUTS.mode?`). It never resolves to an
empty string, because a condition that quietly compares nothing is the silent-branch
failure the [`when:` section](#when-condition-syntax) warns about.

:::caution[Inside an `include:` block, put `$INPUTS` on the RIGHT of the comparison]
An include is a **verbatim text** splice at load time, and a `when:` is one of the
surfaces it rewrites. That makes the right-hand form work and the left-hand form break:

```yaml
when: "$probe.output == '$INPUTS.mode'"   # ✅ becomes  $probe.output == 'fast'
when: "$INPUTS.mode == 'fast'"            # ❌ would become  fast == 'fast'
```

The second would no longer be a condition, so include expansion rejects it at load time and
shows both the authored and rewritten expressions instead of allowing a runtime skip. The
left-hand form is a `workflow:`/direct-run feature: those callers resolve `$INPUTS` at
evaluation time, while an included block is inlined into the caller's own run and has no
input scope left to resolve against.
:::

### Running a workflow that declares inputs

Declaring `inputs:` does not make a workflow callable-only. The same file runs on its own **and**
composes into any number of parents. Supply the values at invocation:

```bash
# one flag per input; repeat it
archon workflow run review-block --input diff="$(git diff)" --input style=terse

# the trailing message is still $ARGUMENTS, independent of --input
archon workflow run review-block --input diff=... "focus on the auth changes"
```

In the **web console**, a workflow that declares `inputs:` renders a field per input in the run
card: description as help text, `default:` as the placeholder, `*` on the required ones. The
Start button stays disabled, and says which input it is waiting for, until every required field
has a value. A field left blank is **omitted**, so it falls back to its declared `default:`;
the console therefore cannot send a deliberate empty string, where `--input name=` can.

The grammar is deliberately small:

- `--input name=value` splits on the **first** `=`, so `--input msg=a=b` gives `a=b`.
- Values are plain strings. `--input name=` supplies a deliberate empty string.
- Repeat the flag per input; supplying the same name twice is an error, not last-wins.
- Omit an input to take its `default:`. Omitting one with no default and no `required: true`
  leaves it unset, and a body referencing it fails at the reference site.

Whatever supplies the values, they go through **one contract**: the same code a caller's `with:`
map goes through, so a map accepted when composing is accepted here:

- a **required** input with no value is refused, naming it;
- an **undeclared** key is refused, naming it and listing what the workflow does declare;
- both refusals happen **before any worktree, clone, or AI cost**;
- supplied values are recorded on the run, so a resume replays exactly what the run started with.

One consequence worth knowing on **chat, the run route, and the console**: the surfaces that reuse a
conversation. Invoking a workflow there when a resumable run of it already exists in that
conversation normally *continues that run* rather than starting a new one, without any resume vocabulary
(see [DAG Resume on Failure](#dag-resume-on-failure)). New `inputs` values passed on such a call are
**not applied**: the continued run keeps what it started with, and Archon says so, naming the
values it ignored. To run fresh with different values, abandon the existing run first
(`/workflow abandon <id>`) and invoke again. The CLI has no such implicit continuation: a plain
`archon workflow run` always starts fresh, and `--input` with `--resume` is rejected outright.

Adoption and supersede declarations are exceptions: if the dispatch would continue an existing run,
Archon refuses the declaration before continuation or its fresh fallback. The refusal names the
existing run and tells you to resume or abandon it first, or use a conversation with no open run.
An accepted fresh supersede records the replaced run ID and `supersede` continuation mode on the
new run. Adoption and supersede cannot be declared together.

In chat (Slack, Telegram, Discord, GitHub, Web UI), the assistant sees each workflow's declared
inputs, asks you for missing required values in conversation, and passes them through its
`invoke_workflow` tool. The same validation and pre-cost refusal apply. Assistants without
[in-process native tools](/reference/provider-capabilities/) use the existing CLI after you
select a project with `/setproject <name>`. They pass declared inputs with
`archon workflow run <workflow> "<message>" --detach --input name=value` from the
registered project directory. Copilot/OpenCode launches are headless, use CLI identity, and
return a run ID for inspection without originating-chat progress or result delivery.
Assistant prose, including slash-command examples, never launches or registers anything.
See [Deprecated providers](/getting-started/ai-assistants/#deprecated-providers).

## Launching a Separate Governed Run with `workflow:`

A `workflow:` node runs another workflow as a **child sub-run**: a genuinely separate
`workflow_runs` record with its own artifacts directory, its own pauses, its own
cost line, and its own audit trail. The child's terminal output threads back into the
parent as `$<nodeId>.output`, exactly like any other node.

### Choosing between `include:` and `workflow:`

Both run another workflow as authored. They differ in how many governance objects exist:

| | `include:` (composition) | `workflow:` (a separate launch) |
|---|---|---|
| **Run record** | One. The block's nodes flatten into this run at load time. | Two. The child gets its own run record, artifacts, cost line and audit trail. |
| **Pauses** | Answered on the run that composed the block. | Answered on the child by its own run id. The parent stays paused and resumes by itself when the child finishes. |
| **Command bodies** | Snapshotted at discovery, so a resumed run survives the file being edited or deleted. | Re-read when the child starts. |
| **Output** | `$includeId.output` (the block's `returns:` node, or its primary sink). | `$nodeId.output` (the child's result). |

Reach for `include:` when you want one run made of reusable parts, which is the common case. Reach for `workflow:` when one delegated unit must be answered, inspected or abandoned independently of its siblings and its caller, or when you want N runtime copies of one workflow (`fan_out:`).

Because a composed block has no run of its own, most launch-only options are load errors on
an `include:` node rather than silent no-ops: `isolation:`, `input:`, and
`mutates_checkout:` each fail with a message naming the option and pointing here. A merely
unread field (an AI option on an include node, say) still only warns. The one exception is
`fan_out:`, which an `include:` node accepts as the composed fan-out described in
[Fanning out a composed block](#fanning-out-a-composed-block-inside-the-run-include--fan_out).

```yaml
nodes:
  - id: plan
    prompt: "Plan the change described in $ARGUMENTS."
    context: fresh

  # `workflow:` names any discovered workflow (bundled / global / repo) to run as a
  # child sub-run; `qa-block` here is a placeholder for your own workflow file.
  # Its terminal output becomes $implement-qa.output.
  - id: implement-qa
    workflow: qa-block
    input: "$plan.output"
    depends_on: [plan]

  - id: summarize
    prompt: "Summarize the sub-run result:\n\n$implement-qa.output"
    depends_on: [implement-qa]
    context: fresh
```

A `workflow:` node has **one** input channel per invocation: either the untyped `input:` string
(delivered as the child's `$ARGUMENTS`) **or** the named `with:` map (delivered as the child's
`$INPUTS.<name>`. See [Workflow Signature](#workflow-signature-inputs-returns-and-inputs)).
Setting both on one node is a load error. Use `with:` when the child declares named `inputs:` or
when its `command:` bodies need named values:

```yaml
  - id: implement-qa
    workflow: qa-block
    with:
      plan: "$plan.output"
      mode: fast
    depends_on: [plan]
```

### Gates, failure, and cost

- **A child pause pauses the whole tree.** When the child pauses for an answer, the child run
  pauses **and** the parent pauses "blocked on child". Answer the **child** by its own full
  run id (for example `archon workflow approve <childRunId>`). Read it from
  `archon workflow get <parentRunId> --json` at `.metadata.approval.childRunId`. The stored
  pause message contains only a short child label; a surface notice may include the full child
  command. When the child completes, the parent **auto-resumes** in-process, re-runs the `workflow:` node,
  finds the child finished, and threads its output onward.
- **Failure & recovery.** A failed child fails the node and the parent run. Recovery is
  resume-through-parent: `/workflow resume <parentRunId>` re-drives the failed child once.
  `retry:` is **not** allowed on a `workflow:` node (a retry would orphan the first child
  run).
- **Cancel cascade.** Abandoning the parent attempts to cancel discovered descendants except completed
  and cancelled runs, within the [500-parent expansion bound](#max_parallel-bounds-concurrency-not-count).
  Cancellation is cooperative: their executors abort at the next status check, within ~10s. A running
  host `bash:` or `script:` node of a run that `archon serve` executes is ended as described
  under [Bash and script node timeouts](#bash-and-script-node-timeouts), and cancelling a
  detached run stops its live node groups and owner group (macOS and Linux) or Job Object
  (Windows), with the output-holder warnings described above.
- **Cost roll-up.** The parent run total includes all child spend. A resumed `workflow:`
  node event carries only the increment not previously reported for that child.
  The `parent_run_id` on the child row makes the run tree visible
  in `archon workflow runs` and the console. A run records what it spent whatever its
  outcome, so a partly-failed fan-out reports the spend of every child, not just the ones
  that finished. How to read token and cost fields without double counting is described in
  [Reading tokens and cost](/reference/node-execution/#reading-tokens-and-cost).

### Choosing the child's checkout with `isolation:`

`isolation:` decides which working directory the child run executes in. It is valid **only**
on a `workflow:` node: on any other node type it is rejected at load time, since only a
sub-run has a checkout of its own to choose.

| Value | The child runs in |
|-------|-------------------|
| omitted (the default) | the parent's checkout, same files, same branch |
| `inherit` | identical to omitting it; write it when you want the sharing to be deliberate rather than incidental |
| `worktree` | its own git worktree, on its own branch |

**Archon never infers this.** Nothing about a node (what workflow it names, how many
children it spawns, whether they run concurrently) makes a worktree appear. A child gets
one when, and only when, you write `isolation: worktree`. Whether a step needs its own
checkout is a judgement about what that step *does*, and the author is the one who knows.

Most sub-runs don't need one. A review, a research pass, or a summarizer that writes only to
`$ARTIFACTS_DIR` is better off in the parent's checkout: it sees the parent's uncommitted
work, and there is nothing to create or clean up afterwards.

#### What `isolation: worktree` gives you, and what it costs

```yaml
  - id: refactor-module
    workflow: refactor-block
    input: "$plan.output"
    isolation: worktree        # its own checkout, its own branch
    depends_on: [plan]
```

The child gets a fresh worktree under `~/.archon/workspaces/<owner>/<repo>/worktrees/`, on a
new branch named `archon/task-<parentRunId8>-<nodeId>-<hash>-child-<n>`, for the node above,
`archon/task-3f9a1c2b-refactor-module-6fd3f873-child-0`. The node id is what keeps two
isolated sub-run nodes in one parent from landing in the same worktree; the hash covers node
ids too long to fit in a branch name. Four consequences are worth knowing before you reach
for it:

- **The branch starts from the repo's base branch, not the parent's.** The worktree is cut
  from `origin/<baseBranch>` **in the canonical checkout**, not from the parent's working
  tree. The base is levels 2–4 of the [base-branch precedence
  table](/reference/cli/#base-branch-precedence): `worktree.baseBranch` in
  `.archon/config.yaml`, else the codebase's stored default branch, else git
  auto-detection. Level 1 is missing on purpose: **the per-dispatch `--base` / `--from`
  overrides do not change an isolated child's cut-from**, so
  `archon workflow run parent --base release/2.0` still cuts every isolated child from the
  repo's configured base. Its `$BASE_BRANCH` reports that provisioning base. If the branch
  is reused without a surviving child run record, its original base is unavailable and
  `$BASE_BRANCH` stays unresolved. Fresh shared-checkout children (`inherit` or omitted) instead inherit the parent's
  resolved `$BASE_BRANCH`, including `--base`. Existing child runs retain their recorded
  base on resume. An isolated child therefore sees neither the parent's uncommitted edits
  **nor the commits the parent made on its own branch**.
  Everything the child needs has to arrive through `input:`, artifacts, or the repo's base
  branch.
- **Nothing merges it back.** The child's commits stay on the child's branch. Landing them
  is the workflow's job: the child pushes and opens a PR, or a later parent node does. What
  returns automatically is only the child's terminal output, as `$<nodeId>.output`.
- **It becomes a tracked environment with a lifecycle.** Each child worktree registers an
  isolation environment, so it appears in `archon isolation list` next to top-level run
  worktrees and is governed by the same `archon isolation cleanup [--merged]` and
  `archon complete <branch>`. It is **not** removed when the child finishes: the branch
  deliberately outlives the run so you can inspect or land it. Isolate many children and you
  accumulate many worktrees and branches to clean up.
- **Resume reuses it, and fails if it is gone.** As long as the child's run row exists, a
  resume reuses the path recorded on it rather than making a second worktree. If that path
  was cleaned up in between, the node fails with *"its working path no longer exists …
  start a fresh run"* rather than dying on a deep `ENOENT` mid-run. Don't run
  `isolation cleanup` while a sub-run tree is still resumable. (Only if the child's run row
  itself is gone does the node spawn fresh, and it lands on the same branch name, since
  the name is derived from the parent run and the node id.)

Nesting works: a grandchild `workflow:` node can request its own worktree too, up to the
sub-run depth cap.

#### When a worktree can't be created

Creating one needs a git repository and a surface that can make worktrees in it. When the run
has neither, the node **fails fast**: it never quietly falls back to the shared checkout,
because a silent fallback would produce exactly the concurrent-write collision the isolation
was asked for:

```text
isolation: 'worktree' on sub-run '<name>' requires an injected child-isolation resolver
(available for git-repo codebases run via the CLI or orchestrator). Remove the isolation
or use 'inherit' (shared checkout).
```

You get this when:

- the project is a **folder project**: a directory registered for in-place execution with no Archon-managed git machinery; it may itself be a git repository
  ([Multi-Repo Projects](/guides/multi-repo-projects/)). Archon does not manage worktrees
  for folder projects. Use `inherit`, or target a separately registered repo project.
- the run resolved no codebase at all (for example a background dispatch with no project
  bound, or a database lookup that failed at run start).

Whether the **parent** is isolated makes no difference. A parent started with
`--no-worktree`, running in your live checkout, can still hand an isolated child its own
worktree, which is a reasonable shape when the parent only reads and one step writes.

`archon validate workflows` **cannot** catch this. Whether a worktree can be created is a
property of the run, not of the file, so a workflow using `isolation: worktree` validates
cleanly everywhere and then fails at the node when it is run somewhere it can't be honored.
If a workflow only makes sense against a git repo, say so in its `description:`.

A worktree that fails for an ordinary git reason (no disk space, a permission problem, a
branch that has diverged from its remote) fails the node the same way, with a readable
message.

### Running sub-runs side by side

Two `workflow:` nodes in the same DAG layer start their children at the same time. What
happens next depends on whether those children share a checkout.

Children **in their own worktrees** (`isolation: worktree`) never interact: separate
directories, separate branches.

Children **sharing the parent's checkout** meet the engine's path-exclusive lock. Every run
takes a lock on its working path at start, and a run that finds the path already held by
another active run **cancels itself**. The lock excludes a run's own ancestors and
descendants: a child never blocks against its own parent. Children of the **same
`fan_out` node** are also excluded and may share the checkout. Children of different
`workflow:` nodes are not excluded. Two such children in one layer over one checkout collide:
the older run keeps the path, the younger one cancels itself, and the parent run fails.

> **Resume does not recover from this.** A parent's resume re-drives a *failed* child, but a
> *cancelled* one is threaded straight through as it stands, so a parent that failed this
> way fails again identically on every resume. The only way out is a fresh run. Avoid the
> collision; don't plan to recover from it.

The way to avoid it is to declare what the child does, on the child workflow itself:

```yaml
# review-block.yaml — reads the repo, writes only to $ARTIFACTS_DIR
name: review-block
description: Reviews the diff and writes findings. Composes into a parent; also runs on its own.
mutates_checkout: false      # skips the path lock: N of these coexist in one checkout
nodes:
  - id: review
    command: review-diff
```

`mutates_checkout: false` is a **workflow-level** field asserting that the run does not write
to its checkout, so the engine skips the path lock for it. It defaults to `true` (take the
lock, prevent overlapping execution on the same path). Direct executor dispatch rejects a
run on a held path; [trigger admission](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy)
queues or skips it according to `overlap`. It is author-declared on purpose: the author of a
review or research workflow is the one who knows it only reads. Children launched by
separate `workflow:` nodes still compete for the path lock unless they declare it.
Children of the same `fan_out:` node and their nested sub-runs may share the checkout
without that declaration; see [fanning out over a list](#fanning-out-over-a-list-with-fan_out).

For concurrent 1:1 children launched by different nodes, choose according to the children:

| The children… | Do this |
|---------------|---------|
| only read the repo (review, research, summarize) | `mutates_checkout: false` on the **child workflow** |
| write to the repo | `isolation: worktree` on each **`workflow:` node** |
| must not overlap at all | sequence them with `depends_on` |

Each 1:1 child run presents its own pause independently, addressed by its own run
ID. Concurrent children can both pause for an answer; the parent stays blocked until its
children finish. Within a single run, pauses are presented one at a time, and deferred pauses
re-run when that run resumes.

### Fanning out over a list with `fan_out:`

`fan_out:` turns one `workflow:` node into **N child runs** (one per element of a list
produced at run time) and reduces their results back into a single node output. Each
child is a full governance object in its own right: its own run record, artifacts, cost
line and audit trail, exactly like a 1:1 sub-run.

```yaml
nodes:
  - id: pick-files
    bash: |
      git diff --name-only origin/main \
        | jq -R -s -c 'split("\n") | map(select(length > 0))'

  # review-one-file declares `mutates_checkout: false` — see "Isolation" below.
  - id: review-each
    workflow: review-one-file
    depends_on: [pick-files]
    fan_out:
      items: "$pick-files.output"    # must resolve to a JSON array
      max_parallel: 3
      # join defaults to all_done: one file failing to review still yields the rest

  - id: summarize
    prompt: "Summarize these per-file reviews:\n\n$review-each.output"
    depends_on: [review-each]
```

Each item becomes one child's `$ARGUMENTS`. `$review-each.output` is a JSON array of the
children's terminal outputs **in item order**, not completion order, so a downstream node
can line results up against the input list positionally.

#### The four fields

| Field | Default | What it does |
|-------|---------|--------------|
| `items` | required | A `$node.output` (or `$node.output.field`) reference that must resolve to a **JSON array** at run time. Anything else (an object, a bare string, malformed JSON, a dangling ref) fails the node before any child is created. It never fans out over the characters of a string, and never silently degrades to zero items. An empty array is legal: the node completes immediately with `[]`. |
| `as` | unset | Names the current item as `$INPUTS.<as>` in each child. It must not collide with a `with:` key. The item also reaches the child as `$ARGUMENTS`. |
| `max_parallel` | `5` | Positive integer limiting unfinished children, or `all` to open every resolved item together. `all` is supported on `workflow:` nodes only. |
| `join` | `all_done` | How N child outcomes reduce to one node outcome (below). |

The `items` producer must be an upstream dependency: the loader rejects a reference to a
node this one doesn't transitively depend on, so the array can never be read before it is
written.

#### `max_parallel` bounds concurrency, not count

`max_parallel` is a sliding window, not a limit on how many children exist. On a `workflow:` node, `max_parallel: all` sets that window to the resolved item count. `items` is
**unbounded**: a 400-element array produces 400 child runs regardless of the window.
Consequences worth planning for:

- Cost scales with `items.length`, not with `max_parallel`. Bound the list in the producer
  node, not here.
- A child that pauses keeps its slot until it finishes, so unanswered children can hold
  the whole window and later items wait. Paused children use no process or provider, so
  a wider window starts more children before they pause and can run their post-answer work concurrently.
- Abandoning the parent expands at most 500 parents (`MAX_CASCADE_RUNS`), considering
  every discovered child for cancellation even in a wide fan-out. One final aggregate
  lookup checks beneath the remaining queue, excluding completed and cancelled leaves. Deeper subtrees may remain
  unvisited; a warning means those descendants need individual inspection. This bounds
  lookup rounds, not cancellation count or total work. A run-tree-wide budget ceiling is tracked in
  [#1961](https://github.com/coleam00/Archon/issues/1961).

#### Join semantics

| `join` | The node succeeds when… | `$<id>.output` |
|--------|------------------------|----------------|
| `all_done` (default) | every child reached a terminal state and at least one child run was created (or the item list was empty) | JSON array in item order: each element is the child's **result value** (a structured child's terminal payload lands as the object itself, single-encoded; a text child's output stays the raw string), with each failed/cancelled child represented as `{ archon_failed: true, error, status }` in its slot |
| `all_success` | every child completed | same array; any failed or cancelled child fails the node instead |
| `first_success` | never (load error) | Racing: **rejected**, not deferred. See below. Rejected at load rather than silently treated as another join |

**Every child runs to its own terminal state before the join reduces, under both joins.** A
child that fails does not stop its siblings, does not stop later items from being spawned,
and does not change any other child's outcome. `all_success` still fails the node if any
child failed: it just reaches that verdict after everyone has finished rather than by
ending the others early. The failure message names the child that failed.

A non-empty `workflow:` fan-out fails if **no child run row was created**, even with
`all_done`. The error names the node, the number of refused children, and the first
refusal reason. Resume re-dispatches this failed node. If at least one child run was
created, `all_done` still completes with the same failure markers for failed and refused
children, even if every child that started failed. An empty item list still completes
with `[]`.

Resume skips a completed fan-out and reports how many children were previously refused.
It does not repeat children that ran, including failed children in an `all_done` batch.
Resume uses the captured parent source, so correcting a binding in that source requires
a fresh launch. Project child workflows still resolve from the live authoring directory
when spawned; installed packs remain captured. A transient refusal may also clear before
resume.

##### A completed fan-out node is not completed child work

Under `all_done` the node completes when every child is terminal, not when every child
succeeded. Once every slot settles, the node records what became of each one as
`fan_out_outcome` on its `node_completed` or `node_failed` event: one slot per item, in item
order, plus a tally that always agrees with the slots. Each slot is one of:

| Outcome | Meaning |
|---------|---------|
| `completed` | the child run completed |
| `failed` | a child run exists and failed |
| `not_started` | no child run exists for this item; the slot's `error` is the refusal, its only record |
| `cancelled_by_engine` | the engine cancelled the child: a fan-out cancel or a failed start-time precondition |
| `cancelled_by_workflow` | the child's own workflow ended it: a `cancel:` node or a rejected approval gate |
| `cancelled_out_of_band` | an operator, or a conversation reset, cancelled the child |
| `cancelled_unattributed` | the child was cancelled before cancellation reasons were recorded, so who cancelled it cannot be told |

Each slot is read from the child's durable run, so the same child gets the same outcome
whatever `max_parallel` was and however many resumes it took. When a completed node has
unfinished slots, the engine logs `workflow.fan_out_completed_with_unfinished_children` and
sends one notice. The node and the run still complete. The all-refused failure above still
applies, and its `node_failed` event carries the `not_started` slots.

Read the record with `archon workflow get <run-id>` (see the [CLI reference](/reference/cli/#workflow-get)),
from `run.nodes[].fan_out_outcome` on `GET /api/workflows/runs/{runId}`, or on the node's line
in the console. It is not a `$node.*` reference: a downstream node that decides what the
results are worth reads the `archon_failed` markers in `$<id>.output`, as below.

##### Why `all_done` is the default

Fan-out children are independent jobs that happen to run together. One failing says nothing
about the others, and an all-or-nothing default would discard the good results after you had
paid for them. So the default treats failure as data: every terminal outcome reaches the
aggregate, failed ones as `{ archon_failed: true, error, status }` in their slot, and the node
succeeds. A later script or prompt node reads the aggregate and decides whether the results
are enough; check the reserved `archon_failed: true` key, not the presence of `error` or
`status`, because a child's own result may declare those fields. There is deliberately no
"succeed if K children completed" join: how many results are enough is a judgement about your
work, not a join rule.

Use `all_success` when the children are one job, so a gap makes the aggregate meaningless
rather than smaller.

##### Why there is no racing join

`join: first_success` fails at load. Racing works only by cancelling the losers, so one
child's outcome would decide its siblings'. For several different attempts with the best one
carried forward, write the attempts as separate nodes, each with its own prompt or model, and
add a collector node that depends on all of them and picks.

Plan for the cost: a fan-out whose first child fails still runs every remaining child.
`max_parallel` caps how many run at once, never how many run in total, so bound the list in
the producer node.

#### Sharing a checkout or choosing isolation

Fan-out changes nothing about [`isolation:`](#choosing-the-childs-checkout-with-isolation).
Without `isolation: worktree`, children share the parent's checkout and run up to
`max_parallel`, including children that write to it. The engine excludes children of the
same `fan_out` node and their nested sub-runs from one another's path lock.
Agents own coordination of their edits; the engine adds no coordination mechanism between them.

Each child's `workflow.checkout_shared` events name its siblings on that checkout through
`sibling_run_id`, with `parent_run_id`, `parent_node_id`, and `working_path`. This records
checkout sharing, including children that use it at different times, rather than claiming
their execution overlapped. Unrelated runs and children of different nodes still compete
for the path lock.

Use `isolation: worktree` explicitly when every child should have its own checkout and
branch, or `max_parallel: 1` when children should run serially. Workflow-level
`mutates_checkout: false` still skips the path lock; node-level `mutates_checkout: false`
still enforces the checkout guard. Neither declaration is required to share a checkout
within one fan-out.

#### Children that pause

A fan-out child may pause like any run: at a `wait:` node, or at a deprecated `approval:`
gate or interactive loop. It stays paused as its own run and its own queue item, and nothing cancels it for
pausing. Its siblings keep running to their own terminal states.

- **The parent waits.** Once no more children can start, the parent pauses on a `fan_out`
  gate that lists every unfinished child (`item <index>: run <id>`) and how many items have
  not started yet. `archon workflow wait` on the parent wakes with the first child, in item
  order, that needs an answer.
- **Answer each child by its own run id.** Approving or rejecting the parent is refused with
  a redirect naming its children. When the children it waits on finish, the parent
  continues on its own, starts any items that were waiting, and joins exactly as above.
  A child that failed before the pause is reported as failed, not run again.
- **A paused child keeps its `max_parallel` slot.** With `max_parallel: 1`, items after a
  paused child wait until it is answered and finishes, so children never overlap in a
  shared checkout.
- **Abandoning the parent** cascade-cancels its paused children with the rest of the tree.
- **Abandoning one child** leaves the parent paused. Resume the parent; it reads that
  child's outcome as cancelled, and the join treats it like any cancelled child.

Pauses around the node work as usual: a `wait: attention` node before the fan-out is an
ordinary parent pause, and one after it reads `$<id>.output` holding the full aggregate.

#### Several independent questions

Use one child run per question and `max_parallel: all` to expose the full list together.
A numeric window can leave later questions unstarted while earlier children are paused.
Each child applies its answer immediately; put that work inside the child after its wait.
The parent stays paused while questions remain and receives the aggregate, in original
item order, only after every child finishes.

Save these two workflows in `.archon/workflows/`. The producer can compute any
runtime-sized question list; this example supplies two:

```yaml
# questions.yaml
name: questions
description: Ask independent questions together
nodes:
  - id: list
    bash: >-
      printf '%s' '[{"key":"first","message":"Accept the first proposal? Recommended accept."},{"key":"second","message":"Accept the second proposal? Recommended defer."}]'
  - id: answers
    depends_on: [list]
    workflow: question
    fan_out:
      items: "$list.output"
      as: question
      max_parallel: all
```

```yaml
# question.yaml
name: question
description: Apply one independent answer
inputs:
  question: { required: true }
returns: apply
nodes:
  - id: question
    bash: printf '%s' "$INPUTS_QUESTION"
    output_format:
      type: object
      properties:
        key: { type: string }
        message: { type: string }
      required: [key, message]
  - id: ask
    depends_on: [question]
    wait:
      attention: "$question.output.message"
      form: select
      options: [{ id: accept }, { id: defer }]
  - id: apply
    depends_on: [ask]
    runtime: bun
    with:
      question: $question.output
      answer: $ask.output
    script: |
      const question = JSON.parse(process.env.INPUTS_QUESTION);
      const answer = JSON.parse(process.env.INPUTS_ANSWER);
      // Apply this question's decision here, before returning its result.
      console.log(JSON.stringify({ key: question.key, decision: answer.decision }));
    output_format:
      type: object
      properties:
        key: { type: string }
        decision: { type: string }
      required: [key, decision]
```

List all children through the [attention queue](/getting-started/operate/#several-items-from-one-workflow).
Read and answer each child's `runId` and `occurrence`; a parent read returns only its first
actionable descendant. Answering the second child first leaves the first question open.
Completed child results and unanswered occurrences survive restart and resume.

`all` opts into concurrency across the entire list, including work before the wait and
after each answer. Keep question children small, bound the producer's list when needed,
and coordinate shared-checkout writes or choose child isolation. The default remains 5;
composed `include:` fan-out accepts positive integers only. There is no new wait or
persisted run shape. Older runs with numeric windows keep their behavior. A binary that
predates `all` cannot load a captured workflow using it: finish those runs before
downgrading, or restore a supporting binary to resume them.

#### Resume, and what `child_index` keys

Children are keyed by their position in the item list (`metadata.child_index`), which is
what makes a parent resume cheap and predictable:

- Completed children are threaded from their existing rows, never re-run, never re-billed.
- When you resume a fan-out node that failed, failed children are re-driven in place, in
  the same row. Children Archon itself cancelled (for example an orphan whose item
  disappeared) are tagged and re-driven too. A child **you** cancelled out of band stays
  cancelled and is never resurrected.
- When the parent continues after its paused children finish, nothing that already
  settled is re-driven: a failed child stays failed in the aggregate.
- A child left `running` or `pending` by an interrupted process is **not** auto-cancelled:
  Archon can't tell a crash orphan from a live run elsewhere. The node fails with the child's
  run id and tells you to wait or abandon it.

Because the key is the index, the `items` list changing between attempts matters:

- **The list got shorter**: a child whose index no longer exists is logged and, if still
  running, cancelled as an orphan. It is never silently dropped.
- **An item at some index changed** (a non-deterministic producer): resume still re-keys by
  index and warns (`workflow.fan_out_item_content_changed`) that a child's item is not the
  one it was spawned with. In the normal case this can't happen: the producer's output is
  cached from the first attempt and replayed on resume. It shows up when the producer node
  is marked `always_run: true`, or when its output genuinely isn't stable.

If you want a fan-out whose item list is guaranteed identical across attempts, keep the
producer deterministic: write the list to `$ARTIFACTS_DIR` and read it back rather than
re-deriving it.

### Limits of `workflow:`

- **Choose one input form**: `input:` sends a single data string as `$ARGUMENTS`;
  `with:` supplies named `$INPUTS` values. The two forms are mutually exclusive.
- **No racing** (`join: first_success`): rejected outright, not deferred (see [Why there is no racing join](#why-there-is-no-racing-join)).
- **Not inside a `loop_group` body**: a `workflow:` node, fanned out or not, is rejected
  there at load time ([#2439](https://github.com/coleam00/Archon/issues/2439)).
- **Static target only.** `workflow:` takes a literal workflow name: no
  `workflow: $something`. Self-reference and ancestor cycles (`A` → `B` → `A`) are rejected
  at run time, and the sub-run tree is depth-capped.

### Fanning out a composed block inside the run (`include:` + `fan_out:`)

A `workflow:` node with `fan_out:` gives every item its own governed child run. When runtime
cardinality does not justify separate run identity: N review comments on N files that all
belong to *this* run's audit trail: put `fan_out:` on an **`include:`** node instead:
the statically named block is expanded once per item *inside this run*.

```yaml
nodes:
  - id: pick-files
    bash: |
      git diff --name-only origin/main \
        | jq -R -s -c 'split("\n") | map(select(length > 0))'

  # annotate-file is an ordinary composable block (a workflow file with its own
  # inputs:/returns: signature). It runs N times HERE — one parent run row, no children.
  - id: annotate-each
    include: annotate-file
    depends_on: [pick-files]
    with:
      style-guide: "${ARTIFACTS_DIR}/style.md"
    fan_out:
      items: "$pick-files.output"
      as: file            # each instance reads $INPUTS.file
      max_parallel: 3     # join defaults to all_done, like a workflow: fan-out

  - id: collect
    prompt: "Merge these per-file annotations:\n\n$annotate-each.output"
    depends_on: [annotate-each]
```

What you get, compared with the `workflow:` fan-out above:

- **One governance object.** No child `workflow_runs` rows, artifacts directories, cost
  lines or gate sets per item. Every instance's events are written under the parent run id,
  under engine-owned instance-qualified step names. Their exact storage form is not part of
  the workflow authoring contract.
- **The same package and signature semantics as a static `include:`.** Command/script bodies
  resolve from the exact packaged source captured for the run, `returns:` selects the
  aggregate value, and `$INPUTS` binding follows the block's declared `inputs:`. The item
  binding named by `fan_out.as` is required; there is no implicit `$ARGUMENTS` fallback.
- **Ordered aggregate.** `$<id>.output` is a JSON array of the instances' terminal outputs
  **in item order**, not completion order; under `join: all_done` a failed instance
  contributes the `{ archon_failed: true, error, status }` marker. An empty item list
  completes immediately with `[]`. Under `join: all_success` any failed instance fails the
  node.
- **Content-addressed resume.** Each instance is keyed by a hash of its item value (plus an
  ordinal for byte-identical duplicates). The first ordered snapshot is persisted before
  anything schedules and remains authoritative: a resume ignores and logs a producer list
  that is now shorter, longer, or reordered. Completed instances and their completed inner
  nodes are threaded from persisted events instead of re-running or being billed twice. If
  an instance has a durable start but no terminal event, Archon cannot prove whether its
  side effects finished and blocks automatic replay for operator recovery.

Two hard limits, both enforced at load time before any upstream node can spend:

- **No suspension inside the complete block closure.** The parent has no durable per-item
  pause cursor, so a block containing a `wait:` node, a deprecated `approval:` node or
  interactive `loop:`/`loop_group:`, or a nested workflow that can pause is rejected. Put the pause in
  the parent around the node, or invoke the block 1:1. When items may pause, use a
  `workflow:` node with `fan_out:` instead: each item is its own run and may pause and be
  answered on its own (see [Children that pause](#children-that-pause)).
- **No `isolation:`**: a composed block runs inside this run and has no checkout of its own
  to isolate. Instances share the parent's checkout and run concurrently up to
  `max_parallel`, as `workflow:` fan-out children do; instances that write must coordinate
  their edits. `fan_out.max_parallel: 1` runs them one at a time.

Cancellation stops the pool from claiming new items. An in-flight item may still reach its
own terminal event; under `all_done`, a cancelled slot is represented by the same reserved
`{ archon_failed: true, error, status: "cancelled" }` marker used by child-run fan-out.
Instance and wrapper events are aggregate accounting rows, so their rolled-up usage is not
counted again during resume. Engine-managed artifact names also carry the enclosing
`loop_group` iteration path, preventing later iterations from overwriting earlier sidecars.

Choose by where the audit boundary belongs: one run row per item → `workflow:` +
`fan_out:`; everything attributable to this run → `include:` + `fan_out:`. Existing
`workflow:` fan-outs keep their exact behavior either way: nothing is migrated or
reinterpreted.

## Result contracts

A node's output is a **value**, and the node that produces it owns that value's shape.
`output_format` is the declaration, and it is the only one: there is no separate
workflow-level result schema to keep in sync with the node that actually produces the
result.

| Question | Answer |
|---|---|
| What is a workflow's result? | The output of the node named by [`returns:`](#workflow-signature-inputs-returns-and-inputs), or, with no `returns:`, the run's terminal output. |
| Who declares its shape? | That node, through its own `output_format`. |
| Which nodes can declare one? | Any node whose output is a value it computes: `prompt:`/`command:` AI nodes, `bash:`/`script:` nodes, and `loop:` nodes. |
| What does declaring one buy? | The value is validated before anything downstream can read it, its JSON type survives the handoff, and `$node.output.<field>` becomes strict: an undeclared name fails the consuming node instead of resolving to `''`. |
| Who repeats the declaration? | Nobody. A downstream node, an `include:` alias, and a `workflow:` caller all read the producer's contract. |

A malformed schema is a **load error**. `archon validate workflows` and every run compile
each declared `output_format` before a provider is called, so a contract can never silently
stop being enforced after the money is spent.

### Inspecting a terminal run

The engine records terminal facts even when failure skips your reporting node. Use
[`archon workflow get <run-id> --json`](/reference/cli/#workflow-get) to read
`terminal_record`, or read `run.terminal_record` from `GET /api/workflows/runs/:runId`.
The record preserves execution status, authored outcome, node states and skip causes,
the selected `returns:` value when available, and an artifact manifest. Execution
status and authored outcome remain independent; the engine does not infer a delivery
verdict from filenames or output prose. Runs created before this support may have no
record. Resumed active runs expose `null` until their next terminal transition. The same
response's `run.nodes` carries the engine's node states for every run: the record's when it
exists, otherwise the same fold over the events recorded so far. Active, resumed, and older
runs therefore show each node's current state.

The manifest contains file metadata, not content previews. Its `limitations` identify
incomplete observations. The scan skips `node_modules` and `.git` directories and stops at
10,000 entries; each bound is recorded in `limitations`. Cancellation can record pending or running nodes and files
that are still changing; terminalization does not make the filesystem snapshot atomic.
You do not need a new YAML field or collector node to obtain these facts.

#### Reporting on a failed run

A `returns:` node on the success path is skipped when an upstream node fails, leaving
`terminal_record.returns` unavailable with reason `node_not_completed`. Keep that success
composer and add a reporter as `returns:`. With `trigger_rule: all_done`, it runs after the
composer completes or is skipped; `{ from: "$result.output", if_skipped: null }` lets it
pass the composer's value through or author a not-done report when the binding is `null`.
`always_run: true` re-executes the reporter on resume, so a report that reads artifacts
reflects the current pass instead of replaying a cached completion.

```yaml
name: failure-report
description: Preserve an authored report after a node failure
returns: report
outcome_field: ok
nodes:
  - id: fail
    bash: exit 1
  - id: result
    depends_on: [fail]
    bash: 'printf ''{"ok":true,"summary":"Done"}'''
  - id: report
    depends_on: [result]
    trigger_rule: all_done
    always_run: true
    with:
      result: { from: "$result.output", if_skipped: null }
    script: |
      const result = process.env.INPUTS_RESULT;
      console.log(result === 'null'
        ? JSON.stringify({ ok: false, summary: 'Not done: a node failed before the result.' })
        : result);
    runtime: bun
    output_format:
      type: object
      properties:
        ok: { type: boolean }
        summary: { type: string }
      required: [ok, summary]
```

The run's status stays `failed`; the authored outcome follows the reporter's
[`outcome_field:`](#workflow-signature-inputs-returns-and-inputs) (`ok: false` here).
The reporter owns the result schema and validates the value it passes through. Bind only
the composer: a [failed producer always fails a binding](#reading-across-a-skipped-branch),
so if the composer itself fails, this reporter fails too. Cancellation runs no further
nodes, and an executor crash can prevent reporting; this pattern covers ordinary node
failures that skip the composer, not every terminal path.

An `include:` caller waits on the block's sinks. When this reporter is its only sink and
completes, nodes depending on the block can run even after a node inside it failed. Gate
success-only work on the returned verdict, for example `when: "$block.output.ok == true"`.
The enclosing run still fails and its terminal record still names the failed node.

### A deterministic producer owns the same contract

Declare `output_format` on a `bash:` or `script:` node and that node certifies its own
stdout:

```yaml
nodes:
  - id: plan
    script: build-plan-result
    runtime: uv
    output_format:
      type: object
      properties:
        ready: { type: boolean }
        units: { type: array, items: { type: object } }
      required: [ready, units]
```

The node's stdout must parse as **one strict JSON document** and satisfy the schema. There
is no code-fence stripping, no repair pass and no reask: stdout that does not match its own
declaration is a bug in the script, so the node fails, naming the offending JSON path and
quoting the start of stdout. That failure is never retried: a `retry:` block re-runs
subprocess and transient failures, not a script whose stdout is deterministically wrong. On
success the canonical document becomes `$plan.output`, the logical value feeds bindings and
`fan_out.items`, and `$plan.output.units` is strict in exactly the same way as an AI node's
field access.

This is what makes a script and an agent interchangeable as the producer behind a `returns:`
node: the contract belongs to whichever node produces the result, not to its kind. A
`bash:`/`script:` node with **no** `output_format` is unchanged: stdout stays raw text, and
a `.field` reference falls back to parsing that text. See
[Script nodes → Declaring a result contract](/guides/script-nodes/#declaring-a-result-contract)
for the script-side detail.

### What `include:` and `workflow:` each guarantee

Both composition forms deliver the callee's contract to the caller. They differ only in
where the value comes from.

| | `include:` | `workflow:` |
|---|---|---|
| Where the producer runs | This run, after flattening | A governed child run |
| What `$node.output.field` is authorized by | The included block's `returns:` node: the alias is rewritten to it at load time, so there is no boundary left | The child's `returns:` node, whose declared field names travel back with the result |
| Caller-side `output_format` | Ignored with a load warning; there is nothing to assert against | A load error naming the child's `returns:` node; there is nothing to assert against |
| After a cold resume | Re-derived from the loaded block, exactly like any other node | Restored from the persisted result, so a parent that declares nothing keeps full field access |

A `workflow:` node cannot declare `output_format`. The loader rejects the file:

```text
Node 'sub' declares output_format on a workflow: node; the result contract belongs to the child's returns: node — declare it there
```

The child's contract is the only one. `$sub.output.field` is strict exactly when the child's
`returns:` node declares a schema, and a schemaless child (no `output_format` on its selected
node, or an older run) carries no field contract. The caller cannot add one.

A fan-out node is the one exception to "the producer declares it". `$fan.output` is an
engine-owned ordered array; the per-item contract belongs to each block or child, and field
access on the aggregate is an error. Consume the whole array.

### A small result that points at a large file

Most useful workflows produce something too big to be a node output, a plan, a report, a
diff. Write it under `$ARTIFACTS_DIR` and return a small result that **points** at it:

```yaml
nodes:
  - id: plan
    command: plan                    # writes $ARTIFACTS_DIR/plan.md
    output_format:
      type: object
      properties:
        ready: { type: boolean }
        plan:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [ready, plan]
```

```json
{ "ready": true, "plan": { "type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "plan.md" } }
```

`type: "archon_artifact"` is reserved. Before the value is persisted, the **producing node**
proves each pointer names its own run (`run_id` is `$WORKFLOW_ID`) and addresses a regular
file that exists under that run's artifacts directory. An absolute path, a `..` segment, a
missing file, a directory, or any other run's id fails the producing node, naming the run,
the path, and the rule. The check runs once, at the producer: a `workflow:` parent and a
fan-out aggregate relay the child's value unchanged, because the child already certified it
against the only run it may name.

The value stays a run id plus a relative path everywhere: in events, in the API, and after a
resume. The engine never expands it into an absolute path and never loads the file, and there
is no in-workflow resolver: a pointer is for **machine readers**, and
`GET /api/artifacts/<run_id>/<path>` serves exactly that file. The read side owns
reachability and real-path checks by design; that route does lexical containment today, and
real-path resolution at read time is not yet implemented (#3160). A prompt inside the
producing run keeps using the `$ARTIFACTS_DIR/<path>` string, which is the same file on
disk. See
[Artifact pointers](/reference/variables/#artifact-pointers-in-a-result) for the full rule
set.

### One contract, end to end

Everything above composes. A deterministic producer declares the contract; the block's
`returns:` publishes it; the caller reads a declared field as a real array and fans a
composed body out over it; each instance certifies its own per-item result:

```yaml
# plan-block.yaml — the callee. Its result IS the `build` node's declared value.
name: plan-block
returns: build
nodes:
  - id: build
    script: build-plan-result
    runtime: uv                      # writes $ARTIFACTS_DIR/plan.md, prints the JSON below
    output_format:
      type: object
      properties:
        units: { type: array, items: { type: object } }
        plan:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [units, plan]
```

```yaml
# the caller — no schema of its own anywhere
nodes:
  - id: plan
    include: plan-block              # $plan.output resolves to plan-block's `build` node

  # unit-block is an ordinary composable block declaring `inputs: { unit: … }`.
  # Its own `returns:` node declares the per-item contract, so $work.output is an
  # ordered array of validated objects rather than an array of prose.
  - id: work
    include: unit-block
    depends_on: [plan]
    fan_out:
      items: "$plan.output.units"    # a declared field, resolved as a real JSON array
      as: unit
      max_parallel: 2

  - id: report
    prompt: |
      Per-unit results: $work.output
      Full plan: $plan.output.plan
    depends_on: [work]
```

Swapping `include: plan-block` for `workflow: plan-block` changes the governance boundary
(a separate child run with its own artifacts, cost, and gates) and nothing else about the
contract: `$plan.output.units` and the pointer read exactly the same.

## Model Configuration

### Configuration Priority

A node's provider, model and options resolve in this order, first match wins:

1. The node's own value.
2. The workflow-level value in the YAML.
3. `assistants.*` in `.archon/config.yaml`.
4. The provider's built-in default (for Codex, including your own Codex `config.toml`).

```yaml
name: my-workflow
provider: claude     # any registered provider
model: medium        # tier, alias, or literal model id
```

### Portable Model References

`model:` accepts four shapes:

- `small`, `medium` or `large`: portable tiers resolved from `tiers:` in `~/.archon/config.yaml` and `.archon/config.yaml`, with built-in defaults for Claude and Codex only.
- `@name`: a custom alias from `aliases:`. A bare alias fails on an install that doesn't define it, so bundled and global workflows can't use one on its own.
- Any other string: a literal model id passed to the resolved provider's SDK.
- A preference list of `@name` aliases ending in a tier or literal model id, such as `['@reviewer', medium]`. The first alias the run's config defines wins; when none is defined, the final entry is used, so the list is portable. Validation checks the final entry too.

```yaml
nodes:
  - id: seams
    command: review-seams
    # The lens's own alias, then the reviewer concern, then the tier used today.
    model: ['@review-seams', '@reviewer', medium]
```

A list is how a bundled workflow names the concern each node serves without requiring you to configure it. Set the alias persistently with `archon ai alias set @reviewer codex gpt-5.5`, or for one run with `archon workflow run ... --model @reviewer=codex/gpt-5.5`. A run binding of an alias that no config defines must name its provider.

Tier and alias refs resolve to a provider, model and optional `effort`. If a workflow or node sets `provider:` and a model ref that resolves to a different provider, Archon warns and uses the provider from the resolved preset. Literal model strings keep the normal provider chain (`node.provider ?? workflow.provider ?? config.assistant`).

Archon keeps no allow-list of literal model ids. The provider's API decides at request time, and a rejected id fails the node with the SDK's error. Pair a provider-specific literal with an explicit `provider:` on the workflow or node, and use tiers for cross-provider defaults. Claude accepts family aliases such as `sonnet`, full model ids, context-window forms such as `opus[1m]`, and `inherit` to reuse the previous session's model. Pi model refs take the form `<backend>/<model-id>`, such as `google/gemini-2.5-pro`. Copilot accepts its model names or `auto`.

### Codex-Specific Options

`webSearchMode:` controls Codex's built-in web-search tool: `disabled` (the default), `cached` or `live`. It is not a network switch; Codex nodes always run with network access, so `disabled` stops Codex from searching, not from reaching the network. It is workflow level only, and on a node that resolves to another provider it warns and does nothing.

Workflow-level `modelReasoningEffort:` is deprecated. The loader applies it as `effort:` and warns; if both are declared, `effort:` wins. `assistants.codex.modelReasoningEffort` in `.archon/config.yaml` is a different setting and is not deprecated.

### Web Execution Mode

A workflow started from the Web UI runs in the background in a worker conversation, and its output appears in the run view. A run that pauses at a `wait: attention` node, or at a deprecated approval or interactive loop gate, pauses durably however it was started. The console's [Needs your input](/guides/workflow-triggers/#find-runs-needing-your-input) banner lists it, and the CLI answers it by run id. The same holds for a `--detach` launch and a trigger start.

### Provider Validation

Loading a workflow checks that the workflow-level `provider:` and every node's `provider:` name a registered provider:

```
Unknown provider: 'claud'. Available: claude, codex, pi, opencode, copilot
```

The list shows the providers registered on your install. Tier and alias model refs are resolved during validation, so malformed `tiers:` or `aliases:` config, unknown aliases and missing tier presets fail before execution. Literal model strings are not checked by Archon; the provider's API accepts or rejects them at request time.

### Resource Validation (CLI)

`archon validate workflows <name>` also checks that every referenced command file, MCP config file and skill directory exists. Bundled and global workflows also reject a bare `@custom` model alias, because it isn't portable across projects; a preference list that ends in a tier or model id is. Use `--json` for machine-readable output.

### Unknown Keys Are Reported, Not Rejected

A key Archon does not recognise is dropped, and the workflow still loads and runs. Archon reports every dropped key as a warning naming the key, where it was found and, when it can tell, what to write instead:

```text
WARNING [parse_warning] Node 'plan': unknown key 'contxt' will be ignored.
```

A key that belongs to a different node type is a load error naming the node, the key and the node types that support it, because the node would silently not do what the key says. That covers `runtime:` and `deps:` off a `script:` node; `timeout:` off `bash:`, `script:`, `loop:` and `loop_group:`; `on_timeout:` off `bash:` and `script:`; `with:` off `command:`, `script:`, `include:` and `workflow:`; `input:` and `isolation:` off `workflow:`; and `fan_out:` off `workflow:` and `include:`. A loop setting such as `until_bash:`, `max_iterations:` or `interactive:` at the top level of a node, instead of inside `loop:` or `loop_group:`, is a load error too. A node-level `interactive: true` reads like a pause and is not one:

```text
Node 'plan': 'interactive' is only honoured inside 'loop:' or 'loop_group:';
  at the top level nothing reads it. Nothing on this node pauses. To ask
  for an answer, add a 'wait: { attention: <message> }' node; to ask on each iteration
  of a loop, use a 'loop_group' whose body ends in one.
```

An AI field on a node that runs no AI, such as `model:` on a `bash:` node, only warns.

The check covers the workflow root, every node, the nested config blocks (`wait:`, the deprecated `approval:` and `approval.on_reject:`, `retry:`, `loop:`, `loop_group:`, `pi:`, each `agents:` entry, `worktree:`, `container:`, `evidence_policy:`) and every node in a `loop_group` body. Three blocks are exempt: `output_format:` is free-form JSON Schema, `sandbox:` passes unknown keys through, and `hooks:` already rejects an unknown key as an error.

Dropped-key warnings appear in `archon validate workflows`, inline in `archon workflow list` (`parseWarnings` in `--json`), on stderr before `archon workflow run` starts, in chat `/workflow list`, and as a marker in the console's workflow picker. Every run that starts also records them as a `workflow_parse_warnings` event, which `archon workflow get <run-id> --verbose` shows. Chat and the console post them to the conversation at run start on a best-effort basis.

A warning belongs to the file that declared the key. If workflow A includes workflow B and B has an unknown key, running A reports nothing; run `archon validate workflows <block-name>` on the included block.

## Deprecating a Workflow

A workflow that is being replaced stays runnable during a deprecation window and declares it:

```yaml
deprecated:
  message: Switch to the sdlc pack instead.
```

The field never changes execution. Every run start announces, on each surface the run reports to and in the run's event trace, that the workflow will be removed in an upcoming release. The notice carries the message and both ways out: switch to the replacement, or copy the workflow file into your project `.archon/workflows/` or global `~/.archon/workflows/` to keep using it. A copy without the field has no notice.

## Variable Substitution

Prompts, command files, `bash:` bodies and `script:` bodies can use workflow variables such as `$ARGUMENTS` (the run's message), `$ARTIFACTS_DIR`, `$WORKFLOW_ID`, `$BASE_BRANCH` and `$STATE_DIR`, and node output references such as `$nodeId.output.field`. The [Variable Reference](/reference/variables/) lists every variable, the substitution order, and the deprecated `$LOOP_USER_INPUT` and `$REJECTION_REASON`. An attention wait's answer replaces both: `$<wait-id>.output.text`, read as `$LOOP_PREV.<wait-id>.output.text` in the next loop iteration.

## Testing a workflow

Check a workflow before it spends anything:

- `archon validate workflows <name>` loads it the way a run would and checks its references.
- `archon workflow run <name> --dry-run --stubs <file>` walks the graph with outputs you supply, without creating a run or calling a provider. `--stubs-init <file>` writes a stub scaffold. See [Deterministic dry-run](/reference/cli/#deterministic-dry-run).
- `archon workflow test <name>` replays the fixtures in the workflow's `fixtures/` folder and checks each declared outcome.

[Build your first workflow](/getting-started/first-workflow/) walks through all three. After a run, `archon workflow get <run-id>`, `archon workflow logs <run-id>` and `archon workflow artifacts <run-id>` show what each node did and wrote.
