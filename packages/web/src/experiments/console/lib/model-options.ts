/**
 * Pure helpers for the agent-aware model pickers (#1957) in the Model Tiers /
 * Aliases / Defaults panels. The valid model space is agent-shaped — Pi has a
 * baked catalog, OpenCode a runtime-introspected one, Copilot a small fixed
 * list, Claude/Codex small curated sets that evolve — so each agent gets a
 * differently sourced suggestion list. Pickers GUIDE, they never GATE: every
 * shape keeps a free-text path and the server stays permissive.
 *
 * All functions are side-effect free so they stay unit-testable without DOM
 * rendering — the console's testing pattern for panel logic (lib/agent-status.ts).
 */
import type { AgentCredentials, OpencodeCredentialProvider, PiModelInfo } from '../skills';
import { isCredentialUsable } from './agent-status';

/** One suggestion in a model picker dropdown. */
export interface ModelOption {
  /** What picking the option writes into the model field. */
  value: string;
  /** Muted metadata rendered next to the value (cost/context, model counts, …). */
  hint?: string;
  /**
   * Prefix completion (OpenCode `backend/`): picking it fills the backend
   * prefix and keeps the input open for the free-typed model id, because the
   * credentials endpoint exposes per-backend model COUNTS but not model ids.
   */
  prefix?: boolean;
}

/**
 * How the model field renders for an agent. Unknown agent ids (future
 * community providers) fall back to plain free text — never an empty picker.
 */
export type ModelPickerShape = 'pi' | 'opencode' | 'select' | 'curated' | 'free';

export function modelPickerShape(agentId: string): ModelPickerShape {
  switch (agentId) {
    case 'pi':
      return 'pi';
    case 'opencode':
      return 'opencode';
    case 'copilot':
      return 'select';
    case 'claude':
    case 'codex':
      return 'curated';
    default:
      return 'free';
  }
}

// ---------------------------------------------------------------------------
// Curated lists. These are CONVENIENCE suggestions, not authority — the SDKs
// ship models faster than Archon can enumerate them, so every consumer keeps a
// free-text escape and nothing client-side blocks an unlisted model string.
// ---------------------------------------------------------------------------

/**
 * Claude SDK model keywords, mirroring the `.archon/config.yaml` examples in
 * CLAUDE.md and docs/getting-started/ai-assistants.md (`model: sonnet # or
 * 'opus', 'haiku', 'claude-*'`). Full `claude-*` ids are free-typed.
 */
export const CLAUDE_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: 'sonnet' },
  { value: 'opus' },
  { value: 'haiku' },
];

/**
 * Codex model strings used across the repo's config examples
 * (docs/getting-started/ai-assistants.md and CLAUDE.md: `gpt-5.3-codex`,
 * tiers example `gpt-5.5`, docs `gpt-5.2`).
 */
export const CODEX_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: 'gpt-5.3-codex' },
  { value: 'gpt-5.5' },
  { value: 'gpt-5.2' },
];

/**
 * Copilot model list. PROVENANCE: no Archon API exposes Copilot's model
 * catalog (the Copilot CLI negotiates it per subscription at runtime), so this
 * is hand-curated from docs/getting-started/ai-assistants.md ("'gpt-5',
 * 'gpt-5-mini', 'claude-sonnet-4.5', 'auto', etc."). NOT authoritative — the
 * select keeps a "Custom…" free-text escape for anything Copilot ships next.
 */
export const COPILOT_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: 'auto', hint: 'Copilot picks' },
  { value: 'gpt-5' },
  { value: 'gpt-5-mini' },
  { value: 'claude-sonnet-4.5' },
];

/** Curated suggestions for an agent's combobox; empty when none exist. */
export function curatedOptionsForAgent(agentId: string): readonly ModelOption[] {
  if (agentId === 'claude') return CLAUDE_MODEL_OPTIONS;
  if (agentId === 'codex') return CODEX_MODEL_OPTIONS;
  if (agentId === 'copilot') return COPILOT_MODEL_OPTIONS;
  return [];
}

// ---------------------------------------------------------------------------
// Effort. Tier/alias `effort` only ROUTES on Claude (node `effort`) and Codex
// (`modelReasoningEffort`) — `routePresetEffort` in
// packages/workflows/src/model-validation.ts returns null for everything else,
// and the PATCH routes validate via `isEffortValidForProvider`. The web
// package cannot import @archon/workflows, so the vocabularies are mirrored
// here (same convention as REASONING_EFFORTS in the Defaults panel).
// ---------------------------------------------------------------------------

/** Mirrors CLAUDE_EFFORTS in packages/workflows/src/model-validation.ts. */
export const CLAUDE_EFFORT_OPTIONS = ['low', 'medium', 'high', 'max'] as const;
/** Mirrors CODEX_REASONING_EFFORTS in packages/workflows/src/model-validation.ts. */
export const CODEX_EFFORT_OPTIONS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ClaudeEffort = (typeof CLAUDE_EFFORT_OPTIONS)[number];
export type CodexEffort = (typeof CODEX_EFFORT_OPTIONS)[number];
/** Any effort value an agent's vocabulary can produce. */
export type EffortOption = ClaudeEffort | CodexEffort;

/**
 * The effort vocabulary an agent's tier/alias `effort` accepts, or null when
 * effort doesn't route there (Pi/OpenCode/Copilot presets drop it) — null
 * hides the field entirely instead of offering a no-op input.
 */
export function effortOptionsForAgent(agentId: string): readonly EffortOption[] | null {
  if (agentId === 'claude') return CLAUDE_EFFORT_OPTIONS;
  if (agentId === 'codex') return CODEX_EFFORT_OPTIONS;
  return null;
}

/**
 * Carry an effort value across a provider switch: keep it when the new agent's
 * vocabulary accepts it (e.g. codex→claude keeps 'high'), clear it otherwise
 * (including agents with no effort concept, where the field is hidden and a
 * stale value would be invisible state).
 */
export function normalizeEffortForAgent(agentId: string, effort: string): EffortOption | '' {
  const valid = effortOptionsForAgent(agentId);
  return valid?.find(v => v === effort) ?? '';
}

// ---------------------------------------------------------------------------
// Pi: searchable picker over GET /api/providers/pi/models, default-filtered to
// backends the agents matrix says are usable.
// ---------------------------------------------------------------------------

/**
 * The set of Pi backend ids (vendor-canonical, same ids the Pi catalog uses as
 * `PiModelInfo.provider`) with a usable credential — connected, install env,
 * or ambient. Returns null when the matrix is unavailable (401/solo install)
 * or carries no Pi credential rows: null means "can't filter, show everything".
 * An EMPTY set is different — the matrix is present but nothing is usable, so
 * the filter is active and the default suggestion list is empty (the "show
 * all backends" toggle is the way out).
 */
export function usablePiBackends(
  agents: AgentCredentials[] | undefined
): ReadonlySet<string> | null {
  const credentials = agents?.find(a => a.id === 'pi')?.credentials;
  if (credentials === undefined || credentials.length === 0) return null;
  return new Set(credentials.filter(isCredentialUsable).map(c => c.vendor));
}

/** Cost/context/reasoning hint for one Pi catalog model. */
export function piModelHint(m: PiModelInfo): string {
  return `$${m.cost.input}/M in · $${m.cost.output}/M out${m.reasoning ? ' · reasoning' : ''} · ${Math.round(m.contextWindow / 1000)}k ctx`;
}

export interface PiPickerResult {
  options: ModelOption[];
  /** Total query matches after backend filtering (options are capped at `limit`). */
  matchTotal: number;
  /** Query matches hidden by the connected-backends filter (drives the "show all" toggle copy). */
  hiddenByFilter: number;
}

/**
 * Suggestions for the Pi picker. The field's current text doubles as the
 * search query (matched against ref and display name). With `backends` known
 * and `showAll` off, only models on usable backends surface; the hidden count
 * lets the UI offer an explicit "show all backends" toggle. Custom
 * ~/.pi/agent/models.json providers aren't in the baked catalog at all —
 * free text is their (documented) path.
 */
export function piModelOptions(
  models: PiModelInfo[] | undefined,
  query: string,
  backends: ReadonlySet<string> | null,
  showAll: boolean,
  limit: number
): PiPickerResult {
  const q = query.trim().toLowerCase();
  const all = models ?? [];
  const queryMatches =
    q === ''
      ? all
      : all.filter(m => m.ref.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  const filtered =
    showAll || backends === null
      ? queryMatches
      : queryMatches.filter(m => backends.has(m.provider));
  return {
    options: filtered.slice(0, limit).map(m => ({ value: m.ref, hint: piModelHint(m) })),
    matchTotal: filtered.length,
    hiddenByFilter: queryMatches.length - filtered.length,
  };
}

/** Exact-ref catalog lookup for the under-field cost hint (trims the input). */
export function findPiModel(
  models: PiModelInfo[] | undefined,
  value: string
): PiModelInfo | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  return models?.find(m => m.ref === v);
}

/** The `backend` of a `backend/model` ref, or null when there's no prefix. */
export function modelRefBackend(value: string): string | null {
  const i = value.indexOf('/');
  return i > 0 ? value.slice(0, i) : null;
}

/**
 * Non-blocking inline hint when a Pi model ref names a backend the credential
 * matrix knows but nothing usable is connected. Pickers guide, never gate:
 * the value still saves (credentials may be connected later or exist only as
 * run-time env). Unknown backends (custom models.json providers) get NO hint —
 * we can't know their credential state.
 */
export function piDisconnectedBackendHint(
  value: string,
  agents: AgentCredentials[] | undefined
): string | null {
  const backend = modelRefBackend(value.trim());
  if (backend === null) return null;
  const pi = agents?.find(a => a.id === 'pi');
  const cred = pi?.credentials.find(c => c.vendor === backend);
  if (!cred || isCredentialUsable(cred)) return null;
  return `No ${cred.displayName} credential connected — saves fine, but runs need one (Settings → Agents).`;
}

// ---------------------------------------------------------------------------
// Generic + OpenCode.
// ---------------------------------------------------------------------------

/** Case-insensitive substring filter over option values (curated/OpenCode lists). */
export function filterModelOptions(options: readonly ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...options];
  return options.filter(o => o.value.toLowerCase().includes(q));
}

/**
 * Backend-prefix options for the OpenCode picker, from the on-demand
 * introspection endpoint: connected backends first, then by model count, then
 * id. Values are `backend/` prefixes (see `ModelOption.prefix`).
 */
export function opencodeBackendOptions(providers: OpencodeCredentialProvider[]): ModelOption[] {
  return [...providers]
    .sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected) ||
        b.modelCount - a.modelCount ||
        a.id.localeCompare(b.id)
    )
    .map(p => ({
      value: `${p.id}/`,
      prefix: true,
      hint: `${p.name} · ${p.modelCount} model${p.modelCount === 1 ? '' : 's'}${p.connected ? ' · connected' : ''}`,
    }));
}
