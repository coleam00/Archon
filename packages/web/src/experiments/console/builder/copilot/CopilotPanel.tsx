/**
 * The Builder Copilot chat panel. Reuses the console chat components
 * (`ChatStream`/`ChatComposer`) end-to-end — same DB-backed conversation, same
 * SSE-as-invalidation-signal pattern as `ChatPage` — and renders the pending
 * Proposal (if any) as an inline `ProposalPreview` after the latest turn.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { ChatStream } from '../../components/ChatStream';
import { ChatComposer } from '../../components/ChatComposer';
import { StreamContextProvider } from '../../lib/stream-context';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { listProviders, type ProviderInfo } from '../../skills/providers';
import { getConfig, type ConfigResponse } from '../../skills/settings';
import type { BuilderWorkflow } from '../types';
import type { EditorAction } from '../editor/state';
import { useCopilot } from './use-copilot';
import { ProposalPreview } from './ProposalPreview';
import type { ProposalPreview as ProposalPreviewData } from './preview-diff';

interface CopilotPanelProps {
  projectId: string | undefined;
  currentWorkflow: BuilderWorkflow | null;
  /** Reports the live preview overlay (or null) so `BuilderConnected` can feed `BuilderPage.preview`. */
  onPreviewChange: (preview: ProposalPreviewData | null) => void;
  /** Fired on Accept with the batch to apply — the parent dispatches it via `BuilderPage.applyBatch`. */
  onAccept: (actions: readonly EditorAction[]) => void;
  /**
   * True while an accepted batch is still being applied by `BuilderPage`. During
   * that window `currentWorkflow` is still the PRE-batch one, so sending would
   * serialize a stale canvas — the composer stays closed until it lands.
   */
  applying?: boolean;
}

export function CopilotPanel({
  projectId,
  currentWorkflow,
  onPreviewChange,
  onAccept,
  applying = false,
}: CopilotPanelProps): ReactElement {
  const { messages, busy, error, proposal, send, accept, reject } = useCopilot(
    projectId,
    currentWorkflow
  );

  // Report the live preview upward only when it actually changes — mirrors
  // BuilderPage's own onChange-reporting guard so StrictMode's double-invoke
  // can't loop the parent's preview state.
  const lastReported = useRef<ProposalPreviewData | null>(null);
  useEffect(() => {
    const next = proposal?.preview ?? null;
    if (next === lastReported.current) return;
    lastReported.current = next;
    onPreviewChange(next);
  }, [proposal, onPreviewChange]);

  const providersView = useEntity<ProviderInfo[]>(K.providers, () => listProviders());
  const configView = useEntity<ConfigResponse>(K.config, () => getConfig());
  const activeProviderId = configView.data?.config.assistant;
  const activeProvider = (providersView.data ?? []).find(p => p.id === activeProviderId);
  // Undefined while either call is still loading — don't flash the "needs
  // Claude or Pi" note before we actually know the active provider.
  const canDriveCanvas =
    activeProvider !== undefined ? activeProvider.capabilities.nativeTools : undefined;

  const handleAccept = (): void => {
    const actions = accept();
    if (actions !== null && actions.length > 0) onAccept(actions);
  };

  return (
    <div className="flex w-[380px] shrink-0 flex-col border-l border-border bg-surface">
      <header className="border-b border-border px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-text-primary">Builder Copilot</h2>
        <p className="text-[11px] text-text-tertiary">
          Describe the edit you want — review and accept before it lands on the canvas.
        </p>
      </header>

      {canDriveCanvas === false ? (
        <div className="border-b border-warning/30 bg-warning/10 px-3 py-2 text-[11.5px] text-text-secondary">
          Copilot needs Claude or Pi to edit the canvas —{' '}
          {activeProvider?.displayName ?? 'the active assistant'} can still answer questions, but
          can't propose edits.
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {currentWorkflow === null ? (
          <p className="text-[12px] text-text-tertiary">
            Open a workflow to chat with the Copilot.
          </p>
        ) : messages.length === 0 ? (
          <p className="text-[12px] text-text-tertiary">
            Ask for a canvas change, e.g. "add an approval gate after the first node."
          </p>
        ) : (
          <StreamContextProvider value={{ runStartedAt: null }}>
            <ChatStream messages={messages} />
          </StreamContextProvider>
        )}
        {proposal !== null ? (
          <div className="mt-2">
            <ProposalPreview proposal={proposal} onAccept={handleAccept} onReject={reject} />
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <div className="border-t border-error/30 bg-error/10 px-3 py-2 font-mono text-[11px] text-error">
          {error}
        </div>
      ) : null}

      <ChatComposer
        onSend={text => {
          void send(text);
        }}
        disabled={busy || applying || currentWorkflow === null}
        disabledReason={
          currentWorkflow === null
            ? 'Open a workflow first.'
            : applying
              ? 'Applying the accepted edits…'
              : undefined
        }
      />
    </div>
  );
}
