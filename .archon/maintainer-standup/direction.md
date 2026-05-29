# Archon Direction

The maintainer-standup workflow consults this document when triaging PRs and issues to suggest which contributions align with the project and which are likely polite-decline candidates.

This file is **committed and shared by all maintainers**. Edit deliberately — direction calls live here so that PR triage stays consistent across runs and across maintainers. When declining a PR, cite the specific clause (e.g., `direction.md §single-developer-tool`).

---

## What Archon IS

- **A remote agentic coding platform.** Control AI coding assistants (Claude Code SDK, Codex SDK, Pi community provider) remotely from Slack, Telegram, GitHub, Discord, CLI, and Web UI.
- **A single-developer tool.** No multi-tenant complexity. Built for one practitioner running their own instance.
- **Platform-agnostic at the conversation layer.** Unified interface across adapters via `IPlatformAdapter`. Stream/batch AI responses in real time.
- **Workflow-driven.** Reproducible AI execution chains defined as YAML DAGs in `.archon/workflows/`. Workflows run in isolated git worktrees by default.
- **Type-safe.** Strict TypeScript everywhere. No `any` without justification.
- **Composable.** Scripts in `.archon/scripts/`, commands in `.archon/commands/`, workflows compose them.
- **Self-hostable.** Bun + TypeScript runtime. SQLite by default; PostgreSQL optional. Zero external service dependencies for core operation.
- **Forge-agnostic.** GitHub is the primary forge, but Gitea and GitLab are community supported targets via community adapters at `packages/adapters/src/community/forge/`. Long-term home for outbound forge operations (PR/issue/review CRUD) is the same per-forge adapter that handles inbound webhooks. New forges land as new community adapters that implement the shared interface.

## What Archon is NOT

- **Not multi-tenant.** No user accounts, role management, billing, or SaaS scaffolding. PRs adding these conflict with the single-developer thesis.
- **Not a hosted service.** No proprietary backend dependencies. Self-hosted by design.
- **Not a general-purpose chat UI.** Adapters are conversation surfaces for *workflow execution*, not standalone chat experiences.
- **Not a replacement for the AI coding agent itself.** Archon orchestrates Claude Code / Codex / Pi — it doesn't reimplement them.
- **Not opinionated about the dev environment.** No mandatory editor integrations, framework lock-in, or Docker requirement beyond what users opt into.
- **Not a workflow marketplace.** Bundled workflows are reference patterns; Archon is not aiming to be a hub for third-party workflow distribution.

## Community providers

Archon ships built-in providers for Claude (`@anthropic-ai/claude-agent-sdk`) and Codex (`@openai/codex-sdk`). Pi (`@mariozechner/pi-coding-agent`) is the reference community provider and sets the pattern others should follow.

**Acceptance criteria** for new community providers:

- **Coding-agent SDK only.** The provider must wrap an existing coding-agent SDK — one that handles file edits, tool use, multi-turn sessions, and planning. Raw LLM API integrations (`chat.completions`-style) are out of scope. Pi already covers ~20 LLM backends via one harness, so single-model wrappers duplicate work that is already done.
- **Match the Pi pattern.** Structure mirrors `packages/providers/src/community/pi/` — provider class implementing `IAgentProvider`, options translator, event bridge, capability matrix, registered with `builtIn: false`. Tests at parity with the Pi suite (config, options-translator, event-bridge, provider, session-resolver as the baseline).
- **Docs page.** Add the provider to `packages/docs-web/src/content/docs/getting-started/ai-assistants.md` with setup, capability matrix, and supported config keys.

**Maintenance policy:**

- We accept any provider that meets the criteria above. There is no cap.
- The contributor and the community maintain the provider. Archon maintainers do not own upstream-SDK breaks for community providers.
- A community provider that goes non-functional — CI broken, upstream SDK gone, no maintainer response — is marked deprecated and removed in the next minor release unless someone from the community submits a fix.

When citing this policy in a PR comment: `direction.md §community-providers`.

## Open questions (no stance yet)

These are direction calls we haven't made. PRs that touch these areas should surface the question for explicit decision rather than be silently accepted or rejected. The workflow may add to this list as new questions appear.

- (No open questions yet — populated over time.)

---

## How to evolve this doc

- Add a "What Archon IS" or "is NOT" line when a PR triage forces a direction call.
- Move "Open questions" entries to the IS / IS NOT sections once decided.
- Reference the relevant clause in PR comments when declining: `direction.md §single-developer-tool`.
- Keep entries short — one or two lines each. The point is fast lookup during triage, not a manifesto.
