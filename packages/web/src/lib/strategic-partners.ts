export interface PartnerLink {
  label: string;
  url: string;
}

export interface EvidenceLink extends PartnerLink {
  note: string;
}

export interface StrategicPartnerProfile {
  slug: string;
  name: string;
  category: string;
  status: string;
  positioning: string;
  overview: string;
  bestFit: string[];
  offering: string[];
  costs: string[];
  benefits: string[];
  marketInsights: string[];
  clinicalEvidence: EvidenceLink[];
  caveats: string[];
  links: PartnerLink[];
}

export const STRATEGIC_PARTNERS: StrategicPartnerProfile[] = [
  {
    slug: 'max-out-360',
    name: 'Max Out 360',
    category: 'Fitness retail / event partner',
    status: 'Exploring',
    positioning:
      'Small sports-nutrition and gym-accessory brand with an easy event, affiliate, and gym-retail use case. Best framed as practical performance support, not clinical care.',
    overview:
      'Max Out 360 sells direct-to-consumer fitness products through its own Shopify storefront and Amazon presence. The current public catalog is narrow: Creapure creatine monohydrate plus training accessories such as straps, wraps, grips, and ankle straps.',
    bestFit: [
      'TTTS / Max Out 360 event activation, raffle bags, trainer demos, and gym challenge kits.',
      'Low-friction affiliate or referral offer for strength, recovery, and active-lifestyle audiences.',
      'Practice-adjacent wellness retail only when claims stay in the sports-performance lane.',
    ],
    offering: [
      'Creapure creatine monohydrate, 60 servings at 5g per serving, marketed as vegan, non-GMO, third-party tested, and NSF/ANSI 173 certified by the brand.',
      'Gym accessories: ankle straps, knee wraps, lifting straps, and leather hand grips.',
      'Public affiliate portal through GoAffPro, suggesting a partner/referral structure can be activated without heavy custom buildout.',
    ],
    costs: [
      'Creatine publicly listed at $27.99.',
      'Accessories publicly listed roughly $15.99 to $24.99 depending on SKU.',
      'Wholesale, event-sponsor, and affiliate commission terms are not publicly posted. Verify directly before committing volume.',
    ],
    benefits: [
      'Simple consumable plus accessory bundle for events and gyms.',
      'Creatine has stronger evidence than most sports supplements when positioned correctly.',
      'Low-ticket price point makes it realistic for samples, giveaways, or first-order affiliate offers.',
    ],
    marketInsights: [
      'Sports nutrition and creatine demand is moving beyond bodybuilding into general strength, recovery, and healthy-aging conversations.',
      'Grand View Research estimates the creatine supplements market at $1.4B in 2025, with aggressive growth projections. Treat market-size figures as industry estimates, not clinical proof.',
      'The pragmatic PMC angle is retail activation and audience fit, not a medical-device or treatment partnership.',
    ],
    clinicalEvidence: [
      {
        label: 'ISSN creatine position stand',
        url: 'https://pubmed.ncbi.nlm.nih.gov/28615996/',
        note: 'Creatine monohydrate is one of the better-supported sports supplements for high-intensity exercise performance and training adaptations.',
      },
      {
        label: 'Creapure purity information',
        url: 'https://www.creapure.com/en/creapurer/what-is-creapurer/',
        note: 'Creapure describes its German-made creatine monohydrate as at least 99.9% pure.',
      },
      {
        label: 'NSF supplement certification overview',
        url: 'https://www.nsf.org/consumer-resources/articles/supplement-vitamin-certification',
        note: 'Useful diligence source for understanding NSF/ANSI 173 and Certified for Sport claims.',
      },
    ],
    caveats: [
      'Catalog is narrow and public operating history appears limited. Do not over-weight this as a full wellness platform.',
      'NSF/product testing claims should be independently verified before any athlete or clinical-facing claim is made.',
      'Terms page appeared partly boilerplate during review, so partner terms need direct confirmation.',
    ],
    links: [
      { label: 'Website', url: 'https://www.maxout360.com/' },
      {
        label: 'Amazon store',
        url: 'https://www.amazon.com/stores/MaxOut360/page/FF45A6A5-0A48-4C14-9AE4-474D46BED57A',
      },
      { label: 'Affiliate portal', url: 'https://maxout360.goaffpro.com/' },
      { label: 'Instagram', url: 'https://www.instagram.com/maxout360_supps' },
    ],
  },
  {
    slug: 'gapin-peak-launch',
    name: 'Gapin Institute / Peak Launch',
    category: "Executive precision health / men's longevity",
    status: 'High-value referral fit',
    positioning:
      'Physician-led precision performance medicine for founders, executives, high performers, and couples. Strong referral fit if hormone, peptide, and outcomes claims stay evidence-aware.',
    overview:
      'Dr. Tracy Gapin and the Gapin Institute position Peak Launch as concierge performance medicine built around advanced diagnostics, hormone optimization, wearable data, coaching, and longevity-oriented accountability. The Sarasota location and executive-health angle make it a natural local strategic partner for high-trust wellness conversations.',
    bestFit: [
      'Referral partner for male founders, executives, entrepreneurs, and high performers who want structured diagnostics and medical oversight.',
      "Collaboration around men's health education, testosterone diligence, executive performance, and longevity events.",
      'Not a mass-market offer. Best used for qualified, high-intent clients who value concierge care.',
    ],
    offering: [
      'Peak Launch Signature: concierge diagnostics, medical optimization, expert coaching, and biometric tracking.',
      'Launch Diagnostics: public page says 200+ biomarkers across hormones, microbiome, cardiovascular health, glucose regulation, stress, inflammation, metabolic health, micronutrients, and food sensitivity.',
      'Hormone optimization, low-testosterone evaluation, executive-health programming, Peak Launch MD clinician training, and Peak Launch Accelerator events.',
    ],
    costs: [
      'Core program pricing is not publicly posted. Public pages route users to a discovery or strategy call.',
      'Peak Launch strategy call is publicly described as no cost.',
      'Peak Launch Accelerator event page publicly lists $100 per seat, with optional VO2 max testing at $250 and comprehensive blood panel at $600.',
    ],
    benefits: [
      'High perceived value for executive and founder audiences.',
      'Clear local Sarasota connection and physician-led positioning.',
      'Good bridge between PMC relationship-building and BioReg/EWC education without forcing a device sale.',
    ],
    marketInsights: [
      'Global Wellness Institute reports the wellness economy reached $6.3T in 2023 and projects it near $9.0T by 2028.',
      'Executive health is attractive because the buyer values time, specificity, and accountability more than generic wellness content.',
      'The strongest commercial lane is qualified referral and education partnership, not broad cold promotion.',
    ],
    clinicalEvidence: [
      {
        label: 'AUA testosterone deficiency guideline',
        url: 'https://www.auanet.org/guidelines-and-quality/guidelines/testosterone-deficiency-guideline',
        note: 'Use for guardrails: total testosterone below 300 ng/dL is a reasonable cutoff, with two early-morning measurements on separate occasions.',
      },
      {
        label: 'Endocrine Society testosterone therapy guideline',
        url: 'https://www.endocrine.org/clinical-practice-guidelines/testosterone-therapy',
        note: 'Diagnosis should require symptoms/signs plus unequivocally and consistently low testosterone. Routine screening of all men is not recommended.',
      },
      {
        label: 'Global Wellness Institute 2024 monitor',
        url: 'https://globalwellnessinstitute.org/industry-research/2024-global-wellness-economy-monitor/',
        note: 'Market context for wellness and longevity demand.',
      },
    ],
    caveats: [
      'Vendor-reported outcome percentages should be treated as marketing claims unless independently validated.',
      'Hormone and peptide protocols require clinical diligence, contraindication screening, fertility discussion, prostate/CV-risk review, and ongoing monitoring.',
      'Core pricing opacity means Jason should qualify the relationship and buyer profile before routing prospects.',
    ],
    links: [
      { label: 'Gapin Institute', url: 'https://gapininstitute.com/' },
      { label: 'Peak Launch', url: 'https://peaklaunch.com/' },
      { label: 'Schedule strategy call', url: 'https://peaklaunch.com/schedule/' },
      { label: 'Dr. Gapin LinkedIn', url: 'https://www.linkedin.com/in/tracygapin/' },
      { label: 'Instagram', url: 'https://www.instagram.com/drtracygapin/' },
    ],
  },
  {
    slug: 'flow-massage-wellness',
    name: 'Flow Massage and Wellness',
    category: 'Lymphatic education / recovery wellness',
    status: 'Local education fit',
    positioning:
      'Sarasota therapeutic massage and lymphatic-drainage studio. Best framed as education-led recovery wellness and conservative referral support, not as detox or cure-based medicine.',
    overview:
      'Flow Massage and Wellness operates in Sarasota and offers therapeutic massage, medical/neuromuscular massage, manual lymphatic drainage, cranio-sacral therapy, Ayurvedic facials, mind-body integration, and energy work. Its strongest PMC fit is lymphatic education and post-op or lymphedema-aware recovery support.',
    bestFit: [
      'Local recovery-wellness referral partner for clients who ask about swelling, post-op support, or lymphatic education.',
      'Educational content partner for safe lymphatic self-care language and realistic expectations.',
      'Adjunct relationship for wellness practices, medspas, and providers who need a conservative local resource.',
    ],
    offering: [
      'Manual lymphatic drainage, including pre- and post-operative lymphatic therapy language on the public site.',
      'Therapeutic massage, medical massage, neuromuscular massage, cranio-sacral therapy, Ayurvedic facials, skin care, and mind-body integration.',
      'Client education and self-treatment classes are referenced in public copy, though events should be verified before promotion.',
    ],
    costs: [
      'Therapeutic massage: 60 min $120, 90 min $180, master therapist $150.',
      'Medical massage: 60 min $120, 90 min $180.',
      'Lymphatic drainage: 60 min $120, master therapist $150. Add-on pricing appears inconsistent across pages at $50 or $60, so verify before quoting.',
      'Mind Body Integration is listed as call for pricing.',
    ],
    benefits: [
      'Local, hands-on recovery resource with a clear lymphatic niche.',
      'Useful for education around lymphedema-aware care, post-op swelling conversations, and client self-advocacy.',
      'Pairs well with wellness and medspa networks if PMC keeps claims conservative.',
    ],
    marketInsights: [
      'Massage demand is increasingly tied to wellness, chronic pain, soreness, stiffness, and recovery rather than luxury alone.',
      'AMTA reports common massage reasons include soreness/stiffness/spasm, chronic pain relief/management, and injury recovery/rehab.',
      'The strongest go-to-market lane is trusted referral and education, not broad consumer hype.',
    ],
    clinicalEvidence: [
      {
        label: 'Manual lymph drainage systematic review',
        url: 'https://pubmed.ncbi.nlm.nih.gov/32803533/',
        note: 'Findings are mixed and limited by methodology. Some benefits appear in certain early or mild cases, but results should not be overstated.',
      },
      {
        label: 'NCI lymphedema clinical summary',
        url: 'https://www.cancer.gov/about-cancer/treatment/side-effects/lymphedema/lymphedema-hp-pdq',
        note: 'Defines lymphedema and places conservative care in a broader management context.',
      },
      {
        label: 'Complete Decongestive Therapy consensus',
        url: 'https://link.springer.com/article/10.1007/s12032-024-02407-4',
        note: 'CDT includes assessment, compression, manual techniques, exercise, skin care, education, and self-management.',
      },
      {
        label: 'AMTA massage industry fact sheet',
        url: 'https://www.amtamassage.org/publications/massage-industry-fact-sheet/',
        note: 'Market context for wellness, pain, and recovery demand.',
      },
    ],
    caveats: [
      'Avoid detox, immune-treatment, or cure language. Use recovery support and education language.',
      "Complex oncology, lymphedema, post-surgical, or medically fragile cases should be coordinated with the patient's clinician.",
      'Public pages have a price discrepancy for the lymphatic add-on and a phone inconsistency on the events page.',
    ],
    links: [
      { label: 'Website', url: 'https://www.flowmassagesrq.com/' },
      {
        label: 'Lymphatic drainage page',
        url: 'https://www.flowmassagesrq.com/lymphatic-drainage-massage',
      },
      { label: 'Service menu', url: 'https://www.flowmassagesrq.com/service-menu' },
      { label: 'Instagram', url: 'https://www.instagram.com/flowmassagesrq/' },
      { label: 'Contact', url: 'https://www.flowmassagesrq.com/contact' },
    ],
  },
];

export function getStrategicPartner(slug: string | undefined): StrategicPartnerProfile | undefined {
  return STRATEGIC_PARTNERS.find(partner => partner.slug === slug);
}
