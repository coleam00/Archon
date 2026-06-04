import overviewRaw from '@second-brain/businesses/pmc/ttts/overview.md?raw';
import { BusinessPage } from '@/components/business/BusinessPage';

const VAULT_PATH = 'second-brain/businesses/pmc/ttts/overview.md';

const SECTIONS = [
  {
    heading: 'June 27 closed-door session',
    items: [
      {
        slug: 'format',
        title: '12-founder session',
        description: 'Closed-door, invitation-only · Sarasota, FL',
        badge: 'event',
        badgeTone: 'sky' as const,
      },
      {
        slug: 'goal',
        title: 'Outcome target',
        description: '8 of 12 founders book follow-up by July 11',
      },
      {
        slug: 'role',
        title: 'BD asset',
        description: 'Feeds Lines #1-2 (BRT BH, Chiro/Medspa). Not the engagement timeline driver.',
      },
    ],
  },
  {
    heading: 'Adjacent ICPs',
    items: [
      {
        slug: 'organizers',
        title: 'Healthcare conference organizers',
        description: 'Cross-event partnership opportunities',
      },
      {
        slug: 'influencers',
        title: 'Wellness influencers with clinical credibility',
        description: 'Founder-network referral path',
      },
      {
        slug: 'device-categories',
        title: 'Adjacent device categories',
        description: 'Red light, hyperbaric, cold plunge',
      },
    ],
  },
  {
    heading: 'Sub-pages in vault',
    items: [
      {
        slug: 'content-roadmap',
        title: 'Content roadmap',
        description: 'content-roadmap.md — 10-week TTTS content plan',
      },
    ],
  },
];

const KPIS = [
  { label: 'Event date', value: 'Jun 27, 2026' },
  { label: 'Format', value: '12 founders' },
  { label: 'Composite rank', value: 'Priority #6' },
  { label: 'Follow-up target', value: '8/12 by 7/11' },
];

export function TTSPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="TTTS — Therapeutic Technology Showcase"
      statusText="Active · BD asset"
      statusTone="sky"
      kpis={KPIS}
      sections={SECTIONS}
      vaultPath={VAULT_PATH}
    />
  );
}
