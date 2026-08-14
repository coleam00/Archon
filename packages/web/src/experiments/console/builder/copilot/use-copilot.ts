/**
 * Builder Copilot conversation + Proposal state. Reuses the console chat
 * end-to-end (DB-backed conversation, `useEntity`/SSE invalidation) exactly
 * like `ChatPage` — no dedicated endpoint, no parallel persistence (Pre-flight
 * #2). The pending Proposal is read off the last assistant message's
 * `toolCalls` (post-turn), never off the raw SSE payload.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useConversationSSE } from '../../lib/sse';
import { useEntity, invalidate } from '../../store/cache';
import { K } from '../../store/keys';
import * as skill from '../../skills';
import type { Message } from '../../primitives/message';
import type { BuilderWorkflow } from '../types';
import { toWorkflowDefinition } from '../model';
import type { EditorAction } from '../editor/state';
import { parseAndValidateOps } from './op-schema';
import { computeProposalPreview, type ProposalPreview } from './preview-diff';
import { opsToEditorActions } from './translate-ops';

const PROPOSE_TOOL_NAME = 'propose_workflow_edits';

/**
 * Match the `propose_workflow_edits` tool call by either name a gated provider
 * can persist it under.
 *
 * Claude registers in-process native tools through an MCP server named `archon`,
 * so the call lands in message metadata as `mcp__archon__propose_workflow_edits`
 * (`@archon/providers` `claude/native-tools.ts` — "tools are callable as
 * `mcp__archon__<name>`"). Pi passes the bare `spec.name` through unchanged
 * (`community/pi/native-tools.ts`). Matching only the bare name meant the
 * Proposal never surfaced on Claude at all.
 */
export function isProposeToolCall(name: string): boolean {
  return name === PROPOSE_TOOL_NAME || name.endsWith(`__${PROPOSE_TOOL_NAME}`);
}

export interface CopilotProposal {
  /** Identifies the source tool call so Accept/Reject can be recorded per-call. */
  key: string;
  /** Null only when `invalidReason` is set — an unparseable batch has nothing to preview. */
  preview: ProposalPreview | null;
  actions: readonly EditorAction[];
  /** Set when the tool call's `ops` failed to parse — the batch cannot be previewed or applied. */
  invalidReason: string | null;
}

export interface UseCopilotResult {
  messages: Message[];
  busy: boolean;
  error: string | null;
  proposal: CopilotProposal | null;
  send: (text: string) => Promise<void>;
  /** Returns the batch to hand to `BuilderPage`'s `applyBatch` prop; clears the pending Proposal. */
  accept: () => readonly EditorAction[] | null;
  reject: () => void;
}

/** Builder Copilot conversation + pending-Proposal state for one project + open workflow. */
export function useCopilot(
  projectId: string | undefined,
  currentWorkflow: BuilderWorkflow | null
): UseCopilotResult {
  const [convId, setConvId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tool-call keys the author has already Accepted/Rejected — keeps a resolved
  // Proposal from resurfacing while its message stays the latest assistant turn.
  const [resolvedKeys, setResolvedKeys] = useState<ReadonlySet<string>>(new Set());

  const messagesKey = convId !== null ? K.messages(convId) : 'noop:no-copilot-conv';
  const { data: messages } = useEntity<Message[]>(messagesKey, () =>
    convId !== null ? skill.listMessages(convId) : Promise.resolve([])
  );

  const onLockChange = useCallback((locked: boolean): void => {
    if (!locked) setBusy(false);
  }, []);
  useConversationSSE(convId, onLockChange);

  const messageList = useMemo(() => messages ?? [], [messages]);

  const pendingCall = useMemo(() => {
    for (let i = messageList.length - 1; i >= 0; i -= 1) {
      const m = messageList[i];
      if (m?.role !== 'assistant') continue;
      // Keyed per CALL, not per message: the tool description asks for one call
      // per proposal, but nothing enforces it. Keying by message id alone made a
      // second call in the same turn invisible forever, and let resolving the
      // first silently resolve it too. Surface them oldest-first, one at a time.
      const calls = m.toolCalls
        .map((c, index) => ({ c, index }))
        .filter(({ c }) => isProposeToolCall(c.name));
      if (calls.length === 0) continue;
      for (const { c, index } of calls) {
        const key = `${m.id}:${PROPOSE_TOOL_NAME}:${index.toString()}`;
        if (!resolvedKeys.has(key)) return { key, input: c.input };
      }
      return null;
    }
    return null;
  }, [messageList, resolvedKeys]);

  const proposal = useMemo<CopilotProposal | null>(() => {
    if (pendingCall === null || currentWorkflow === null) return null;
    const raw = typeof pendingCall.input.ops === 'string' ? pendingCall.input.ops : '';
    const parsed = parseAndValidateOps(raw);
    if (!parsed.ok) {
      return { key: pendingCall.key, preview: null, actions: [], invalidReason: parsed.error };
    }
    const preview = computeProposalPreview(currentWorkflow, parsed.ops);
    const { actions } = opsToEditorActions(parsed.ops, currentWorkflow);
    return { key: pendingCall.key, preview, actions, invalidReason: null };
  }, [pendingCall, currentWorkflow]);

  // Guards against a StrictMode/double-invocation issuing two conversation creates
  // for the same first send — createConversation is called at most once per mount.
  const creatingRef = useRef<Promise<string> | null>(null);

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (projectId === undefined || currentWorkflow === null) return;
      setError(null);
      setBusy(true);
      try {
        let id = convId;
        if (id === null) {
          if (creatingRef.current === null) {
            creatingRef.current = skill
              .createConversation(projectId)
              .then(conv => conv.conversationId)
              .catch((e: unknown) => {
                // Without this the ref keeps the REJECTED promise, so every later
                // send awaits the same rejection and the panel is permanently
                // unusable until remount. Clear it so the next send can retry.
                creatingRef.current = null;
                throw e;
              });
          }
          id = await creatingRef.current;
          setConvId(id);
        }
        const canvasState = JSON.stringify(toWorkflowDefinition(currentWorkflow));
        await skill.sendMessage(id, text, undefined, { builderMode: true, canvasState });
        invalidate(K.messages(id));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        setBusy(false);
      }
      // On success `busy` stays true until the conversation-lock SSE event clears it.
    },
    [projectId, currentWorkflow, convId]
  );

  const accept = useCallback((): readonly EditorAction[] | null => {
    // `proposal?.` also covers the null-proposal case: `undefined !== null` is true,
    // so we return early and TS narrows `proposal` to non-null below.
    if (proposal?.invalidReason !== null) return null;
    // A Proposal is atomic: a batch carrying any error-severity issue is never
    // partially applied. `ProposalPreview` also disables the Accept button, but
    // the invariant belongs here — a second caller (keyboard shortcut, an
    // "accept all" affordance) must not be able to bypass a UI-only guard.
    if (proposal.preview?.issues.some(i => i.severity === 'error') === true) return null;
    setResolvedKeys(prev => new Set(prev).add(proposal.key));
    return proposal.actions;
  }, [proposal]);

  const reject = useCallback((): void => {
    if (proposal === null) return;
    setResolvedKeys(prev => new Set(prev).add(proposal.key));
  }, [proposal]);

  return { messages: messageList, busy, error, proposal, send, accept, reject };
}
