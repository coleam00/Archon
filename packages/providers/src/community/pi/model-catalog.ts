/**
 * Read-only view of Pi's model catalog (built-in models.dev snapshot merged
 * with the user's ~/.pi/agent/models.json). Serves the console's cost/speed
 * hint next to tier models — a HINT surface only: lookups are best-effort and
 * never block tier/alias saves.
 *
 * The Pi SDK is loaded lazily (same constraint as provider.ts — the SDK's
 * config.js reads a package.json at module init, which crashes inside a
 * compiled binary without the PI_PACKAGE_DIR shim).
 */
import { createLogger } from '@archon/paths';
import { ensurePiPackageDirShim } from './provider';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('pi-model-catalog');
  return cachedLog;
}

/** One Pi catalog entry — metadata only, no credentials. */
export interface PiModelInfo {
  /** Full Archon model ref as used in `model:` fields: '<pi-provider>/<model-id>' */
  ref: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** USD per million tokens. */
  cost: { input: number; output: number };
  contextWindow: number;
}

let cachedCatalog: PiModelInfo[] | null = null;

/**
 * List Pi's model catalog. Cached per process (the built-in catalog is a
 * static snapshot; models.json edits need a restart to show in the hint —
 * acceptable for a hint surface). Returns `[]` on any failure: this powers
 * a UI hint, so degrading to "no hint" beats failing the settings page.
 */
export async function listPiModels(): Promise<PiModelInfo[]> {
  if (cachedCatalog !== null) return cachedCatalog;
  try {
    ensurePiPackageDirShim();
    const piCodingAgent = await import('@earendil-works/pi-coding-agent');
    const authStorage = piCodingAgent.AuthStorage.create();
    const registry = piCodingAgent.ModelRegistry.create(authStorage);
    cachedCatalog = registry.getAll().map(m => ({
      ref: `${m.provider}/${m.id}`,
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      cost: { input: m.cost.input, output: m.cost.output },
      contextWindow: m.contextWindow,
    }));
    return cachedCatalog;
  } catch (err) {
    // Intentional fallback: the catalog is a hint, not a dependency.
    getLog().warn({ err: err as Error }, 'pi.model_catalog_list_failed');
    return [];
  }
}
