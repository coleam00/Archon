import { listPiModels } from './model-catalog';
import type {
  CredentialStatus,
  ProviderDiagnostics,
  ProviderModelList,
} from '@archon/provider-contract';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { PI_CAPABILITIES } from './capabilities';
import { parsePiConfig } from './config';
import { closeOpenToolCalls } from '../../shared/tool-calls';
import { failureClassOfThrown, failureResult } from '../../shared/failure';
import { piExtensionFailureEvidence } from './extension-error-broker';
import {
  applyPiEnvOverride,
  createPiModelRuntime,
  piAuthEnv,
  resolvePiModel,
  resolvePiTurnAuth,
} from './auth';
import { ensurePiPackageDirShim } from './sdk-setup';
import { streamPiTurn } from './turn';

// IMPORTANT: Do NOT add static `import { ... } from '@earendil-works/*'` here,
// and do NOT statically import sibling modules that themselves import runtime
// values from Pi (options-translator, resource-loader, session-resolver,
// ui-context-stub, event-bridge, session-setup). Pi's `@earendil-works/pi-coding-agent/dist/config.js`
// runs `readFileSync(getPackageJsonPath(), "utf-8")` at module load; inside a
// compiled Archon binary `getPackageJsonPath()` resolves to
// `dirname(process.execPath) + "/package.json"` — a path that doesn't exist —
// and archon crashes at startup before any command runs (v0.3.7 symptom).
//
// All Pi SDK value bindings and Pi-dependent helper modules are dynamically
// imported when a Pi workflow is actually invoked (`streamPiTurn` in ./turn.ts,
// and the methods below). Type-only imports are fine — TS erases them.
//
// Lazy-loading defers the crash from boot-time to sendQuery-time — but the
// crash still happens when Pi is actually used. `ensurePiPackageDirShim()`
// (./sdk-setup.ts) fixes the *runtime* half: before any dynamic Pi import,
// write a stub package.json to tmpdir and point Pi at it via its own
// documented `PI_PACKAGE_DIR` escape hatch.

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

/**
 * Pi community provider — wraps `@earendil-works/pi-coding-agent`'s full
 * coding-agent harness. Each `sendQuery()` call creates a fresh session
 * (no reuse) so concurrent calls don't collide.
 */
export class PiProvider implements IAgentProvider {
  async listModels(
    request: Parameters<NonNullable<IAgentProvider['listModels']>>[0]
  ): Promise<ProviderModelList> {
    return {
      models: (await listPiModels(request.signal)).map(model => ({
        id: model.ref,
        label: model.name,
        details: {
          provider: model.provider,
          modelId: model.id,
          reasoning: model.reasoning,
          cost: model.cost,
          contextWindow: model.contextWindow,
        },
      })),
    };
  }

  async diagnose(
    request: Parameters<NonNullable<IAgentProvider['diagnose']>>[0]
  ): Promise<ProviderDiagnostics> {
    request.signal.throwIfAborted();
    const checks: ProviderDiagnostics['checks'] = [];
    try {
      ensurePiPackageDirShim();
      await import('@earendil-works/pi-coding-agent');
      checks.push({ id: 'pi-sdk', label: 'Pi SDK', status: 'ok', message: 'Pi SDK loaded' });
    } catch (error) {
      request.signal.throwIfAborted();
      return {
        checks: [
          {
            id: 'pi-sdk',
            label: 'Pi SDK',
            status: 'fail',
            message: `Pi SDK could not load: ${redactCredentialValues(error instanceof Error ? error.message : String(error), collectCredentialValues(process.env))}`,
            remedy: 'Reinstall the Pi provider',
          },
        ],
      };
    }
    const credential = await this.checkCredential({
      ...request,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      signal: request.signal,
    });
    request.signal.throwIfAborted();
    checks.push({
      id: 'pi-credentials',
      label: 'Pi backend credentials',
      status:
        credential.state === 'usable'
          ? 'ok'
          : credential.state === 'not_checked'
            ? 'skip'
            : credential.state === 'check_failed'
              ? 'fail'
              : 'warn',
      message: `Backend credential status: ${credential.state}${'evidence' in credential ? `: ${credential.evidence}` : ''}`,
      ...(credential.state === 'usable'
        ? {}
        : { remedy: 'Configure a Pi model and its backend credentials' }),
    });
    return { checks };
  }

  async resolveCredentialModel(
    request: Parameters<NonNullable<IAgentProvider['resolveCredentialModel']>>[0]
  ): Promise<string> {
    ensurePiPackageDirShim();
    const sdk = await import('@earendil-works/pi-coding-agent');
    const config = parsePiConfig(request.assistantConfig ?? {});
    const parsed = resolvePiModel(request.model ?? config.model, request.cwd, sdk);
    return `${parsed.provider}/${parsed.modelId}`;
  }

  async checkCredential(
    request: Parameters<IAgentProvider['checkCredential']>[0]
  ): Promise<CredentialStatus> {
    const { signal } = request;
    let { credentialValues } = piAuthEnv(undefined, request.env);
    try {
      const piConfig = parsePiConfig(request.assistantConfig ?? {});
      const authEnv = piAuthEnv(piConfig.env, request.env);
      credentialValues = authEnv.credentialValues;
      signal.throwIfAborted();
      ensurePiPackageDirShim();
      const piCodingAgent = await import('@earendil-works/pi-coding-agent');
      const parsed = resolvePiModel(request.model ?? piConfig.model, process.cwd(), piCodingAgent);
      const requestModelRuntime = await createPiModelRuntime(
        piCodingAgent,
        parsed.provider,
        authEnv,
        signal
      );
      const { runtime } = requestModelRuntime;
      try {
        await applyPiEnvOverride(runtime, parsed.provider, authEnv, requestModelRuntime.authPath);
        const { status } = await resolvePiTurnAuth(
          runtime,
          parsed.provider,
          new piCodingAgent.ModelRegistry(runtime).find(parsed.provider, parsed.modelId) !==
            undefined,
          credentialValues,
          signal
        );
        return status;
      } finally {
        requestModelRuntime.release();
      }
    } catch (error) {
      return {
        state: 'check_failed',
        source: 'native',
        evidence: redactCredentialValues(
          error instanceof Error ? error.message : String(error),
          credentialValues
        ),
      };
    }
  }

  /**
   * One call is one Pi prompt. A failure, including one thrown while setting the
   * session up, ends in a `result` carrying a typed `failure`, and the engine decides
   * whether to try again. Every turn ends in `settled`. Cancellation still throws.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    let resultReported = false;
    try {
      for await (const chunk of closeOpenToolCalls(
        streamPiTurn(prompt, cwd, resumeSessionId, requestOptions),
        { resultEndsTurn: true }
      )) {
        if (chunk.type === 'result') resultReported = true;
        yield chunk;
      }
    } catch (error) {
      if (requestOptions?.abortSignal?.aborted === true) throw error;
      const err = error as Error;
      // The turn already reported its one result; a later error does not change it.
      if (resultReported) getLog().error({ err }, 'pi.error_after_result');
      else
        yield failureResult(
          failureClassOfThrown(err),
          'pi_query_failed',
          piExtensionFailureEvidence(err) ?? err.message
        );
    }
    // The bridge ends when `prompt()` resolves, after every run of Pi's agent loop
    // (auto-retry, compaction, queued follow-ups) has finished: nothing more runs.
    yield { type: 'settled' };
  }

  getType(): string {
    return 'pi';
  }

  getCapabilities(): ProviderCapabilities {
    return PI_CAPABILITIES;
  }
}
