import overviewRaw from '@second-brain/businesses/pmc/clients/fountain-wpb/overview.md?raw';
import { BusinessPage, type BusinessProspect } from '@/components/business/BusinessPage';
import prospectsData from '@/lib/business-prospects.generated.json';

const VAULT_PATH = 'second-brain/businesses/pmc/clients/fountain-wpb/overview.md';

const PROSPECTS = (prospectsData.by_business as Record<string, BusinessProspect[]>).Fountain ?? [];

const VALUE_PROPS = [
  {
    title: 'Luxury wellness destination',
    body: 'West Palm Beach high-performance venue. Premium audience and longevity ICP overlap directly with BioReg + Cellcom target market.',
  },
  {
    title: 'Cross-brand showcase',
    body: 'BioReg, Cellcom, IHHT, QEP all natural product fits at the venue. Single client engagement opens 4 product surfaces.',
  },
  {
    title: 'Referral flywheel',
    body: 'Executive clientele drives high-LTV referral pipeline back to PMC fractional advisory and direct device sales.',
  },
];

const SECTIONS = [
  {
    heading: 'Engagement',
    items: [
      {
        slug: 'key-contact',
        title: 'Key contact',
        description: 'Blake Baynham (title / email / phone — pending intake)',
        badge: 'intake needed',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'origin',
        title: 'Partnership origin',
        description: 'QEP (Quantum Executive Protocol) ecosystem → elevated to core 2026-06-03',
      },
      {
        slug: 'segment',
        title: 'Segment',
        description: 'Luxury wellness / longevity destination · West Palm Beach, FL',
      },
    ],
  },
  {
    heading: 'Cross-brand pull-through',
    items: [
      {
        slug: 'bioreg',
        title: 'BioReg / Cellcom',
        description: 'Cellular optimization layer — performance + recovery story',
        to: '/brt',
      },
      {
        slug: 'qep',
        title: 'QEP',
        description: 'Quantum Executive Protocol — partnership origin',
        to: '/qep',
      },
      {
        slug: 'ihht',
        title: 'IHHT',
        description: 'Intermittent Hypoxia-Hyperoxia training adjunct',
        to: '/ihht',
      },
      {
        slug: 'pmc',
        title: 'PMC advisory',
        description: 'Fractional leadership / cash-pay practice transformation',
        to: '/pmc',
      },
    ],
  },
  {
    heading: 'Next actions',
    items: [
      {
        slug: 'intake',
        title: 'Capture key-contact details',
        description: 'Title, email, phone for Blake Baynham',
        badge: 'pending',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'scope',
        title: 'Define engagement scope',
        description: 'Contract / SOW / cadence with Jason',
        badge: 'pending',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'deliverables',
        title: 'List active deliverables',
        description: 'Protocols, content, ops support in flight',
      },
      {
        slug: 'pipeline',
        title: 'List pipeline opportunities',
        description: 'Which BRT / Cellcom / PMC offerings are in play',
      },
    ],
  },
];

const KPIS = [
  { label: 'Tier', value: 'Core' },
  { label: 'Status', value: 'Active' },
  { label: 'Segment', value: 'Luxury wellness' },
  { label: 'Elevated', value: '2026-06-03' },
];

export function FountainPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="The Fountain — West Palm Beach"
      taglineOverride="Core PMC client · Luxury wellness / longevity destination · West Palm Beach, FL"
      statusText="Core client"
      statusTone="emerald"
      kpis={KPIS}
      valueProps={VALUE_PROPS}
      sections={SECTIONS}
      prospects={PROSPECTS}
      prospectsHeading="Fountain WPB contacts"
      prospectsSubtitle="Key contact + audience — engagement scope intake pending"
      vaultPath={VAULT_PATH}
    />
  );
}
