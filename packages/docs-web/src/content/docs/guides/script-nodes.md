---
title: Script Nodes
description: Run TypeScript, JavaScript, or Python code as a DAG node without invoking an AI agent.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 5
---

DAG workflow nodes support a `script` field that runs a TypeScript, JavaScript,
or Python snippet as part of the workflow. No AI agent is invoked — the script
runs via the `bun` or `uv` runtime, `stdout` is captured as the node's output,
and the result is available downstream as `$nodeId.output`.

Use script nodes for deterministic work that needs a real programming language:
parsing JSON, transforming data between upstream AI nodes, calling HTTP APIs
with typed clients, or computing values that a shell one-liner would mangle.
If a plain shell command is enough, use a [`bash:` node](/reference/workflow-language/#node-fields)
instead.

## Quick Start

### Inline TypeScript (bun)

```yaml
nodes:
  - id: parse
    script: |
      const data = { count: 42, label: "ok" };
      console.log(JSON.stringify(data));
    runtime: bun
```

### Inline Python (uv)

```yaml
nodes:
  - id: compute
    script: |
      import json, statistics
      values = [1, 2, 3, 4, 5]
      print(json.dumps({ "mean": statistics.mean(values) }))
    runtime: uv
```

### Named script from `.archon/scripts/`

```yaml
nodes:
  - id: fetch-pages
    script: fetch-github-pages   # resolves .archon/scripts/fetch-github-pages.ts
    runtime: bun
    timeout: 60000
```

The file `.archon/scripts/fetch-github-pages.ts` is loaded and executed with
`bun --no-env-file run <path>`.

## How It Works

1. **Substitute variables.** Non-user-controlled [workflow variables](/reference/variables/)
   and upstream output references are substituted into the `script` text before
   execution. User-controlled workflow variables like `$ARGUMENTS` and
   `$USER_MESSAGE` are not substituted into a `script:` body: they arrive as
   environment variables instead (`process.env.ARGUMENTS`, `process.env.USER_MESSAGE`
   in bun; `os.environ['ARGUMENTS']`, `os.environ['USER_MESSAGE']` in uv/python), so
   these workflow-variable values stay out of script source — see
   [Environment and Isolation](#environment-and-isolation). Upstream output
   references are still substituted as raw text into script source and may
   contain user-influenced content.
2. **Detect inline vs named.** If the `script` value contains a newline or any
   shell metacharacter (see [Inline vs Named Scripts](#inline-vs-named-scripts)
   below), it's treated as inline code. Otherwise it's treated as a named-script
   reference.
3. **Dispatch.**
   - `runtime: bun` + inline → `bun --no-env-file -e '<code>'`
   - `runtime: bun` + named  → `bun --no-env-file run <path>`
   - `runtime: uv` + inline  → `uv run [--with dep ...] python -c '<code>'`
   - `runtime: uv` + named   → `uv run [--with dep ...] <path>`
4. **Capture.** `stdout` (with the trailing newline stripped) becomes
   `$nodeId.output`. On a successful run, `stderr` is logged as a warning and
   posted to the conversation but does **not** fail the node. A non-zero exit
   code fails the node; on failure, tails of both streams are surfaced in the
   error message (`Script node 'X' failed [exit N]: [stderr] ... [stdout] ...`),
   sharing a ~2 KB diagnostic budget — stderr keeps priority, stdout gets the
   remainder, and a label prefixes each stream only when both are populated.
   With stderr empty, the stdout tail becomes the diagnostic. The script body
   is never echoed back to users. A timeout also fails by default. Set
   `on_timeout: skip` when the result is optional and downstream nodes handle
   its absence with an `if_skipped` binding.
5. **Retain.** Regardless of outcome, capped and credential-redacted tails of
   both streams are written to the run transcript as an `exec_output` row — see
   [Retained subprocess evidence](/reference/workflow-language#retained-subprocess-evidence).
   That retention is evidence only; it never caps `$nodeId.output`.

## YAML Schema

```yaml
- id: node-name
  script: <inline code OR named identifier>   # required, non-empty
  runtime: bun | uv                            # required
  deps: ["httpx", "pydantic>=2"]               # optional, uv-only (see below)
  timeout: 60000                               # optional ms; no timeout when omitted
  on_timeout: skip                             # optional; default is to fail
  depends_on: [upstream]                       # optional
  when: "$upstream.output != '[]'"             # optional (upstream is a bash/script node;
                                               #  an AI producer needs output_format + a field)
  output_format:                               # optional JSON Schema; makes stdout a contract
    type: object
    properties:
      severity: { type: string }
    required: [severity]
  trigger_rule: all_success                    # optional (default)
  retry:                                       # optional; same shape as bash/AI nodes
    max_attempts: 3
    on_error: all                              # a script exit is retried only under `all`;
                                               #  `transient` retries only a timeout
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `script` | string | Yes | Inline code, or a named script in the owning workflow's `scripts/` directory or the pack's `.shared/scripts/` (packaged workflows) or shared script directories (legacy workflows) |
| `runtime` | `'bun'` \| `'uv'` | Yes | Which runtime executes the script. Must match the file extension for named scripts |
| `deps` | string[] | No | Python dependencies to install for this run. **uv only** — ignored with a warning for `bun` |
| `timeout` | number (ms) | No | Milliseconds before Archon sends `SIGTERM` to the node. Omitted: no timeout, the node runs until it exits |
| `on_timeout` | `'skip'` | No | Complete the node as skipped after a timeout. The default is failed. The persisted skip cause is `timeout`. See [Bash and script node timeouts](/reference/workflow-language/#bash-and-script-node-timeouts) for what a timeout ends |
| `output_format` | object | No | JSON Schema the node's stdout must satisfy. See [Declaring a result contract](#declaring-a-result-contract) |

Standard DAG fields (`id`, `depends_on`, `when`, `trigger_rule`, `retry`) all
work, and so does `output_format` — see
[Declaring a result contract](#declaring-a-result-contract). AI-specific fields
(`model`, `provider`, `context`, `allowed_tools`, `denied_tools`, `hooks`,
`mcp`, `skills`, `agents`, `effort`, `maxBudgetUsd`, `systemPrompt`,
`fallbackModel`, `betas`, `sandbox`) are accepted by the parser but emit a
loader warning and are ignored at runtime — no AI is invoked. `idle_timeout` is also accepted but ignored: script nodes
run as one-shot subprocesses, so use `timeout` instead.

## Inline vs Named Scripts

The executor decides mode from the `script` string itself. A value is treated
as **inline code** if it contains a newline or any shell metacharacter; otherwise
it's a **named script** lookup.

- **Metacharacters that trigger inline mode:** space, `;` `(` `)` `{` `}` `&`
  `|` `<` `>` `$` `` ` `` `"` `'`
- **Inline examples:** `"const x = 1; console.log(x)"`, multi-line blocks, any
  snippet with a space
- **Named examples:** `fetch-pages`, `analyze_metrics`, `triage-fmt` — bare
  identifiers with no whitespace or shell syntax

If you want an inline snippet that happens to be syntactically a single
identifier, add a trailing comment or newline to force inline mode.

### Named Script Resolution

Named scripts use one of two resolution modes:

- **Packaged workflow:** resolve from the owning workflow's `scripts/` directory, then from the pack's shared scripts in `<pack>/.shared/scripts/`. The workflow's own script wins. Bundled package scripts use the same rule and are embedded for binary distribution.
- **Legacy workflow:** resolve shared scripts from `<repoRoot>/.archon/scripts/`, then `~/.archon/scripts/`.

Workflow-local lookup is scoped to the workflow that declared the node, including through `include:` expansion. Authors still write only the bare name (`script: publish`); the ownership key is internal. A lookup never leaves the pack: a name in neither place fails the workflow at load time, and the error names both directories.

Packaged scripts can import modules from their pack's `.shared/` directory. Keep package dependencies out of that tree: packaged scripts must not depend on the target project's `package.json`, `node_modules`, or `tsconfig.json`. Python dependencies can still be declared with `deps:`. Imports across packs and npm dependencies are outside the packaged-module contract.

### Share code within a pack

Put reusable `.ts`, `.js`, or `.py` modules under `<pack>/.shared/`. Module subdirectories are supported. Use regular files; the binary generator rejects symlinks under `.shared`. `.shared` is reserved for modules, `.md` documents, the pack's [`metric-views.json`](/guides/metrics/#overview-cards-a-pack-declares) and its [shared scripts](#share-a-script-between-workflows-of-a-pack): its files are not workflows, and only those under `.shared/scripts/` are named script targets. Documents ship with the pack in every build, beside the modules. Any node reads one through `$PACK_DIR`, the pack's directory in the run's source: a prompt or command file names `$PACK_DIR/.shared/policy/triage.md`, and a `bash:` or `script:` node also gets `PACK_DIR` in its environment. See [`$PACK_DIR`](/reference/variables/#pack_dir-the-workflows-own-pack). A packaged workflow that names an unavailable script, including a shared module, fails at load time.

```text
my-pack/
├── .shared/
│   ├── result.ts
│   └── result.py
├── release/
│   ├── release.yaml
│   └── scripts/
│       └── publish.ts
└── inspect/
    ├── inspect.yaml
    └── scripts/
        └── report.py
```

For Bun, import from the script's location:

```typescript
// release/scripts/publish.ts
import { summary } from '../../.shared/result.ts';
console.log(summary);
```

### Share a script between workflows of a pack

When several workflows of a pack run the same script, put one copy in `<pack>/.shared/scripts/`. A `script:` node of any workflow in the pack that names it finds it there, unless the workflow has a script of that name in its own `scripts/`, which wins. As in a workflow's `scripts/`, a script sits directly in the directory or one folder below it, and its name is the file name without the extension.

```text
my-pack/
├── .shared/
│   ├── result.ts
│   └── scripts/
│       └── preflight.ts        # script: preflight, from release and inspect
├── release/
│   └── release.yaml
└── inspect/
    ├── inspect.yaml
    └── scripts/
        └── preflight.ts        # inspect runs its own
```

A shared script imports the pack's modules from one level up (`import { summary } from '../result.ts';`).

Python scripts run as files, so package-relative syntax such as `from ...shared` does not apply. Add the pack's shared directory using Python's standard library:

```python
# inspect/scripts/report.py
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".shared"))
from result import summary

print(summary)
```

Archon preserves these relative paths in project and global source trees, bundled binaries, and frozen captures. A binary caches each pack's scripts and modules as one unit; changing a shared module creates a new unit. Authored scripts remain the only entry points, so workflow nodes still use names such as `script: publish`.

Keep output under the supplied `ARTIFACTS_DIR` or `STATE_DIR`, never beside a script. Bun module loading does not add files beside these sources, and Archon disables Python bytecode caching in both workflow execution and executable fixtures. This prevents import caches from changing the frozen source; it does not prevent your script from writing there explicitly.

### The script API

A Bun script imports what it needs from the host by name:

```typescript
import { emit, forge, input, refuse, state } from 'archon:script';

const number = Number(input('pr-number'));
if (!Number.isInteger(number)) {
  refuse('pr-number is not a number');
} else {
  const ref = { repo: { host: 'github.com', path: 'owner/repository' }, number };
  const view = forge('pr.view', { selector: { kind: 'number', ref } });
  emit({ draft: view?.pr.is_draft ?? null });
}
```

Archon provides the `archon:script` module to every `runtime: bun` script: named scripts, inline bodies, the modules they import, and scripts executed by a dry run or a fixture with `exec-code`. A pack carries no file for it and needs no `node_modules`. The module is a thin wrapper over what every runtime already has (the `INPUTS_*` and engine environment variables, JSON on stdout, exit codes, and the CLI named by `ARCHON_CLI_COMMAND`), so a Python script, or a Bun script that prefers to, uses those directly. A script that does not import the module runs as it always has. A process your script starts is not given the module.

| Export | What it does |
| --- | --- |
| `input(name)` | A `with:` binding or workflow input by its declared name, as text. Empty when nothing bound it |
| `runId()`, `artifactsDir()`, `packDir()` | The run's id, its artifact directory, and the directory of the pack the workflow belongs to. Each throws when the engine did not set it, as `packDir()` does outside a pack |
| `emit(value)` | Writes the node's result: one JSON document on stdout |
| `refuse(reason)` | Fails the node: the reason on stderr and exit code 1. Return after calling it |
| `forge(op, request)` | Runs one [forge operation](/reference/forge/) and returns its typed result |
| `state.get`, `put`, `patch`, `delete`, `list`, `listValues`, `claim` | Reads and writes the project's [state documents](/reference/cli/#state) as this run and node |
| `outcomes()` | The engine's listing of what each node of the run has recorded (`$NODE_OUTCOMES_FILE`) |
| `trigger.fire(binding, inputs, options)` | Fires a trigger binding (`archon trigger fire`) and returns the admission its request got |

Write `input('<name>')` with a string literal. Archon checks at load that every input a script reads is provided, and it reads `input('pr-number')` in the node's own script the way it reads `process.env.INPUTS_PR_NUMBER`. A computed name, or a read inside an imported module, is not checked.

Do not call `process.exit()`. Bun exits without draining stdout, so a large result written to a pipe arrives cut short and reads as a complete one. `refuse` sets the exit code instead; let the script end.

**Forge errors.** `forge` throws `ForgeError` when the host answers with a failure. `kind` is the typed reason, and `mutation` is set for a write: `mutation.outcome` says whether it was refused, applied but unverified, or left with an unknown outcome. Never retry a write past an unknown outcome.

```typescript
import { ForgeError, forge } from 'archon:script';

try {
  forge('pr.ready', { ref });
} catch (error) {
  if (error instanceof ForgeError && error.mutation?.outcome === 'outcome_unknown') {
    console.error(error.message); // report it, do not retry it
  }
  throw error;
}
```

Every function that calls the host throws `HostCommandError` when the CLI gives no answer at all; after a write, treat it as possibly applied. The host validates each forge request and result against the forge contract, so the module does not validate them again. To refuse early when a host has no plugin, lacks an operation or has no credential, call `forge('check', { host, operations })` in the workflow's first node; see [Check forge access before a run spends](/reference/forge/#check-forge-access-before-a-run-spends).

**State writes.** `state.put`, `patch` and `delete` return `{ ok: true, revision }`, or `{ ok: false, conflict }` when the store refused the write: `revision_moved`, `lease_held` or `lease_not_held`. Their options are `ifRevision`, `lease: 'take' | 'release'` and `held`, which are the CLI's `--if-revision`, `--lease`, `--release-lease` and `--held`. `state.claim(candidates)` returns `{ claimed, skipped }`; `claimed` is null when nothing could be taken.

**Types in an editor.** `archon script types --out archon-script.d.ts` writes the module's declaration: every export above, and the request and result type of every forge operation. Include that file in the `tsconfig.json` that covers your scripts, and a wrong operation name, request field or result field is a compile error. The file describes the Archon that wrote it, so write it again after an upgrade; `--check` exits 1 when it is stale.

**Outside a run.** Plain `bun` cannot resolve `archon:script`; only a run provides it. `archon script preload --out test/archon-script.preload.ts` writes the file a run uses, and then `bun --preload ./test/archon-script.preload.ts scripts/triage.ts` runs the script, and `bun test --preload ./test/archon-script.preload.ts` (or `preload` under `[test]` in `bunfig.toml`) lets a pack's tests import its scripts in-process.

The preload only makes the module resolve. A script still reads its inputs from the environment and reaches the host through the CLI named by `ARCHON_CLI_COMMAND`, so a test sets those itself, and a stand-in CLI it names there keeps working. The file belongs to the Archon that wrote it: write it again after an upgrade, and `--check` exits 1 when it is stale.

**Where it sits.** The script API is the author-facing entry of Archon's SDK family: what code running inside a workflow calls. It has no dependencies and speaks only the CLI wire. The host-facing entry, for a program that embeds the engine to define, run, govern and query workflows, is separate and is not part of this module. Every export of `archon:script` is public contract; the declaration `archon script types` writes is the complete list.

**Container runs.** A script in a [container execution](/guides/container-isolation/) imports the module the same way, and `input`, `emit`, `refuse`, `outcomes` and the accessors work. A container run does not receive `ARCHON_CLI_COMMAND`, so `forge`, `state` and `trigger.fire` throw `HostCommandError` there.

### Frozen source integrity

When a run uses captured source, Archon rechecks the full capture against the run's pinned digest and source-resolution settings before each named-script attempt, including retries, and before lookup or subprocess dispatch. Any change to the capture refuses the node before it starts. Inline scripts are already held in the workflow definition and do not read the capture at execution time.

This is checkpoint detection, not sealing or sandboxing. A process running as the Archon user can change source after the check, and a parallel node that already started is not cancelled.

Each shared scripts directory is walked one subfolder deep (e.g. `.archon/scripts/triage/foo.ts`
resolves as `foo`). Deeper nesting is ignored. On a same-name collision the
repo-local entry wins silently — see [Global Workflows](/guides/global-workflows/)
for the shared precedence rules.

### Extension ↔ Runtime Mapping

Named scripts derive their runtime from the file extension:

| Extension | Runtime |
|-----------|---------|
| `.ts`, `.js` | `bun` |
| `.py` | `uv` |

The `runtime:` declared on the node **must match the file's extension** — the
validator rejects `runtime: uv` pointing at a `.ts` file, and vice versa. For
inline scripts, you can use any language that the chosen runtime supports.

## Dependencies (uv only)

`deps` is a pass-through to `uv run --with <dep>`, which installs packages into
a per-run ephemeral environment:

```yaml
- id: scrape
  script: |
    import httpx
    r = httpx.get("https://api.github.com/repos/anthropics/anthropic-cookbook")
    print(r.text)
  runtime: uv
  deps: ["httpx>=0.27"]
```

- **Version pinning** — any PEP 508 specifier works (`pkg==1.2.3`, `pkg>=2,<3`).
- **Bun ignores `deps`** — Bun auto-installs imported packages on first run, so
  the validator emits a warning if you set `deps` with `runtime: bun`. Remove
  the field, or switch to `uv` if you need explicit dependency management.
- **No persistent environment** — each run is isolated; there is no `requirements.txt`
  or lockfile to maintain.

## Output and Data Flow

`stdout` (trimmed of its trailing newline) becomes `$nodeId.output`. Print JSON
if you want downstream nodes to access structured fields with
`$nodeId.output.field` — the workflow engine tries to parse the output as JSON
for field access in `when:` conditions and prompt substitution.

Declare `output_format` when you want that JSON to be a contract rather than a
convention — see [Declaring a result contract](#declaring-a-result-contract).

```yaml
- id: classify
  script: |
    const input = process.argv.slice(2).join(' ');
    const severity = input.includes('crash') ? 'high' : 'low';
    console.log(JSON.stringify({ severity, length: input.length }));
  runtime: bun

- id: investigate
  command: investigate-bug
  depends_on: [classify]
  when: "$classify.output.severity == 'high'"
```

### Declaring a result contract

Without `output_format`, `$classify.output.severity` above works by convention:
the engine parses the text and hopes the key is there. Declare `output_format`
and the same result becomes a contract the node owns.

```yaml
- id: classify
  script: |
    const input = process.env.ARGUMENTS ?? '';
    console.log(JSON.stringify({
      severity: input.includes('crash') ? 'high' : 'low',
      units: [],
    }));
  runtime: bun
  output_format:
    type: object
    properties:
      severity: { type: string, enum: [low, high] }
      units: { type: array, items: { type: object } }
    required: [severity, units]
```

With a schema declared, the node:

- parses stdout as **one strict JSON document** — no code fences, no prose
  preamble, no repair pass, and no second attempt;
- validates it against the schema, and **fails the node** when it does not
  match, naming the offending JSON path and quoting the start of stdout;
- publishes the canonical JSON document as `$classify.output`, the logical
  value to downstream bindings and `fan_out.items`, and the declared property
  names to `$classify.output.<field>`;
- makes a reference to an **undeclared** field fail the consuming node instead
  of silently resolving to `''`.

That is the same contract an AI node's `output_format` carries, so a script and
an agent are interchangeable as the producer behind a `returns:` node. What that
buys a caller — through an `include:` alias, a `workflow:` sub-run, a fan-out, or
an artifact pointer — is described once in
[Workflow language → Result contracts](/reference/workflow-language/#result-contracts).

A schemaless script is unchanged: stdout stays raw text, trimmed only of its trailing
newline as before.

### Variable Substitution in Scripts

Variables are substituted into the `script` text **as raw strings, without
shell quoting**. In `bash:` nodes, small string `$nodeId.output` values are
single-quoted inline, while spilled values use an unquoted command substitution
that splits words and expands globs when used as a bare argument. For Bash,
[assign the reference, then quote the shell variable](/reference/variables/#shell-quoting-in-bash-vs-script).
In script bodies, treat substituted values as untrusted input and parse them with
language features, not by interpolating into shell syntax.

:::caution[Avoid String.raw with `$nodeId.output`]
The pattern `` String.raw`$nodeId.output` `` looks safe but fails silently when
the substituted value contains a backtick — common in AI-generated markdown,
`output_format` payloads, or any output with inline code spans. The backtick
terminates the template literal early, producing a cryptic `Expected ";"` parse
error at runtime.

**Use direct assignment instead.** JSON is a strict subset of JavaScript
expression syntax, so the substituted value is always a valid JS literal:

```typescript
// Safe — works for any valid JSON, including content with backticks
const data = $fetch-issue.output;

// Fragile — breaks if output contains a backtick
const data = JSON.parse(String.raw`$fetch-issue.output`);  // DON'T
```
:::

For **named scripts**, read workflow variables from the environment
(`process.env.USER_MESSAGE`, `os.environ['USER_MESSAGE']`) and `with:` bindings
from `INPUTS_<UPPER_SNAKE>` environment variables. Named scripts receive no stdin
payload. For **inline scripts**, substituted variables are
literally embedded into the code string at execution time.

## Environment and Isolation

:::note[Shell injection prevention]
User-controlled workflow variables like `$USER_MESSAGE` and `$ARGUMENTS` are passed to `bash:` nodes as environment variables (not inline-substituted into the shell command) to prevent shell injection — read an environment-delivered value with `"$ARGUMENTS"`. `script:` nodes receive these values the same way (`process.env.USER_MESSAGE`, `process.env.ARGUMENTS` in bun; `os.environ['USER_MESSAGE']`, `os.environ['ARGUMENTS']` in uv/python). A `loop_group` body's `bash:` node is the exception: the loop scope splices the reply (`$LOOP_USER_INPUT`) into its source, shell-quoted, so the reply arrives already quoted. Read the spliced reply as an already-quoted value — assign it and quote the variable (`value=$LOOP_USER_INPUT; printf '%s' "$value"`) — rather than as `"$LOOP_USER_INPUT"`.
:::

Script subprocesses receive `process.env` merged with any codebase-scoped env
vars you've configured by opening **Environment variables** from the project row
in the console project rail, or through the `env:` block in
`.archon/config.yaml`. This is the same injection surface used by Claude, Codex,
and bash nodes.

**Target repo `.env` isolation:** the Bun subprocess is invoked with
`--no-env-file`, so variables in the target repo's `.env` do **not** leak into
the script. Archon-managed env (from `~/.archon/.env` and `<repo>/.archon/.env`)
passes through normally. `uv`-launched Python subprocesses do not auto-load
`.env` at all. See [Security Model](/reference/security/#target-repo-env-isolation)
for the full story.

## Validation

`archon validate workflows <name>` checks script nodes for:

- **Script file exists** — for named scripts, the basename must exist in the
  owning workflow's `scripts/` directory, the pack's `.shared/scripts/`, or the
  legacy shared search path, with a matching extension for the declared runtime.
  Missing files fail validation, naming the directories that were searched.
- **Runtime available on PATH** — `bun` or `uv` must be installed. Missing
  runtimes emit a warning with the official install command:
  - `curl -fsSL https://bun.sh/install | bash`
  - `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **`deps` with `runtime: bun`** — warns that `deps` is a no-op under Bun.

Runtime availability is cached per-process — the check spawns `which bun` /
`which uv` once and memoizes the result.

## Patterns

### Transform AI output before the next node

Use a script node as a deterministic adapter between two AI nodes. The script
parses the upstream classifier's JSON, filters, and forwards a clean payload:

```yaml
- id: classify
  prompt: "Classify: $ARGUMENTS"
  allowed_tools: []
  output_format:
    type: object
    properties:
      items:
        type: array
        items: { type: object }

- id: filter
  script: |
    const upstream = JSON.parse(process.env.UPSTREAM ?? '{}');
    const high = (upstream.items ?? []).filter(i => i.severity === 'high');
    console.log(JSON.stringify(high));
  runtime: bun
  depends_on: [classify]

- id: triage
  command: triage-high-severity
  depends_on: [filter]
  when: "$filter.output != '[]'"
```

*(Note: to actually populate `UPSTREAM` you'd inline-substitute
`$classify.output` into the script body. The example above illustrates the
shape.)*

### Reusable helper in `~/.archon/scripts/`

A helper you want available in every repo — say, a triage summary formatter —
lives at `~/.archon/scripts/triage-fmt.ts`:

```typescript
// ~/.archon/scripts/triage-fmt.ts
const raw = process.argv.slice(2).join(' ') || '{}';
const data = JSON.parse(raw);
const lines = data.issues?.map((i: { id: string; title: string }) =>
  `- [${i.id}] ${i.title}`
).join('\n') ?? '';
console.log(lines || 'no issues');
```

Then reference it by name from any repo's workflow:

```yaml
- id: format
  script: triage-fmt
  runtime: bun
  depends_on: [gather]
```

### Python with scientific dependencies

```yaml
- id: analyze
  script: |
    import json, sys
    import pandas as pd
    data = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    df = pd.DataFrame(data)
    print(df.describe().to_json())
  runtime: uv
  deps: ["pandas>=2.0"]
  depends_on: [collect]
```

## What Does NOT Work

- **AI-only features** — `hooks`, `mcp`, `skills`, `allowed_tools`,
  `denied_tools`, `agents`, `model`, `provider`, `effort`,
  `maxBudgetUsd`, `systemPrompt`, `fallbackModel`, `betas`, and `sandbox` are
  all ignored at runtime. The loader emits a warning listing the ignored fields.
  (`output_format` is **not** in that set — a script owns it, see
  [Declaring a result contract](#declaring-a-result-contract).)
- **JSON repair and reasks** — a certified script's stdout must be exactly right
  the first time. There is no fence stripping and no second attempt: stdout that
  does not match the declared schema is a bug in the script.
- **Interactive prompts** — the script runs headlessly and receives no user input.
  A `stdin` read may block rather than immediately see EOF.
- **Runtimes other than `bun` and `uv`** — rejected at parse time.
- **Cancelling mid-execution** — there is no cooperative cancellation signal.
  Cancelling the run ends a running script's process tree instead; see
  [Bash and script node timeouts](/reference/workflow-language/#bash-and-script-node-timeouts)
  for what it reaches. Without a `timeout`, a script that hangs runs until it is
  cancelled.

## See Also

- [Workflow language](/reference/workflow-language/): the full workflow reference
- [Global Workflows, Commands, and Scripts](/guides/global-workflows/) — home-scoped `~/.archon/scripts/`
- [Security Model](/reference/security/#target-repo-env-isolation) — env isolation details
- [Variables Reference](/reference/variables/) — substitution rules
