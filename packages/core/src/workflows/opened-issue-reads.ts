/**
 * The engine's side of opened-issue reads: their first sight, the `since` each later pass
 * lists from, and the guard that keeps a source to that `since`. Split from
 * `source-plugins.ts`, which calls it once per observe pass.
 */
import type {
  ObservedOpenedIssueRead,
  SourceForgeReader,
} from '@archon/workflows/webhook-source-plugin';

/**
 * The delivery id of the receipt that says an opened-issue read has been observed once: an
 * issue opened before its time starts nothing. A persisted contract as the label one is.
 */
export function openedSeenMarker(read: ObservedOpenedIssueRead): string {
  return `observe:issue-opened-seen:${read.bindingId}:${read.repo.host}/${read.repo.path}`;
}

/**
 * How far an opened-issue read looks back past the start of its last clean pass: the
 * forge's clock against this host's, and an issue the forge lists a little after creating
 * it. Issues read twice are replays, so the overlap costs no start.
 */
const OPENED_OVERLAP_MS = 10 * 60 * 1000;

type HandedRead = ObservedOpenedIssueRead & { since: string };

/** One pass's opened-issue reads. */
export interface OpenedIssuePass {
  /** The reads past their first sight, each with the `since` to list from. */
  handed: HandedRead[];
  /** The reads seen for the first time: their marker is recorded and nothing is listed. */
  unseen: ObservedOpenedIssueRead[];
  /** `forge` with `issuesOpened` refused for any repository or `since` not handed. */
  forge: SourceForgeReader;
  /** After the pass: a clean one moves each read's next `since` up to its start. */
  settle(clean: boolean): void;
}

/**
 * The opened-issue reads of one plugin host. It remembers, per read, the `since` its next
 * pass lists from, once a pass had no failure; a new process lists from the first sight.
 */
export function openedIssueReads(): {
  pass(input: {
    sourceInstanceId: string;
    reads: readonly ObservedOpenedIssueRead[];
    passStartedAt: string;
    forge: SourceForgeReader;
    /** The read's seen marker, as recorded: its time is the first-sight cutoff. */
    marker: (read: ObservedOpenedIssueRead) => Promise<{ occurredAt: string | null } | null>;
  }): Promise<OpenedIssuePass>;
} {
  const nextSince = new Map<string, string>();
  return {
    async pass({ sourceInstanceId, reads, passStartedAt, forge, marker }) {
      const key = (read: ObservedOpenedIssueRead): string =>
        JSON.stringify([sourceInstanceId, read.bindingId, read.repo.host, read.repo.path]);
      const handed: HandedRead[] = [];
      const unseen: ObservedOpenedIssueRead[] = [];
      for (const read of reads) {
        const cutoff = (await marker(read))?.occurredAt ?? null;
        if (cutoff === null) {
          unseen.push(read);
          continue;
        }
        const later = nextSince.get(key(read));
        const since =
          later !== undefined && Date.parse(later) > Date.parse(cutoff) ? later : cutoff;
        handed.push({ ...read, since });
      }
      // A plugin lists opened issues only from the `since` it was handed, so it cannot start
      // an issue opened before the read's first sight.
      const isHanded = (repo: HandedRead['repo'], since: string): boolean =>
        handed.some(
          read =>
            read.repo.host === repo.host && read.repo.path === repo.path && read.since === since
        );
      return {
        handed,
        unseen,
        forge: {
          ...forge,
          issuesOpened: async request => {
            if (!isHanded(request.repo, request.since))
              throw new Error(
                `No opened-issue read of '${request.repo.host}/${request.repo.path}' lists from ${request.since} in this pass`
              );
            return forge.issuesOpened(request);
          },
        },
        settle(clean) {
          if (!clean) return;
          const next = new Date(Date.parse(passStartedAt) - OPENED_OVERLAP_MS).toISOString();
          for (const read of handed)
            if (Date.parse(next) > Date.parse(read.since)) nextSince.set(key(read), next);
        },
      };
    },
  };
}
