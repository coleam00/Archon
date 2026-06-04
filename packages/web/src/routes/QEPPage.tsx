import overviewRaw from '@second-brain/businesses/pmc/qep/overview.md?raw';
import { BusinessPage, type BusinessProspect } from '@/components/business/BusinessPage';
import prospectsData from '@/lib/business-prospects.generated.json';

const VAULT_PATH = 'second-brain/businesses/pmc/qep/overview.md';

const PROSPECTS = (prospectsData.by_business as Record<string, BusinessProspect[]>).QEP ?? [];

const VALUE_PROPS = [
  {
    title: 'Anchor at The Fountain',
    body: 'QEP is the WPB Fountain partnership. Quantum executive protocols delivered in a premium clinical venue.',
  },
  {
    title: 'Bioenergetic medicine',
    body: 'Cellular-energy modality positioning for functional medicine, executive performance, longevity buyers.',
  },
  {
    title: 'Cross-brand carrier',
    body: 'QEP gives BioReg/Cellcom a clinical context for the luxury-wellness ICP — protocols, not just devices.',
  },
];

const SECTIONS = [
  {
    heading: 'Partnership',
    items: [
      {
        slug: 'fountain',
        title: 'The Fountain (WPB)',
        description: 'QEP partner venue — now a core PMC client',
        to: '/clients/fountain-wpb',
        badge: 'core client',
        badgeTone: 'emerald' as const,
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
    heading: 'ICP segments',
    items: [
      {
        slug: 'qep-practitioners',
        title: 'Quantum Energy Practitioners',
        description: 'Bioenergetic-medicine clinicians; emerging-modality early adopters',
      },
      {
        slug: 'functional-med',
        title: 'Functional medicine practices',
        description: 'Adjacent — diagnostic + protocol integration',
      },
      {
        slug: 'wellness-retreats',
        title: 'Wellness retreats',
        description: 'With diagnostic offerings — premium positioning',
      },
    ],
  },
];

const KPIS = [
  { label: 'Status', value: 'Active' },
  { label: 'Anchor venue', value: 'The Fountain WPB' },
  { label: 'Vault depth', value: 'overview only' },
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
