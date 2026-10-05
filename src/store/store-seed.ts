export type StoreSeedProduct = {
  slug: string;
  title: string;
  subtitle: string;
  description?: string;
  category: 'plans' | 'ebooks';
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
  {
    slug: 'glute-ultimate-workouts',
    title: 'Glute Ultimate Workouts',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223533/gymtrack/store/products/product-muvk8rq8.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Glute Ultimate Workouts — a complete guide to building stronger, sculpted glutes with targeted workouts, progressive programs, exercise guidance, and practical form cues.',
    sortOrder: 301,
  },
  {
    slug: 'monster-back-workouts',
    title: 'Monster Back Workouts',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223567/gymtrack/store/products/product-muvk9hji.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Monster Back Workouts — build a wider, thicker, stronger back with science-based workouts, progressive programs, exercise guidance, and form-focused training.',
    sortOrder: 302,
  },
  {
    slug: 'gun-biceps-workouts',
    title: 'Gun Biceps Workouts',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223612/gymtrack/store/products/product-muvkagis.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Gun Biceps Workouts — build bigger, stronger and more defined arms with targeted biceps training, progressive overload, exercise guidance, and proven workout programs.',
    sortOrder: 303,
  },
  {
    slug: 'titan-chest-workouts',
    title: 'Titan Chest Workouts',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223627/gymtrack/store/products/product-muvkasas.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Titan Chest Workouts — build a bigger, stronger and more defined chest with structured training, progressive programs, exercise guidance, and practical form cues.',
    sortOrder: 304,
  },
  {
    slug: 'quad-beast-workouts',
    title: 'Quad Beast Workouts',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223638/gymtrack/store/products/product-muvkb0gg.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Quad Beast Workouts — develop bigger, stronger and more defined legs with quad-focused exercises, progressive training programs, workout guidance, and form cues.',
    sortOrder: 305,
  },
  {
    slug: '3d-shoulder-workouts',
    title: '3D Shoulder Workouts',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223670/gymtrack/store/products/product-muvkbpan.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro 3D Shoulder Workouts — build wider, rounder and stronger shoulders with targeted delt training, progressive programs, anatomy guidance, and exercise-specific form cues.',
    sortOrder: 306,
  },
  {
    slug: 'triceps-x-workouts',
    title: 'Triceps X Workouts',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223682/gymtrack/store/products/product-muvkbykj.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Triceps X Workouts — build bigger and stronger triceps with targeted training, progressive overload, activation-focused exercises, form guidance, and structured workout programs.',
    sortOrder: 307,
  },
  {
    slug: 'armor-core-abs-workout',
    title: 'Armor Core',
    subtitle: 'Digital download',
    priceLabel: '₹799',
    pricePaise: 79900,
    imageUrl:
      'https://res.cloudinary.com/dxfj2ocp/image/upload/v1791223697/gymtrack/store/products/product-muvkca6o.jpg',
    category: 'ebooks',
    kind: 'merch',
    description:
      'Hybrid Pro Armor Core — a complete abs workout guide for building a stronger, leaner and more defined core with progressive programs, targeted exercises, form guidance, and practical training strategies.',
    sortOrder: 308,
  },
];
