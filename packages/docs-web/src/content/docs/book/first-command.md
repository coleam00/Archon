---
title: Creating Your First Command
description: Write your first Archon command file — a focused markdown prompt that the AI executes as a single task.
category: book
part: customization
audience: [user]
sidebar:
  order: 6
---

You've seen commands do real work — investigating issues, writing code, posting reviews. In [Chapter 3](/book/how-it-works/), we traced how `archon-fix-github-issue` stitched seven of them together. Now you're going to write one yourself.

Commands are simpler than they look. They're plain markdown files. The AI reads them as instructions.

---

## What Is a Command?

A **command** is a markdown file that tells the AI exactly what to do in one focused task. It's the atomic unit of Archon — the smallest thing that can run independently or be wired into a workflow.

Commands live in your repository at `.archon/commands/`. When Archon runs a step like `command: run-tests`, it finds `.archon/commands/run-tests.md`, substitutes any variables, and sends the whole document to the AI as its task instructions.

That's it. Commands are prompts, not code. You write what you want the AI to do, and it does it.

> **Where to put them**: Create a `.archon/commands/` directory in any git repository you're working with. Archon finds commands there automatically alongside any bundled defaults.

---

## Anatomy of a Command

Here's the complete structure of a command file, with every part labeled:

```markdown
---
description: Run tests for a specific module and report results    <- shown in /commands list
argument-hint: <module-name>                                        <- tells users what to pass
---

# Run Tests

**Input**: $ARGUMENTS                                              <- always show your input

---

## Your Task

Run the tests for the `$ARGUMENTS` module and report what you find.

[... AI instructions ...]
```

**The frontmatter** (the `---` block at the top) is optional but recommended. The `description` field is what appears when someone runs `archon workflow list` or asks the AI which commands are available. The `argument-hint` tells users what they're expected to provide.

**The body** is the actual instructions for the AI. Write it like you're explaining a task to a capable engineer who has never seen this codebase before. Be specific about what success looks like.

**Variables** get substituted before the AI sees the file. `$ARGUMENTS` becomes whatever the user passed when invoking the command.

---

## Build It: A Test Runner Command

Let's build a real command. The goal: run tests for a specific module and report results clearly.

### Step 1: Create the File

```bash
mkdir -p .archon/commands
touch .archon/commands/run-tests.md
```

### Step 2: Write the Frontmatter

```markdown
---
description: Run tests for a specific module and report results
argument-hint: <module-name>
---
```

### Step 3: Write the Instructions

```markdown
# Run Tests

**Module**: $ARGUMENTS

---

## Your Task

Run the test suite for the `$ARGUMENTS` module and produce a clear summary of the results.

## Steps

1. Find the test files for `$ARGUMENTS`:
   - Look in the same directory as the module source (e.g., `$ARGUMENTS.test.ts`)
   - Check any `__tests__/` or `tests/` subdirectories

2. Run the tests. Use the project's test runner (check `package.json` for the test script):
   ```bash
   bun test <path-to-test-files>
   ```

3. Report your findings with this structure:
   - **Status**: PASSED or FAILED
   - **Tests run**: total count
   - **Failures**: list each failing test with its error message
   - **Next step**: if tests failed, suggest the most likely fix

## If No Tests Found

If you can't find test files for `$ARGUMENTS`, say so clearly and list the files you searched.

## Success Criteria

- [ ] Tests located and run
- [ ] Results reported with pass/fail counts
- [ ] Failing tests identified with error messages
- [ ] Clear recommendation for next step
```

### Step 4: Test It

You can invoke a command directly through `archon-assist`:

```bash
archon workflow run archon-assist "/command-invoke run-tests auth"
```

Archon routes the `/command-invoke run-tests` instruction to the AI, which finds your `.archon/commands/run-tests.md`, substitutes `$ARGUMENTS` with `auth`, and runs the task.

You should see the AI find your auth module tests, run them, and produce a structured report.

---

## Variable Reference

| Variable | Contains | Example |
|----------|----------|---------|
| `$ARGUMENTS` | Everything the user passed | `"auth module"` |
| `$1` | First space-separated argument | `auth` (from `auth module`) |
| `$2` | Second space-separated argument | `module` (from `auth module`) |
| `$3` | Third space-separated argument | — |
| `$ARTIFACTS_DIR` | Absolute path to this run's artifact directory | `/home/user/.archon/workspaces/owner/repo/artifacts/runs/abc123/` |
| `$WORKFLOW_ID` | Unique ID for the current workflow run | `abc123def456` |
| `$BASE_BRANCH` | The base branch for the current worktree | `main` |
| `$DOCS_DIR` | Documentation directory path | `docs/` |

Use `$ARTIFACTS_DIR` whenever your command writes output files that a later step needs to read. Use `$1`, `$2`, `$3` when you want to treat arguments as structured positional inputs rather than a single string.

---

## Command Design Tips

**Define what success looks like.** End your command with a success criteria checklist. It gives the AI a final verification step and gives you a clear definition of "done."

**Tell the AI what to do when things go wrong.** What should happen if the test file doesn't exist? If a dependency is missing? Commands that handle edge cases explicitly produce much more consistent behavior than ones that leave it up to the AI to improvise.

**Write artifacts for anything the next step needs.** If your command produces information that a downstream step should use, have the AI write it to `$ARTIFACTS_DIR` as a file. Never rely on the AI remembering something across a context-cleared step.

**One task per command.** Resist the urge to make a command that investigates, implements, and creates a PR all at once. Focused commands are reusable, debuggable, and composable. Split work that belongs in separate phases.

---

## Invoking Commands

**From `archon-assist`** (interactive):
```bash
archon workflow run archon-assist "/command-invoke run-tests auth"
```

**From a workflow** (automated):
```yaml
nodes:
  - id: validate
    command: run-tests
    prompt: "Run tests for the auth module"
```

**Browse what's available**:
```bash
archon workflow run archon-assist "/commands"
```

This lists every command available — your custom ones from `.archon/commands/` alongside Archon's bundled defaults. The bundled commands (like `archon-investigate-issue` and `archon-fix-issue`) are good reference material when you're deciding how to structure your own.

---

In [Chapter 7: Creating Your First Workflow →](/book/first-workflow/), you'll take the command you just built and wire it into a multi-step workflow — combining it with other steps, passing artifacts between them, and building something that runs from start to finish automatically.
