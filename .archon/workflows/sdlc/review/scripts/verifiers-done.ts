/**
 * The join settle waits on: it completes once every verifier has settled, whether
 * it voted, failed or was skipped for a Ready verdict. It binds nothing, so a
 * failed verifier cannot fail it; settle separately requires synthesize, whose
 * output it reads.
 */

import { emit } from 'archon:script';

emit({});
