import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/**
 * Installation-wide settings skills: assistant config + system health/version.
 *
 * Mirrors the envVars skill (requestJson + method). Types come from the generated
 * OpenAPI spec (`@/lib/api.generated`) — never `@/lib/api` — so the console stays
 * inside its isolation boundary. The write path is GLOBAL only: PATCH
 * /api/config/assistants persists to ~/.archon/config.yaml (no repo overrides).
 */

export type SafeConfig = components['schemas']['SafeConfig'];
export type ConfigResponse = components['schemas']['ConfigResponse'];
export type UpdateAssistantConfigBody = components['schemas']['UpdateAssistantConfigBody'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type UpdateCheckResponse = components['schemas']['UpdateCheckResponse'];

export function getConfig(): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>('/api/config');
}

export function updateAssistantConfig(body: UpdateAssistantConfigBody): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>('/api/config/assistants', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health');
}

export function getUpdateCheck(): Promise<UpdateCheckResponse> {
  return requestJson<UpdateCheckResponse>('/api/update-check');
}

/**
 * Editable assistant form state. `models` is providerId → free-text model (model
 * strings are intentionally unvalidated — the SDK ships models faster than Archon
 * can enumerate them). The codex-only reasoning/web-search fields are flat here
 * and only attached to the codex entry by `buildAssistantUpdate`.
 */
export interface AssistantConfigForm {
  assistant: string;
  models: Record<string, string>;
  modelReasoningEffort: string;
  webSearchMode: string;
}

/**
 * Pure form → PATCH-body transform. Omits a provider's `model` when blank (so we
 * never overwrite a saved model with `''`) and drops a provider entirely when it
 * contributes no fields. Codex additionally carries `modelReasoningEffort` /
 * `webSearchMode` when set.
 *
 * Safety note: the PATCH route validates only provider *ids* and merges the body
 * into config.yaml UNFILTERED — per-field safe-filtering runs on the read path, not
 * the write path. So it matters that this function only ever attaches the codex-only
 * fields to the `codex` entry (it does); it must not leak them onto other providers.
 */
export function buildAssistantUpdate(form: AssistantConfigForm): UpdateAssistantConfigBody {
  const assistants: Record<string, Record<string, unknown>> = {};
  for (const [providerId, rawModel] of Object.entries(form.models)) {
    const entry: Record<string, unknown> = {};
    const model = rawModel.trim();
    if (model !== '') entry.model = model;
    if (providerId === 'codex') {
      if (form.modelReasoningEffort !== '') entry.modelReasoningEffort = form.modelReasoningEffort;
      if (form.webSearchMode !== '') entry.webSearchMode = form.webSearchMode;
    }
    if (Object.keys(entry).length > 0) assistants[providerId] = entry;
  }

  const body: UpdateAssistantConfigBody = { assistant: form.assistant };
  if (Object.keys(assistants).length > 0) body.assistants = assistants;
  return body;
}
