import type { To } from 'react-router';

/** A project's Overview tab, where the curated map and its stage modal are drawn. */
export function overviewPath(projectId: string): string {
  return `/console/p/${encodeURIComponent(projectId)}/overview`;
}

/** An item's run log, where a map or stage modal row opens it: the console has no item page. */
export function runLogPath(projectId: string, runId: string): string {
  return `/console/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(runId)}`;
}

/** A link that opens a stage as the modal over the Overview's map. */
export interface StageModalLink {
  to: To;
  /**
   * Marks the entry the link pushed, so closing the modal goes back to the entry before it;
   * `tab` opens it on that tab rather than the stage's first.
   */
  state: { stageModal: true; tab?: StageTab };
}

/** The tabs a stage opens on: what it does, the items in it, its real workflow. */
export type StageTab = 'does' | 'items' | 'workflow';

/**
 * The Overview with `stage` open as a modal over its map: `?stage=<id>`, pushed, so Back closes
 * it, and on `tab` when one is given.
 */
export function stageModalLink(projectId: string, stage: string, tab?: StageTab): StageModalLink {
  return {
    to: { pathname: overviewPath(projectId), search: `?stage=${encodeURIComponent(stage)}` },
    state: tab === undefined ? { stageModal: true } : { stageModal: true, tab },
  };
}

/** A pack's How it works in the console's sidebar, by the pack's key (`owner.name` when installed). */
export function factoryPackPath(packKey: string, rest = '/how-it-works'): string {
  return `/console/factory/${encodeURIComponent(packKey)}${rest}`;
}
