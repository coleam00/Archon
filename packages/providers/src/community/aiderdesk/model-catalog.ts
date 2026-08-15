/**
 * AiderDesk model catalog — fetches available models from AiderDesk's REST API.
 *
 * Mirrors Pi's listPiModels() pattern: fetch from the backend, map to a
 * provider-neutral ModelInfo shape.
 */
import { AiderDeskClient } from './client';
import type { AiderDeskModelInfo } from './types';

/**
 * Fetch available models from the AiderDesk backend and map them to
 * Archon's provider/model ref format ('providerId/modelId').
 *
 * Best-effort: returns an empty array on any error (network failure,
 * AiderDesk not running, etc.) — never throws. Callers (tier picker UI,
 * CLI) handle the empty case gracefully.
 */
export async function listAiderdeskModels(client?: AiderDeskClient): Promise<AiderDeskModelInfo[]> {
  try {
    const c = client ?? new AiderDeskClient();
    const models = await c.getModels();

    return models.map(m => ({
      id: m.id,
      providerId: m.providerId,
      ref: `${m.providerId}/${m.id}`,
    }));
  } catch {
    // Best-effort — AiderDesk may not be running, or the network may be down.
    // Return empty so callers don't crash.
    return [];
  }
}
