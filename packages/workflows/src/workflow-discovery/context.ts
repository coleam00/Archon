import type { WorkflowLoadError } from '../schemas';
import type { loadWorkflowSource, WorkflowSourceRoots } from '../workflow-source';
import type { CommandScanConfig } from './command-scan';
import type { WorkflowParseContext } from './load-dir';

/** What one `discoverWorkflows` call shares across its scopes. */
export interface DiscoveryContext extends WorkflowParseContext {
  cwd: string | null;
  roots: WorkflowSourceRoots;
  /** The verified capture when `roots` are a run's frozen source. */
  capture: Awaited<ReturnType<typeof loadWorkflowSource>> | undefined;
  commandScan: CommandScanConfig;
  /**
   * Every load error so far, in discovery order. Include expansion reads it, so a scope
   * expanded later sees the errors of the scopes before it.
   */
  allErrors: WorkflowLoadError[];
}
