/**
 * Brand registry for the Social Content tab.
 *
 * Each brand owns a subtab and (per 2026-05-10 decision) requires Apollo sequences
 * to be prefixed with the bracket-tag below in Apollo's sequence-name field.
 * Backend will parse the prefix to assign sequences to the correct subtab.
 *
 * Naming convention (REQUIRED in Apollo): `[<APOLLO_PREFIX>] <Sequence Name>`
 * e.g. `[PMC] Cold Outreach v3` or `[BRT] Nesta Pro Demo Funnel`
 *
 * If a sequence has no prefix or an unknown prefix, it surfaces in the
 * "Unassigned" subtab so we can fix or rename in Apollo.
 *
 * See: ~/repos/jid5274/second-brain/specs/apollo-wiring-spec.md
 */

export interface BrandDef {
  /** URL-safe slug used for the subtab route param */
  slug: string;
  /** Display name shown in the subtab */
  label: string;
  /** Required prefix tag in Apollo sequence names */
  apolloPrefix: string;
  /** One-line ICP description (used in the recommendations panel) */
  icp: string;
  /** Adjacent ICPs the recommender can tailor variants for */
  adjacentIcps: string[];
}

export const BRANDS: BrandDef[] = [
  {
    slug: 'pmc',
    label: 'PMC',
    apolloPrefix: 'PMC',
    icp: 'Medical practice owners and administrators (5-50 employees) seeking fractional VP of Sales / Director of BD support.',
    adjacentIcps: [
      'Hospital department heads (specialty clinics)',
      'Practice management consulting firms (sub-contracting)',
      'Healthcare PE-backed roll-ups',
    ],
  },
  {
    slug: 'brt',
    label: 'BRT',
    apolloPrefix: 'BRT',
    icp: 'Wellness clinic owners and physical therapists evaluating clinical devices (Nesta Pro, Cellcom, PEMF) for in-practice use.',
    adjacentIcps: [
      'Chiropractic groups',
      'Sports performance / recovery centers',
      'Concierge medicine practices',
      'Naturopathic doctors',
    ],
  },
  {
    slug: 'ttts',
    label: 'TTTS',
    apolloPrefix: 'TTTS',
    icp: 'Closed-door 12-founder Sarasota session (June 27, 2026). Wellness-tech vendors and clinical device makers as invitation-only attendees, sponsors, and speaker prospects.',
    adjacentIcps: [
      'Healthcare conference organizers',
      'Wellness influencers with clinical credibility',
      'Adjacent device categories (red light, hyperbaric, cold plunge)',
    ],
  },
  {
    slug: 'ewc',
    label: 'EWC',
    apolloPrefix: 'EWC',
    icp: 'Cash-pay-curious providers (concierge, DPC, medspa, functional med) evaluating practice transformation. Three-pillar partnership: premium wellness products + FDA-cleared equipment + AI practice automation.',
    adjacentIcps: [
      'Independent physicians considering cash-pay pivot',
      'Concierge medicine launching add-on services',
      'Direct primary care (DPC) practices scaling vertical',
      'Functional medicine + medspa hybrids',
    ],
  },
  {
    slug: 'naba',
    label: 'NABA',
    apolloPrefix: 'NABA',
    icp: 'Wellness-journey buyers: high-net-worth individuals seeking curated multi-modality recovery and longevity programs.',
    adjacentIcps: [
      'Family office wellness coordinators',
      'Executive concierge medicine clients',
      'Longevity clinic patient pipelines',
    ],
  },
  {
    slug: 'ihht',
    label: 'IHHT',
    apolloPrefix: 'IHHT',
    icp: 'Clinics and trainers offering Intermittent Hypoxic-Hyperoxic Training; performance and recovery practitioners.',
    adjacentIcps: [
      'Altitude training facilities',
      'Cardiac rehabilitation centers',
      'Elite sports teams + Olympic training centers',
    ],
  },
  {
    slug: 'qep',
    label: 'QEP',
    apolloPrefix: 'QEP',
    icp: 'Quantum Energy Practitioners and bioenergetic-medicine clinicians; emerging-modality early adopters.',
    adjacentIcps: [
      'Functional medicine practices',
      'Energy healers transitioning to clinical credibility',
      'Wellness retreats with diagnostic offerings',
    ],
  },
];

/** Quick lookup by slug */
export const BRAND_BY_SLUG: Record<string, BrandDef> = Object.fromEntries(
  BRANDS.map(b => [b.slug, b])
);

/** Quick lookup by Apollo prefix tag (case-insensitive matching done in caller) */
export const BRAND_BY_PREFIX: Record<string, BrandDef> = Object.fromEntries(
  BRANDS.map(b => [b.apolloPrefix.toUpperCase(), b])
);
