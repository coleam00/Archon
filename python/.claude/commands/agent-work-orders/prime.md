# Prime

Execute the following sections to understand the codebase before starting new work, then summarize your understanding.

## Run

- List all tracked files: `git ls-files`
- Show project structure: `tree -I '.venv|__pycache__|*.pyc|.pytest_cache|.mypy_cache|.ruff_cache' -L 3`

## Read

- `CLAUDE.md` - Core project instructions, principles, logging rules, testing requirements
- `python/src/agent_work_orders` - Project overview and setup (if exists)

- Identify core files in the agent work orders directory to understand what we are woerking on and its intent

## Report

Provide a concise summary of:

1. **Project Purpose**: What this application does
2. **Architecture**: Key patterns (vertical slice, FastAPI + Pydantic AI)
3. **Core Principles**: TYPE SAFETY, KISS, YAGNI
4. **Tech Stack**: Main dependencies and tools
5. **Key Requirements**: Logging, testing, type annotations
6. **Current State**: What's implemented

Keep the summary brief (5-10 bullet points) and focused on what you need to know to contribute effectively.
