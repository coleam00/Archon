import type { MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import type { ProviderPluginDescriptor } from '@archon/provider-contract/plugin/wire';
import { descriptor as claude } from './claude/descriptor';
import { descriptor as codex } from './codex/descriptor';
import { descriptor as pi } from './community/pi/descriptor';

export const maintainedDescriptors = { claude, codex, pi } satisfies Record<
  (typeof MAINTAINED_PROVIDER_IDS)[number],
  ProviderPluginDescriptor
>;
