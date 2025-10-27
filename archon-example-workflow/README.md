# Archon AI Coding Workflow Template

A simple yet reliable template for systematic AI-assisted development using **create-plan** and **execute-plan** workflows, powered by [Archon](https://github.com/coleam00/Archon) - the open-source AI coding command center. Build on top of this and create your own AI coding workflows!

## What is This?

This is a reusable workflow template that brings structure and reliability to AI coding assistants. Instead of ad-hoc prompting, you get:

- **Systematic planning** from requirements to implementation
- **Knowledge-augmented development** via Archon's RAG capabilities
- **Task management integration** for progress tracking
- **Specialized subagents** for analysis and validation
- **Codebase consistency** through pattern analysis

Works with **Claude Code**, **Cursor**, **Windsurf**, **Codex**, and any AI coding assistant that supports custom commands or prompt templates.

## Core Workflows

### 1. Create Plan (`/create-plan`)

Transform requirements into actionable implementation plans through systematic research and analysis.

**What it does:**
- Reads your requirements document
- Searches Archon's knowledge base for best practices and patterns
- Analyzes your codebase using the `codebase-analyst` subagent
- Produces a comprehensive implementation plan (PRP) with:
  - Task breakdown with dependencies and effort estimates
  - Technical architecture and integration points
  - Code references and patterns to follow
  - Testing strategy and success criteria

**Usage:**
```bash
/create-plan requirements/my-feature.md
```

### 2. Execute Plan (`/execute-plan`)

Execute implementation plans with integrated Archon task management and validation.

**What it does:**
- Reads your implementation plan
- Creates an Archon project and tasks automatically
- Implements each task systematically (`todo` → `doing` → `review` → `done`)
- Validates with the `validator` subagent to create unit tests
- Tracks progress throughout with full visibility

**Usage:**
```bash
/execute-plan PRPs/my-feature.md
```

## Why Archon?

[Archon](https://github.com/coleam00/Archon) is an open-source AI coding OS that provides:

- **Knowledge Base**: RAG-powered search across documentation, PDFs, and crawled websites
- **Task Management**: Hierarchical projects with AI-assisted task creation and tracking
- **Smart Search**: Hybrid search with contextual embeddings and reranking
- **Multi-Agent Support**: Connect multiple AI assistants to shared context
- **Model Context Protocol**: Standard MCP server for seamless integration

Think of it as the command center that keeps your AI coding assistant informed and organized.

## What's Included

```
.claude/
├── commands/
│   ├── create-plan.md      # Requirements → Implementation plan
│   ├── execute-plan.md     # Plan → Tracked implementation
│   └── primer.md           # Project context loader
├── agents/
│   ├── codebase-analyst.md # Pattern analysis specialist
│   └── validator.md        # Testing specialist
└── CLAUDE.md               # Archon-first workflow rules
```

## Setup Instructions

### For Claude Code

1. **Copy the template to your project:**
   ```bash
   cp -r use-cases/archon-example-workflow/.claude /path/to/your-project/
   ```

2. **Install Archon MCP server** (if not already installed):
   - Follow instructions at [github.com/coleam00/Archon](https://github.com/coleam00/Archon)
   - Configure in your Claude Code settings

3. **Start using workflows:**
   ```bash
   # In Claude Code
   /create-plan requirements/your-feature.md
   # Review the generated plan, then:
   /execute-plan PRPs/your-feature.md
   ```

### For Other AI Assistants

The workflows are just markdown prompt templates - adapt them to your tool - examples:

#### **Cursor / Windsurf**
- Copy files to `.cursor/` or `.windsurf/` directory
- Use as custom commands or rules files
- Manually invoke workflows by copying prompt content

#### **Cline / Aider / Continue.dev**
- Save workflows as prompt templates
- Reference them in your session context
- Adapt the MCP tool calls to your tool's API

#### **Generic Usage**
Even without tool-specific integrations:
1. Read `create-plan.md` and follow its steps manually
2. Use Archon's web UI for task management if MCP isn't available
3. Adapt the workflow structure to your assistant's capabilities

## Workflow in Action

### New Project Example

```bash
# 1. Write requirements
echo "Build a REST API for user authentication" > requirements/auth-api.md

# 2. Create plan
/create-plan requirements/auth-api.md
# → AI searches Archon knowledge base for JWT best practices
# → AI analyzes your codebase patterns
# → Generates PRPs/auth-api.md with 12 tasks

# 3. Execute plan
/execute-plan PRPs/auth-api.md
# → Creates Archon project "Authentication API"
# → Creates 12 tasks in Archon
# → Implements task-by-task with status tracking
# → Runs validator subagent for unit tests
# → Marks tasks done as they complete
```

### Existing Project Example

```bash
# 1. Create feature requirements
# 2. Run create-plan (it analyzes existing codebase)
/create-plan requirements/new-feature.md
# → Discovers existing patterns from your code
# → Suggests integration points
# → Follows your project's conventions

# 3. Execute with existing Archon project
# Edit execute-plan.md to reference project ID or let it create new one
/execute-plan PRPs/new-feature.md
```

## Key Benefits

### For New Projects
- **Pattern establishment**: AI learns and documents your conventions
- **Structured foundation**: Plans prevent scope creep and missed requirements
- **Knowledge integration**: Leverage best practices from day one

### For Existing Projects
- **Convention adherence**: Codebase analysis ensures consistency
- **Incremental enhancement**: Add features that fit naturally
- **Context retention**: Archon keeps project history and patterns

## Customization

### Adapt the Workflows

Edit the markdown files to match your needs - examples:

- **Change task granularity** in `create-plan.md` (Step 3.1)
- **Add custom validation** in `execute-plan.md` (Step 6)
- **Modify report format** in either workflow
- **Add your own subagents** for specialized tasks

### Extend with Subagents

Create new specialized agents in `.claude/agents/`:

```markdown
---
name: "security-auditor"
description: "Reviews code for security vulnerabilities"
tools: Read, Grep, Bash
---

You are a security specialist who reviews code for...
```

Then reference in your workflows.
