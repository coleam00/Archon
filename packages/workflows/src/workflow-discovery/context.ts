import type { WorkflowLoadError } from '../schemas';
import type { loadWorkflowSource, WorkflowSourceRoots } from '../workflow-source';
import type { CommandScanConfig } from './command-scan';
import type { WorkflowParseContext } from './load-dir';

/** What one `discoverWorkflows` call shares across its scopes. */
export interface DiscoveryContext extends WorkflowParseContext {
  cwd: string | null;
  workflowName?: string;
  roots: WorkflowSourceRoots;
  /** Authenticated capture and the payload files verified for this discovery. */
  capture: Awaited<ReturnType<typeof loadWorkflowSource>> | undefined;
  commandScan: CommandScanConfig;
  /**
   * Every load error so far, in discovery order. Include expansion reads it, so a scope
   * expanded later sees the errors of the scopes before it.
   */
  allErrors: WorkflowLoadError[];
}
