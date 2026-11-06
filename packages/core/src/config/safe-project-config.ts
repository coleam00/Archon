import { toSafeConfig } from './config-loader';
import type { MergedConfig, SafeProjectConfig } from './config-types';

/** Project a repo's MergedConfig for clients: the safe subset plus its env key names. */
export function toSafeProjectConfig(config: MergedConfig): SafeProjectConfig {
  return {
    config: toSafeConfig(config),
    envKeys: Object.keys(config.envVars ?? {}).sort(),
  };
}
