/** Hand the triage prompt the directory holding the pack's default policy documents. */

import { emit } from '../../.shared/io.ts';
import { policyDefaultsDir } from '../../.shared/policy.ts';

emit({ defaults: policyDefaultsDir() });
