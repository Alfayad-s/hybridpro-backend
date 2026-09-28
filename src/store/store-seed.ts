export type StoreSeedProduct = {
  slug: string;
  title: string;
  subtitle: string;
  description?: string;
  category: 'plans' | 'tees' | 'shorts' | 'ebooks';
  kind: 'plan' | 'merch';
  priceLabel: string;
  pricePaise?: number;
  coinPrice?: number;
  /** `asset:…` for bundled member assets, or https URL */
  imageUrl?: string;
  sizes?: string[];
  planId?: string;
  sortOrder: number;
};

/** Default Hybrid Pro catalog — seeded once when the table is empty. */
export const STORE_SEED_PRODUCTS: StoreSeedProduct[] = [
  {
    slug: 'plan-foundation',
    title: 'Foundation',
    subtitle: 'Training plan',
    priceLabel: '₹3,999 / mo',
    pricePaise: 399900,
    imageUrl: 'asset:assets/men/assessment.png',
    category: 'plans',
    kind: 'plan',
    planId: 'foundation',
    description: 'Build your basics with structured workouts.',
    sortOrder: 10,
  },
  {
    slug: 'plan-performance',
    title: 'Performance',
    subtitle: 'Take it to the next level',
    priceLabel: '₹11,999 / mo',
    pricePaise: 1199900,
    imageUrl: 'asset:assets/female/assessment.png',
    category: 'plans',
    kind: 'plan',
    planId: 'performance',
    description: 'Advanced training for better strength & results.',
    sortOrder: 20,
  },
  {
    slug: 'plan-elite',
    title: 'Elite coaching',
    subtitle: 'Maximum support',
    priceLabel: '₹24,999 / mo',
    pricePaise: 2499900,
    imageUrl: 'asset:assets/history/history-workout.png',
    category: 'plans',
    kind: 'plan',
    planId: 'elite',
    description: 'Personalized training, expert guidance.',
    sortOrder: 30,
  },
  {
    slug: 'tee-black',
    title: 'Hybrid Tee',
    subtitle: 'Available sizes',
    priceLabel: '₹1,499',
    pricePaise: 149900,
    coinPrice: 500,
    imageUrl: 'asset:assets/store/tshirt-3d.png',
    category: 'tees',
    kind: 'merch',
    description:
      'Black performance tee with the Hybrid Pro mark on the chest. Soft stretch fabric for training and everyday wear.',
    sizes: ['S', 'M', 'L', 'XL'],
    sortOrder: 100,
  },
  {
    slug: 'tee-charcoal',
    title: 'Mark Tee',
    subtitle: 'Available sizes',
    priceLabel: '₹1,599',
    pricePaise: 159900,
    imageUrl: 'asset:assets/store/tshirt-charcoal-3d.png',
    category: 'tees',
    kind: 'merch',
    description:
      'Charcoal athletic tee with a bold neon Hybrid Pro logo print. Lightweight and breathable.',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    sortOrder: 110,
  },
  {
    slug: 'tee-white',
    title: 'Core Tee',
    subtitle: 'Available sizes',
    priceLabel: '₹1,499',
    pricePaise: 149900,
    imageUrl: 'asset:assets/store/tee-white-3d.png',
    category: 'tees',
    kind: 'merch',
    description:
      'White performance tee with lime Hybrid Pro logo. Clean everyday training staple.',
    sizes: ['S', 'M', 'L', 'XL'],
    sortOrder: 120,
  },
  {
    slug: 'tee-lime',
    title: 'Volt Tee',
    subtitle: 'Available sizes',
    priceLabel: '₹1,699',
    pricePaise: 169900,
    imageUrl: 'asset:assets/store/tee-lime-3d.png',
    category: 'tees',
    kind: 'merch',
    description:
      'Neon lime statement tee with black Hybrid Pro mark. Made to stand out in the gym.',
    sizes: ['S', 'M', 'L', 'XL'],
    sortOrder: 130,
  },
  {
    slug: 'tee-navy',
    title: 'Night Tee',
    subtitle: 'Available sizes',
    priceLabel: '₹1,549',
    pricePaise: 154900,
    imageUrl: 'asset:assets/store/tee-navy-3d.png',
    category: 'tees',
    kind: 'merch',
    description:
      'Navy athletic tee with lime Hybrid Pro logo. Soft mesh fabric for heavy sessions.',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    sortOrder: 140,
  },
  {
    slug: 'shorts-black',
    title: 'Train Shorts',
    subtitle: 'Available sizes',
    priceLabel: '₹1,299',
    pricePaise: 129900,
    imageUrl: 'asset:assets/store/shorts-3d.png',
    category: 'shorts',
    kind: 'merch',
    description:
      'Black training shorts with Hybrid Pro logo on the thigh. Built for lifts, runs, and rest days.',
    sizes: ['S', 'M', 'L', 'XL'],
    sortOrder: 200,
  },
  {
    slug: 'shorts-olive',
    title: 'Studio Shorts',
    subtitle: 'Available sizes',
    priceLabel: '₹1,399',
    pricePaise: 139900,
    imageUrl: 'asset:assets/store/shorts-olive-3d.png',
    category: 'shorts',
    kind: 'merch',
    description:
      'Olive performance shorts with a discreet Hybrid Pro mark. Soft waistband and quick-dry fabric.',
    sizes: ['S', 'M', 'L', 'XL'],
    sortOrder: 210,
  },
  {
    slug: 'shorts-heather',
    title: 'Drift Shorts',
    subtitle: 'Available sizes',
    priceLabel: '₹1,349',
    pricePaise: 134900,
    imageUrl: 'asset:assets/store/shorts-heather-3d.png',
    category: 'shorts',
    kind: 'merch',
    description:
      'Heather grey training shorts with lime Hybrid Pro logo. Everyday gym essential.',
    sizes: ['S', 'M', 'L', 'XL'],
    sortOrder: 220,
  },
  {
    slug: 'shorts-navy',
    title: 'Pulse Shorts',
    subtitle: 'Available sizes',
    priceLabel: '₹1,399',
    pricePaise: 139900,
    imageUrl: 'asset:assets/store/shorts-navy-3d.png',
    category: 'shorts',
    kind: 'merch',
    description:
      'Navy performance shorts with Hybrid Pro mark. Breathable mesh for hard sessions.',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    sortOrder: 230,
  },
  {
    slug: 'shorts-white',
    title: 'Air Shorts',
    subtitle: 'Available sizes',
    priceLabel: '₹1,299',
    pricePaise: 129900,
    imageUrl: 'asset:assets/store/shorts-white-3d.png',
    category: 'shorts',
    kind: 'merch',
    description:
      'White training shorts with lime Hybrid Pro logo. Light, clean, and ready to train.',
    sizes: ['S', 'M', 'L', 'XL'],
    sortOrder: 240,
  },
  {
    slug: 'ebook-training',
    title: 'Training Guide',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl: 'asset:assets/store/ebook-3d.png',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Training Guide — progressive programming, form cues, and weekly templates in one digital book.',
    sortOrder: 300,
  },
  {
    slug: 'ebook-nutrition',
    title: 'Nutrition Playbook',
    subtitle: 'Digital download',
    priceLabel: '₹699',
    pricePaise: 69900,
    imageUrl: 'asset:assets/store/ebook-nutrition-3d.png',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Nutrition Playbook — macros, meal structure, and habit systems for fat loss and muscle gain.',
    sortOrder: 310,
  },
  {
    slug: 'ebook-strength',
    title: 'Strength Codex',
    subtitle: 'Digital download',
    priceLabel: '₹849',
    pricePaise: 84900,
    imageUrl: 'asset:assets/store/ebook-strength-3d.png',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Strength Codex — progressive overload templates, accessory work, and deload planning.',
    sortOrder: 320,
  },
  {
    slug: 'ebook-recovery',
    title: 'Recovery Manual',
    subtitle: 'Digital download',
    priceLabel: '₹649',
    pricePaise: 64900,
    imageUrl: 'asset:assets/store/ebook-recovery-3d.png',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Recovery Manual — sleep, mobility, and reset protocols for consistent progress.',
    sortOrder: 330,
  },
  {
    slug: 'ebook-habits',
    title: 'Hybrid Habits',
    subtitle: 'Digital download',
    priceLabel: '₹599',
    pricePaise: 59900,
    imageUrl: 'asset:assets/store/ebook-habits-3d.png',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Habits — daily systems for training consistency, nutrition adherence, and mindset.',
    sortOrder: 340,
  },
];
