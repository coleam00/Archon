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
                      "SSE run-prompt returned empty content",
                      "UnknownAiderDeskAgentProfileError",
                      "InvalidAiderDeskModelOverrideError".
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
  validates-against: 4203a00e
---

# AiderDesk ⇄ archon-v2 Bridge

The bridge wires the **archon-v2 engine** (running in a Docker container whose
cwd is a container-only path — `/app`, `/host/projects/<name>` via `:ro` bind
mount) through **AiderDeskProvider.translateProjectDir** (`de175bc`) → the
**AiderDesk REST API** (running on the host at `http://172.18.0.1:24337` via
the Docker bridge gateway) → a **Poe-com hosted model** (selected by the
`<providerId>/<modelId>` value on `modelOverride:` selected at workflow
authoring time, routed by the AiderDesk agent-profile bound at run time) →
the **AiderDesk SSE `run-prompt` stream** → **archon MessageChunks** → the
**web UI message assembly**.

Ten commits constitute the verified working baseline; cite them verbatim —
the test suite (`@archon/providers` AiderDesk: **74 unit tests green**) and
the live round-trip on 2026-08-18 both pin to this set:

| commit      | role                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `bbaeaac`   | **Rule 2 tiebreaker** — picks configured Poe-API runtime when both Poe-API and Poe-Provider are present           |
| `9847d8d`   | **dual-bind** agentProfileId+mainModel pre-run so AiderDesk task has both fields populated                        |
| `de175bc`   | **translateProjectDir** — remap container-only cwd to host-writable dir before talking to AiderDesk               |
| `fc3251c`   | **.env.example mirror** — AIDERDESK_PROJECT_DIR_REMAP is documented in `.env.example` so fresh installs reproduce |
| `7315a791` | **provider split** — ollama exits the aiderdesk `model:` slot; profile-name contract becomes authoritative         |
| `388e25e4` | **bundled-defaults refresh** — capability matrix rebuilt after ollama split + new profile-name tier presets        |
| `91b712c1` | **dag-executor test bootstrap** — register aiderdesk provider for `@archon/workflows` test runs                   |
| `2bae7bf0` | **ollama NDJSON fix** — provider reads `message.content` from `/api/chat`, not legacy `.response`                  |
| `1fac9e3`  | **strict profile-name lookup** — `catalogue.find(a => a.name === requestOptions.model)`, literal-pair rejected     |
| `4203a00e` | **title-gen sanitize** — orchestrator-side guard substitutes clean profile when resolved tier is a stale literal   |

## Routing

| Intent                                                       | Reference                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Install the env / set `.env.example` keys                    | [Setup](#setup)                                                                        |
| First run / canonical smoke probe                            | [E2E probe](#e2e-probe)                                                                |
| Diagnose a failing workflow                                  | [Failure taxonomy](#failure-taxonomy)                                                  |
| `model:` vs `modelOverride:` vs tier-preset vs `mainModel`   | [Profile-name vs model-literal](#profile-name-vs-model-literal-the-three-paths-in-v20) |
| Operator tier preset ↔ the baked image default ↔ user prefs  | [Tier spillover](#tier-spillover-where-the-stale-literal-arrives-from)                 |
| Add a new AiderDesk workflow node                            | [Authoring a new AiderDesk workflow](#authoring-a-new-aiderdesk-workflow)              |
| Extend the provider code (`@archon/providers/aiderdesk`)     | [Provider extension checklist](#provider-extension-checklist)                          |
| Check the canonical commit refs / live verification          | [Commit baseline (verified)](#commit-baseline-verified)                               |

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

**Pre-`1fac9e3` operator configs often look like this** (still in dirty
sandbox home configs as of 2026-08-18):

```yaml
# ----- PRE-1fac9e3 (incorrect post-split) -----
tiers:
  small:
    provider: aiderdesk
    model: ollama/gemma4:8b-8k                            # ← rejected by strict lookup
```

The literal-pair shape `ollama/<id>` was legal in the pre-split era when the
aiderdesk provider answered for ollama directly. Post-`1fac9e3` ollama is its
own provider and **the aiderdesk `model:` slot is now a profile NAME** —
resolved only against the live `/api/agent-profiles` catalog (case-sensitive
exact match). PATCH /api/config/tiers via the engine's UI — see [Tier
spillover](#tier-spillover-where-the-stale-literal-arrives-from).

## E2E probe

The exact bash that produced the live "Hello! … round-trip confirmed …"
response on 2026-08-18. Paste-able verbatim, runs in ~8 s on a warm smoke
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
- the bound **agent-profile** by name — `Poe` is what the `9847d8d` lex-first
  rule picks today and what `bbaeaac` selects on the live host. (Pre-`9847d8d`,
  this line used to spell out the configured `poe/<model>`; with the strict
  profile-name lookup at `1fac9e3`, that's misleading and the contract flipped
  to **profile name wins**.)
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

| Symptom                                                                                          | Cause                                                                                                                                                                                                       | Fix                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dag.node_empty_output` after ~150 s                                                             | projectDir handed to AiderDesk was a **container-only path** (`/app`, `/host/projects/<x>`); AiderDesk on the host can't `mkdir` it → empty SSE                                                                | Set `AIDERDESK_PROJECT_DIR_REMAP` per [Setup](#setup). Rebuild + re-run.                                                                                         |
| `dag.node_empty_output` after ~14 s                                                              | AiderDesk task was created without **`agentProfileId` AND `mainModel` bound** (one or both blank); provider sent a bare POST to `/api/project/tasks`                                                       | Ensure the provider sends BOTH fields via `POST /api/project/tasks/.../update` before `/api/run-prompt` — the **dual-bind** at `9847d8d`. Re-run.                |
| `UnknownAiderDeskAgentProfileError: 'ollama/<id>'` from a workflow node                          | Pre-`1fac9e3` literal-pair `model:` value on the workflow; the strict lookup at `1fac9e3` rejects all `<providerId>/<modelId>` strings. No catalog name matches `ollama/gemma4:8b-8k`                      | Rewrite `model:` to a profile NAME — `Poe`, `Aider`, `Power Tools`, `Inspector`, `Codenomicron`, `Aider with Power Search`. Set `modelOverride:` if a specific inference endpoint is needed. |
| `UnknownAiderDeskAgentProfileError: 'ollama/<id>'` from `service.title-generator`                | Title-gen side-call dispatched on a per-user `remote_agent_user_ai_prefs.tiers` row whose value is a pre-`1fac9e3` literal pair; layered above `.archon/config.yaml`                                          | (a) PATCH the operator home config so `tiers.small.model` is a profile NAME; or (b) wait — the producer-side guard at `4203a00e` will substitute the configured fallback once a clean preset exists. |
| `InvalidAiderDeskModelOverrideError: 'ollama/<unknown>'`                                          | `modelOverride:` is set but the literal is NOT a `<providerId>/<id>` value returned by AiderDesk's live `/api/models` catalog. Curl the catalog to confirm allowed strings                                       | Use a literal that exists in `/api/models` for the chosen profile's `provider`. Cross-check at `provider.dart` line ~605 where the catalog pre-warm fires.         |
| Workflow completes but assistant says Ollama / wrong model                                       | **Rule 2 tiebreaker** picked the Ollama runtime instead of the Poe-API runtime; user requested `poe/<model>` but got `ollama/<something>`                                                                | Re-confirm `assistantConfig.providers.poe.api.baseUrl` and `providerId` in `.archon/config.yaml`. The `bbaeaac` fix requires both fields populated.               |
| `run-prompt returns 0 chunks, no SSE frames` (curl-host direct)                                  | **Stale `taskId`** from a host migration or pruned `.aider-desk/tasks/` cleanup; session-resume hit missing files                                                                                            | Pass a fresh `taskId` (drop the `--task-id` resume) and re-run. Don't delete `.aider-desk/tasks/internal/` — that's AiderDesk-managed.                           |
| `node_counts: failed: 1` for `e2e-deterministic` "uv binary ENOENT"                              | Unrelated to AiderDesk. `oven/bun:1.3.11-slim` base image lacks `uv`. The `e2e-deterministic` workflow uses `script-python` nodes.                                                                          | Install `uv` in the image OR remove the `script-python` node. Out of scope for this skill.                                                                       |
| "MCP Client creation failed … spawn uvx/npx ENOENT" cascade (in `error-<date>.log`)              | AiderDesk's project-scoped MCP spawn path can't find `npx` / `uvx` on the host PATH; harmless for the AiderDesk→Poe round-trip                                                                              | Filter out. The cascade does NOT affect `/api/run-prompt` content; it's the project-scoped MCP init. See [Known noise](#known-noise-to-ignore).                  |
| Provider sends untranslated `cwd` after a recent code change                                     | A new `client.<method>(cwd, …)` call was added without threading `projectDir` (the translated local)                                                                                                        | Inspect the diff for `cwd` literals adjacent to `client.` calls. Replace each with `projectDir`. Add a unit test under `translateProjectDir`'s describe block.  |

## Profile-name vs model-literal: the three paths in v0.9

Post-`1fac9e3` the `provider: aiderdesk` engine signature is strict. Three
explicit paths exist and they are **not interchangeable**.

| Field on workflow YAML or runtime config | Form (`aiderdesk` provider)                            | Resolved against                            | On miss                                              |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------- |
| `model:` <br>(workflow-level default)    | **profile NAME only** — e.g. `Power Tools`, `Poe`      | `GET /api/agent-profiles` (case-sensitive)  | `UnknownAiderDeskAgentProfileError` — hard           |
| `model:` <br>(per-node override)         | Same as above                                          | Same as above                               | Same as above                                        |
| `modelOverride:` <br>(per-node optional) | **`<providerId>/<id>` literal** — e.g. `poe/claude-haiku-4-5` or `ollama/internlm/internlm2.5:7b-8k` | `GET /api/models` (literal exact match)     | `InvalidAiderDeskModelOverrideError` — hard         |
| `tiers.<k>.model` (`.archon/config.yaml`)| **profile NAME only** since `1fac9e3`                   | Same as workflow `model:`                   | Same as above — caught at engine boot validation    |
| `userAiPrefs.tiers.<k>.model` (DB row)   | Has been a literal pair in pre-`1fac9e3` DB rows        | Same as workflow `model:`                   | Caught at orchestrator-agent's `looksLikeStaleAiderDeskLiteral` (`4203a00e`) and substituted by configured fallback |

**Three pre-`1fac9e3` antipatterns** that silently regress today:

1. **Pre-`1fac9e3` workflow `model:` literals.** E.g. `model: poe/minimax-m3`.
   The catalog lookup is exact-name on `Poe`/`Aider`/etc., and `poe/minimax-m3`
   is *not* one of those names. Today these workflows need their model field
   rewritten to profile-name; `modelOverride:` is the only place the
   literal-pair form survives.

2. **Layered per-user DB rows.** `remote_agent_user_ai_prefs.tiers.small =
   { provider: 'aiderdesk', model: 'ollama/gemma4:8b-8k' }` is structurally
   invalid post-`1fac9e3`. The producer-side sanitize at `4203a00e`
   (`orchestrator-agent.ts → resolveTitleModelRequest → looksLikeStaleAiderDeskLiteral`)
   intercepts and substitutes a clean profile, falling back to a warn-only line
   when the configured fallback is itself stale. **Do NOT delete the guard.**

3. **Tier-keyword on workflow nodes referencing `large`/`medium`/`small`.**
   These resolve at `providerProperties.tiers`; if the operator's preset
   carries a literal pair, the looked-up request is stale. PATCH `/api/config/tiers`
   sets the operator home config and is the canonical cure. Verify with
   `GET /api/config` after each PATCH; then `POST /api/conversations/.../message`
   with a non-command scaffold to trigger the title-gen side-call.

**Operator command — canonical sanitize of stale DB rows**:

```bash
docker exec -w /app archon-v2-app-1 gosu appuser \
  bun run packages/core/src/cli/normalize-stale-user-ai-prefs.ts --apply
# dry-run preview: drop the --apply
```

The script prints `refused` and exits 2 when the operator's home config
itself carries a literal pair — this is correct behavior: refuse to mass-rewrite
DB rows using the engine's own stale input as ground truth.

## Tier spillover: where the stale literal arrives from

The `4203a00e` commit ships a producer-side guard in
`packages/core/src/orchestrator/orchestrator-agent.ts`. To use it correctly,
trace which of these surfaces is feeding the stale literal:

| Surface                                        | Source-of-truth file                                | What to inspect                                                                                  | Remediation                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Operator home config (host bind, baked alike)  | `/home/lfontanez/.archon-v2-sandbox/data/config.yaml` (host) <br> ↔ `/.archon/config.yaml` (container bind) | `defaultAssistant`, `assistants`, `tiers.small/medium/large.model`                              | `curl -X PATCH http://localhost:8052/api/config/tiers -d '{tiers:{small:{provider:"aiderdesk",model:"Power Tools"},...}}'` |
| Engine's image-baked config                    | `/app/.archon/config.yaml` (baked at Dockerfile COPY) | same fields; survives `docker compose restart app` only when image is rebuilt                   | Rebuild + `docker compose up -d app`. Authoritative until the operator's bind shadow lands                  |
| Per-user DB row                                | postgres `remote_agent_user_ai_prefs.tiers` row     | per-user `default_model`, `tiers` as `{small:{provider,model},...}`                              | `normalize-stale-user-ai-prefs.ts --apply` after the operator's home config is clean                        |
| AiderDesk-side project-level `settings.json`   | `/home/lfontanez/dev/<project>/.aider-desk/tasks/<id>/settings.json` | `mainModel`, `agentProfileId`, `provider`, `model` per task                                | One-shot re-run after `1fac9e3` lands; the dual-bind (`9847d8d`) corrects the live call but `settings.json` keeps the literal until AiderDesk rewrites it |

**Symptom gate that always tells you which surface is bad**:

```bash
# Engine's view (machine):
curl -s http://localhost:8052/api/config | jq '.config.tiers'

# AiderDesk's view (host):
for f in /home/lfontanez/dev/*/.aider-desk/tasks/*/settings.json; do
  echo "$f: $(jq -r '.mainModel // "null"' "$f")"
done

# Engine's DB:
docker exec archon-v2-postgres-1 psql -U archon -t -A -c \
  'select user_id, default_model, tiers from remote_agent_user_ai_prefs where tiers is not null;'
```

Three different sources of truth; they will drift; the producer-side guard
keeps the engine from poisoning itself when they do.

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
model: Poe        # profile NAME (post-1fac9e3 strict lookup); `Power Tools`, `Aider`, `Inspector`, `Codenomicron` all valid

inputs:
  projectLabel:
    required: false
    default: '(unspecified repo)'
    description: Human label of the repo under review

returns: confirm # unless you add a node returning a structured value

nodes:
  - id: bootstrap
    # Deterministic pre-flight: prove the cwd binding the engine handed us.
    # Without this the assistant response is ungrounded and the profile sometimes
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

  - id: hotter
    # Optional: pin a specific <providerId>/<id> literal at this node only.
    # Use this when you want Poe's logic but a different inference endpoint
    # for this one turn (e.g. a smaller model for a sub-task).
    depends_on: [confirm]
    provider: aiderdesk
    model: Poe
    modelOverride: poe/claude-haiku-4-5
    prompt: |
      Re-run step confirm against the hot path with a cheaper model.
      Return under 80 words.
```

**Rules** (post-`1fac9e3`):

- Always set **workflow-level `model:` to a profile NAME** — verbatim match
  against `/api/agent-profiles`. The pre-`1fac9e3` pattern of
  `model: poe/<x>` is rejected by the strict lookup.
- Use `modelOverride:` on a per-node basis when you want to pin a specific
  `<providerId>/<id>` literal — that is the only place the literal-pair form
  is legal post-split.
- Always include a `bootstrap` bash node that prints `pwd`. The user IS going
  to ask "did the cwd binding survive the container→host translation?" and
  the answer MUST be visible in the assistant message stream.
- Don't add `script-python` nodes unless you know the image has `uv`
  (`oven/bun:1.3.11-slim` does NOT).

## Provider extension checklist

For someone modifying `packages/providers/src/community/aiderdesk/**`:

- [ ] **74 unit tests must pass** after any change. Run `PATH=/home/lfontanez/.bun/bin:$PATH bun --filter @archon/providers test src/community/aiderdesk/`. The suite grew 53 → 61 at `de175bc`, then 61 → 74 across `1fac9e3` + `4203a00e`; never edit provider TS without re-running.
- [ ] **Atomic commit per behavior change.** One commit per logical change. The branch baseline (`dev`) currently has the ten-commit chain in [Commit baseline](#commit-baseline-verified); new changes ride on top.
- [ ] **Commit message format** — match the existing history on `dev`:
  - `feat(aiderdesk): …` for new behavior
  - `fix(aiderdesk): …` for bug fixes (cite the failure/run id)
  - `chore(aiderdesk): …` for non-behavior refactors
  - `docs(aiderdesk): …` for docs-only changes (matching `fc3251c`)
- [ ] **When adding a new env var**, mirror it into `.env.example` in the **same atomic commit** (matching `fc3251c`'s precedent). `.env` is gitignored; without `.env.example`, fresh installs reproduce the original `dag.node_empty_output` symptom.
- [ ] **When adding a new provider capability**, also touch `packages/providers/src/community/aiderdesk/capabilities.ts` — declared capabilities drive routing in the workflow DAG executor's `resolveNodeProviderAndModel`. Declared `false` is safer than over-claimed `true`.
- [ ] **When tightening the catalog lookup** (case-sensitivity, name-only, etc.), bump `metadata.validates-against` in `skills/aiderdesk-archon-bridge/SKILL.md` to the new commit. SKILL readers will see the new pin.
- [ ] **When introducing a new failure type** (especially post-`1fac9e3` profile-name rejection paths), add a row to [Failure taxonomy](#failure-taxonomy) in SKILL.md and a unit test under the appropriate describe block.

**Test counts** — when adding tests under the `translateProjectDir` describe
block or the `profile-name strict lookup` describe block, the new count =
previous + new. The next merge should hold the suite at **≥ 74 tests passing**.

## Known noise to ignore

These entries appear in `~/.config/aider-desk/logs/error-<date>.log` and look
alarming but are unrelated to archon-v2:

- `[ExtensionFetcher] Failed to fetch extensions from loop: Invalid repository URL: loop` — AiderDesk's extension store registers a stub remote called `loop` by default; it always 404s. Pre-existing harmlessness, not from archon.
- `Failed to download AiderDesk update` / `[AutoUpdater] Error during update process` — AiderDesk tries to self-update on launch; harmless if it fails.
- `[ExtensionFetcher] Fetched 50 extension(s) from https://github.com/hotovo/aider-desk/...` — INFORMATIONAL, not an error despite the level field being `info`.
- `[taskId: internal] UnknownAiderDeskAgentProfileError ...` — AiderDesk's `internal` task probing its own catalog on boot. Harmless. The skip rule below catches it.

**Filter rule** — before triaging an `error-<date>.log` entry,
filter on `(taskId != "internal") AND (timestamp ≥ workflow start)`. The
`internal` task is AiderDesk's own manager; entries under it (extension update
failures, MCP-init cascades) are NOT from your workflow.

## Commit baseline (verified)

| commit      | subject                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| `bbaeaac`   | `fix(aiderdesk): Rule 2 tiebreaker picks configured Poe-API runtime`                 |
| `9847d8d`   | `feat(aiderdesk): dual-bind agentProfileId+mainModel pre-run`                        |
| `de175bc`   | `feat(aiderdesk): translate cwd projectDir to host path before talking to AiderDesk` |
| `fc3251c`   | `docs(aiderdesk): mirror AIDERDESK_PROJECT_DIR_REMAP into .env.example`              |
| `7315a791` | `chore(provider): split ollama from aiderdesk, profile-key aiderdesk model`          |
| `388e25e4` | `chore(generate): refresh bundled defaults + capability matrix after ollama split`   |
| `91b712c1` | `fix(workflows): register AiderDesk provider in dag-executor.test.ts bootstrap`       |
| `2bae7bf0` | `fix(ollama): read message.content from /api/chat NDJSON, not legacy .response`       |
| `1fac9e3`  | *(this is the commit that flipped the contract; its subject line falls near          |
|            |  the head of `chore(provider): split ollama from aiderdesk, profile-key aiderdesk model` |
| `4203a00e` | `fix(core): ensure title-gen path resolves to profile names, not stale literal-pairs` |

Poe round-trip verified LIVE on **2026-08-18**:

- **Task id**: `41eb0ed6` (host-side AiderDesk task)
- **Conversation id**: `web-1787010309443-sbmkm0` (orchestration-home codebase)
- **Container image**: `sha256:a8b5d37e710c521469…0858201` (compiled at 23:41:39 UTC)
- **Workflow**: a non-command scaffold `POST /api/conversations/{id}/message` with `message="gamma-roundtrip-probe-2026-08-17-23:43 — say a single short line confirming you received this through the title-gen path. Do not invoke tools."`
- **Bound agent profile**: `Poe` (`agentProfileId: 16059d20-60b9-481a-8685-28cceeb3cfe5`) on the `poe/minimax-m3` runtime
- **State**: `READY_FOR_REVIEW`, **wall-clock duration ≈ 6.251 s** (started 23:45:09, completed 23:45:15)
- **Streamed assistant message**: `Received, my friend — gamma-roundtrip-probe-2026-08-17-23:43, logged through the title-gen path.`
- **Persisted conversation title**: `Gamma Round-Trip Probe Verification`
- **Stderr signature over the post-rebuild window**: 0 `UnknownAiderDeskAgentProfileError`, 0 `level=50` errors, 0 `level=40` warnings (sanitize at `4203a00e` fired **silently**, with the resolved profile name `Power Tools` quietly passing the strict-lookup check)

If these references become stale (new image, new commit chain), update this
section with a fresh round-trip run before shipping the next behavior change.
The `metadata.validates-against` line in this SKILL.md's frontmatter is the
machine-checkable pin: bump it when the baseline moves.

---

_Mirror of this SKILL.md placed at `~/.aider-desk/skills/aiderdesk-archon-bridge/SKILL.md`
so it travels with the AiderDesk home config. The home copy byte-equals this
file at the time of each commit._
