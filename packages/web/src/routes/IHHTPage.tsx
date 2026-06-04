import overviewRaw from '@second-brain/businesses/pmc/iht/overview.md?raw';
import { BusinessPage } from '@/components/business/BusinessPage';

const VAULT_PATH = 'second-brain/businesses/pmc/iht/overview.md';

const SECTIONS = [
  {
    heading: 'ICP segments',
    items: [
      {
        slug: 'altitude',
        title: 'Altitude training facilities',
        description: 'Adjacent — performance and recovery practitioners',
      },
      {
        slug: 'cardiac-rehab',
        title: 'Cardiac rehabilitation centers',
        description: 'CPAP-relevant research thread (pmc.ncbi.nlm.nih.gov)',
      },
      {
        slug: 'elite-sports',
        title: 'Elite sports / Olympic training',
        description: 'Top-tier performance + recovery use case',
      },
    ],
  },
  {
    heading: 'Partnership',
    items: [
      {
        slug: 'ihht-cellit',
        title: 'IHHT-CellIT',
        description: 'ihht-cellit.com — partner site for hypoxia-hyperoxia therapy',
        href: 'https://ihht-cellit.com',
      },
    ],
  },
];

const KPIS = [
  { label: 'Status', value: 'Active' },
  { label: 'Brand role', value: 'PMC sub-brand' },
  { label: 'Vault depth', value: 'overview only' },
];

export function IHHTPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="IHHT — Intermittent Hypoxia-Hyperoxia Therapy"
      statusText="Active"
      statusTone="emerald"
      kpis={KPIS}
      sections={SECTIONS}
      vaultPath={VAULT_PATH}
    />
  );
}
