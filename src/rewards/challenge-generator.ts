import {
  CATEGORY_META,
  DIFFICULTY_REWARDS,
  type ChallengeGeneratorInput,
  type GeneratedChallenge,
} from './rewards.constants.js';

function normalizeChallenge(c: GeneratedChallenge): GeneratedChallenge {
  const rewards = DIFFICULTY_REWARDS[c.difficulty];
  const meta = CATEGORY_META[c.category];
  return {
    ...c,
    xpReward: c.xpReward ?? rewards.xp,
    coinReward: c.coinReward ?? rewards.coins,
    autoComplete: c.autoComplete ?? false,
    icon: c.icon ?? meta.icon,
    color: c.color ?? meta.color,
  };
}

/** Deterministic daily set (legacy fallback — no AI in V1). */
export function generateDailyChallenges(
  input: ChallengeGeneratorInput = {},
): GeneratedChallenge[] {
  const recoveryLow = (input.recoveryScore ?? 70) < 45;
  const hardMode = (input.streak ?? 0) > 30;
  const easyMode = Boolean(input.skippedYesterday);
  const waterTarget = input.waterTarget ?? 3000;
  const proteinTarget = input.proteinTarget ?? 150;

  const items: GeneratedChallenge[] = [];

  if (recoveryLow) {
    items.push({
      title: 'Active Recovery',
      description: 'Take a recovery-focused day: stretch or foam roll for 10 minutes.',
      category: 'Recovery',
      difficulty: 'Easy',
      targetValue: 10,
      unit: 'minutes',
      autoComplete: false,
    });
    items.push({
      title: 'Sleep Well',
      description: 'Aim for 8 hours of sleep to restore recovery.',
      category: 'Recovery',
      difficulty: 'Easy',
      targetValue: 8,
      unit: 'hours',
      autoComplete: false,
    });
  } else if (input.todayWorkout) {
    items.push({
      title: `Complete ${input.todayWorkout}`,
      description: `Finish today's planned workout: ${input.todayWorkout}.`,
      category: 'Workout',
      difficulty: easyMode ? 'Easy' : hardMode ? 'Hard' : 'Medium',
      targetValue: 1,
      unit: 'workout',
      autoComplete: true,
    });
  } else {
    items.push({
      title: 'Log a Workout',
      description: 'Complete any workout session today.',
      category: 'Workout',
      difficulty: 'Easy',
      targetValue: 1,
      unit: 'workout',
      autoComplete: true,
    });
  }

  items.push({
    title: `Drink ${(waterTarget / 1000).toFixed(1)}L Water`,
    description: 'Stay hydrated throughout the day.',
    category: 'Hydration',
    difficulty: 'Easy',
    targetValue: waterTarget,
    unit: 'ml',
    autoComplete: false,
  });

  items.push({
    title: `Hit ${proteinTarget}g Protein`,
    description: 'Meet your daily protein target.',
    category: 'Nutrition',
    difficulty: easyMode ? 'Easy' : 'Medium',
    targetValue: proteinTarget,
    unit: 'g',
    autoComplete: false,
  });

  items.push({
    title: 'Open Hybrid Pro',
    description: 'Check in and review your plan for today.',
    category: 'Habit',
    difficulty: 'Easy',
    targetValue: 1,
    unit: 'check-in',
    autoComplete: true,
  });

  if (items.length < 5) {
    items.push({
      title: hardMode ? 'Push Workout Volume' : 'Mobility Flow',
      description: hardMode
        ? 'Add extra volume or finish one more exercise than planned.'
        : 'Spend 8 minutes on mobility or stretching.',
      category: hardMode ? 'Strength' : 'Mobility',
      difficulty: hardMode ? 'Hard' : 'Easy',
      targetValue: hardMode ? 1 : 8,
      unit: hardMode ? 'session' : 'minutes',
      autoComplete: false,
    });
  }

  return items.slice(0, 5).map(normalizeChallenge);
}

export function generateWeeklyChallenges(): GeneratedChallenge[] {
  const weekly: GeneratedChallenge[] = [
    {
      title: 'Complete 5 Workouts',
      description: 'Finish five training sessions this week.',
      category: 'Workout',
      difficulty: 'Hard',
      targetValue: 5,
      unit: 'workouts',
      autoComplete: true,
    },
    {
      title: 'Hit 800g Protein',
      description: 'Accumulate 800g of protein across the week.',
      category: 'Nutrition',
      difficulty: 'Hard',
      targetValue: 800,
      unit: 'g',
      autoComplete: false,
    },
    {
      title: 'Stay Hydrated',
      description: 'Log at least 20L of water this week.',
      category: 'Hydration',
      difficulty: 'Medium',
      targetValue: 20000,
      unit: 'ml',
      autoComplete: false,
    },
  ];
  return weekly.map(normalizeChallenge);
}

export function generateMonthlyChallenges(): GeneratedChallenge[] {
  const monthly: GeneratedChallenge[] = [
    {
      title: 'Train 20 Days',
      description: 'Complete workouts on at least 20 days this month.',
      category: 'Workout',
      difficulty: 'Extreme',
      targetValue: 20,
      unit: 'days',
      autoComplete: true,
    },
    {
      title: 'Upload BIA Twice',
      description: 'Upload two body composition reports this month.',
      category: 'Progress',
      difficulty: 'Medium',
      targetValue: 2,
      unit: 'reports',
      autoComplete: true,
    },
    {
      title: 'Maintain Streak',
      description: 'Keep your challenge streak alive all month.',
      category: 'Habit',
      difficulty: 'Hard',
      targetValue: 1,
      unit: 'streak',
      autoComplete: false,
    },
  ];
  return monthly.map(normalizeChallenge);
}
