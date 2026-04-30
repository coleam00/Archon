# Memexia Pipeline Onboarding

How to set up the Memexia-backed PRD pipeline (`archon-brainstorm-to-prd` → `archon-prd-to-plan` → `archon-plan-to-stories` → `archon-execute-story`) on a new project.

Once-per-machine setup: ~30 seconds.
Once-per-project setup: ~30 seconds (mostly file copies).

---

## Once per machine — already done if you've used this pipeline before

Add the Memexia credentials to `~/.archon/.env` (Archon auto-loads this file on every workflow run). The values below are the current Memexia router endpoint:

```bash
cat >> ~/.archon/.env <<'EOF'
MEMEXIA_API_URL=http://46.250.246.94:3000
MEMEXIA_API_KEY=<your-memexia-api-key>
EOF
```

> **The MCP config in this folder uses `$MEMEXIA_API_URL` and `$MEMEXIA_API_KEY` references** — the actual secrets never live in your repo. Workflow bash nodes also read these env vars directly. One source of truth, never committed.

If you already have these vars set, skip this step.

---

## Once per project — when adding the pipeline to a new repo

From the **root of the new project**:

```bash
# 1. Create the .archon directory structure.
mkdir -p .archon/mcp

# 2. Copy the MCP config and project config from this onboarding folder.
cp /path/to/archon/docs/memexia-onboarding/memexia.json .archon/mcp/
cp /path/to/archon/docs/memexia-onboarding/config.yaml .archon/

# 3. Edit .archon/config.yaml — set baseBranch to whatever your project uses (main / dev / develop).

# 4. Gitignore the MCP folder (it contains no secrets today, but keeps the option open for project-specific MCP files later).
grep -qxF '.archon/mcp/' .gitignore 2>/dev/null || echo '.archon/mcp/' >> .gitignore

# 5. Sanity check from any path inside the project.
archon validate workflows archon-brainstorm-to-prd
```

That's it. You can now run:

```bash
archon workflow run archon-brainstorm-to-prd --branch <branch-name> "your idea here"
```

---

## What's in this folder

| File | Where it goes | Purpose |
|---|---|---|
| `memexia.json` | `<project>/.archon/mcp/memexia.json` | MCP config so workflow nodes can use `mcp__memexia__*` tools. Reads URL and key from `~/.archon/.env`. No secrets in the file itself. |
| `config.yaml` | `<project>/.archon/config.yaml` | Tells Archon which base branch to use and to copy `.archon/mcp/` into worktrees so the MCP file is available there too. Edit `baseBranch` per project. |
| `README.md` | (this file — read once) | These instructions. |

---

## Workflows are bundled into Archon defaults

The four pipeline workflows (`archon-brainstorm-to-prd`, `archon-prd-to-plan`, `archon-plan-to-stories`, `archon-execute-story`) live in Archon's bundled defaults — every install has them globally. You do **not** need to copy YAML files per project.

If they're missing from `archon workflow list`, Archon was built before the pipeline shipped — pull the latest and reinstall.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `bank-setup` fails with `MEMEXIA_API_URL not set` | `~/.archon/.env` missing the var | Run the once-per-machine step above |
| `MCP server connection failed: memexia` | Memexia router unreachable, bad creds, or path to `memexia-router` checkout in `memexia.json` is wrong | Check `curl ${MEMEXIA_API_URL}/api/v1/health` returns 200; verify the `cd ...memexia-router` path in `memexia.json` exists on this machine |
| Workflow can't find `.archon/mcp/memexia.json` | `worktree.copyFiles: [.archon/mcp]` missing from `.archon/config.yaml` | Add it (template above already includes it) |
| `archon validate workflows archon-brainstorm-to-prd` says "not found" | Archon binary doesn't include the pipeline workflows | Pull latest Archon and rebuild |

---

## Future automation (not yet built)

A planned future enhancement: `archon init pipeline` CLI subcommand that does the per-project setup automatically (copies files, edits gitignore, prompts for `baseBranch`). Until then, the manual three-line copy above is the path. See `docs/specs/prd-pipeline-workflows.md` §9 for the broader pipeline acceptance criteria.
