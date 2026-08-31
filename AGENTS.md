# Working on Archon

Archon is a self-hostable, governed agentic automation engine. It runs workflows that mix deterministic steps, AI agents, human gates, and audit trails. Coding automation is its most mature surface, but the engine is intended for general business operations too.

This file is the canonical project guidance for coding agents. Keep it short, durable, and about judgment. Put changing product direction in [`.archon/direction.md`](.archon/direction.md), workflow-language design in [`.archon/workflow-language-constitution.md`](.archon/workflow-language-constitution.md), aspirational engineering craft and review values in [`.archon/engineering.md`](.archon/engineering.md), user documentation in the docs site, and machine-checkable rules in code, types, tests, lint, or CI.

## Read before changing code

- Treat the source, its call sites, and its tests as the current evidence. The request defines the goal and constraints, but a prompt may describe old code.
- Read every relevant consumer before changing a producer, contract, path, identifier, schema, or generated artifact.
- Reproduce bugs when practical. If reproduction is impossible, establish another concrete causal chain before editing.
- Do not trust a passing test by itself. Check that it exercises the behavior it claims to protect.
- A question is read-only. Explain first; change code only when the user asks for a change.
- Do not stop at editing. Finish the requested change and verify the outcome.
- If the implementation keeps getting more complicated, stop and reconsider the model. Solve the underlying problem.

## Product boundaries

- Archon is a governed automation engine, not a replacement for the coding agents it orchestrates.
- One install serves one operator or client. Client isolation belongs at the deployment layer. Multiple users within one install are supported and are not multi-tenancy.
- Keep the conversation layer platform-agnostic. Platform adapters translate transport details; core behavior should not depend on Slack, Telegram, GitHub, Discord, CLI, or Web UI semantics.
- Keep the core self-hostable. Do not make a proprietary hosted service a runtime dependency.
- Keep the core small and flexible. Agentic engineering changes too quickly for one monolith to encode every useful workflow or integration; give users stable seams to assemble and extend the rest.
- Treat bundled workflows as reference implementations, not a frozen compatibility surface.
- A git worktree separates checkouts; it is not an execution or security sandbox.
- Consult [`.archon/direction.md`](.archon/direction.md) before making product-scope or architecture-direction decisions.

## Engineering taste

### Prefer the smallest truthful system

- Apply KISS and YAGNI. Do not add configuration, interfaces, lifecycle states, compatibility paths, or guards without a current requirement or concrete failure mode.
- Before adding machinery, look for dead, redundant, or superseded machinery on the same path that can disappear.
- Fix drift on the path you touch rather than preserving it for a cleaner diff. Two sites that should agree and do not are a defect, not a diff-size decision.
- Duplicate small local logic when it keeps ownership clear. Extract only after a pattern has repeated and stabilized.
- Prefer explicit control flow and narrow typed interfaces over meta-programming, shared mutable state, or hidden coupling.
- Keep policy, transport, persistence, and execution concerns separate.
- Consider a focused rewrite when it produces a smaller, clearer result without widening risk.

### Let types carry invariants

- Keep TypeScript strict. Avoid `any` and broad assertions when a sound type can express the state.
- Two declarations that must agree to stay correct, kept in agreement by discipline rather than by a mechanism, are a present defect and not a future risk. Treat a hand-synced pair as a bug the moment it exists, and as a live one once the sides already disagree. Derive from the owner instead: an import, a derived or mapped type, a generated artifact with an owning script, or an enforced conformance test. A "keep in sync" comment is none of those; it records the defect rather than clearing it.
- Import external SDK types rather than restating them. Where a boundary genuinely cannot share one definition, the copy owes a conformance test.
- Use discriminated unions and constructors to make invalid states hard to represent.
- Keep interfaces narrow. Extend an existing interface only when the new method belongs to the same responsibility.

### Fail clearly

- Fail early on unsupported, ambiguous, or unsafe states. Silent fallback in an agent runtime can waste money or broaden capabilities.
- Never silently swallow an error or broaden permissions.
- Translate errors at the boundary that can explain them, while preserving the original evidence for logs and diagnostics.
- A fallback must be intentional, safe, documented near the branch, and observable enough to debug.
- Never log credentials, secret values, user-message contents, or unnecessary personal data.

### Write for the next maintainer

- Comments should explain a non-obvious invariant, ownership decision, or reason a tempting alternative is wrong. Do not narrate the code.
- Delete stale comments and documentation when behavior changes.
- Use one precise name for each concept. Prefer direct prose, active voice, and concrete mechanisms over slogans or vague summaries.
- Avoid hardcoded examples that will become false as files, counts, providers, or routes change.

## Agentic-system boundaries

### Natural language is not a wire format

- Let the agent interpret the full natural-language message. Do not reconstruct intent with regexes, keyword lists, exact prose tokens, or hand-written parsers.
- Put determinism after interpretation: give the agent typed tools, then validate resolved identifiers, arguments, permissions, and invariants at the tool boundary.
- If exact syntax is required, expose a structured interface such as a CLI flag, typed tool, button action, or schema.
- In a workflow, prose inside a node is model reasoning. Prose passed between nodes as a token to parse is an invented protocol; use structured output, typed inputs, exit status, or another explicit engine channel.
- Vendor output is prose too. Classifying git, SDK, or vendor error text with a pattern is a last resort, not a carve-out: prefer the structured channel (exit code, typed error class, `--json` or porcelain output), then agent classification into a typed value, then an honest unclassified failure carrying the original evidence. A match that survives anchors to a machine token embedded in the message (an errno, an error code) and may enrich a report — never gate retry, fallback, or suppression, where a vendor rewording silently changes behavior.

### Do not guess lifecycle ownership

- A process must not mark non-terminal work failed, cancelled, or abandoned when it cannot distinguish a live owner from an orphaned process.
- Surface ambiguous ownership and give the operator an explicit action.
- Timers remain appropriate for recoverable operations such as retry backoff, subprocess timeouts, and cleanup of already-terminal data.
- Terminal state transitions and completion signals belong to the engine, not to workflow-specific scripts that reinterpret run state.

### Project guidance should be available, not sprayed everywhere

- This `AGENTS.md` is the project-guidance channel for agent nodes. Provider integrations should preserve that contract through the provider's native context mechanism.
- `AGENTS.md` may point to focused project context such as direction or language-design documents.
- Do not inject every project document into every node. A node should receive only the context its responsibility requires.
- The engine and reusable workflow packs must not hardcode a project's context paths.

### Preserve provider configuration; scope capabilities

- Provider integrations must preserve the provider's native user and project configuration, including its global and project guidance files. The user's provider configuration owns whether those sources load; Archon must not replace a provider home directory or add a parallel context switch.
- Workflow AI nodes start without ambient skills, skill-like plugins, or MCP servers. A node receives only the skills, plugins, and MCP servers it explicitly names. Enforce that boundary without hiding unrelated provider settings.
- Pi extensions are user-owned provider configuration, not Archon-managed plugins. Load them as Pi configures them; any tools or MCP clients an extension exposes are the user's responsibility.
- Leave native prompt templates and commands under provider control unless the provider automatically advertises them to the model as a skill-like capability. In that case they follow the same explicit node-scoping rule as skills and plugins.
- Preserve the selected agent provider's native authentication contract. A Claude Code subscription runs through the Claude Agent SDK; using an Anthropic model through another provider is not Claude Code subscription support. Do not reroute or relabel provider identity to reuse credentials.
- Provider-boundary tests must prove both halves of the contract: native settings and guidance remain visible, while undeclared skills, plugins, and MCP servers remain unavailable and explicitly named capabilities load.

## Workflow-language boundary

The governing rule is: **YAML coordinates. Code computes. Agents judge.** Read [`.archon/workflow-language-constitution.md`](.archon/workflow-language-constitution.md) before changing the YAML surface.

- YAML should expose only what the engine must see to govern a run: topology, gates, joins, retries, sessions, artifacts, durable waits, and reusable structure.
- Computation belongs inside a `bash:`, `script:`, or `prompt:` node. Choosing a script instead of a prompt is an ordinary reliability and maintainability decision, not a constitutional rule.
- A new YAML field or expression feature must add governance value that existing node bodies and wiring cannot provide.
- Do not grow `when:` one operator at a time. Compute a complex decision in a node and gate on structured output.
- Composition must preserve a graph the engine can validate and govern. Runtime-created independent work belongs in a child run, not hidden dynamic YAML structure.
- Provider capabilities normally belong in provider config, tiers, or aliases. A new node field must earn genuine per-node variance.
- Implicit behavior must be documented, defeatable where appropriate, visible, and fail-safe.

## Architecture and ownership

- Preserve package boundaries. Inspect package manifests and current imports before adding a dependency; do not rely on a copied package inventory.
- Provider SDK dependencies and SDK-specific option translation belong in `@archon/providers`.
- Workflow execution depends on injected contracts, not on core database or adapter implementations.
- Platform-specific parsing and authorization belong inside the owning adapter. Core receives normalized intent and identity.
- The Web client consumes generated API types through its local API layer; it does not import server or workflow runtime packages.
- Shared schemas are the source of truth for persisted and API shapes. Keep OpenAPI generation and runtime validation on the same schema path.
- Use the type system, schema validation, and package boundaries to enforce architecture before adding prose rules.

## Data and compatibility

- Database schema evolution is additive-only. There is no migration ledger or version gate, and older binaries may open the same database.
- Never rename, retype, or drop a shipped table or column. A new `NOT NULL` column needs a default that remains valid for older writers.
- Keep SQLite and PostgreSQL schemas aligned unless a narrow, documented exception is already enforced.
- Test upgrades from shipped schema shapes, not only fresh database creation.
- Keep generated or mirrored artifacts synchronized through their owning scripts. Find those scripts in `package.json` and adjacent tests instead of copying a list here.
- Persisted identifiers, paths, and wire values are contracts. Trace them through every reader before changing their meaning.

## Git and workspace safety

- `main` is the release branch and `dev` is the working base. Never commit directly to either for feature work, and never force-push `main` or `master`.
- Preserve user changes, including untracked files. Do not use `git clean -fd`, destructive resets, or broad cleanup commands on user-owned workspaces.
- Let git report conflicts and dirty state. Do not hide or automatically resolve a state the operator owns.
- Hard reset is allowed only for an explicit reset mode on an Archon-owned checkout.
- Run artifacts, logs, and state belong outside the repository under the Archon workspace. Do not stage them.
- When stopping a process, target the recorded PID or exact bound port. Never kill by a broad process-name match.
- Keep commits and pull requests focused. Do not mix unrelated cleanup into the requested outcome.

## Running Archon workflows

The input is the contract. A run is only as accurate as the brief it starts from, and a
workflow cannot recover from a premise that was never stated — it will produce a confident,
well-formed answer to the wrong question. Treat writing the input as the work, not the
preamble to it.

Before launching a run, the input — an issue body, a message, a document, whatever the run
reads — must state:

- the problem to solve;
- why it is worth solving;
- why now;
- the desired outcome;
- the invariants that must hold;
- what acceptance looks like.

Solution steering is optional and belongs last, but omitting it is a decision: the run then
chooses its own approach. State a constraint you actually hold — reuse this primitive, no new
dependency, migrate rather than rewrite — because an unstated preference cannot be honoured.
Naming an implementation *before* the problem is settled narrows the run to your first guess.

Do not launch a run against an input missing any of the six. Fix the input first, and say
what you changed — a thin brief is cheaper to correct before a run than after one.

## Tests and validation

- Add tests for meaningful behavior and failure modes. Do not preserve deleted features through regression-test clutter.
- Prefer deterministic, cheap tests. Remove accidental I/O and unnecessary subprocesses before increasing timeouts.
- Remove test temp trees with `removeTempTree` or `trackTempRoots` from `@archon/paths/test-utils`.
- Spawn a subprocess only when the subprocess is the subject under test. To suppress an inherited env key for a Bun child, pass it as `''`; deleting it allows `.env` loading to restore it.
- Bun's module mocks pollute the process cache. Use the package test scripts that preserve isolation; do not run `bun test` from the repository root.
- Always run lint through `bun run lint` or `bun run lint:fix`; the wrapper isolates packages to keep typed lint within its memory budget.
- Run the narrow checks that prove the changed behavior while iterating.
- Run `bun run validate` before opening a pull request. CI may contain additional environment-dependent checks; inspect changed-path workflows and run applicable checks when practical.
- Schema changes also require the PostgreSQL upgrade check documented in the contributor docs and CI.
- For visual or runtime behavior, add direct evidence when static tests cannot prove the outcome.
- Destructive verification, including DDL, migrations, and data writes, runs only against a scratch database you create and drop. A configured live DSN is read-only at most; when only a live resource exists, stop and surface it to the operator.

## Pull requests

- Branch from `dev` and open the pull request back to `dev`.
- Use [`.github/pull_request_template.md`](.github/pull_request_template.md). Keep its required sections, remove instructional comments and irrelevant conditional sections, and describe the problem before the implementation.
- Review the complete diff against the actual base branch before opening the pull request.
- Link the source issue with a closing keyword when the work has one.
- Keep titles concise and outcome-focused. Do not add AI attribution to commits or pull requests.

## Find current facts

Do not expand this file with copied reference material. Use the owning source:

- Product direction: [`.archon/direction.md`](.archon/direction.md)
- Workflow-language design: [`.archon/workflow-language-constitution.md`](.archon/workflow-language-constitution.md)
- Engineering craft and review values: [`.archon/engineering.md`](.archon/engineering.md)
- CLI: [`packages/docs-web/src/content/docs/reference/cli.md`](packages/docs-web/src/content/docs/reference/cli.md) and `archon --help`
- Workflow authoring: [`packages/docs-web/src/content/docs/guides/authoring-workflows.md`](packages/docs-web/src/content/docs/guides/authoring-workflows.md) and workflow schemas
- Database behavior: [`packages/docs-web/src/content/docs/reference/database.md`](packages/docs-web/src/content/docs/reference/database.md), migrations, and adapter tests
- Available commands and generated-file checks: root and package `package.json` scripts
