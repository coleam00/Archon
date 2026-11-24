import type { QueryParams } from '../lib/api-types';
import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

export type FactoryViews = components['schemas']['FactoryViews'];
export type FactoryProgress = components['schemas']['FactoryProgress'];
export type FactoryItemDetail = components['schemas']['FactoryItemDetail'];
/**
 * One item's engine read (`GET /api/items/window`) joined with its progress
 * (`GET /api/factory/progress`), null when the server could not derive it: the shape the
 * item detail's `item` has, which is the item read's schema extended with `progress`.
 */
export type FactoryItem = FactoryItemDetail['item'];
/** What the board needs of one item beyond its read. */
export type FactoryItemProgress = NonNullable<FactoryItem['progress']>;

/** The factory views that apply to one project, and declarations that failed, with their files. */
export async function getFactoryViews(
  opts: QueryParams<'/api/factory/views', 'get'>,
  init: { signal?: AbortSignal } = {}
): Promise<FactoryViews> {
  return requestJson('/api/factory/views', 'get', { query: opts, signal: init.signal });
}

export type FactoryWorkflow = components['schemas']['FactoryWorkflow'];

/** One workflow a project's factory view names: its steps, loop groups and includes. */
export async function getFactoryWorkflow(
  opts: QueryParams<'/api/factory/workflow', 'get'>,
  init: { signal?: AbortSignal } = {}
): Promise<FactoryWorkflow> {
  return requestJson('/api/factory/workflow', 'get', { query: opts, signal: init.signal });
}

/** The board progress of the items `keys` names, by key; a key with no item is left out. */
export async function getFactoryProgress(
  opts: QueryParams<'/api/factory/progress', 'get'>,
  init: { signal?: AbortSignal } = {}
): Promise<FactoryProgress> {
  return requestJson('/api/factory/progress', 'get', { query: opts, signal: init.signal });
}

/** One item, its read and progress, with each of its runs' timeline facts. */
export async function getFactoryItem(
  opts: QueryParams<'/api/factory/item', 'get'>,
  init: { signal?: AbortSignal } = {}
): Promise<FactoryItemDetail> {
  return requestJson('/api/factory/item', 'get', { query: opts, signal: init.signal });
}

export type FactoryPacksRead = components['schemas']['FactoryPacks'];

/** Every pack with a factory overview file, which overview its page shows, and the projects that run it. */
export async function getFactoryPacks(
  init: { signal?: AbortSignal } = {}
): Promise<FactoryPacksRead> {
  return requestJson('/api/factory/packs', 'get', { signal: init.signal });
}

export type FactoryDiscoveries = components['schemas']['FactoryDiscoveries'];

/** What the project's discoveries drains decided to file, held and dropped. */
export async function getFactoryDiscoveries(
  opts: QueryParams<'/api/factory/discoveries', 'get'>,
  init: { signal?: AbortSignal } = {}
): Promise<FactoryDiscoveries> {
  return requestJson('/api/factory/discoveries', 'get', { query: opts, signal: init.signal });
}

export type FactoryPackSettings = components['schemas']['FactoryPackSettings'];

/** A pack's declared settings, in its order, and what each project that runs it sets. */
export async function getFactoryPackSettings(
  opts: QueryParams<'/api/factory/pack-settings', 'get'>,
  init: { signal?: AbortSignal } = {}
): Promise<FactoryPackSettings> {
  return requestJson('/api/factory/pack-settings', 'get', { query: opts, signal: init.signal });
}
