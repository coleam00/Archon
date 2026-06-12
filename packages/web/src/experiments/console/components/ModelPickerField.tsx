import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { AgentCredentials, OpencodeCredentialProvider, PiModelInfo } from '../skills';
import {
  COPILOT_MODEL_OPTIONS,
  curatedOptionsForAgent,
  filterModelOptions,
  findPiModel,
  modelPickerShape,
  opencodeBackendOptions,
  piDisconnectedBackendHint,
  piModelHint,
  piModelOptions,
  usablePiBackends,
  type ModelOption,
} from '../lib/model-options';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { INPUT_CLASS, SELECT_CLASS, SelectShell } from './SettingsFormPrimitives';

/** Cap on rendered Pi suggestions — the catalog is ~920 models. */
const PI_SUGGESTION_LIMIT = 30;

const DROPDOWN_CLASS =
  // Same elevation recipe as ProjectRow's context menu (the console's other
  // floating dropdown).
  'absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-[9px] border border-border bg-surface-elevated shadow-[0_18px_44px_-18px_rgba(0,0,0,0.85)]';
const OPTION_CLASS =
  'flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left font-mono text-[12px] transition-colors hover:bg-surface-hover';
const FOOTER_BUTTON_CLASS =
  'w-full border-t border-border px-3 py-2 text-left font-mono text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary';

interface ModelPickerFieldProps {
  /** Agent provider id ('' renders plain free text — e.g. an unset tier row). */
  agentId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Sizing classes for the field wrapper (e.g. 'min-w-[160px] flex-1'). */
  className?: string;
  /**
   * Label for the empty option in select-shaped pickers (Copilot). The free
   * text `placeholder` is often too long for an option label, so panels pass a
   * short one ('inherit', 'Select model…').
   */
  selectEmptyLabel?: string;
  /** Agents matrix (K.providerConnections) — undefined means no readiness data (solo/401). */
  agents?: AgentCredentials[];
  /** Pi catalog (K.piModels) — best-effort, undefined/[] means no Pi suggestions. */
  piModels?: PiModelInfo[];
}

/**
 * Agent-aware model input (#1957). One component, four shapes:
 * - Pi: searchable picker over the baked catalog, default-filtered to usable
 *   backends per the agents matrix, with an explicit "show all backends"
 *   toggle. Cost/context/reasoning hints ride each suggestion and the exact
 *   match. Custom models.json providers are free-typed.
 * - OpenCode: free text with on-demand backend-prefix suggestions. The
 *   introspection endpoint boots the embedded runtime, so NOTHING loads until
 *   the user explicitly clicks "Load backend suggestions" inside the open
 *   dropdown; it lists `backend/` prefixes (model counts, connected state) and
 *   the model id itself stays free-typed — the endpoint doesn't expose ids.
 * - Copilot: fixed select over the curated list + a "Custom…" free-text escape.
 * - Claude/Codex (and unknown agents): free text; Claude/Codex surface their
 *   curated common options as suggestions.
 *
 * Pickers guide, never gate: every shape saves arbitrary strings, and a model
 * on a disconnected backend only draws a non-blocking inline hint.
 */
export function ModelPickerField(props: ModelPickerFieldProps): ReactElement {
  if (modelPickerShape(props.agentId) === 'select') {
    return <CopilotModelSelect {...props} />;
  }
  return <ModelCombobox {...props} />;
}

/** Suggestion row; `onMouseDown` is prevented by the list container so the input never blurs. */
function OptionRow({
  option,
  onPick,
}: {
  option: ModelOption;
  onPick: (o: ModelOption) => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={() => {
        onPick(option);
      }}
      className={OPTION_CLASS}
    >
      <span className="min-w-0 truncate text-text-primary">{option.value}</span>
      {option.hint !== undefined ? (
        <span className="shrink-0 text-[10px] text-text-tertiary">{option.hint}</span>
      ) : null}
    </button>
  );
}

function ModelCombobox({
  agentId,
  value,
  onChange,
  disabled = false,
  placeholder,
  ariaLabel,
  className = '',
  agents,
  piModels,
}: ModelPickerFieldProps): ReactElement {
  const [open, setOpen] = useState(false);
  // Pi only: include backends without a usable credential in the suggestions.
  const [showAll, setShowAll] = useState(false);
  const shape = modelPickerShape(agentId);

  // OpenCode on-demand backend list. Per-field state by design: the endpoint
  // is only hit on this field's explicit "Load backend suggestions" click.
  const [ocPhase, setOcPhase] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [ocProviders, setOcProviders] = useState<OpencodeCredentialProvider[]>([]);
  const [ocError, setOcError] = useState<string | null>(null);
  const cancelledRef = useCancelledRef();

  const loadOpencode = async (): Promise<void> => {
    setOcPhase('loading');
    setOcError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        skill.listOpencodeCredentials(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Timed out waiting for the OpenCode runtime — retry.'));
          }, skill.OPENCODE_LOAD_TIMEOUT_MS);
        }),
      ]);
      if (cancelledRef.current) return;
      setOcProviders(result);
      setOcPhase('loaded');
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setOcError(e instanceof Error ? e.message : 'Failed to load OpenCode backends.');
      setOcPhase('error');
    } finally {
      clearTimeout(timer);
    }
  };

  // Suggestions per shape; the field's text doubles as the search query.
  const backends = shape === 'pi' ? usablePiBackends(agents) : null;
  const pi =
    shape === 'pi' ? piModelOptions(piModels, value, backends, showAll, PI_SUGGESTION_LIMIT) : null;
  let options: ModelOption[];
  if (pi !== null) {
    options = pi.options;
  } else if (shape === 'opencode') {
    options =
      ocPhase === 'loaded' ? filterModelOptions(opencodeBackendOptions(ocProviders), value) : [];
  } else {
    options = filterModelOptions(curatedOptionsForAgent(agentId), value);
  }

  const pick = (o: ModelOption): void => {
    onChange(o.value);
    // Prefix completions keep the dropdown open: the model id is typed next.
    if (o.prefix !== true) setOpen(false);
  };

  // Under-field hints (outside the dropdown, so they show while typing too).
  const exactPi = shape === 'pi' ? findPiModel(piModels, value) : undefined;
  const disconnectedHint =
    shape === 'pi' && !disabled ? piDisconnectedBackendHint(value, agents) : null;

  const hasDropdownContent = options.length > 0 || shape === 'pi' || shape === 'opencode';

  return (
    <span className={`relative inline-flex flex-col gap-1 ${className}`}>
      <input
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') setOpen(false);
        }}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        className={`${INPUT_CLASS} ${disabled ? 'opacity-50' : ''}`}
      />

      {open && !disabled && hasDropdownContent ? (
        // preventDefault keeps focus in the input, so option clicks land
        // before any blur-close — the standard combobox trick.
        <div
          className={DROPDOWN_CLASS}
          onMouseDown={e => {
            e.preventDefault();
          }}
        >
          {options.map(o => (
            <OptionRow key={o.value} option={o} onPick={pick} />
          ))}

          {pi !== null ? (
            <>
              {pi.matchTotal > options.length ? (
                <p className="px-3 py-1.5 font-mono text-[10.5px] text-text-tertiary">
                  …{pi.matchTotal - options.length} more — keep typing to narrow.
                </p>
              ) : null}
              {/* Two distinct empty states: an undefined catalog (still
                  loading, or the fetch failed — all panels read K.piModels
                  best-effort and drop the error) is NOT "no match". */}
              {piModels === undefined ? (
                <p className="px-3 py-2 font-mono text-[11px] text-text-tertiary">
                  Catalog unavailable — free text is fine.
                </p>
              ) : null}
              {piModels !== undefined && pi.matchTotal === 0 && pi.hiddenByFilter === 0 ? (
                <p className="px-3 py-2 font-mono text-[11px] text-text-tertiary">
                  No catalog match — custom models.json refs are fine as free text.
                </p>
              ) : null}
              {backends !== null ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowAll(s => !s);
                  }}
                  className={FOOTER_BUTTON_CLASS}
                >
                  {showAll
                    ? 'Show connected backends only'
                    : `Show all backends${pi.hiddenByFilter > 0 ? ` (${String(pi.hiddenByFilter)} more match)` : ''}`}
                </button>
              ) : null}
            </>
          ) : null}

          {shape === 'opencode' ? (
            <OpencodeDropdownFooter
              phase={ocPhase}
              error={ocError}
              optionCount={options.length}
              onLoad={() => void loadOpencode()}
            />
          ) : null}
        </div>
      ) : null}

      {exactPi !== undefined ? (
        <p className="font-mono text-[10.5px] text-text-tertiary">{piModelHint(exactPi)}</p>
      ) : null}
      {disconnectedHint !== null ? (
        <p className="font-mono text-[10.5px] text-warning">{disconnectedHint}</p>
      ) : null}
    </span>
  );
}

/** OpenCode dropdown footer: explicit load affordance + loading/error states. */
function OpencodeDropdownFooter({
  phase,
  error,
  optionCount,
  onLoad,
}: {
  phase: 'idle' | 'loading' | 'loaded' | 'error';
  error: string | null;
  optionCount: number;
  onLoad: () => void;
}): ReactElement {
  if (phase === 'idle') {
    return (
      <div className="flex flex-col gap-1 px-3 py-2">
        <p className="font-mono text-[10.5px] text-text-tertiary">
          Format: <span className="text-text-secondary">backend/model-id</span> (free text).
        </p>
        <button
          type="button"
          onClick={onLoad}
          className="self-start rounded border border-border px-2.5 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
        >
          Load backend suggestions
        </button>
      </div>
    );
  }
  if (phase === 'loading') {
    return (
      <p className="px-3 py-2 font-mono text-[11px] text-text-tertiary">
        Loading backends… (starting the OpenCode runtime can take a moment)
      </p>
    );
  }
  if (phase === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <p className="font-mono text-[11px] text-error">{error}</p>
        <button
          type="button"
          onClick={onLoad}
          className="rounded border border-border px-2.5 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <p className="border-t border-border px-3 py-1.5 font-mono text-[10.5px] text-text-tertiary">
      {optionCount > 0
        ? 'Pick a backend prefix, then type the model id.'
        : 'No backend matches the typed prefix — free text is fine.'}
    </p>
  );
}

/** Sentinel select value that switches the Copilot field to free-text mode. */
const CUSTOM_SENTINEL = '__custom__';

/**
 * Copilot's fixed select (the curated list is hand-maintained, see
 * COPILOT_MODEL_OPTIONS provenance) with a "Custom…" free-text escape. A saved
 * value outside the list renders in custom mode so it's never misdisplayed.
 */
function CopilotModelSelect({
  value,
  onChange,
  disabled = false,
  placeholder,
  ariaLabel,
  className = '',
  selectEmptyLabel,
}: ModelPickerFieldProps): ReactElement {
  const inList = value === '' || COPILOT_MODEL_OPTIONS.some(o => o.value === value);
  const [customMode, setCustomMode] = useState(false);
  const custom = customMode || !inList;

  if (custom) {
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        <input
          value={value}
          onChange={e => {
            onChange(e.target.value);
          }}
          disabled={disabled}
          placeholder={placeholder ?? 'model id'}
          aria-label={ariaLabel}
          autoComplete="off"
          className={`${INPUT_CLASS} ${disabled ? 'opacity-50' : ''}`}
        />
        <button
          type="button"
          onClick={() => {
            setCustomMode(false);
            // A non-curated value can't render in the select — clear it.
            if (!inList) onChange('');
          }}
          disabled={disabled}
          className="shrink-0 rounded border border-border px-2.5 py-1.5 font-mono text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40"
        >
          List
        </button>
      </span>
    );
  }

  return (
    <SelectShell className={className}>
      <select
        value={value}
        onChange={e => {
          if (e.target.value === CUSTOM_SENTINEL) {
            setCustomMode(true);
          } else {
            onChange(e.target.value);
          }
        }}
        disabled={disabled}
        aria-label={ariaLabel}
        className={`${SELECT_CLASS} ${disabled ? 'opacity-50' : ''}`}
      >
        <option value="">{selectEmptyLabel ?? 'Select model…'}</option>
        {COPILOT_MODEL_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.value}
            {o.hint !== undefined ? ` — ${o.hint}` : ''}
          </option>
        ))}
        <option value={CUSTOM_SENTINEL}>Custom…</option>
      </select>
    </SelectShell>
  );
}
