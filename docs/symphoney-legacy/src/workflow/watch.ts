import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { loadWorkflowFromPath } from "./loader.js";
import { buildSnapshot, type ConfigSnapshot } from "../config/snapshot.js";
import { validateDispatchConfig } from "../config/validate.js";

export interface WatcherEvents {
  onReload: (snapshot: ConfigSnapshot) => void;
  onError: (err: Error) => void;
}

export interface WorkflowWatcher {
  current(): ConfigSnapshot;
  reloadNow(): Promise<void>;
  close(): Promise<void>;
}

export async function startWorkflowWatcher(
  workflowPath: string,
  events: WatcherEvents,
): Promise<WorkflowWatcher> {
  const initial = await loadAndBuild(workflowPath);
  let snapshot = initial;
  let closing = false;
  let watcher: FSWatcher | null = null;

  const reload = async () => {
    if (closing) return;
    try {
      const next = await loadAndBuild(workflowPath);
      const validation = validateDispatchConfig(next);
      if (!validation.ok) {
        events.onError(
          new Error(`workflow validation failed on reload: ${validation.code}: ${validation.message}`),
        );
        return;
      }
      snapshot = next;
      events.onReload(next);
    } catch (err) {
      events.onError(err as Error);
    }
  };

  watcher = chokidarWatch(workflowPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 75, pollInterval: 25 },
  });
  watcher.on("change", reload);
  watcher.on("add", reload);

  return {
    current: () => snapshot,
    reloadNow: reload,
    async close() {
      closing = true;
      if (watcher) await watcher.close();
    },
  };
}

async function loadAndBuild(workflowPath: string): Promise<ConfigSnapshot> {
  const { definition, absolutePath } = await loadWorkflowFromPath(workflowPath);
  return buildSnapshot(absolutePath, definition);
}
