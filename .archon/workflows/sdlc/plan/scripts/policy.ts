/** Hand the plan prompt the pack's default policy documents; it reads `rulings.md`. */

import { emit } from '../../.shared/io.ts';
import { writePolicyDefaults } from '../../.shared/policy-defaults.ts';

emit({ defaults: writePolicyDefaults() });
