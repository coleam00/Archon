/** Hand the triage prompt the pack's default policy documents; it reads `triage.md`. */

import { emit } from '../../.shared/io.ts';
import { writePolicyDefaults } from '../../.shared/policy-defaults.ts';

emit({ defaults: writePolicyDefaults() });
