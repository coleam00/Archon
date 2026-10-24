/** Copy the holdout agents' instructions into this run's artifacts, where their prompts point. */

import { copyBriefs } from '../../.shared/briefs.ts';

copyBriefs(['holdout-verifier', 'holdout-writer']);
