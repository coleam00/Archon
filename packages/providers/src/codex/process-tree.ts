import { terminateTree } from '@archon/paths/plugin-process';

/** Stop the dedicated POSIX process group after its app-server exits. */
export async function stopAppServerDescendants(pid: number): Promise<void> {
  // Windows post-exit containment is deferred; an exited root cannot prove tree ownership.
  if (process.platform !== 'win32') await terminateTree(pid);
}
