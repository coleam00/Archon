#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--tool amp|claude|codex|test-gpt5.5-codex|ccs-bp] [max_iterations]
#
# Configuration precedence (highest first):
#   1. CLI args / env vars
#   2. ralph-config.yml (next to this script)
#   3. Hardcoded defaults

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/ralph-config.yml"

# Tiny YAML reader for top-level `key: value` lines. Strips inline comments and
# surrounding quotes. Returns nothing if file missing or key absent.
_read_config_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 1
  grep -E "^[[:space:]]*${key}[[:space:]]*:" "$file" 2>/dev/null \
    | head -n 1 \
    | sed -E "s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*//; s/[[:space:]]*#.*$//; s/^[\"']//; s/[\"']$//; s/[[:space:]]+$//"
}

# Defaults (lowest precedence). `tool`, `model`, `reasoning_effort` are REQUIRED
# — left empty so the validation gate below can detect a missing config and fail
# loud instead of silently running with a stale default.
TOOL=""
MAX_ITERATIONS=10
MODEL=""
REASONING_EFFORT=""

# Config overrides (middle precedence)
_cfg_tool="$(_read_config_value tool "$CONFIG_FILE" || true)"
[ -n "$_cfg_tool" ] && TOOL="$_cfg_tool"
_cfg_max_iter="$(_read_config_value max_iterations "$CONFIG_FILE" || true)"
[[ "$_cfg_max_iter" =~ ^[0-9]+$ ]] && MAX_ITERATIONS="$_cfg_max_iter"
_cfg_model="$(_read_config_value model "$CONFIG_FILE" || true)"
[ -n "$_cfg_model" ] && MODEL="$_cfg_model"
_cfg_effort="$(_read_config_value reasoning_effort "$CONFIG_FILE" || true)"
[ -n "$_cfg_effort" ] && REASONING_EFFORT="$_cfg_effort"

# Export reasoning effort so wrappers / settings hooks can pick it up if the
# underlying CLI doesn't expose a stable flag.
export REASONING_EFFORT

# CLI args (highest precedence)
while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      fi
      shift
      ;;
  esac
done

# Required-config gate — `tool`, `model`, `reasoning_effort` must all be set
# via ralph-config.yml or CLI override. Empty values produce a single error
# listing every missing key so the user fixes them in one pass.
_missing=()
[ -z "$TOOL" ]             && _missing+=("tool")
[ -z "$MODEL" ]            && _missing+=("model")
[ -z "$REASONING_EFFORT" ] && _missing+=("reasoning_effort")
if [ ${#_missing[@]} -gt 0 ]; then
  {
    echo "[ralph] missing required config: ${_missing[*]}"
    echo "  set them in $CONFIG_FILE (or pass --tool on the CLI)"
  } >&2
  exit 3
fi

# Patch C — consent gate (spec-kit Ralph Loop v2; not in upstream)
# Three opt-in paths: env var, sentinel file, or ralph-config.yml flag.
_consent_file="$SCRIPT_DIR/.consent"
_consent_cfg="$(_read_config_value ralph_i_understand_dangerous "$CONFIG_FILE" || true)"
if [ "${RALPH_I_UNDERSTAND_DANGEROUS:-0}" != "1" ] \
   && [ ! -f "$_consent_file" ] \
   && [ "$_consent_cfg" != "1" ]; then
  {
    echo "[ralph] consent required — this script runs the selected tool with permission bypass enabled."
    echo "Pick ONE to proceed:"
    echo "  export RALPH_I_UNDERSTAND_DANGEROUS=1"
    echo "  touch .specify/extensions/ralph-loop/.consent"
    echo "  set 'ralph_i_understand_dangerous: 1' in .specify/extensions/ralph-loop/ralph-config.yml"
  } >&2
  exit 4
fi

# Resolution precedence:
#   1. $RALPH_PRD_FILE / $RALPH_PROGRESS_FILE   (env override — wins for tests + ad-hoc runs)
#   2. .specify/feature.json → ralph_prd_file / ralph_progress_file
#      (set by /speckit.ralph-loop.tasks-to-ralph; relative paths resolve against repo root)
#   3. $SCRIPT_DIR/prd.json / progress.txt      (legacy fallback)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
FEATURE_JSON="$REPO_ROOT/.specify/feature.json"

_resolve_from_feature_json() {
  local key="$1"
  [ -f "$FEATURE_JSON" ] || return 1
  local v
  v=$(jq -r --arg k "$key" '.[$k] // empty' "$FEATURE_JSON" 2>/dev/null)
  [ -n "$v" ] || return 1
  case "$v" in
    /*) printf '%s' "$v" ;;
    *)  printf '%s/%s' "$REPO_ROOT" "$v" ;;
  esac
}

PRD_FILE="${RALPH_PRD_FILE:-$(_resolve_from_feature_json ralph_prd_file || echo "$SCRIPT_DIR/prd.json")}"
PROGRESS_FILE="${RALPH_PROGRESS_FILE:-$(_resolve_from_feature_json ralph_progress_file || echo "$SCRIPT_DIR/progress.txt")}"

# Export so the spawned tool (Claude / amp) and AGENT.md instructions see them.
export RALPH_PRD_FILE="$PRD_FILE"
export RALPH_PROGRESS_FILE="$PROGRESS_FILE"

ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")

  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"

    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"

    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

echo "Starting Ralph - Tool: $TOOL - Max iterations: $MAX_ITERATIONS"
echo "  model: $MODEL  reasoning_effort: $REASONING_EFFORT"

# Snapshot total batches ONCE before the loop. Recomputing inside the loop
# made the "of N" denominator shrink each iteration (batches flip completed:true)
# and looked like the total was decreasing.
TOTAL_BATCHES=$(jq -r '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "?")
[ -z "$TOTAL_BATCHES" ] && TOTAL_BATCHES="?"

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $TOTAL_BATCHES (max $MAX_ITERATIONS) ($TOOL)"
  echo "==============================================================="

  # Run the selected tool with the ralph prompt.
  # Pattern: tee output to a tempfile (live progress on terminal + captured copy on disk).
  # Why not `OUTPUT=$(... | tee /dev/stderr)` — that capture-and-mirror trick blocks
  # forever if any child of the agent keeps stdout open past "done", because $()
  # only returns when every writer in the pipeline closes. The tempfile decoupling
  # means bash advances the moment the agent process itself exits.
  ITER_LOG=$(mktemp -t ralph-iter.XXXXXX)

  # Live event formatter for Claude Code stream-json output.
  # Compact amp-style: one line per action — `label: "content..."` (truncated).
  # Tool-result echoes (user turns) are hidden to keep the feed scan-friendly;
  # raw JSONL is still captured for debugging via $ITER_LOG.json.
  _claude_stream_formatter='
    def oneline: (. // "") | tostring | gsub("\n"; " ") | gsub("\\s+"; " ");
    def trunc(n): if (. | length) > n then .[0:n] + "..." else . end;
    def fmt(tag; content): "  " + tag + ": \"" + (content | oneline | trunc(60)) + "\"";

    . as $e |
    if ($e.type // "") == "system" and ($e.subtype // "") == "init" then
      fmt("session"; (($e.session_id // "?") | tostring | .[0:8]) + " (" + ($e.model // "?") + ")")
    elif $e.type == "assistant" then
      ($e.message.content // []) | .[] |
        if .type == "text" then
          fmt("message"; .text // "")
        elif .type == "tool_use" then
          .name as $tool | (.input // {}) as $in |
          if $tool == "Bash" then fmt("terminal"; $in.command // "")
          elif $tool == "Read" then fmt("read_file"; $in.file_path // "")
          elif $tool == "Edit" then fmt("patch"; $in.file_path // "")
          elif $tool == "MultiEdit" then fmt("patch"; ($in.file_path // "") + " (×" + (($in.edits // [] | length) | tostring) + ")")
          elif $tool == "Write" then fmt("write_file"; $in.file_path // "")
          elif $tool == "Grep" then fmt("search_files"; ($in.pattern // "") + (if $in.path then " in " + $in.path else "" end))
          elif $tool == "Glob" then fmt("search_files"; $in.pattern // "")
          elif $tool == "Task" or $tool == "Agent" then fmt("agent"; ($in.subagent_type // "?") + ": " + ($in.description // ""))
          elif $tool == "TodoWrite" then fmt("todo"; "updating " + (($in.todos // [] | length) | tostring) + " task(s)")
          elif $tool == "WebFetch" then fmt("fetch_url"; $in.url // "")
          elif $tool == "WebSearch" then fmt("search_web"; $in.query // "")
          elif $tool == "Skill" then
            fmt("skill"; ($in.skill // "?") + (if ($in.args // "") != "" then " " + $in.args else "" end))
          elif ($tool | startswith("mcp__")) then
            ($tool | sub("^mcp__"; "") | sub("__"; "/")) as $st |
            fmt("mcp"; $st + " " + ($in | tojson))
          else fmt($tool; ($in | tojson))
          end
        else empty end
    elif $e.type == "user" then empty
    elif $e.type == "result" then
      fmt("done"; "$" + ((.total_cost_usd // .cost_usd // 0) | tostring)
        + " · " + ((.duration_ms // 0) | tostring) + "ms"
        + (if .num_turns then " · " + (.num_turns | tostring) + "t" else "" end))
    else empty end
  '

  # Runs `claude` (or a ccs wrapper) in stream-json mode, prints events live,
  # captures raw JSONL for later analysis, and writes concatenated assistant
  # text into $ITER_LOG so the existing <promise>COMPLETE</promise> grep works.
  _run_claude_stream() {
    local iter_json="${ITER_LOG}.json"
    "$@" --dangerously-skip-permissions --print --verbose \
        --model "$MODEL" \
        --output-format stream-json --input-format text \
        < "$SCRIPT_DIR/AGENT.md" \
      | tee "$iter_json" \
      | jq -r --unbuffered "$_claude_stream_formatter" || true
    jq -sr '[.[]? | select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text] | join("\n")' \
        "$iter_json" > "$ITER_LOG" 2>/dev/null || cp "$iter_json" "$ITER_LOG"
    rm -f "$iter_json"
  }

  # Live event formatter for `codex exec --json` JSONL output.
  # Compact amp-style — same vocabulary as the claude formatter so the two
  # tools render identically inside the same loop. Command-output echoes are
  # hidden; raw JSONL is captured for debugging via $ITER_LOG.json.
  _codex_stream_formatter='
    def oneline: (. // "") | tostring | gsub("\n"; " ") | gsub("\\s+"; " ");
    def trunc(n): if (. | length) > n then .[0:n] + "..." else . end;
    def fmt(tag; content): "  " + tag + ": \"" + (content | oneline | trunc(60)) + "\"";

    . as $e |
    if $e.type == "thread.started" then
      fmt("thread"; ($e.thread_id // "?") | tostring | .[0:8])
    elif $e.type == "turn.started" then empty
    elif $e.type == "item.started" then
      ($e.item // {}) as $it |
      if $it.type == "command_execution" then
        ($it.command // "") as $cmd |
        if ($cmd | test("apply_patch")) then fmt("patch"; $cmd)
        else fmt("terminal"; $cmd) end
      elif $it.type == "file_change" or $it.type == "patch_apply" then
        fmt("patch"; ($it.path // $it.file_path // "") | tostring)
      elif $it.type == "mcp_tool_call" then
        ((($it.server // "?") | tostring) + "/" + (($it.tool // "?") | tostring)) as $st |
        ($it.arguments // $it.args // {}) as $a |
        fmt("mcp"; $st + (if ($a | type) == "object" and ($a | length) > 0 then " " + ($a | tojson) else "" end))
      elif $it.type == "web_search" then
        fmt("search_web"; $it.query // $it.q // "")
      elif $it.type == "plan_update" then
        ($it.plan // $it.items // $it.todos // []) as $p |
        fmt("todo"; "updating " + (($p | length) | tostring) + " task(s)")
      elif ($it.type // "" | test("skill")) then
        fmt("skill"; ($it.name // $it.skill // $it.skill_name // "?")
          + (if $it.arguments then " " + ($it.arguments | tojson) else "" end))
      elif $it.type == "reasoning" then empty
      else fmt($it.type // "item"; ($it | tojson))
      end
    elif $e.type == "item.completed" then
      ($e.item // {}) as $it |
      if $it.type == "agent_message" then fmt("message"; $it.text // "")
      else empty end
    elif $e.type == "turn.completed" then
      ($e.usage // {}) as $u |
      fmt("done"; "in=" + (($u.input_tokens // 0) | tostring)
        + " out=" + (($u.output_tokens // 0) | tostring)
        + (if ($u.cached_input_tokens // 0) > 0
            then " cached=" + (($u.cached_input_tokens) | tostring) else "" end))
    elif $e.type == "error" or $e.type == "turn.failed" then
      fmt("error"; $e.message // ($e | tojson))
    else empty end
  '

  # Runs `codex exec` with permission bypass + JSONL streaming, prints events
  # live, captures raw JSONL, and writes concatenated agent_message text into
  # $ITER_LOG so the existing <promise>COMPLETE</promise> grep works.
  _run_codex_stream() {
    local iter_json="${ITER_LOG}.json"
    codex exec --json \
        -m "$MODEL" \
        -c "model_reasoning_effort=\"$REASONING_EFFORT\"" \
        --dangerously-bypass-approvals-and-sandbox \
        --skip-git-repo-check \
        - \
        < "$SCRIPT_DIR/AGENT.md" \
      | tee "$iter_json" \
      | jq -r --unbuffered "$_codex_stream_formatter" || true
    jq -sr '[.[]? | select(.type=="item.completed") | .item // {} | select(.type=="agent_message") | .text // ""] | join("\n")' \
        "$iter_json" > "$ITER_LOG" 2>/dev/null || cp "$iter_json" "$ITER_LOG"
    rm -f "$iter_json"
  }

  if [[ "$TOOL" == "amp" ]]; then
    amp --dangerously-allow-all < "$SCRIPT_DIR/AGENT.md" 2>&1 | tee "$ITER_LOG" || true
  elif [[ "$TOOL" == "claude" ]]; then
    _run_claude_stream claude
  elif [[ "$TOOL" == "codex" ]]; then
    _run_codex_stream
  elif [[ "$TOOL" == "test-gpt5.5-codex" ]]; then
    _run_claude_stream ccs test-gpt5.5-codex
  elif [[ "$TOOL" == "ccs-bp" ]]; then
    _run_claude_stream ccs bp
  else
    echo "Unsupported tool: $TOOL" >&2
    rm -f "$ITER_LOG"
    exit 2
  fi
  OUTPUT=$(cat "$ITER_LOG")
  rm -f "$ITER_LOG"

  # Check for completion signal — must be a STANDALONE line near the end of output.
  # Why anchored + tail: the agent often quotes the token in explanatory prose
  # ("not emitting `<promise>COMPLETE</promise>` yet, more work ahead"). A loose
  # substring grep treats that as completion and exits prematurely (bug repro:
  # iteration 9 of 13 stopped early). Protocol contract is "reply with the
  # token" — it's a terminal signal on its own line, not embedded prose.
  if printf '%s\n' "$OUTPUT" | tail -n 20 | grep -qE '^[[:space:]]*<promise>COMPLETE</promise>[[:space:]]*$'; then
    echo ""
    echo "  Ralph completed all tasks!"
    echo "  Completed at iteration $i of $MAX_ITERATIONS"
    exit 0
  fi
  # Patch B (v3 nested schema): exit when every batch has completed:true.
  # Backstop: the [completed] flag is denormalized — if the agent forgets to
  # flip it but flips every task.passes:true, fall through to the deeper
  # check so we still exit cleanly.
  if jq -e '[.userStories[] | select(.completed==false)] | length == 0' "$PRD_FILE" >/dev/null 2>&1; then
      echo "[ralph] all userStories completed:true — exiting"; exit 0
  fi
  if jq -e '[.userStories[].tasks[]? | select(.passes==false)] | length == 0' "$PRD_FILE" >/dev/null 2>&1; then
      echo "[ralph] all tasks passes:true — exiting"; exit 0
  fi

  echo "  Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
