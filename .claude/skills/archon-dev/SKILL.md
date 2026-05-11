---
name: archon-dev
description: |
  The PRIMARY development workflow for the Archon project (remote-coding-agent).
  Use this skill instead of any PRP skills when working on Archon code.
  Routes to 10 specialized cookbooks based on what the user is trying to do:

  RESEARCH    — "how does the orchestrator work?", "where is session state defined?",
                "trace the workflow execution flow", "what is IWorkflowStore?"
  INVESTIGATE — "should we use Drizzle or Prisma?", "what's the best way to add WebSockets?",
                "can we migrate to Turso?", "how do other projects handle rate limiting?"
  PRD         — "write a PRD for dark mode", "spec out the notification feature",
                "product requirements for webhook retry"
  PLAN        — "plan the auth refactor", "design the caching layer",
                "create an implementation plan for #42"
  IMPLEMENT   — "implement the plan", "execute .claude/archon/plans/auth.plan.md",
                "build the feature from the plan", "code this up"
  REVIEW      — "review PR #123", "review my changes", "code review the diff"
  DEBUG       — "debug the failing test", "why is streaming broken?",
                "root cause analysis on the timeout issue"
  COMMIT      — "commit these changes", "commit the auth refactor"
  PR          — "create a PR", "open a pull request for this branch"
  ISSUE       — "report this to gh", "create a gh issue", "log it in github",
                "file a bug for this", "create a feature request"

  This skill triggers on ANY development task: researching, investigating,
  planning, building, reviewing, debugging, committing, or shipping code.
  NOT for: Running Archon CLI workflows in worktrees (use /archon instead).
argument-hint: "[cookbook] [task description or issue number]"
---

# archon-dev

Development workflow — research, plan, build, review, ship.

## Current State

- **Branch**: !`git branch --show-current 2>/dev/null || echo "not in git repo"`
- **Artifacts**: !`ls .claude/archon/ 2>/dev/null || echo "none yet"`
- **Active plans**: !`ls .claude/archon/plans/*.plan.md 2>/dev/null | head -5 || echo "none"`

---

## Routing

**Read `$ARGUMENTS` and determine which cookbook to load.**

If the user explicitly names a cookbook (e.g., "plan", "implement"), use that.
Otherwise, match intent from keywords:

| Intent | Keywords | Cookbook |
|--------|----------|---------|
| Codebase questions, document what exists | "research", "how does", "what is", "where is", "trace", "find" | [cookbooks/research.md](cookbooks/research.md) |
| Strategic research, library eval, feasibility | "investigate", "should we", "can we", "compare", "evaluate", "feasibility", "best way to", "best approach" | [cookbooks/investigate.md](cookbooks/investigate.md) |
| Write product requirements | "prd", "requirements", "spec", "product requirement" | [cookbooks/prd.md](cookbooks/prd.md) |
| Create implementation plan | "plan", "design", "architect", "write a plan" | [cookbooks/plan.md](cookbooks/plan.md) |
| Execute an existing plan | "implement", "execute", "build", "code this", path to `.plan.md` | [cookbooks/implement.md](cookbooks/implement.md) |
| Review code or PR | "review", "review PR", "code review", "review changes" | [cookbooks/review.md](cookbooks/review.md) |
| Debug or root cause analysis | "debug", "rca", "root cause", "why is", "broken", "failing" | [cookbooks/debug.md](cookbooks/debug.md) |
| Commit changes | "commit", "save changes", "stage" | [cookbooks/commit.md](cookbooks/commit.md) |
| Create pull request | "pr", "pull request", "create pr", "open pr" | [cookbooks/pr.md](cookbooks/pr.md) |
| Report to GitHub | "issue", "report to gh", "log in github", "file a bug", "feature request", "create issue", "gh issue" | [cookbooks/issue.md](cookbooks/issue.md) |

**If ambiguous**: Ask the user which cookbook to use.

**After routing**: Read the matched cookbook file and follow its instructions exactly.

---

## Workflow Chains

Cookbooks feed into each other. After completing one, suggest the next:

```
research ──► investigate ──► prd ──► plan ──► implement ──► commit ──► pr
                              ▲                    │
             debug ───────────┘      review ◄──────┘
                 │
                 ▼
               issue ──► plan (if feature) or debug (if bug)
```

---

## Artifact Directory

All artifacts go to `.claude/archon/`. Create subdirectories as needed on first use.

```
.claude/archon/
├── prds/              # Product requirement documents
├── plans/             # Implementation plans
│   └── completed/     # Archived after implementation
├── reports/           # Implementation reports
├── issues/            # GitHub issue investigations
│   └── completed/
├── reviews/           # PR review reports
├── debug/             # Root cause analysis
└── research/          # Research findings
```

---

## Project Detection

Do NOT hardcode project-specific commands. Detect dynamically:

- **Package manager**: Check for `bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm
- **Validation command**: Check `package.json` scripts for `validate`, `check`, or `verify`
- **Test command**: Check for `test` script in `package.json`
- **Conventions**: Read CLAUDE.md for project-specific rules

---

## Rules

1. **Evidence-based**: Every claim about the codebase must reference `file:line`
2. **No speculation**: If uncertain, investigate first
3. **Fail fast**: Surface errors immediately, never swallow them
4. **Respect CLAUDE.md**: Project conventions override cookbook defaults
5. **No AI attribution**: Never add "Generated with Claude" or "Co-Authored-By: Claude" to commits or PRs
