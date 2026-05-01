import {
  EMOJI_OPTIONS,
  RESPONSE_LENGTH_OPTIONS,
  STATUS_OPTIONS,
  TONE_OPTIONS,
  type AgentDraft,
} from './agent-draft';

interface IdentityTabProps {
  draft: AgentDraft;
  onPatch: (patch: Partial<AgentDraft>) => void;
}

export function IdentityTab({ draft, onPatch }: IdentityTabProps): React.ReactElement {
  function setIdentity<K extends keyof AgentDraft['identity']>(
    key: K,
    value: AgentDraft['identity'][K]
  ): void {
    onPatch({ identity: { ...draft.identity, [key]: value } });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionHeader
          title="Identity"
          hint="Define how your agent thinks, responds, and behaves in any situation."
        />
      </div>

      <Field
        label="Description"
        hint="Used in the registry list and by parent agents to decide when to delegate."
      >
        <input
          type="text"
          value={draft.description}
          onChange={e => {
            onPatch({ description: e.target.value });
          }}
          maxLength={1024}
          className="w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-1.5 text-[13px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
      </Field>

      <Field
        label="System prompt"
        hint="The body of the agent file. Becomes the system prompt sent to the model."
      >
        <textarea
          value={draft.body}
          onChange={e => {
            onPatch({ body: e.target.value });
          }}
          rows={10}
          className="w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-2 font-mono text-[12.5px] leading-relaxed text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          placeholder="You are a friendly support agent for Acme. Always greet users by name and escalate billing issues to a human."
        />
      </Field>

      <Row
        title="Status"
        hint="Active agents are surfaced in pickers; archived ones are hidden by default."
        control={
          <Select
            value={draft.status}
            onChange={v => {
              onPatch({ status: v as AgentDraft['status'] });
            }}
            options={STATUS_OPTIONS}
          />
        }
      />

      <Row
        title="Model"
        hint="Override the default model. Leave empty to inherit from .archon/config.yaml."
        control={
          <input
            type="text"
            value={draft.model}
            onChange={e => {
              onPatch({ model: e.target.value });
            }}
            placeholder="sonnet"
            className="w-32 rounded-md border border-bridges-border bg-bridges-surface px-2 py-1 font-mono text-[12.5px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none"
          />
        }
      />

      <Row
        title="Max turns"
        hint="Cap on multi-turn back-and-forth. Empty for unlimited."
        control={
          <input
            type="number"
            value={draft.maxTurns ?? ''}
            onChange={e => {
              const raw = e.target.value;
              if (raw === '') {
                onPatch({ maxTurns: null });
                return;
              }
              const n = Number(raw);
              if (Number.isFinite(n) && n > 0) onPatch({ maxTurns: Math.floor(n) });
            }}
            placeholder=""
            className="w-20 rounded-md border border-bridges-border bg-bridges-surface px-2 py-1 text-right font-mono text-[12.5px] text-bridges-fg1 focus:border-bridges-border-strong focus:outline-none"
          />
        }
      />

      <div className="mt-2">
        <SectionHeader title="Conversation style" small />
      </div>
      <Row
        title="Response length"
        hint="Control how long or short replies are."
        control={
          <Select
            value={draft.identity.responseLength}
            onChange={v => {
              setIdentity('responseLength', v as AgentDraft['identity']['responseLength']);
            }}
            options={RESPONSE_LENGTH_OPTIONS}
          />
        }
      />
      <Row
        title="Tone"
        hint="Default communication style with users."
        control={
          <Select
            value={draft.identity.tone}
            onChange={v => {
              setIdentity('tone', v as AgentDraft['identity']['tone']);
            }}
            options={TONE_OPTIONS}
          />
        }
      />
      <Row
        title="Emoji"
        hint="How often the agent uses emoji."
        control={
          <Select
            value={draft.identity.emoji}
            onChange={v => {
              setIdentity('emoji', v as AgentDraft['identity']['emoji']);
            }}
            options={EMOJI_OPTIONS}
          />
        }
      />
      <Row
        title="Show source"
        hint="Display source links in agent responses."
        control={
          <Toggle
            value={draft.identity.showSource}
            onChange={v => {
              setIdentity('showSource', v);
            }}
          />
        }
      />
      <Row
        title="Feedback buttons"
        hint="Display thumbs up/down on agent responses."
        control={
          <Toggle
            value={draft.identity.feedbackButtons}
            onChange={v => {
              setIdentity('feedbackButtons', v);
            }}
          />
        }
      />
    </div>
  );
}

function SectionHeader({
  title,
  hint,
  small,
}: {
  title: string;
  hint?: string;
  small?: boolean;
}): React.ReactElement {
  return (
    <div>
      <div
        className={
          small
            ? 'text-[12.5px] font-semibold text-bridges-fg1'
            : 'text-[15px] font-semibold text-bridges-fg1'
        }
      >
        {title}
      </div>
      {hint && <div className="mt-1 text-[12.5px] leading-snug text-bridges-fg2">{hint}</div>}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[12.5px] font-medium text-bridges-fg1">{label}</div>
      {hint && <div className="mb-2 text-[12px] leading-snug text-bridges-fg3">{hint}</div>}
      {children}
    </div>
  );
}

function Row({
  title,
  hint,
  control,
}: {
  title: string;
  hint?: string;
  control: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-bridges-border-subtle py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-bridges-fg1">{title}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-bridges-fg3">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={e => {
        onChange(e.target.value);
      }}
      className="rounded-md border border-bridges-border bg-bridges-surface px-2 py-1 text-[12.5px] text-bridges-fg1 focus:border-bridges-border-strong focus:outline-none"
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => {
        onChange(!value);
      }}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        value ? 'bg-bridges-action' : 'bg-bridges-border'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
