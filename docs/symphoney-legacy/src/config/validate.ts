import type { ConfigSnapshot } from "./snapshot.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function validateDispatchConfig(snapshot: ConfigSnapshot): ValidationResult {
  if (snapshot.tracker.kind !== "linear") {
    return {
      ok: false,
      code: "unsupported_tracker_kind",
      message: `tracker.kind must be "linear" (got ${JSON.stringify(snapshot.tracker.kind)})`,
    };
  }
  if (!snapshot.tracker.api_key) {
    return {
      ok: false,
      code: "missing_tracker_api_key",
      message: "tracker.api_key is missing or resolves to an empty value",
    };
  }
  if (!snapshot.tracker.project_slug) {
    return {
      ok: false,
      code: "missing_tracker_project_slug",
      message: "tracker.project_slug is required for Linear",
    };
  }
  if (snapshot.agent.backend === "codex") {
    if (!snapshot.codex.command || !snapshot.codex.command.trim()) {
      return {
        ok: false,
        code: "missing_codex_command",
        message: "codex.command must be a non-empty shell command when agent.backend = 'codex'",
      };
    }
  } else if (snapshot.agent.backend === "claude") {
    if (!snapshot.claude.model) {
      return {
        ok: false,
        code: "missing_claude_model",
        message: "claude.model must be set when agent.backend = 'claude'",
      };
    }
  }
  return { ok: true };
}
