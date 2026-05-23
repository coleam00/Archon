/**
 * Gemini community provider — wraps @lrilai/gemini-cli-sdk.
 *
 * Auth: ambient gemini-cli OAuth login. A `gemini` "Sign in with Google" writes
 * credentials under ~/.gemini/, picked up automatically by the subprocess.
 * Archon injects NO key. The subprocess inherits the full parent environment
 * (including HOME), so ~/.gemini resolves without any env manipulation.
 *
 * Port-time fixes vs the reference adapter (seanrobertwright/Gemini-CLI-SDK):
 *   1. No `workflow_dispatch` sentinel before tool chunks (the SDK never emits
 *      that chunk and neither Claude nor Codex do this).
 *   2. Types imported from ../../types and the SDK directly, not a local mirror.
 *   3. No `isModelCompatible` in registration (the field was removed from
 *      ProviderRegistration; Archon does not validate model strings).
 */
import { query } from '@lrilai/gemini-cli-sdk';
import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { GEMINI_CAPABILITIES } from './capabilities';
import { parseGeminiConfig } from './config';
import { resolveGeminiBinaryPath } from './binary-resolver';
import { translateChunk, translateOptions, warnIgnoredOptions } from './options-translator';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.gemini');
  return cachedLog;
}

export class GeminiProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const geminiConfig = parseGeminiConfig(assistantConfig);

    // Resolve the gemini-cli binary (env → config → vendor → autodetect; throws
    // in binary builds if absent, undefined in dev so the SDK uses PATH).
    const resolvedCliPath = await resolveGeminiBinaryPath(geminiConfig.geminiBinaryPath);

    // Dev-mode visibility for options Gemini cannot honor (never throws).
    warnIgnoredOptions(requestOptions);

    const sdkOptions = translateOptions(
      prompt,
      cwd,
      resumeSessionId,
      requestOptions,
      resolvedCliPath
    );

    getLog().info(
      {
        cwd,
        model: sdkOptions.model,
        hasSession: sdkOptions.session !== undefined,
        hasAllowedTools: Array.isArray(sdkOptions.allowedTools),
        hasEnv: sdkOptions.env !== undefined,
        hasCliPath: sdkOptions.cliPath !== undefined,
      },
      'gemini.query_started'
    );

    try {
      // PORT-TIME FIX: do NOT yield a workflow_dispatch sentinel before tool
      // chunks — just translate and forward each chunk.
      for await (const sdkChunk of query(sdkOptions)) {
        yield translateChunk(sdkChunk);
      }
      getLog().info({ cwd }, 'gemini.query_completed');
    } catch (err) {
      getLog().error({ err, cwd }, 'gemini.query_failed');
      throw err;
    }
  }

  getType(): string {
    return 'gemini';
  }

  getCapabilities(): ProviderCapabilities {
    return GEMINI_CAPABILITIES;
  }
}
