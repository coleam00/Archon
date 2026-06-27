# Ralph Driver Interface Contract

## Overview

The Ralph loop loads a platform driver by sourcing `ralph/drivers/${PLATFORM_DRIVER}.sh`
inside `load_platform_driver()` (`ralph_loop.sh` line 296). The `PLATFORM_DRIVER` variable
defaults to `"claude-code"` and can be overridden via `.ralphrc`.

After sourcing, `ralph_loop.sh` immediately calls three functions to populate core globals:

1. `driver_valid_tools` -- populates `VALID_TOOL_PATTERNS`
2. `driver_cli_binary` -- stored in `CLAUDE_CODE_CMD`
3. `driver_display_name` -- stored in `DRIVER_DISPLAY_NAME`

**File naming convention:** `${PLATFORM_DRIVER}.sh` (e.g., `claude-code.sh`, `codex.sh`).

**Scope:** This documents the sourceable driver contract used by `ralph_loop.sh`. Helper
scripts like `cursor-agent-wrapper.sh` are out of scope.

**Calling conventions:**

- Data is returned via stdout (`echo`).
- Booleans are returned via exit status (`0` = true, `1` = false).
- Some functions mutate global arrays as side effects.

---

## Required Hooks

Called unconditionally by `ralph_loop.sh` with no `declare -F` guard or default stub.
Omitting any of these will break the loop at runtime.

### `driver_name()`

```bash
driver_name()
```

No arguments. Echo a short lowercase identifier (e.g., `"claude-code"`, `"codex"`).
Used at line 2382 to gate platform-specific logic.

### `driver_display_name()`

```bash
driver_display_name()
```

No arguments. Echo a human-readable name (e.g., `"Claude Code"`, `"OpenAI Codex"`).
Stored in `DRIVER_DISPLAY_NAME`, used in log messages and tmux pane titles.

### `driver_cli_binary()`

```bash
driver_cli_binary()
```

No arguments. Echo the CLI executable name or resolved path (e.g., `"claude"`, `"codex"`).
Stored in `CLAUDE_CODE_CMD`. Most drivers return a static string; cursor resolves
dynamically.

### `driver_valid_tools()`

```bash
driver_valid_tools()
```

No arguments. Must populate the global `VALID_TOOL_PATTERNS` array with the platform's
recognized tool name patterns. Used by `validate_allowed_tools()`.

### `driver_build_command(prompt_file, loop_context, session_id)`

```bash
driver_build_command "$prompt_file" "$loop_context" "$session_id"
```

Three string arguments:

| Argument          | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `$1` prompt_file  | Path to the prompt file (e.g., `.ralph/PROMPT.md`)   |
| `$2` loop_context | Context string for session continuity (may be empty) |
| `$3` session_id   | Session ID for resume (empty string = new session)   |

Must populate the global `CLAUDE_CMD_ARGS` array with the complete CLI command and
arguments. Return `0` on success, `1` on failure (e.g., prompt file not found).

**Reads globals:** `CLAUDE_OUTPUT_FORMAT`, `CLAUDE_PERMISSION_MODE` (claude-code only),
`CLAUDE_ALLOWED_TOOLS` (claude-code only), `CLAUDE_USE_CONTINUE`.

---

## Optional Overrides with Loop Defaults

`ralph_loop.sh` defines default stubs at lines 284 and 288. All existing drivers override
them, but a minimal driver can rely on the defaults.

### `driver_supports_tool_allowlist()`

```bash
driver_supports_tool_allowlist()
```

No arguments. Return `0` if the driver supports `--allowedTools` filtering, `1` otherwise.

**Default:** returns `1` (false). Currently only `claude-code` returns `0`.

### `driver_permission_denial_help()`

```bash
driver_permission_denial_help()
```

No arguments. Print platform-specific troubleshooting guidance when the loop detects a
permission denial.

**Reads:** `RALPHRC_FILE`, `DRIVER_DISPLAY_NAME`.

**Default:** generic guidance text.

---

## Optional Capability Hooks

Guarded by `declare -F` checks or wrapper functions in `ralph_loop.sh` (lines 1917-1954,
1576-1583). Safe to omit -- documented fallback behavior applies.

### `driver_supports_sessions()`

```bash
driver_supports_sessions()
```

No arguments. Return `0` if the driver supports session resume, `1` otherwise.

**If not defined:** assumed true (`0`).

Implemented by all 5 drivers; `copilot` returns `1`.

### `driver_supports_live_output()`

```bash
driver_supports_live_output()
```

No arguments. Return `0` if the driver supports structured streaming output (stream-json
or JSONL), `1` otherwise.

**If not defined:** assumed true (`0`).

`copilot` returns `1`; all others return `0`.

### `driver_prepare_live_command()`

```bash
driver_prepare_live_command()
```

No arguments. Transform `CLAUDE_CMD_ARGS` into `LIVE_CMD_ARGS` for streaming mode.

**If not defined:** `LIVE_CMD_ARGS` is copied from `CLAUDE_CMD_ARGS` unchanged.

| Driver      | Behavior                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| claude-code | Replaces `json` with `stream-json` and adds `--verbose --include-partial-messages` |
| codex       | Copies as-is (output is already suitable)                                          |
| opencode    | Copies as-is (output is already suitable)                                          |
| cursor      | Replaces `json` with `stream-json`                                                 |

### `driver_stream_filter()`

```bash
driver_stream_filter()
```

No arguments. Echo a `jq` filter expression that transforms raw streaming events into
displayable text.

**If not defined:** returns `"empty"` (no output).

Each driver has a platform-specific filter; `copilot` returns `'.'` (passthrough).

### `driver_extract_session_id_from_output(output_file)`

```bash
driver_extract_session_id_from_output "$output_file"
```

One argument: path to the CLI output log file. Echo the extracted session ID.

Tried first in the session save chain before the generic `jq` extractor. Only `opencode`
implements this (uses `sed` to extract from a `"session"` JSON object).

### `driver_fallback_session_id(output_file)`

```bash
driver_fallback_session_id "$output_file"
```

One argument: path to the output file (caller passes it at line 1583; the only
implementation in `opencode` ignores it).

Last-resort session ID recovery when both driver-specific and generic extractors fail.
Only `opencode` implements this (queries `opencode session list --format json`).

---

## Conventional Metadata Hooks

Present in every driver but NOT called by `ralph_loop.sh`. Consumed by bmalph's TypeScript
doctor/preflight checks in `src/platform/`. A new driver should implement these for
`bmalph doctor` compatibility.

### `driver_min_version()`

```bash
driver_min_version()
```

No arguments. Echo the minimum required CLI version as a semver string.

### `driver_check_available()`

```bash
driver_check_available()
```

No arguments. Return `0` if the CLI binary is installed and reachable, `1` otherwise.

---

## Global Variables

### Written by drivers

| Variable              | Written by                      | Type  | Description                                       |
| --------------------- | ------------------------------- | ----- | ------------------------------------------------- |
| `VALID_TOOL_PATTERNS` | `driver_valid_tools()`          | array | Valid tool name patterns for allowlist validation |
| `CLAUDE_CMD_ARGS`     | `driver_build_command()`        | array | Complete CLI command with all arguments           |
| `LIVE_CMD_ARGS`       | `driver_prepare_live_command()` | array | Modified command for live streaming               |

### Read by drivers (set by ralph_loop.sh or .ralphrc)

| Variable                 | Used in                                | Description                                         |
| ------------------------ | -------------------------------------- | --------------------------------------------------- |
| `CLAUDE_OUTPUT_FORMAT`   | `driver_build_command()`               | `"json"` or `"text"`                                |
| `CLAUDE_PERMISSION_MODE` | `driver_build_command()` (claude-code) | Permission mode flag, default `"bypassPermissions"` |
| `CLAUDE_ALLOWED_TOOLS`   | `driver_build_command()` (claude-code) | Comma-separated tool allowlist                      |
| `CLAUDE_USE_CONTINUE`    | `driver_build_command()`               | `"true"` or `"false"`, gates session resume         |
| `RALPHRC_FILE`           | `driver_permission_denial_help()`      | Path to `.ralphrc` config file                      |
| `DRIVER_DISPLAY_NAME`    | `driver_permission_denial_help()`      | Human-readable driver name                          |

### Environment globals (cursor-specific)

| Variable       | Used in                                | Description                     |
| -------------- | -------------------------------------- | ------------------------------- |
| `OS`, `OSTYPE` | `driver_running_on_windows()`          | OS detection                    |
| `LOCALAPPDATA` | `driver_localappdata_cli_binary()`     | Windows local app data path     |
| `PATH`         | `driver_find_windows_path_candidate()` | Manual PATH scanning on Windows |

### Set by ralph_loop.sh from driver output

| Variable              | Source                  | Description                 |
| --------------------- | ----------------------- | --------------------------- |
| `CLAUDE_CODE_CMD`     | `driver_cli_binary()`   | CLI binary name/path        |
| `DRIVER_DISPLAY_NAME` | `driver_display_name()` | Human-readable display name |

---

## Capability Matrix

| Capability                                                          | claude-code |    codex     |   opencode   |   copilot   |   cursor   |
| ------------------------------------------------------------------- | :---------: | :----------: | :----------: | :---------: | :--------: |
| Tool allowlist (`driver_supports_tool_allowlist`)                   |     yes     |      no      |      no      |     no      |     no     |
| Session continuity (`driver_supports_sessions`)                     |     yes     |     yes      |     yes      |     no      |    yes     |
| Structured live output (`driver_supports_live_output`)              |     yes     |     yes      |     yes      |     no      |    yes     |
| Live command transform (`driver_prepare_live_command`)              |  transform  | passthrough  | passthrough  |     --      | transform  |
| Stream filter (`driver_stream_filter`)                              | complex jq  | JSONL select | JSONL select | passthrough | complex jq |
| Custom session extraction (`driver_extract_session_id_from_output`) |     --      |      --      |     yes      |     --      |     --     |
| Fallback session lookup (`driver_fallback_session_id`)              |     --      |      --      |     yes      |     --      |     --     |
| Dynamic binary resolution (`driver_cli_binary`)                     |   static    |    static    |    static    |   static    |  dynamic   |

---

## Creating a New Driver

### Minimal driver skeleton

```bash
#!/usr/bin/env bash
# ralph/drivers/my-platform.sh
# Driver for My Platform CLI
#
# Sourced by ralph_loop.sh via load_platform_driver().
# PLATFORM_DRIVER must be set to "my-platform" in .ralphrc.

# ---------------------------------------------------------------------------
# Required hooks (5) -- omitting any of these breaks the loop
# ---------------------------------------------------------------------------

# Short lowercase identifier used to gate platform-specific logic.
driver_name() {
  echo "my-platform"
}

# Human-readable name for log messages and tmux pane titles.
driver_display_name() {
  echo "My Platform"
}

# CLI executable name or resolved path.
driver_cli_binary() {
  echo "my-platform"
}

# Populate VALID_TOOL_PATTERNS with recognized tool name patterns.
# Used by validate_allowed_tools() to check allowlist entries.
driver_valid_tools() {
  VALID_TOOL_PATTERNS=(
    "Read"
    "Write"
    "Edit"
    "Bash"
    # Add your platform's tool patterns here
  )
}

# Build the complete CLI command array.
# $1 = prompt_file  Path to .ralph/PROMPT.md
# $2 = loop_context Context string for session continuity (may be empty)
# $3 = session_id   Session ID for resume (empty = new session)
driver_build_command() {
  local prompt_file="$1"
  local loop_context="$2"
  local session_id="$3"

  if [[ ! -f "$prompt_file" ]]; then
    return 1
  fi

  CLAUDE_CMD_ARGS=(
    "my-platform"
    "--prompt" "$prompt_file"
    "--output-format" "${CLAUDE_OUTPUT_FORMAT:-json}"
  )

  # Append session resume flag if continuing a session
  if [[ "$CLAUDE_USE_CONTINUE" == "true" && -n "$session_id" ]]; then
    CLAUDE_CMD_ARGS+=("--session" "$session_id")
  fi

  # Append context if provided
  if [[ -n "$loop_context" ]]; then
    CLAUDE_CMD_ARGS+=("--context" "$loop_context")
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Optional overrides (2) -- loop provides default stubs
# ---------------------------------------------------------------------------

# Return 0 if the platform supports --allowedTools filtering, 1 otherwise.
driver_supports_tool_allowlist() {
  return 1
}

# Print troubleshooting guidance on permission denial.
driver_permission_denial_help() {
  echo "Permission denied. Check that $DRIVER_DISPLAY_NAME has the required permissions."
  echo "See $RALPHRC_FILE for configuration options."
}

# ---------------------------------------------------------------------------
# Metadata hooks (2) -- used by bmalph doctor, not called by ralph_loop.sh
# ---------------------------------------------------------------------------

# Minimum required CLI version (semver).
driver_min_version() {
  echo "1.0.0"
}

# Return 0 if the CLI binary is installed and reachable, 1 otherwise.
driver_check_available() {
  command -v my-platform &>/dev/null
}
```

### Checklist

- [ ] All 5 required hooks implemented (`driver_name`, `driver_display_name`,
      `driver_cli_binary`, `driver_valid_tools`, `driver_build_command`)
- [ ] `driver_valid_tools` populates `VALID_TOOL_PATTERNS` with your platform's tool names
- [ ] `driver_build_command` handles all three arguments correctly
      (`prompt_file`, `loop_context`, `session_id`)
- [ ] `driver_check_available` returns `0` only when the CLI is installed
- [ ] File named `${platform_id}.sh` matching the `PLATFORM_DRIVER` value in `.ralphrc`
- [ ] Register corresponding platform definition in `src/platform/` for bmalph CLI integration
- [ ] Tested with `bmalph doctor`

---

## Session ID Recovery Chain

When the loop needs to persist a session ID for resume, it follows a three-step priority
chain (`ralph_loop.sh` lines 1574-1588):

1. **`driver_extract_session_id_from_output($output_file)`** -- Driver-specific extraction.
   If the function exists (`declare -F` guard) and echoes a non-empty string, that value
   is used. Only `opencode` implements this (uses `sed` to extract from a `"session"` JSON
   object).

2. **`extract_session_id_from_output($output_file)`** -- Generic `jq` extractor from
   `response_analyzer.sh`. Searches the output file for `.sessionId`,
   `.metadata.session_id`, and `.session_id` in that order.

3. **`driver_fallback_session_id($output_file)`** -- CLI-based last-resort recovery. If the
   function exists and the previous steps produced nothing, this is called. Only `opencode`
   implements this (queries `opencode session list --format json`).

The first step that returns a non-empty string wins. If all three steps fail, no session ID
is saved and the next iteration starts a fresh session.
