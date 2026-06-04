import overviewRaw from '@second-brain/partners/accufit/_accufit.md?raw';
import { BusinessPage, type BusinessProspect } from '@/components/business/BusinessPage';
import prospectsData from '@/lib/business-prospects.generated.json';

const VAULT_PATH = 'second-brain/partners/accufit/_accufit.md';

const PROSPECTS = (prospectsData.by_business as Record<string, BusinessProspect[]>).AccuFit ?? [];

const VALUE_PROPS = [
  {
    title: 'DEMS body contouring',
    body: 'Lutronic Direct Electrical Muscle Stimulation — non-invasive, no downtime, 30min sessions. Same category as Emsculpt/CoolTone, distributor-friendly.',
  },
  {
    title: 'Same ICP as BRT',
    body: 'Medspas, luxury wellness, high-end gyms, aesthetic practices — perfect cross-sell into the BioReg target base.',
  },
  {
    title: '$50K-$150K capital sale',
    body: 'High-ticket aesthetic device sale with healthy distributor margins. One placement per quarter materially moves the revenue line.',
  },
];

const SECTIONS = [
  {
    heading: 'Distributor opportunity',
    items: [
      {
        slug: 'manufacturer',
        title: 'Lutronic Aesthetic',
        description: 'Large Korean / global aesthetic device manufacturer, 20+ years in market',
        href: 'https://www.lutronicaesthetic.com',
      },
      {
        slug: 'accufit-product',
        title: 'AccuFit product page',
        description: 'Lutronic AccuFit (DEMS body contouring)',
        href: 'https://lutronicaesthetic.com/products/accufit',
      },
      {
        slug: 'showpad',
        title: 'Showpad sales resource',
        description: 'Lutronic-supplied asset library for Jason',
        href: 'https://lutronic.showpad.com/share/5MwdplrytFlgFCWWuzpk4',
      },
    ],
  },
  {
    heading: 'Cross-sell playbook',
    items: [
      {
        slug: 'brt-bundle',
        title: 'BRT + AccuFit stack',
        description: 'BRT addresses physiology + recovery; AccuFit addresses body composition. Together = complete wellness+aesthetics revenue stack.',
      },
      {
        slug: 'medspa-fit',
        title: 'Medspa fit',
        description: 'Premium medspas already buying high-ticket devices — natural co-placement opportunity.',
      },
      {
        slug: 'luxury-gym',
        title: 'Luxury gym positioning',
        description: 'Body composition outcome story fits the recovery / performance brand narrative.',
      },
    ],
  },
  {
    heading: 'Open intake items',
    items: [
      {
        slug: 'rep-contact',
        title: 'Lutronic territory rep contact',
        description: 'TBD — need name + email + phone for the FL territory',
        badge: 'pending',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'comm-terms',
        title: 'Commission / margin structure',
        description: 'TBD — need explicit splits before formal pitch',
        badge: 'pending',
        badgeTone: 'amber' as const,
      },
    ],
  },
];

const KPIS = [
  { label: 'Status', value: 'Exploring' },
  { label: 'Ticket size', value: '$50K-$150K' },
  { label: 'ICP overlap', value: 'BRT base' },
  { label: 'Sales resource', value: 'Showpad live' },
];

export function AccuFitPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="AccuFit (Lutronic)"
      statusText="Exploring · partner"
      statusTone="amber"
      kpis={KPIS}
      valueProps={VALUE_PROPS}
      sections={SECTIONS}
      prospects={PROSPECTS}
      prospectsHeading="Outreach surface"
      prospectsSubtitle="Pending Lutronic rep intake + BRT cross-sell list"
      vaultPath={VAULT_PATH}
    />
  );
}
