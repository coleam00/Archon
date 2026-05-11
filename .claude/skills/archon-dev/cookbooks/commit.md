# Commit Cookbook

Analyze changes and create well-structured commits. Supports natural language file targeting. Acts on git directly — no artifact file.

**Input**: `$ARGUMENTS` — optional target description and/or commit message hint, or omit for auto-analysis.

---

## Phase 1: ANALYZE — Understand What Changed

Run in parallel:
1. `git status` — see all modified and untracked files
2. `git diff` — see unstaged changes
3. `git diff --staged` — see already-staged changes
4. `git log --oneline -5` — see recent commit style

**CHECKPOINT**: Changes understood before proceeding.

---

## Phase 2: TARGET — Determine What to Stage

If `$ARGUMENTS` contains a target description, interpret it:

| Input | Action |
|-------|--------|
| (blank) | Stage all relevant changes (but respect safety checks) |
| `staged` | Use current staging as-is |
| `*.ts` / `typescript files` | `git add "*.ts"` |
| `files in src/X` | `git add src/X/` |
| `except tests` | Add all, then `git reset *test* *spec*` |
| `only new files` | Add only untracked files |
| `the X changes` | Interpret from diff context |

**Safety checks** (automatic, no user prompt needed):
- `.env` or credentials files → NEVER stage, skip silently
- Large binaries → skip and note in output
- Generated files → include if they're part of the build

---

## Phase 3: CLASSIFY — Determine Commit Type

Based on the changes, classify:

| Type | When |
|------|------|
| `feat` | New functionality |
| `fix` | Bug fix |
| `refactor` | Code restructuring, no behavior change |
| `test` | Adding or modifying tests |
| `docs` | Documentation only |
| `chore` | Build, config, dependencies |
| `style` | Formatting, whitespace |
| `perf` | Performance improvement |

---

## Phase 4: GROUP — Split if Needed

If changes span multiple unrelated concerns, split into multiple commits.

For each logical group:
- Which files belong together
- What type of change it is
- Commit message for that group

---

## Phase 5: DRAFT — Write Commit Message

Follow conventional commit format:

```
{type}({scope}): {concise description}

{Optional body explaining WHY, not WHAT — the diff shows what changed}
```

**Rules from CLAUDE.md:**
- No "Generated with Claude Code" footer
- No "Co-Authored-By: Claude"
- No robot emoji
- Write as if a human wrote it
- Focus on WHY, not WHAT
- Keep subject line under 72 characters

If `$ARGUMENTS` contains a message hint, use it as the basis.

---

## Phase 6: EXECUTE — Stage and Commit

1. Stage specific files (NEVER use `git add -A` or `git add .` unless targeting all changes)
2. Create the commit using a HEREDOC for the message:

```bash
git add {file1} {file2} {file3}
git commit -m "$(cat <<'EOF'
{commit message}
EOF
)"
```

3. Verify with `git status` after commit

If committing multiple groups, repeat for each group in logical order.

---

## Done

Report:
- Commit hash(es) created
- Files committed
- Suggest next step: `/archon-dev pr` to create a pull request

### Examples

```
/archon-dev commit                          # All changes
/archon-dev commit typescript files         # *.ts only
/archon-dev commit except package-lock      # Exclude specific
/archon-dev commit only the new files       # Untracked only
/archon-dev commit staged                   # Already-staged only
/archon-dev commit the auth refactor        # Context-based targeting
```
