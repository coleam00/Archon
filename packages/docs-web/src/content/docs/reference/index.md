---
title: Reference
description: Technical reference for Archon's architecture, CLI, commands, database, configuration, and troubleshooting.
category: reference
audience: [developer]
sidebar:
  order: 0
---

Technical reference documentation for Archon internals.

## Reference Docs

- **[Architecture](/reference/architecture/)** -- System overview, interfaces, data flow, extension guides
- **[Archon Directories](/reference/archon-directories/)** -- Directory structure, path resolution, configuration system
- **[CLI Reference](/reference/cli/)** -- All CLI commands, flags, and usage examples
- **[Commands Reference](/reference/commands/)** -- Slash commands available in all platform adapters
- **[Variables Reference](/reference/variables/)** -- Variable substitution in commands and workflows ($ARGUMENTS, $BASE_BRANCH, etc.)
- **[API Reference](/reference/api/)** -- REST API endpoints for programmatic access
- **[Database](/reference/database/)** -- Schema, migrations, SQLite/PostgreSQL setup
- **[Configuration Reference](/reference/configuration/)** -- Full config.yaml options, environment variables, streaming modes
- **[Security](/reference/security/)** -- Permission model, authorization, webhook verification, data privacy
- **[Troubleshooting](/reference/troubleshooting/)** -- Common issues and solutions

## For AI tools

Point Cursor, Claude projects, ChatGPT retrieval, and similar tools at:

- [`/llms.txt`](https://archon.diy/llms.txt) — index of all documentation pages ([llmstxt.org](https://llmstxt.org/) spec)
- [`/llms-full.txt`](https://archon.diy/llms-full.txt) — full documentation concatenated as a single markdown file
- [`/llms-small.txt`](https://archon.diy/llms-small.txt) — trimmed variant for context-limited models

These are regenerated on every docs build and stay in sync with the rendered site.
