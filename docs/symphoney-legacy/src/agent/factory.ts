import type { Logger } from "pino";
import type { ConfigSnapshot } from "../config/snapshot.js";
import type { AgentClient } from "./client.js";
import { StdioCodexClient } from "./stdio-client.js";
import { ClaudeAgentClient } from "./claude-client.js";

/**
 * Construct the agent backend implied by the active workflow snapshot.
 *
 * For the Claude backend we additionally pre-warm the SDK subprocess via the
 * SDK's `startup()` helper (added in claude-agent-sdk v0.2.89) — first-query
 * latency drops by roughly 20x compared to a cold start. Best-effort: any error
 * is logged and the agent is still returned, since `query()` will fall back to
 * a normal cold start.
 */
export async function createAgentClient(
  snapshot: ConfigSnapshot,
  logger: Logger,
): Promise<AgentClient> {
  if (snapshot.agent.backend === "claude") {
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const startupFn = (sdk as unknown as { startup?: () => Promise<unknown> }).startup;
      if (typeof startupFn === "function") {
        await startupFn();
        logger.info({}, "claude_sdk_startup_prewarm_done");
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "claude_sdk_startup_prewarm_failed");
    }
    return new ClaudeAgentClient();
  }

  return new StdioCodexClient({
    onStderr: (chunk) => logger.debug({ stream: "codex_stderr" }, chunk.trimEnd()),
  });
}
