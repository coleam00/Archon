import type { IWorkflowPlatform } from './deps';
import { spellWorkflowCommand } from './deps';
import type { WorkflowGateStore } from './store';
import { getWorkflowEventEmitter } from './event-emitter';

export async function presentWorkflowGate(
  store: WorkflowGateStore,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string
): Promise<void> {
  const gate = await store.claimWorkflowGatePresentation(runId);
  if (!gate) return;
  const interactive = gate.context.type === 'interactive_loop';
  const heading = interactive ? 'Input required' : 'Approval required';
  const approve = `approve ${gate.runId} --gate ${gate.id}${interactive ? ' <your feedback>' : ''}`;
  const message =
    `⏸ **${heading}**: ${gate.context.message}\n\n` +
    `Run ID: \`${gate.runId}\`\n` +
    `${interactive ? 'Respond' : 'Approve'}: \`${spellWorkflowCommand(platform, approve)}\` | ` +
    `${interactive ? 'Cancel' : 'Reject'}: \`${spellWorkflowCommand(platform, `reject ${gate.runId} --gate ${gate.id}`)}\``;
  try {
    await platform.sendMessage(conversationId, message);
  } catch (cause) {
    const error = new Error(`Gate message failed to deliver for node '${gate.context.nodeId}'`, {
      cause,
    });
    const result = await store.failWorkflowGatePresentation(runId, gate.id, error.message);
    if (result.failed) throw error;
    return;
  }
  const { active } = await store.confirmWorkflowGatePresentation(runId, gate.id);
  if (!active) return;
  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId: gate.runId,
    nodeId: gate.context.nodeId,
    message: gate.context.message,
    gateId: gate.id,
  });
}
