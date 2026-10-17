import type { AssertNever, PiExtensionPosture } from '@archon/provider-contract';
import type { PiNodeConfig } from './schemas/dag-node';

export type AuthoringPostureHasEveryContractKey = AssertNever<
  Exclude<keyof PiExtensionPosture, keyof PiNodeConfig>
>;
export type AuthoringPostureHasNoExtraKeys = AssertNever<
  Exclude<keyof PiNodeConfig, keyof PiExtensionPosture>
>;
export type AuthoringPostureAcceptsTheContract = AssertNever<
  PiExtensionPosture extends PiNodeConfig ? never : 'incompatible authoring posture'
>;
export type ContractAcceptsTheAuthoringPosture = AssertNever<
  PiNodeConfig extends PiExtensionPosture ? never : 'incompatible provider posture'
>;
