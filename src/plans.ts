export const COMPANY_NAME = 'Hybrid Pro';

export type PricingPlanId = 'foundation' | 'performance' | 'elite';

export type PricingPlan = {
  id: PricingPlanId;
  company: typeof COMPANY_NAME;
  category: string;
  name: string;
  shortName: string;
  saveLabel: string | null;
  originalPrice: string;
  price: string;
  amountPaise: number;
  cadence: string;
  billingNote: string;
  blurb: string;
  included: string[];
  rank: number;
};

export const pricingPlans: PricingPlan[] = [
  {
    id: 'foundation',
    company: COMPANY_NAME,
    category: 'Training plan',
    name: 'Hybrid Pro Foundation',
    shortName: 'Foundation',
    saveLabel: 'Save 10%',
    originalPrice: '₹4,999',
    price: '₹3,999',
    amountPaise: 3999_00,
    cadence: '/ month',
    billingNote: '30 days of access · pay again to renew',
    blurb: 'Build healthy habits. Start your Hybrid Pro journey.',
    included: [
      'Full program library (workout + nutrition)',
      'App-based tracking (workouts, meals, progress)',
      'Monthly plan refresh',
      'Progressive overload templates',
      'Basic video form reviews (up to 2 per week)',
      'Nutrition guide (general guidance)',
      'Weekly check-ins via app',
    ],
    rank: 1,
  },
  {
    id: 'performance',
    company: COMPANY_NAME,
    category: 'Personalised coaching',
    name: 'Hybrid Pro Performance',
    shortName: 'Performance',
    saveLabel: 'Save 15%',
    originalPrice: '₹14,999',
    price: '₹11,999',
    amountPaise: 11999_00,
    cadence: '/ month',
    billingNote: '30 days of access · most popular',
    blurb: 'Personalised plans. Real results. Hybrid Pro coaching in your corner.',
    included: [
      'Custom workout programming',
      'Personalised nutrition plan (macros + meal guidance)',
      'App-based tracking (workouts, meals, progress)',
      'Bi-weekly plan reviews',
      'Video form reviews (up to 4 per month)',
      'Weekly check-ins via app + message',
      'Nutrition targets (calorie + macro guidance)',
      'Direct message support (2–3 times per week)',
    ],
    rank: 2,
  },
  {
    id: 'elite',
    company: COMPANY_NAME,
    category: 'Elite coaching',
    name: 'Hybrid Pro Elite',
    shortName: 'Elite',
    saveLabel: 'Save 20%',
    originalPrice: '₹29,999',
    price: '₹24,999',
    amountPaise: 24999_00,
    cadence: '/ month',
    billingNote: '30 days of access · limited spots',
    blurb: 'Maximum support. Elite Hybrid Pro results.',
    included: [
      'Fully customised training plan',
      'Personalised nutrition (macro + micro + meal plan)',
      'App-based tracking including body composition',
      'Weekly plan adjustments',
      'Unlimited video form reviews',
      'Nutrition and habit coaching',
      'Unlimited direct messages',
      'Monthly progress assessment',
      'Priority support (faster response)',
    ],
    rank: 3,
  },
];

export function getPricingPlan(id: string): PricingPlan | undefined {
  return pricingPlans.find((p) => p.id === id);
}

export function isPricingPlanId(id: string): id is PricingPlanId {
  return id === 'foundation' || id === 'performance' || id === 'elite';
}

export function planRank(planId: string | null | undefined) {
  return getPricingPlan(planId || '')?.rank ?? 0;
}
