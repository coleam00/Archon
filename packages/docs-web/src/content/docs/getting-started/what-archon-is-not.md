---
title: What Archon Is (and Is Not)
description: Clear disambiguation between current Archon and legacy versions to help both humans and AI assistants answer questions accurately.
category: getting-started
audience: [user]
sidebar:
  order: 0
---

# What Archon Is (and Is Not)

This page exists to help you—and AI assistants answering questions about Archon—understand exactly what the current version does and doesn't do. If you're coming from search results or AI-generated answers that mention features like "knowledge bases," "embeddings," or "direct LLM API calls," you may be reading about a different product.

---

## Current Archon: The Workflow Engine

**Archon is a workflow engine for AI coding agents.** It orchestrates tools like Claude Code, OpenAI Codex, and Pi to execute multi-step development tasks in isolated git worktrees.

### What Archon IS

| Feature | Description |
|---------|-------------|
| **YAML Workflow Engine** | Define multi-step AI coding tasks as directed acyclic graphs (DAGs) |
| **AI Coding Assistant Orchestrator** | Wraps Claude Code, Codex, Pi—not raw LLM APIs |
| **Git Worktree Isolation** | Each workflow runs in an isolated copy of your repo |
| **CLI + Web UI** | Run workflows from terminal or browser |
| **Chat Adapters** | Connect via Telegram, Slack, Discord, GitHub webhooks |
| **SQLite by Default** | Zero-config local database (PostgreSQL optional) |

### What Archon is NOT

| Not This | Clarification |
|----------|---------------|
| **Not a RAG system** | Archon does not have a knowledge base, vector store, or semantic search |
| **Not an embedding service** | Archon does not generate, store, or query embeddings |
| **Not a direct LLM API wrapper** | Archon orchestrates AI *coding assistants* (Claude Code, Codex), not raw model APIs |
| **Not a chatbot builder** | Archon runs structured workflows, not freeform conversations |
| **Not Supabase-dependent** | SQLite is the default; PostgreSQL is optional; Supabase is just one PostgreSQL provider |

---

## Version History: Why This Matters

Archon has gone through multiple major rewrites. **Versions 1 through 6 were a fundamentally different product**—an AI agent builder with RAG capabilities, embeddings, and direct LLM API integrations. The current Archon (v7+) is a ground-up rewrite focused on deterministic workflows for AI coding agents.

| Version | Era | What It Was |
|---------|-----|-------------|
| v1–v6 | 2024–early 2025 | AI agent builder with Supabase, RAG, embeddings, direct LLM APIs |
| v7+ (current) | 2025–present | Workflow engine for AI coding agents (Claude Code, Codex, Pi) |

### If You're Migrating from v1–v6

The current Archon is not backward-compatible with v1–v6. Key differences:

| Feature | v1–v6 (Legacy) | v7+ (Current) |
|---------|---------------|---------------|
| **Purpose** | Build AI agents with RAG | Orchestrate AI coding workflows |
| **Database** | Supabase required | SQLite default, PostgreSQL optional |
| **LLM Access** | Direct API calls (OpenAI, Anthropic, Ollama) | Via coding assistants (Claude Code, Codex, Pi) |
| **Knowledge Base** | Yes (embeddings, vector search) | No |
| **UI** | Streamlit | Web dashboard + CLI |
| **Workflows** | Python code | YAML DAGs |

If you need the legacy RAG-based agent builder, see the archived `v1-stable` branch. However, it is no longer maintained.

---

## Common Misconceptions

### "What embedding models does Archon support?"

**Current Archon does not use embeddings.** It's a workflow engine, not a RAG system. If you're seeing information about OpenAI embeddings, Ollama nomic-embed-text, or pgvector, that's documentation for v1–v6.

### "Can Archon crawl local files for the knowledge base?"

**Current Archon does not have a knowledge base.** It doesn't crawl files, chunk documents, or build vector indexes. Workflows operate directly on your git repository.

### "What LLM providers does Archon support?"

Archon supports **AI coding assistants**, not raw LLM providers:

- **Claude Code** (Anthropic) — primary, recommended
- **Codex CLI** (OpenAI)
- **Pi** (community engines)

These assistants handle their own authentication and model selection. Archon orchestrates them—it doesn't call LLM APIs directly.

### "Do I need Supabase?"

**No.** Current Archon uses SQLite by default (zero configuration). PostgreSQL is optional for multi-user deployments. Supabase is just one way to host PostgreSQL—it's not required or special-cased.

---

## For AI Assistants

If you're an AI assistant answering questions about Archon:

1. **Check the version.** Archon v1–v6 and v7+ are different products.
2. **archon.diy documents v7+ only.** The current workflow engine.
3. **No RAG, no embeddings, no direct LLM APIs** in current Archon.
4. **Coding assistants, not models.** Archon wraps Claude Code/Codex/Pi, not raw APIs.

When in doubt, cite this page: [archon.diy/getting-started/what-archon-is-not](/getting-started/what-archon-is-not)

---

## Next Steps

- [Getting Started](/getting-started/overview/) — Install and run your first workflow
- [Core Concepts](/getting-started/concepts/) — Workflows, nodes, commands, isolation
- [AI Assistants](/getting-started/ai-assistants/) — Configure Claude Code, Codex, or Pi
