/** Schemas for the Software Factory section's read-only routes (`api.factory.ts`). */
import { factoryDiscoveriesSchema } from '@archon/workflows/factory-discoveries';
import { factoryItemDetailSchema, factoryProgressSchema } from '@archon/workflows/factory-items';
import { factoryPackSettingsSchema } from '@archon/workflows/factory-pack-settings';
import { factoryWorkflowSchema as factoryWorkflowShape } from '@archon/workflows/schemas/factory-steps';
import { factoryPacksSchema } from '@archon/workflows/schemas/factory-overview';
import { factoryViewsListingSchema } from '@archon/workflows/schemas/factory-view';

export const factoryViewsSchema = factoryViewsListingSchema.meta({ id: 'FactoryViews' });

export const factoryProgressResponseSchema = factoryProgressSchema.meta({ id: 'FactoryProgress' });

export const factoryWorkflowSchema = factoryWorkflowShape.meta({ id: 'FactoryWorkflow' });

export const factoryItemDetailResponseSchema = factoryItemDetailSchema.meta({
  id: 'FactoryItemDetail',
});

export const factoryPacksResponseSchema = factoryPacksSchema.meta({ id: 'FactoryPacks' });

export const factoryDiscoveriesResponseSchema = factoryDiscoveriesSchema.meta({
  id: 'FactoryDiscoveries',
});

export const factoryPackSettingsResponseSchema = factoryPackSettingsSchema.meta({
  id: 'FactoryPackSettings',
});
