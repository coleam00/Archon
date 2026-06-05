import overviewRaw from '@second-brain/businesses/pmc/qep/overview.md?raw';
import { BusinessPage, type BusinessProspect } from '@/components/business/BusinessPage';
import prospectsData from '@/lib/business-prospects.generated.json';

const VAULT_PATH = 'second-brain/businesses/pmc/qep/overview.md';

const PROSPECTS = (prospectsData.by_business as Record<string, BusinessProspect[]>).QEP ?? [];

const VALUE_PROPS = [
  {
    title: 'Proprietary health-data governance',
    body: 'A patient-data orchestration platform Blake is building with Plaud.ai. Treats encounters, notes, and protocol-tracking as first-class governed assets — not a longevity protocol.',
  },
  {
    title: 'White-label resale to physician practices',
    body: 'PMC owns the resale channel. Same physician-practice ICP we already target with RCM and BRT; QEP is the recurring-revenue attach.',
  },
  {
    title: 'Multi-line per account economics',
    body: 'RCM audit (one-time) + QEP white-label (recurring) + BRT/IHHT modalities (consumable). A single PMC engagement becomes a portfolio sale.',
  },
];

const SECTIONS = [
  {
    heading: 'Build partnership',
    items: [
      {
        slug: 'blake',
        title: 'Blake Baynham (The Fountain WPB)',
        description: 'Platform builder + product owner. PMC is the GTM partner.',
        to: '/clients/fountain-wpb',
        badge: 'core client',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'plaud',
        title: 'Plaud.ai (capture layer)',
        description: 'AI voice / capture / transcription. Distributorship in formation.',
        to: '/solutions/plaud-ai',
      },
      {
        slug: 'website',
        title: 'quantumexecprotocol.com',
        description: 'Official QEP site',
        href: 'https://quantumexecprotocol.com',
      },
    ],
  },
  {
    heading: 'White-label ICP',
    items: [
      {
        slug: 'physician-owned',
        title: 'Physician-owned small-to-mid practices',
        description: 'Non-IDN. Need governance + AI capture, cannot build in-house.',
      },
      {
        slug: 'concierge',
        title: 'Concierge / cash-pay clinics',
        description: 'High-touch capture as a differentiation tool. Co-sells with BRT / IHHT.',
      },
      {
        slug: 'multi-loc',
        title: 'Multi-location specialty groups',
        description: 'Consistent data layer across sites; M&A consolidation prep.',
      },
    ],
  },
];

const KPIS = [
  { label: 'Phase', value: 'Build (white-label scope)' },
  { label: 'Build partner', value: 'Blake + Plaud.ai' },
  { label: 'Composite rank', value: 'Potentially top-tier' },
  { label: 'Top blocker', value: 'Lock white-label commercial structure' },
];

export function QEPPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="QEP — Quantum Executive Protocol"
      statusText="Active"
      statusTone="emerald"
      kpis={KPIS}
      valueProps={VALUE_PROPS}
      sections={SECTIONS}
      prospects={PROSPECTS}
      prospectsHeading="QEP key contacts"
      vaultPath={VAULT_PATH}
    />
  );
}
