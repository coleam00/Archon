import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { augmentPromptForJsonSchema } from '../../shared/structured-output';
import { OMP_CAPABILITIES } from './capabilities';
import { parseOmpConfig } from './config';
import { createOmpDiagnosticsContext, OmpEnrichedError } from './diagnostics';
import { parseOmpModelRef } from './model-ref';
import {
  formatOmpAuthInitFailedMessage,
  formatOmpInvalidModelRefMessage,
  formatOmpModelNotFoundMessage,
  formatOmpModelRequiredMessage,
  isOmpRuntimeDiscoveredProvider,
} from './model-registry-hints';
import { readOmpAgentDefaultModel } from './omp-agent-config';

// Do NOT statically import modules that pull runtime values from @oh-my-pi/pi-coding-agent
// (event-bridge, session-resolver). SDK + OMP-dependent helpers load inside sendQuery().

/**
 * Write a minimal package.json to a stable tmpdir and set `OMP_PACKAGE_DIR`
 * so OMP's config.js short-circuits its `dirname(process.execPath)` walk
 * (which fails inside a compiled archon binary).
 */
function ensureOmpPackageDirShim(): void {
  const shimDir = join(tmpdir(), 'archon-omp-shim');
  const shimPkgJson = join(shimDir, 'package.json');
  if (!existsSync(shimPkgJson)) {
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      shimPkgJson,
      JSON.stringify({
        name: 'archon-omp-shim',
        version: '0.0.0',
        piConfig: {},
      })
    );
  }
  process.env.OMP_PACKAGE_DIR = shimDir;
}

/** Env var name per OMP provider id — shared with model-preflight's credential check. */
export const OMP_PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
};

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp');
  return cachedLog;
}

export class OmpProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    ensureOmpPackageDirShim();

    const [
      omp,
      { bridgeSessionWithRetry },
      { resolveOmpThinkingLevel, resolveOmpSkills },
      { resolveOmpSession },
    ] = await Promise.all([
      import('@oh-my-pi/pi-coding-agent'),
      import('./retry'),
      import('./options-translator'),
      import('./session-resolver'),
    ]);
    const { createAgentSession } = omp;

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const ompConfig = parseOmpConfig(assistantConfig);

    // Apply config-level env vars (assistants.omp.env) to process.env so
    // OMP's auth/registry layers and extensions can read them. Shell env wins:
    // only keys not already present are set. Request-level `requestOptions.env`
    // remains a separate channel (per-provider credential override below).
    // Mirrors the Pi provider (community/pi/provider.ts).
    if (ompConfig.env) {
      const applied: string[] = [];
      for (const [key, value] of Object.entries(ompConfig.env)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          applied.push(key);
        }
      }
      if (applied.length > 0) {
        // Key names only — never log values (may be secrets).
        getLog().debug({ keys: applied }, 'omp.config_env_applied');
      }
    }

    const nodeConfig = requestOptions?.nodeConfig;
    const modelRaw =
      requestOptions?.model ??
      (nodeConfig?.model as string | undefined) ??
      ompConfig.model ??
      (await readOmpAgentDefaultModel());
    if (!modelRaw) {
      throw new Error(formatOmpModelRequiredMessage());
    }
    const parsed = parseOmpModelRef(modelRaw);
    if (!parsed) {
      throw new Error(formatOmpInvalidModelRefMessage(modelRaw));
    }

    const enableExtensions = ompConfig.enableExtensions === true;
    const interactive = enableExtensions && ompConfig.interactive === true;

    let authStorage: Awaited<ReturnType<typeof omp.discoverAuthStorage>>;
    let modelRegistry: InstanceType<typeof omp.ModelRegistry>;
    try {
      authStorage = await omp.discoverAuthStorage();
      modelRegistry = new omp.ModelRegistry(authStorage);
      await modelRegistry.refresh();
    } catch (err: unknown) {
      const e = err as Error;
      getLog().error({ err: e, ompProvider: parsed.provider }, 'omp.auth_storage_init_failed');
      throw new Error(formatOmpAuthInitFailedMessage(e.message));
    }

    let model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model && isOmpRuntimeDiscoveredProvider(parsed.provider)) {
      await modelRegistry.refreshProvider(parsed.provider, 'online');
      model = modelRegistry.find(parsed.provider, parsed.modelId);
    }
    if (!model) {
      const loadError = modelRegistry.getError?.();
      const loadErrorMessage = typeof loadError === 'string' ? loadError : loadError?.message;
      if (loadErrorMessage) {
        getLog().warn(
          { ompProvider: parsed.provider, modelId: parsed.modelId, loadError: loadErrorMessage },
          'omp.model_registry_load_error'
        );
      }
      getLog().error(
        {
          ompProvider: parsed.provider,
          modelId: parsed.modelId,
          loadError: loadErrorMessage ?? null,
        },
        'omp.model_not_found'
      );
      throw new Error(
        formatOmpModelNotFoundMessage(parsed.provider, parsed.modelId, loadErrorMessage)
      );
    }

    const envVarName = OMP_PROVIDER_ENV_VARS[parsed.provider];
    const envOverride = envVarName
      ? (requestOptions?.env?.[envVarName] ?? process.env[envVarName])
      : undefined;
    if (envOverride) {
      authStorage.setRuntimeApiKey(parsed.provider, envOverride);
    }

    const resolvedKey = await authStorage.getApiKey(parsed.provider);
    if (!resolvedKey && envVarName) {
      const envHint = `Set ${envVarName} in the environment or codebase env vars (.archon/config.yaml env: section).`;
      throw new Error(`OMP auth: no credentials for provider '${parsed.provider}'. ${envHint}`);
    }

    const { level: thinkingLevel, warning: thinkingWarning } = resolveOmpThinkingLevel(nodeConfig);
    if (thinkingWarning) {
      yield { type: 'system', content: `⚠️ ${thinkingWarning}` };
    }

    const { paths: skillPaths, missing: missingSkills } = resolveOmpSkills(cwd, nodeConfig?.skills);
    if (missingSkills.length > 0) {
      yield {
        type: 'system',
        content: `⚠️ OMP could not resolve skill names: ${missingSkills.join(', ')}. Searched .agents/skills and .claude/skills (project + user-global).`,
      };
    }

    const { sessionManager, resumeFailed } = await resolveOmpSession(cwd, resumeSessionId);
    if (resumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume OMP session. Starting fresh conversation.',
      };
    }

    const diagnostics = createOmpDiagnosticsContext({
      provider: parsed.provider,
      modelId: parsed.modelId,
      cwd,
      resumed: resumeSessionId !== undefined && !resumeFailed,
    });

    const skills =
      skillPaths.length > 0 ? (await omp.discoverSkills(cwd, undefined, {})).skills : undefined;

    getLog().info(
      {
        ompProvider: parsed.provider,
        modelId: parsed.modelId,
        cwd,
        thinkingLevel,
        skillCount: skillPaths.length,
        missingSkillCount: missingSkills.length,
        extensionsEnabled: enableExtensions,
        interactive,
        resumed: resumeSessionId !== undefined && !resumeFailed,
      },
      'omp.session_started'
    );

    // Session creation lives in a factory so the retry layer can create a
    // FRESH session per attempt (bridgeSession disposes its session in a
    // finally — re-prompting a disposed session is the 70eaa443 bug).
    let firstCreation = true;
    let firstCreationFallbackMessage: string | undefined;
    const createSession = async (): Promise<
      Awaited<ReturnType<typeof createAgentSession>>['session']
    > => {
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd,
        model,
        authStorage,
        modelRegistry,
        sessionManager,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        thinkingLevel: thinkingLevel as any,
        skills,
        disableExtensionDiscovery: !enableExtensions,
        additionalExtensionPaths: [],
        hasUI: interactive,
      });

      if (firstCreation) {
        firstCreation = false;
        firstCreationFallbackMessage = modelFallbackMessage;
      }

      if (enableExtensions && ompConfig.extensionFlags) {
        const runner = session.extensionRunner;
        if (runner) {
          for (const [name, value] of Object.entries(ompConfig.extensionFlags)) {
            runner.setFlagValue(name, value);
          }
        }
      }

      return session;
    };

    // Create the first session eagerly so model-fallback warnings surface
    // before streaming starts; retries get fresh sessions from the factory.
    let preCreatedSession: Awaited<ReturnType<typeof createSession>> | undefined =
      await createSession();
    if (firstCreationFallbackMessage) {
      yield { type: 'system', content: `⚠️ ${firstCreationFallbackMessage}` };
    }
    const sessionFactory = async (): Promise<Awaited<ReturnType<typeof createSession>>> => {
      if (preCreatedSession) {
        const session = preCreatedSession;
        preCreatedSession = undefined;
        return session;
      }
      return createSession();
    };

    const outputFormat = requestOptions?.outputFormat;
    const effectivePrompt = outputFormat
      ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
      : prompt;

    try {
      yield* bridgeSessionWithRetry(
        sessionFactory,
        effectivePrompt,
        requestOptions?.abortSignal,
        outputFormat?.schema,
        undefined,
        { diagnostics }
      );
      getLog().info({ ompProvider: parsed.provider }, 'omp.prompt_completed');
    } catch (err: unknown) {
      const error = err as Error;
      getLog().error({ err: error, ...diagnostics.toLogSummary() }, 'omp.prompt_failed');
      // Bridge errors already carry the bounded diagnostics summary; only
      // append it for raw failures (e.g. session factory rejections).
      const summary =
        error instanceof OmpEnrichedError ? '' : ` ${diagnostics.formatForErrorMessage()}`;
      throw new Error(
        `OMP prompt failed (${parsed.provider}/${parsed.modelId}): ${error.message}.${summary} ` +
          'Recovery: re-run the node or use /workflow resume; if this persists, check provider ' +
          `credentials and model availability for '${parsed.provider}'.`,
        { cause: error }
      );
    }
  }

  getType(): string {
    return 'omp';
  }

  getCapabilities(): ProviderCapabilities {
    return OMP_CAPABILITIES;
  }
}
