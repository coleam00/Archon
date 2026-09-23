# Archon Direction

The project's product-direction document, for maintainers and agents alike: PR/issue triage (the maintainer-standup workflow consults it to flag polite-decline candidates), grounding for agent runs, and a direction sidecar any workflow can read.

This file is **committed and shared by all maintainers**. Edit deliberately — direction calls live here so that PR triage stays consistent across runs and across maintainers. When declining a PR, cite the specific clause (e.g., `direction.md §single-tenant-per-install`).

---

## What Archon IS

- **A governed agentic automation engine.** Runs multi-step workflows that mix deterministic steps (bash/scripts) with AI agents (Claude Code SDK, Codex SDK, and community providers), with human approval gates and audit trails — driven remotely from Slack, Telegram, GitHub, Discord, CLI, and Web UI. Its most mature surface today is agentic **coding**; the same engine is being extended to drive general **business-operations** automation.
- **Single-tenant per install.** One isolated instance per operator or client (the deployment model is one install/VPS per client, not one install serving many tenants). Data model and runtime stay single-tenant — client isolation is at the deployment layer, not in code. Multi-**user** within an install (several humans sharing one instance, each with their own identity/credentials) is supported and is distinct from multi-**tenant**.
- **Heading toward always-on automation.** Native scheduling and event/webhook triggers are a planned primitive (tracked in the workflow-triggers PRD), enabling scheduled, event-driven, and unattended runs — including operational, non-coding work. PRs toward this direction align.
- **Platform-agnostic at the conversation layer.** Unified interface across adapters via `IPlatformAdapter`. Stream/batch AI responses in real time.
- **Workflow-driven.** Reproducible AI execution chains defined as YAML DAGs in `.archon/workflows/`. Workflows run in isolated git worktrees by default.
- **Type-safe.** Strict TypeScript everywhere. No `any` without justification.
- **Composable.** Scripts in `.archon/scripts/`, commands in `.archon/commands/`, workflows compose them.
- **Bundled defaults are reference implementations — composition is how we author them, not a stability contract we offer.** "Reference patterns" is the user-facing posture; "composable" is the authoring technique. The set demonstrates capabilities and authoring best practice, stack-agnostic so it runs on any project (rewrite: #2123). `include:` blocks stay internally consistent within a bundle release, never guaranteed across releases (declare `returns:` — #2470). User copies are expected to diverge; building on a bundled block is allowed but neither mandatory nor the recommendation — the best workflows are project-specific. Repo-override by name is the pinning mechanism. Cite as `direction.md §defaults-reference-implementations`.
- **Has a community workflow marketplace.** A place for the community to share their workflows — the registry at `packages/docs-web/src/data/marketplace.ts` (each entry pinned to a commit SHA), surfaced on the docs site.
- **Self-hostable.** Bun + TypeScript runtime. SQLite by default; PostgreSQL optional. Zero external service dependencies for core operation.
- **Forge-agnostic.** GitHub is the primary forge, but Gitea and GitLab are community supported targets via community adapters at `packages/adapters/src/community/forge/`. Long-term home for outbound forge operations (PR/issue/review CRUD) is the same per-forge adapter that handles inbound webhooks. New forges land as new community adapters that implement the shared interface.

## What Archon is NOT

- **Not multi-tenant inside one install.** No per-tenant isolation, tenant multiplexing, billing, or SaaS scaffolding within a single instance — serve multiple clients by running one install per client. (Per-**user** identity and credentials within an install already exist and are in scope; that is not multi-tenancy.) PRs adding in-process multi-tenant isolation or billing conflict with the per-install model.
- **Not a hosted service.** No proprietary backend dependencies. Self-hosted by design.
- **Not a general-purpose chat UI.** Adapters are conversation surfaces for *workflow execution*, not standalone chat experiences.
- **Not a replacement for the AI coding agent itself.** Archon orchestrates Claude Code / Codex / Pi — it doesn't reimplement them.
- **Not opinionated about the dev environment.** No mandatory editor integrations, framework lock-in, or Docker requirement beyond what users opt into.
- **Not a deployment-infrastructure product.** Caddy is the single maintained reference reverse proxy (`--profile cloud`). Alternative proxies and infra recipes (Traefik, Nginx, k8s, ...) live in **docs** as community-maintained examples against the documented proxy contract (exposed port, health endpoint, `/internal/*` never proxied — see #2193), not as compose profiles Archon maintains: each maintained proxy config doubles a security-critical surface. Cite as `direction.md §deployment-recipes`.
- **Not a package-manager distribution hub.** The maintained install channels are the curl/PowerShell installer, Homebrew, Docker, and the GitHub release binaries. Additional channels (Nix, AUR, Scoop, winget, apt, ...) are welcome as **community-maintained docs recipes**, or as packages upstream in the package manager's own registry (e.g. nixpkgs) where they get that ecosystem's CI and hash-update bots for free — not as in-repo manifests Archon version-bumps. Every hash-pinned channel adds a per-release chore and a surface that rots silently between releases; Homebrew already costs one. Cite as `direction.md §distribution-channels`.
- **Not a programming language.** The workflow YAML coordinates (gates, joins, retries, sessions, artifacts, reusable structure); computation lives inside nodes, not in the YAML. PRs that add computation to the YAML surface conflict — see §workflow-language. This is about the *language*, not about which node type an author picks: a `prompt:` node that computes is a legitimate choice — see §prompt-computation.

## Aspirational architecture: a standalone core

This is the target architecture, not a description of the current package graph or install. Design work should move toward it without pretending the decomposition is already complete. Tracked in [#2791](https://github.com/coleam00/Archon/issues/2791).

Agentic engineering changes too quickly for a monolith to stay right. Projects that endure keep a small, flexible core and let users build the rest through plugins and extensions.

- **The engine stands alone as an SDK.** Its public surface defines, validates, runs, resumes, governs, and queries workflows without requiring the server, Web UI, platform adapters, provider implementations, or a database.
- **Core plus CLI is a complete local install.** The engine and CLI must be downloadable and installable without the rest of Archon. Worktree isolation is part of that baseline because it is the default local workspace primitive.
- **Append-only files are the default persistence.** A standalone install uses append-only JSON or JSONL run records and event logs. A database is an optional persistence adapter, not a prerequisite for the engine.
- **Providers and platform adapters are plugins.** AI providers, Slack, Telegram, GitHub, Discord, Web, and future integrations attach through stable extension seams. None belongs to the required core distribution.
- **Additional isolation backends are plugins.** Worktrees remain built in; containers, VMs, microVMs, remote execution, and future isolation forms are optional add-ons behind the isolation contract.
- **Engine capabilities have pluggable hosts.** Continuation wakes, schedules, triggers, and similar lifecycle functions belong to core surfaces that a CLI command, server loop, OS timer, or third-party host can drive. The server is a batteries-included host, not the owner of the capability.
- **Everything outside the core is optional.** The server, UI, database adapters, providers, platform adapters, and non-worktree isolation should compose around the SDK. A consumer adopts only the surfaces it needs.

Triage clause: cite this direction as `direction.md §standalone-core`. Do not reject incremental improvements because they do not complete the decomposition in one change; reject new coupling that makes the target materially harder.

## Web UI

Archon's Web UI is a reference implementation over the governed engine and SDK, not a privileged product layer. It should prove that another team can build its own UI against the same public contracts.

- **The console replaces the legacy UI.** The console is the maintained path for runs, settings, configuration, and observability. The legacy UI and its duplicate components are removed rather than maintained as a second product. Temporary redirects may preserve bookmarks during cutover, but the old UI is not a compatibility surface.
- **The served console is a supported management surface.** A Docker or other server deployment runs Archon remotely and serves the console for the operator to manage it from a browser. The console must not assume that the browser shares the engine's filesystem or process. CLI-only and SDK-only use remain supported; the Web UI is not required to run the engine.
- **Console authentication is optional.** A local or otherwise trusted solo install remains usable without a login. Operators may enable Archon's Web authentication or place the served UI behind a trusted authentication proxy when network access needs an identity boundary. Authentication gates the same console and API rather than creating a separate product mode, and multi-user identity does not turn one install into a multi-tenant service.
- **The Web UI demonstrates the engine as a product surface.** It consumes the same run, governance, event, artifact, and configuration contracts available to another SDK or API client. A feature that works only through Web-specific engine behavior is missing a public seam.
- **The Web UI also demonstrates useful applications over governed workflows.** Workflows should be able to produce an actionable result surface, not only logs and generic artifacts. A review workflow may produce a review UI, a delivery workflow a merge queue, and a triage workflow a triage view. Archon's implementation should show users how to build equivalent UIs over their own workflows and outputs without depending on bundled workflow names or private Web behavior.
- **Workflow output owns the meaning; the host owns safe presentation and action dispatch.** The output may eventually be structured data, a declared view, sandboxed HTML, or another small contract. The exact representation is undecided. Any action from a rendered result must still pass through typed engine-owned authorization and governance boundaries.
- **Workflow authoring does not gate the console cutover.** The current visual builder is an experiment, not a committed product shape and not a reason to retain the legacy UI. A smaller path may be an agent editing workflow YAML while the UI renders the resulting DAG. Keep both approaches open until real authoring use provides evidence.

Triage clause: cite this direction as `direction.md §web-ui`.

## Community plugins

Providers and platform integrations change faster than Archon's core. Community implementations should therefore ship as optional plugins from contributor-owned repositories, not as new dependencies and implementations compiled into Archon.

- **One distribution model, separate runtime contracts.** Independently packaged plugins share one manifest, marketplace, and CLI install/update/remove mechanism. Each plugin kind keeps the runtime contract its responsibility needs: provider plugins own agent sessions, streaming, native configuration, and capability enforcement; chat/platform plugins own inbound authentication, identity, transport, and lifecycle; forge plugins own normalized forge operations. Do not force these different boundaries through one generic runtime interface.
- **The engine owns each contract.** A conforming plugin attaches without provider- or platform-specific branches in engine control flow. If an integration requires those branches or a new static import in an Archon registry, its contract is missing or not ready.
- **The contributor owns the implementation.** Community plugin source, releases, SDK dependencies, and upstream-breakage maintenance stay in the contributor's repository. Archon may list and promote the plugin without taking ownership of its code or dependencies.
- **Marketplace entries are installable trust records.** A listing identifies an immutable release or source revision, Archon compatibility, plugin kind, declared capabilities and permissions, and its maintainer. Installation makes the third-party-code boundary explicit. A broken or abandoned listing can be deprecated or removed without an Archon release.
- **Existing bundled community integrations are a transition state, not the extension pattern.** They may receive focused compatibility, correctness, and security fixes. Do not add another bundled community provider or adapter, or substantially expand one, until its external plugin contract and loading path exist. Migration of existing integrations can happen incrementally after those seams are proven.
- **Build the seams in evidence order.** The forge contract in #2963 goes first, followed by chat/platform and provider contracts. A focused seam does not need to build a generic plugin framework or marketplace before it can prove its runtime contract, but its package shape must not block the shared distribution model that follows.

- **Built-in does not mean bundled.** Archon maintains the Claude, Codex, and Pi providers in this repository and does not install their SDKs by default. An install selects the providers it needs — one, several, or all — and community plugins arrive through the same selection mechanism. Maintenance ownership and distribution are separate decisions: being maintained here earns a provider correctness and parity work, not a place in every install's dependency tree.
- **Maintained providers hold parity with each other.** A user who selects Codex should not get worse diagnostics, resolution, or configuration handling than one who selects Claude. A fix that lands on one maintained provider and not its siblings is drift on the path, not a scoping choice.

Archon maintains the provider and platform integrations it explicitly designates as built-ins. Listing a community plugin is curation and discovery, not a transfer of maintenance responsibility.

When citing this policy in a PR comment: `direction.md §community-plugins`.

## Workflow language (YAML surface)

The workflow YAML is a **coordination language**, not a programming language. Admissibility test for any new YAML surface feature (field, node type, expression capability): (1) does the *engine* need to see it to govern the run? (2) is it declarative data, not evaluation? (3) could a script node + existing wiring express it today? A feature that computes rather than coordinates is declined with a pointer to the escape hatch. Full rationale, case law, and the five failure smells: `.archon/workflow-language-constitution.md`.

Triage clauses — cite as `direction.md §<clause>`:

- **§when-grammar** — `when:` never grows incrementally (no parentheses, functions, string ops, arithmetic). Standing answer: compute the decision in a `script:` node, gate on `$node.output.field`. Only sanctioned growth is adopting CEL wholesale in one versioned change — never home-grown operators.
- **§load-time-composition** — composition targets and body topology must resolve at load time. The engine may repeat that static body at runtime (for a loop or runtime item list); data may determine repetition, never select a target or construct topology. A dynamically selected target or graph is a sub-run — a governance object with its own run record (#2121 Phase 2, co-designed with #1764) — not a language feature.
- **§governed-launch-ownership** — a `workflow:` node launches an independently governed workflow. The caller may bind declared inputs and choose launch coordination or isolation, but cannot override the child's authored provider, model, reasoning, tools, or capability policy; those remain owned by the child and resolve through normal tier and alias configuration. Authors who need different execution policy should launch an explicitly authored variant rather than mutate the child across the run boundary.
- **§workaround-triage** — repeated YAML structure or *recurring* deterministic logic embedded in prompts is a signal, triaged into three buckets: missing *coordination* primitive → design it constitutionally; missing *pattern* → document the pattern (e.g. polyglot validate = detect-AI → execute-bash → fix-AI); computation that has leaked *into the YAML surface* → point at script nodes. This bucket never produces a rewrite-the-prompt verdict — see §prompt-computation. The workaround corpus decides language shape; the feature-request queue doesn't.
- **§prompt-computation** — the constitution governs the **YAML surface**, not what an agent does inside a node. A `prompt:` node performing computation is a legitimate authoring choice, and the right one when the author doesn't know the rule or expects it to change — forcing an uncertain rule into a script freezes a guess into code. Script vs prompt is ordinary engineering owned by the workflow author. **Never decline or rewrite a prompt on constitutional grounds.** The only sanctioned argument for making a specific check deterministic is *reliability*: no judgment content (one correct answer) plus irreversible external consequences if it doesn't fire — argue that on its merits, not by citing the constitution.
- **§schema-width** — new provider capabilities default into provider config or tier/alias presets, not new node fields; a node field is earned only by genuine per-node variance. Capability mismatches warn loudly, never silently no-op (`capabilities.ts` is the source of truth; docs derive from it — #2116).
- **§implicit-behavior** — a new implicit behavior (auto-anything) must be documented in the canonical behavior list, individually defeatable, and fail-safe — convenience alone never qualifies.

## Isolation

Isolation has two independent axes, and they are chosen separately:

- **Workspace** — which working tree a run sees, and at which ref. A git worktree is one way to provide that, not the definition of it. A folder project has no git layer at all.
- **Execution** — where commands actually run and what they can reach. The host today, or a container.

**Execution is always the outer boundary, and the workspace nests inside it.** A worktree is a git mechanism, not an execution sandbox: if a run executes inside a container, VM, or microVM, the worktree is a layer *within* that, never an alternative to it. On its own a worktree bounds which files a run sees and little else — concurrent runs still share `~/.archon` and its single database, `$STATE_DIR`, persisted node sessions, caches, and the machine. The host environment is the clearest case: `buildRequestSubprocessEnv` is the env-isolation enforcement point and it withholds `process.env` only for a **container** run, so a host run inherits the ambient environment whether or not it sits in a worktree. What per-run separation does exist (artifacts, logs, run-scoped sessions) is keyed by **run id**, not by worktree. So a worktree is not a security boundary and must not be described as one. The engine coordinates runs; it does not own how they are isolated.

Today's backends are what exist, not the limit of what we want. Isolation will expand, and proposals with a genuinely good answer for isolating runs are welcome — folder projects especially, where there is no git layer to lean on and execution isolation is the only isolation available. Running a repo checkout inside a container is a gap we want filled (#2206). Cite as `direction.md §isolation-layers`.

Triage clauses — cite as `direction.md §<clause>`:

- **§isolation-never-inferred** — the engine never guesses isolation. A worktree is created only on an explicit `isolation: worktree`, and a mismatch fails fast naming the setting the author must supply. PRs that default, infer, or silently upgrade isolation conflict.
- **§isolation-arrives-whole** — a new isolation backend lands as one change: backend, contract, and lifecycle together. Contract surface with no producer is declined with a pointer to the backend that would use it — an isolation backend is a security boundary, and a half-landed one is a boundary nobody owns.
- **§same-path-workspace** — a container addresses the workspace at the same path the host does, which is what lets `$ARTIFACTS_DIR` mean one thing in prompt text, env, and argv alike. Divergent addressing is not forbidden, but it must resolve every path once at a single seam rather than remapping strings at the edges (#2206, #2207).

## Open questions (no stance yet)

These are direction calls we haven't made. PRs that touch these areas should surface the question for explicit decision rather than be silently accepted or rejected. The workflow may add to this list as new questions appear.

- **License posture.** Whether Archon stays MIT or moves to a fair-code/source-available license (and adopts a CLA) for a future hosted/enterprise offering is undecided — deferred to the maintainers. PRs that assume either posture are premature.
- **Workflow result surfaces.** The Web UI should render useful, actionable workflow outcomes and demonstrate the same capability for user-built UIs. The contract is unsettled: structured JSON and known renderers, sandboxed HTML, a view manifest, or another narrow form. Settle the trust boundary, portable schema, action authorization, and audit behavior before adding workflow-specific UI branches.
- **Provider selection on a fresh install.** Built-ins are maintained but not bundled; what a brand-new install resolves to before the user has chosen is undecided. Options include failing loudly with a selection prompt, resolving whatever provider CLI is already on the machine, or a named default. Settle it against "core plus CLI is a complete local install" — an install that cannot run a workflow until a second download is not complete, and a silent default that spends on an unintended provider is worse.
- **Workflow authoring.** The current visual builder remains an experiment. An agent writing YAML with a rendered DAG may be the smaller product. Decide from real authoring use; do not make legacy-UI removal depend on this choice or move Web-owned editor vocabulary into the engine meanwhile.
- **UI theming.** The Web UI ships one hardcoded theme with no extension seam; whether to add a brand-override token file, a full community theme marketplace (`§community-plugins`-style trust boundary), or neither is undecided and unrequested so far (#3335). Don't build either before demand is confirmed and the queue position against `§community-plugins` and `§web-ui` is settled.

---

## How to evolve this doc

- Add a "What Archon IS" or "is NOT" line when a PR triage forces a direction call.
- Move "Open questions" entries to the IS / IS NOT sections once decided.
- Reference the relevant clause in PR comments when declining: `direction.md §single-tenant-per-install`.
- Keep entries short — one or two lines each. The point is fast lookup during triage, not a manifesto.
