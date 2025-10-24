# Create Git Commit

Create an atomic git commit with a properly formatted commit message following best practices for the uncommited changes or these specific files if specified.

Specific files (skip if not specified):

- File 1: $1
- File 2: $2
- File 3: $3
- File 4: $4
- File 5: $5

## Instructions

**Commit Message Format:**

- Use conventional commits: `<type>: <description>`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- Present tense (e.g., "add", "fix", "update", not "added", "fixed", "updated")
- 50 characters or less for the subject line
- Lowercase subject line
- No period at the end
- Be specific and descriptive

**Examples:**

- `feat: add web search tool with structured logging`
- `fix: resolve type errors in middleware`
- `test: add unit tests for config module`
- `docs: update CLAUDE.md with testing guidelines`
- `refactor: simplify logging configuration`
- `chore: update dependencies`

**Atomic Commits:**

- One logical change per commit
- If you've made multiple unrelated changes, consider splitting into separate commits
- Commit should be self-contained and not break the build

**IMPORTANT**

- NEVER mention claude code, anthropic, co authored by or anything similar in the commit messages

## Run

1. Review changes: `git diff HEAD`
2. Check status: `git status`
3. Stage changes: `git add -A`
4. Create commit: `git commit -m "<type>: <description>"`

## Report

- Output the commit message used
- Confirm commit was successful with commit hash
- List files that were committed
