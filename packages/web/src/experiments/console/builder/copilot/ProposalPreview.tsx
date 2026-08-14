/**
 * The atomic Proposal preview: a summary of what the batch would do, the
 * would-be issues, and the Accept/Reject controls. Renders inline in the
 * Copilot chat stream, right after the assistant turn that proposed it.
 */
import type { ReactElement } from 'react';
import type { CopilotProposal } from './use-copilot';

const GHOST_LABEL: Record<'add' | 'changed' | 'remove', string> = {
  add: 'Add',
  changed: 'Change',
  remove: 'Remove',
};

interface ProposalPreviewProps {
  proposal: CopilotProposal;
  onAccept: () => void;
  onReject: () => void;
}

export function ProposalPreview({
  proposal,
  onAccept,
  onReject,
}: ProposalPreviewProps): ReactElement {
  if (proposal.invalidReason !== null || proposal.preview === null) {
    return (
      <div className="rounded-[10px] border border-error/30 bg-error/10 px-3 py-2.5 text-[12.5px] text-text-secondary">
        <p className="text-error">
          The proposed edits couldn't be read: {proposal.invalidReason ?? 'unknown error'}.
        </p>
        <button
          type="button"
          onClick={onReject}
          className="mt-2 rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          Dismiss
        </button>
      </div>
    );
  }

  const { preview } = proposal;
  const entries = [...preview.ghosts.entries()];
  const blockingIssues = preview.issues.filter(i => i.severity === 'error');
  const canAccept = blockingIssues.length === 0 && entries.length > 0;

  return (
    <div className="rounded-[10px] border border-border bg-surface-elevated px-3 py-2.5">
      <div className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-tertiary">
        Proposed edit{entries.length === 1 ? '' : 's'} ({entries.length.toString()})
      </div>
      <ul className="mb-2 space-y-0.5">
        {entries.map(([id, kind]) => (
          <li
            key={id}
            className={`font-mono text-[12px] ${kind === 'remove' ? 'text-error line-through' : 'text-text-secondary'}`}
          >
            {GHOST_LABEL[kind]} <span className="text-text-primary">{id}</span>
          </li>
        ))}
      </ul>
      {preview.issues.length > 0 ? (
        <div className="mb-2 space-y-1 border-t border-border/60 pt-2">
          {preview.issues.map(issue => (
            <p
              key={issue.id}
              className={`text-[11.5px] ${issue.severity === 'error' ? 'text-error' : 'text-warning'}`}
            >
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canAccept}
          onClick={onAccept}
          title={
            blockingIssues.length > 0
              ? 'Accept is blocked while this batch has an error — Reject and ask again.'
              : undefined
          }
          className="rounded-[8px] bg-accent-bright px-3 py-1 text-[12px] font-semibold text-white/95 transition-opacity hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={onReject}
          className="rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
