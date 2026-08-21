import { useEffect, useState, type ReactElement } from 'react';
import * as skill from '../../skills';

interface SubmitModalProps {
  open: boolean;
  onClose: () => void;
  workflowName: string;
  cwd: string;
}

/** The four self-attestation checklist items, verbatim (CONTRIBUTING.md:114-121 / S9). */
const CHECKLIST_ITEMS: readonly {
  key: keyof skill.MarketplaceSubmitAttestation;
  label: string;
}[] = [
  {
    key: 'noExfiltration',
    label: 'The workflow does not exfiltrate data, credentials, or secrets',
  },
  {
    key: 'noDestructiveOps',
    label: 'The workflow does not execute destructive operations without user confirmation',
  },
  { key: 'rightToShare', label: 'You have the right to share this workflow publicly' },
  {
    key: 'shaReviewed',
    label: 'The pinned SHA points to a reviewed, stable version of your workflow',
  },
] as const;

const EMPTY_ATTESTATION: skill.MarketplaceSubmitAttestation = {
  noExfiltration: false,
  noDestructiveOps: false,
  rightToShare: false,
  shaReviewed: false,
};

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: skill.MarketplaceSubmitResult }
  | { kind: 'error'; message: string };

/**
 * Marketplace Submission (PR-4): the self-attestation checklist gating
 * Submit, plus the result/error surface. Canonical term is "Marketplace
 * Submission" (never "publish/share/upload" in UI copy — CONTEXT.md).
 */
export function SubmitModal({
  open,
  onClose,
  workflowName,
  cwd,
}: SubmitModalProps): ReactElement | null {
  const [attestation, setAttestation] =
    useState<skill.MarketplaceSubmitAttestation>(EMPTY_ATTESTATION);
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  // Reset on every open so a stale success/error from a prior submission
  // doesn't linger if the modal is reopened for a different workflow.
  useEffect(() => {
    if (open) {
      setAttestation(EMPTY_ATTESTATION);
      setState({ kind: 'idle' });
    }
  }, [open, workflowName]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state.kind !== 'submitting') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, state.kind]);

  if (!open) return null;

  const allChecked = CHECKLIST_ITEMS.every(item => attestation[item.key]);
  const canSubmit = allChecked && state.kind !== 'submitting' && state.kind !== 'success';

  const submit = async (): Promise<void> => {
    setState({ kind: 'submitting' });
    try {
      const result = await skill.submitToMarketplace({ workflowName, cwd, attestation });
      setState({ kind: 'success', result });
    } catch (err) {
      setState({ kind: 'error', message: skill.httpErrorToMessage(err) });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Marketplace Submission for ${workflowName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={() => {
        if (state.kind !== 'submitting') onClose();
      }}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative w-full max-w-[560px] overflow-hidden rounded-2xl border bg-surface-elevated p-[22px] text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-[2px] opacity-90" />

        <header className="mb-[18px]">
          <h2 className="text-[18px] font-extrabold tracking-[-0.3px] text-text-primary">
            Marketplace Submission
          </h2>
          <p className="mt-1 truncate font-mono text-[12px] text-text-tertiary">{workflowName}</p>
        </header>

        {state.kind === 'success' ? (
          <SuccessBody result={state.result} onClose={onClose} />
        ) : (
          <>
            <p className="mb-3 text-[13px] leading-relaxed text-text-secondary">
              Archon will bundle this workflow, commit it to this project's repo, and open a pull
              request against the community marketplace registry. By submitting, you attest that:
            </p>

            <ul
              className="mb-3 divide-y divide-border rounded-[11px] border bg-surface"
              style={{ borderColor: 'var(--border)' }}
            >
              {CHECKLIST_ITEMS.map(item => (
                <li key={item.key} className="flex items-start gap-2.5 p-3">
                  <input
                    id={`attest-${item.key}`}
                    type="checkbox"
                    checked={attestation[item.key]}
                    disabled={state.kind === 'submitting'}
                    onChange={e => {
                      setAttestation(prev => ({ ...prev, [item.key]: e.target.checked }));
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-accent-bright"
                  />
                  <label
                    htmlFor={`attest-${item.key}`}
                    className="cursor-pointer text-[13px] leading-snug text-text-primary"
                  >
                    {item.label}
                  </label>
                </li>
              ))}
            </ul>

            {state.kind === 'error' ? (
              <p className="mb-3 rounded-lg border border-error/30 bg-error/10 p-2.5 font-mono text-[11.5px] text-error">
                {state.message}
              </p>
            ) : null}

            <div className="mt-[22px] flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={state.kind === 'submitting'}
                className="rounded-[10px] border bg-transparent px-[18px] py-2.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => {
                  void submit();
                }}
                className="brand-bar rounded-[10px] px-[18px] py-2.5 text-[13px] font-bold text-white transition-all hover:brightness-110 disabled:opacity-40"
              >
                {state.kind === 'submitting' ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SuccessBody({
  result,
  onClose,
}: {
  result: skill.MarketplaceSubmitResult;
  onClose: () => void;
}): ReactElement {
  return (
    <>
      <p className="mb-3 text-[13px] leading-relaxed text-text-secondary">
        {result.action === 'update' ? 'Update' : 'Submission'} opened as a pull request against the
        marketplace registry.
      </p>
      <a
        href={result.prUrl}
        target="_blank"
        rel="noreferrer"
        className="mb-3 block truncate rounded-lg border bg-surface px-3 py-2.5 font-mono text-[12.5px] text-accent-bright hover:underline"
        style={{ borderColor: 'var(--border)' }}
      >
        {result.prUrl}
      </a>
      <div className="mt-[22px] flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="brand-bar rounded-[10px] px-[18px] py-2.5 text-[13px] font-bold text-white transition-all hover:brightness-110"
        >
          Done
        </button>
      </div>
    </>
  );
}
