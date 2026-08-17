---
name: aiderdesk-archon-bridge
description: |
  Use when: User wants to run, diagnose, or extend a workflow that
            routes the archon-v2 engine through AiderDesk's REST API
            to Poe-com hosted models (e.g. poe/minimax-m3, poe/claude-sonnet
            via the AiderDesk `poe` provider).
  Triggers (run):     "run aiderdesk workflow", "smoke test",
                      "aiderdesk-smoke-test", "aiderdesk-e2e-demo",
                      "Poe round-trip via archon",
                      "fire workflow against orchestration-home".
  Triggers (diagnose): "the last aiderdesk run failed",
                      "dag.node_empty_output",
                      "AiderDesk returned empty content",
                      "JavaScript Error in AiderDesk main process",
                      "EACCES mkdir /app or /host/...",
                      "MCP Client creation failed spawn uvx/npx ENOENT cascade",
                      "translateProjectDir not working",
                      "agentProfileId not bound",
                      "SSE run-prompt returned empty content".
  Triggers (extend):  "add a workflow that talks to AiderDesk",
                      "add a new aiderdesk provider option",
                      "tier preset for aiderdesk",
                      "wire AiderDesk task hooks".
  Capability: Diagnoses the engine⇄AiderDesk pipeline, runs the canonical
              translateProjectDir-baked smoke probe, and authors atomic commits
              to the @archon/providers/aiderdesk workspace following the
              dual-bind + projectDir-translation contract.
  NOT for: General archon CLI workflow authoring (use the broader `archon`
           skill), or debugging the AiderDesk GUI itself (use AiderDesk's own
           diagnostics).
argument-hint: "<workflow> [task-id or 'last']"
metadata:
  validates-against: fc3251c
---

# AiderDesk ⇄ archon-v2 Bridge

The bridge wires the **archon-v2 engine** (running in a Docker container whose
cwd is a container-only path — `/app`, `/host/projects/<name>` via `:ro` bind
mount) through **AiderDeskProvider.translateProjectDir** (`de175bc`) → the
**AiderDesk REST API** (running on the host at `http://172.18.0.1:24337` via
the Docker bridge gateway) → a **Poe-com hosted model** (selected by
`poe/<model>` in workflow YAML) → the **AiderDesk SSE `run-prompt` stream** →
**archon MessageChunks** → the **web UI message assembly**.

Four commits are the verified working baseline; cite them verbatim — the test
suite (`@archon/providers` AiderDesk: 61 unit tests green) and the live
round-trip on 2026-08-17 both pin to this set:

| commit    | role                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `bbaeaac` | **Rule 2 tiebreaker** — picks configured Poe-API runtime when both Poe-API and Poe-Provider are present           |
| `9847d8d` | **dual-bind** agentProfileId+mainModel pre-run so AiderDesk task has both fields populated                        |
| `de175bc` | **translateProjectDir** — remap container-only cwd to host-writable dir before talking to AiderDesk               |
| `fc3251c` | **.env.example mirror** — AIDERDESK_PROJECT_DIR_REMAP is documented in `.env.example` so fresh installs reproduce |

## Routing

| Intent                                                   | Reference                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Install the env / set `.env.example` keys                | [Setup](#setup)                                                           |
| First run / canonical smoke probe                        | [E2E probe](#e2e-probe)                                                   |
| Diagnose a failing workflow                              | [Failure taxonomy](#failure-taxonomy)                                     |
| Add a new AiderDesk workflow node                        | [Authoring a new AiderDesk workflow](#authoring-a-new-aiderdesk-workflow) |
| Extend the provider code (`@archon/providers/aiderdesk`) | [Provider extension checklist](#provider-extension-checklist)             |
| Check the canonical commit refs / live verification      | [Commit baseline](#commit-baseline-verified)                              |

> The routing table is the **spec**. The bodies inline below are the **first
> edition**. Each section is small and pasteable; link to the source file for
> deeper detail.

## Setup

The four-line `.env` shape the operator MUST hit before this skill is usable.
(An historical AIDERDESK_API_URL lives in `.env` from commit `fc3251c`; `.env`
is gitignored, `.env.example` is the tracked source-of-truth.)

```bash
# --- AiderDesk bridge (see .archon/workflows/defaults/aiderdesk-smoke-test.yaml) ---
AIDERDESK_API_URL=http://172.18.0.1:24337
AIDERDESK_PROJECT_DIR_REMAP=[{"from":"^/app($|/)", "to":"/home/lfontanez/dev/archon-v2"}, {"from":"^/host/projects/", "to":"/home/lfontanez/dev/"}]
ANTHROPIC_API_KEY=                         # not used by the AiderDesk path itself, but the engine reads it for tier resolution
CLAUDE_USE_GLOBAL_AUTH=false               # engine-level escape hatch; keep false unless operator-level override required
```

**DO NOT quote the JSON.** Both lines work: object form `{"<regex>":"<path>"}`
(longest-key wins) AND array form `[{"from":"<regex>","to":"<path>"}, ...]`
(declaration-order first-match wins). The `.env` line above uses array form
because it has two prefix rules; object form requires the JSON-object line
literal in shell which can squeeze through a quoted shell env badly.

**Rebuild after any provider code change**:

```bash
cd /home/lfontanez/dev/archon-v2
docker compose --profile with-db build app
docker compose --profile with-db up -d   # recreates archon-v2-app-1 (restart: "no")
```

After any edit under `packages/providers/src/community/aiderdesk/**`, the docker
image MUST be rebuilt before the running container sees it. The container's
`provider.ts` is baked in at image-build time; `process.env` only carries
env-level config, NOT source.

## E2E probe

The exact bash that produced the live "Hello! … round-trip confirmed …"
response on 2026-08-17. Paste-able verbatim, runs in ~8 s on a warm smoke
run. The codebase id is for **`orchestration-home`** — a folder-codebase whose
host-realm path is `/home/lfontanez/dev/orchestration-home` and whose
container-realm default_cwd is `/host/projects/orchestration-home`.

```bash
# 1. Bind a conversation to the orchestration-home codebase
CONV=$(curl -s -X POST http://localhost:8052/api/conversations \
  -H 'Content-Type: application/json' \
  -d '{"codebaseId":"86216155-e14f-412a-8f38-fe03b8f41274"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('conversationId'))")

# 2. Fire the smoke test
curl -s -X POST http://localhost:8052/api/workflows/aiderdesk-smoke-test/run \
  -H 'Content-Type: application/json' \
  -d "{\"conversationId\":\"$CONV\",\"message\":\"smoke\"}"

# 3. Poll for the assistant response (Poe round-trip marker present in <8 s)
sleep 8
curl -s "http://localhost:8052/api/conversations/$CONV/messages" | tail -20
```

**PASS signature** — the last assistant message MUST contain:

- `Hello! … round-trip confirmed …` (assistant greeting)
- the configured `poe/<model>` model name (e.g. `poe/minimax-m3`) — verifies
  the **Rule 2 tiebreaker** (`bbaeaac`) and the **dual-bind** (`9847d8d`).
- a reference to the cwd (`/host/projects/orchestration-home`) — verifies the
  agent saw the bash pre-step's `pwd` output.

**Host-side writable check** — the remap landed on a host-writable path iff
AiderDesk mkdired its task bookkeeping. After any successful run:

```bash
ls -la /home/lfontanez/dev/orchestration-home/.aider-desk/tasks/<taskId>/
# expect: settings.json, context.json, .aider.chat.history.md
# mtimes within the past few seconds → fresh task was created on host
```

If the `.aider-desk/tasks/` directory on the host is missing or its mtimes are
NOT within the run window, the remap DID NOT fire and the run went through with
a container-only cwd. See [Failure taxonomy](#failure-taxonomy) row 1.

## Failure taxonomy

| Symptom                                                                             | Cause                                                                                                                                                                    | Fix                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dag.node_empty_output` after ~150 s                                                | projectDir handed to AiderDesk was a **container-only path** (`/app`, `/host/projects/<x>`); AiderDesk on the host can't `mkdir` it → empty SSE                          | Set `AIDERDESK_PROJECT_DIR_REMAP` per [Setup](#setup). Rebuild + re-run.                                                                                       |
| `dag.node_empty_output` after ~14 s                                                 | AiderDesk task was created without **`agentProfileId` AND `mainModel` bound** (one or both blank); provider sent a bare POST to `/api/project/tasks`                     | Ensure the provider sends BOTH fields via `POST /api/project/tasks/.../update` before `/api/run-prompt` — the **dual-bind** at `9847d8d`. Re-run.              |
| "JavaScript Error in AiderDesk main process" dialog (AiderDesk GUI)                 | AiderDesk's Node caught an uncaughtException on the **main process** (renderer-surfaceable). 99% of cases in this environment: `mkdir <projectDir>` failed with `EACCES` | Check `~/.config/aider-desk/logs/error-<today>.log` for the `mkdir` line. Route as the row above.                                                              |
| Workflow completes but assistant says Ollama / wrong model                          | **Rule 2 tiebreaker** picked the Ollama runtime instead of the Poe-API runtime; user requested `poe/<model>` but got `ollama/<something>`                                | Re-confirm `assistantConfig.providers.poe.api.baseUrl` and `providerId` in `.archon/config.yaml`. The `bbaeaac` fix requires both fields populated.            |
| `run-prompt returns 0 chunks, no SSE frames` (curl-host direct)                     | **Stale `taskId`** from a host migration or pruned `.aider-desk/tasks/` cleanup; session-resume hit missing files                                                        | Pass a fresh `taskId` (drop the `--task-id` resume) and re-run. Don't delete `.aider-desk/tasks/internal/` — that's AiderDesk-managed.                         |
| `node_counts: failed: 1` for `e2e-deterministic` "uv binary ENOENT"                 | Unrelated to AiderDesk. `oven/bun:1.3.11-slim` base image lacks `uv`. The `e2e-deterministic` workflow uses `script-python` nodes.                                       | Install `uv` in the image OR remove the `script-python` node. Out of scope for this skill.                                                                     |
| "MCP Client creation failed … spawn uvx/npx ENOENT" cascade (in `error-<date>.log`) | AiderDesk's project-scoped MCP spawn path can't find `npx` / `uvx` on the host PATH; harmless for the AiderDesk→Poe round-trip                                           | Filter out. The cascade does NOT affect `/api/run-prompt` content; it's the project-scoped MCP init. See [Known noise](#known-noise-to-ignore).                |
| Provider sends untranslated `cwd` after a recent code change                        | A new `client.<method>(cwd, …)` call was added without threading `projectDir` (the translated local)                                                                     | Inspect the diff for `cwd` literals adjacent to `client.` calls. Replace each with `projectDir`. Add a unit test under `translateProjectDir`'s describe block. |

## translateProjectDir contract

The seam at `packages/providers/src/community/aiderdesk/provider.ts:sendQuery`
step **1a** is the ONE place the cwd is rewritten. Four rules, deterministic:

1. **Precedence** (top-down highest):
   - `requestOptions.env.AIDERDESK_PROJECT_DIR_REMAP` _(per-codebase, injected via envVars at engine boundary)_
   - `process.env.AIDERDESK_PROJECT_DIR_REMAP` _(host-level)_
   - `assistantConfig.projectDirRemap` _(operator hard pin in `.archon/config.yaml`)_
   - identity — return `cwd` untouched.
2. **JSON shapes** — both accepted on every surface:
   - Object form `{"<containerRegex>": "<hostPath>"}` — **longest-key wins** (stable insertion-order tiebreak).
   - Array form `[{"from": "<regex>", "to": "<path>"}, ...]` — **declaration-order first-match wins**.
3. **Malformed JSON → identity, never crash**. The provider emits **exactly one** `system` chunk explaining the malformed JSON and supported shapes over the SSE stream, then continues with the un-translated `cwd`. The workflow does NOT abort.
4. **Log marker** — `log.debug({ from, to, source }, 'aiderdesk.projectDir_remapped')` fires whenever a remap applies. `source` is one of `requestOptions.env` / `process.env` / `assistantConfig` / `identity`.

The `projectDir` local replaces `cwd` everywhere it is forwarded to AiderDesk:
`client.createTask`, `client.loadTask`, `client.updateTask`,
`runPromptStream({ projectDir })`. No `client.<method>(cwd, …)` literal should
survive in `provider.ts` after the `de175bc` reshuffle — grep verifies:

```bash
grep -nE 'client\.[a-zA-Z]+\(cwd' packages/providers/src/community/aiderdesk/provider.ts
# expect: zero hits
```

## Authoring a new AiderDesk workflow

The canonical boilerplate lives at
`/home/lfontanez/dev/archon-v2/.archon/workflows/defaults/aiderdesk-smoke-test.yaml`.
Reproduced here for copy-paste:

```yaml
name: <workflow-name>
description: <one-liner — say what the workflow proves, not what it does>
provider: aiderdesk
model: poe/<poe-hosted-model-id> # e.g. poe/minimax-m3 (fast smoke), poe/claude-sonnet (prod)

inputs:
  projectLabel:
    required: false
    default: '(unspecified repo)'
    description: Human label of the repo under review

returns: confirm # unless you add a node returning a structured value

nodes:
  - id: bootstrap
    # Deterministic pre-flight: prove the cwd binding the engine handed us.
    # Without this the assistant response is ungrounded and Poe sometimes
    # hallucinates the path.
    bash: |
      echo "=== CWD binding confirmation ==="
      echo "pwd  = $(pwd)"
      echo "=== Top-level files ==="
      ls -1 | head -20

  - id: confirm
    depends_on: [bootstrap]
    prompt: |
      You are running against $inputs.projectLabel.
      The bash pre-step confirmed the cwd and listed the top-level entries:

      ---
      $bootstrap.output
      ---

      <your actual prompt here, keep under 200 words for fast demos>
```

**Rules**:

- Always specify `provider: aiderdesk` AND `model: poe/...` at the top-level
  (workflow-scoped defaults). The engine's tier resolver falls back to these
  when per-node `provider`/`model` are absent.
- Always include a `bootstrap` bash node that prints `pwd`. The user IS going
  to ask "did the cwd binding survive the container→host translation?" and
  the answer MUST be visible in the assistant message stream.
- Don't add `script-python` nodes unless you know the image has `uv`
  (`oven/bun:1.3.11-slim` does NOT).

## Provider extension checklist

For someone modifying `packages/providers/src/community/aiderdesk/**`:

- [ ] **61 unit tests must pass** after any change. Run `bun --filter @archon/providers test src/community/aiderdesk/`. The number grew from 53 → 61 with the `translateProjectDir` describe block; never edit provider TS without re-running the suite.
- [ ] **Atomic commit per behavior change.** One commit per logical change. The branch baseline (`dev`) currently has the four-commit chain `bbaeaac → 9847d8d → de175bc → fc3251c`; new changes ride on top.
- [ ] **Commit message format** — match the existing history on `dev`:
  - `feat(aiderdesk): …` for new behavior
  - `fix(aiderdesk): …` for bug fixes (cite the failure/run id)
  - `chore(aiderdesk): …` for non-behavior refactors
  - `docs(aiderdesk): …` for docs-only changes (matching `fc3251c`)
- [ ] **When adding a new env var**, mirror it into `.env.example` in the **same atomic commit** (matching `fc3251c`'s precedent). `.env` is gitignored; without `.env.example`, fresh installs reproduce the original `dag.node_empty_output` symptom.
- [ ] **When adding a new provider capability**, also touch `packages/providers/src/community/aiderdesk/capabilities.ts` — declared capabilities drive routing in the workflow DAG executor's `resolveNodeProviderAndModel`. Declared `false` is safer than over-claimed `true`.

**Test counts** — when adding tests under the `translateProjectDir` describe
block, the new count = previous + new. The next merge should hold the suite to
**≥ 61 tests passing**.

## Known noise to ignore

These entries appear in `~/.config/aider-desk/logs/error-<date>.log` and look
alarming but are unrelated to archon-v2:

- `[ExtensionFetcher] Failed to fetch extensions from loop: Invalid repository URL: loop` — AiderDesk's extension store registers a stub remote called `loop` by default; it always 404s. Pre-existing harmlessness, not from archon.
- `Failed to download AiderDesk update` / `[AutoUpdater] Error during update process` — AiderDesk tries to self-update on launch; harmless if it fails.
- `[ExtensionFetcher] Fetched 50 extension(s) from https://github.com/hotovo/aider-desk/...` — INFORMATIONAL, not an error despite the level field being `info`.

**Filter rule** — before triaging an `error-<date>.log` entry,
filter on `(taskId != "internal") AND (timestamp ≥ workflow start)`. The
`internal` task is AiderDesk's own manager; entries under it (extension update
failures, MCP-init cascades) are NOT from your workflow.

## Commit baseline (verified)

| commit    | subject                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| `bbaeaac` | `fix(aiderdesk): Rule 2 tiebreaker picks configured Poe-API runtime`                 |
| `9847d8d` | `feat(aiderdesk): dual-bind agentProfileId+mainModel pre-run`                        |
| `de175bc` | `feat(aiderdesk): translate cwd projectDir to host path before talking to AiderDesk` |
| `fc3251c` | `docs(aiderdesk): mirror AIDERDESK_PROJECT_DIR_REMAP into .env.example`              |

Poe round-trip verified LIVE on **2026-08-17**:

- **Run id**: `983ca526-2ba2-4fb6-bd23-99a032394634`
- **Conversation id**: `web-1786972342135-p7j8mj`
- **Container image**: `2b823c9004b5…f2958a` (sha256 prefix; AiderDesk wrote `.aider-desk/tasks/85c15db0/` on host as proof of remap firing)
- **Workflow**: `aiderdesk-smoke-test` (`poe/minimax-m3`)
- **Assistant message**: `Hello! Engine → AiderDesk → poe provider round-trip confirmed (poe/minimax-m3). Ready to assist with <projectLabel> at /host/projects/orchestration-home.`

If these references become stale (new image, new commit chain), update this
section with a fresh round-trip run before shipping the next behavior change.
The `metadata.validates-against` line in this SKILL.md's frontmatter is the
machine-checkable pin: bump it when the baseline moves.

---

_Mirror of this SKILL.md placed at `~/.aider-desk/skills/aiderdesk-archon-bridge/SKILL.md`
so it travels with the AiderDesk home config. The home copy byte-equals this
file at the time of each commit._
