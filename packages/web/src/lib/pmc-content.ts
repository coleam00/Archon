import overviewRaw from '@second-brain/businesses/pmc/overview.md?raw';
import { parseFrontmatter, type PmcDoc } from './pmc-frontmatter';

export type { PmcDoc } from './pmc-frontmatter';

export interface PmcClient extends PmcDoc {
  slug: string;
}

export const pmcOverview: PmcDoc = parseFrontmatter(overviewRaw);

// Client engagements (ewc, precision-health) intentionally omitted from
// public static build -- internal client work, not for public pages.
// See feat/pmc-tab for the full internal-build version.
export const pmcClients: PmcClient[] = [];
