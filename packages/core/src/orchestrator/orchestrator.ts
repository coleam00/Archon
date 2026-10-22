/**
 * Public entry for a conversation's isolation resolution and for background workflow
 * dispatch. Their phases live beside the other dispatch phases in ./dispatch/.
 */
export {
  ensureIsolationConfigured,
  validateAndResolveIsolation,
} from './dispatch/isolation-resolver';
export { dispatchBackgroundWorkflow, type WorkflowRoutingContext } from './dispatch/background';
