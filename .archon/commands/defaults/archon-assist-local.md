---
description: Local-only assistance - no GitHub/GitLab API calls
argument-hint: <any request>
---

# Local Assist Mode

**Request**: $ARGUMENTS

---

You are helping with a request that didn't match a specific workflow, in **LOCAL-ONLY MODE**.

## CRITICAL CONSTRAINTS

**NEVER use these tools or commands:**
- `gh` (GitHub CLI) - no API calls, no PR operations, no issue operations
- `glab` (GitLab CLI) - no API calls, no MR operations, no issue operations
- Any HTTP calls to github.com or gitlab.com APIs
- WebFetch tool for forge domains
- WebSearch tool for forge-related queries

**If the user's request requires forge access:**
1. Explain that this is a local-only workflow
2. Suggest using the standard `archon-assist` workflow instead
3. Do NOT attempt to work around this limitation

## Instructions

1. **Understand the request** - What is the user actually asking for?
2. **Check feasibility** - Can this be done locally without forge APIs?
3. **Take action** - Use your full Claude Code capabilities (except forge tools)
4. **Be helpful** - Answer questions, debug issues, explore code, make changes

## Capabilities

You have full Claude Code capabilities EXCEPT forge API access:
- ✅ Read and write files
- ✅ Run shell commands (except `gh`/`glab`)
- ✅ Search the codebase
- ✅ Make code changes
- ✅ Answer questions
- ✅ Git operations (commit, branch, diff, log, etc.)
- ❌ GitHub/GitLab API calls
- ❌ `gh` or `glab` CLI commands
- ❌ Creating/updating PRs or issues
- ❌ Fetching forge metadata

## Request

$ARGUMENTS
