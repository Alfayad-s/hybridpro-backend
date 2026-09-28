/** Fixed copy. Admin can override title, body, and enabled later. No generated text. */

export const NOTIFICATION_TYPES = [
  'MORNING_GREETING',
  'PRE_WORKOUT',
  'WORKOUT_REMINDER',
  'POST_WORKOUT',
  'MISSED_WORKOUT',
  'BREAKFAST_REMINDER',
  'LUNCH_REMINDER',
  'DINNER_REMINDER',
  'HYDRATION_REMINDER',
  'RECOVERY_REMINDER',
  'SLEEP_REMINDER',
  'GOAL_PROGRESS',
  'STREAK',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export type NotificationTemplate = {
  type: NotificationType;
  title: string;
  body: string;
  deepLink: string;
  enabled: boolean;
  priority: NotificationPriority;
};

export type NotificationCategory =
  | 'workout'
  | 'meals'
  | 'hydration'
  | 'sleep'
  | 'motivation'
  | 'streak';

export const PRIORITY_RANK: Record<NotificationPriority, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

export const DEFAULT_TEMPLATES: Record<NotificationType, NotificationTemplate> = {
  MORNING_GREETING: {
    type: 'MORNING_GREETING',
    title: 'Good morning',
    body: 'Ready to start your day?',
    deepLink: '/home',
    enabled: true,
    priority: 'LOW',
  },
  PRE_WORKOUT: {
    type: 'PRE_WORKOUT',
    title: 'Workout coming up',
    body: 'Your workout starts soon. Ready to train?',
    deepLink: '/workout',
    enabled: true,
    priority: 'HIGH',
  },
  WORKOUT_REMINDER: {
    type: 'WORKOUT_REMINDER',
    title: 'Workout time',
    body: 'Your workout is coming up. Ready to train?',
    deepLink: '/workout',
    enabled: true,
    priority: 'HIGH',
  },
  POST_WORKOUT: {
    type: 'POST_WORKOUT',
    title: 'Workout completed',
    body: 'Great work today.',
    deepLink: '/home',
    enabled: true,
    priority: 'MEDIUM',
  },
  MISSED_WORKOUT: {
    type: 'MISSED_WORKOUT',
    title: 'Workout still open',
    body: 'Today’s workout is still waiting for you.',
    deepLink: '/workout',
    enabled: true,
    priority: 'HIGH',
  },
  BREAKFAST_REMINDER: {
    type: 'BREAKFAST_REMINDER',
    title: 'Breakfast time',
    body: 'Have you had breakfast today?',
    deepLink: '/meals',
    enabled: true,
    priority: 'HIGH',
  },
  LUNCH_REMINDER: {
    type: 'LUNCH_REMINDER',
    title: 'Lunch time',
    body: 'Have you had your lunch today?',
    deepLink: '/meals',
    enabled: true,
    priority: 'HIGH',
  },
  DINNER_REMINDER: {
    type: 'DINNER_REMINDER',
    title: 'Dinner time',
    body: 'Have you had dinner today?',
    deepLink: '/meals',
    enabled: true,
    priority: 'HIGH',
  },
  HYDRATION_REMINDER: {
    type: 'HYDRATION_REMINDER',
    title: 'Water check',
    body: 'You are behind on today’s water target.',
    deepLink: '/meals',
    enabled: true,
    priority: 'MEDIUM',
  },
  RECOVERY_REMINDER: {
    type: 'RECOVERY_REMINDER',
    title: 'Recovery',
    body: 'Training is done. Leave time to recover tonight.',
    deepLink: '/home',
    enabled: true,
    priority: 'MEDIUM',
  },
  SLEEP_REMINDER: {
    type: 'SLEEP_REMINDER',
    title: 'Time to wind down',
    body: 'Your body needs recovery too. Try to get some sleep.',
    deepLink: '/home',
    enabled: true,
    priority: 'HIGH',
  },
  GOAL_PROGRESS: {
    type: 'GOAL_PROGRESS',
    title: 'Daily targets met',
    body: 'Workout and water are both done for today.',
    deepLink: '/home',
    enabled: true,
    priority: 'LOW',
  },
  STREAK: {
    type: 'STREAK',
    title: 'Streak',
    body: 'Your training streak is still going.',
    deepLink: '/streaks',
    enabled: true,
    priority: 'LOW',
  },
};

export function categoryFor(type: NotificationType): NotificationCategory {
  switch (type) {
    case 'PRE_WORKOUT':
    case 'WORKOUT_REMINDER':
    case 'POST_WORKOUT':
    case 'MISSED_WORKOUT':
    case 'RECOVERY_REMINDER':
      return 'workout';
    case 'BREAKFAST_REMINDER':
    case 'LUNCH_REMINDER':
    case 'DINNER_REMINDER':
      return 'meals';
    case 'HYDRATION_REMINDER':
      return 'hydration';
    case 'SLEEP_REMINDER':
      return 'sleep';
    case 'STREAK':
      return 'streak';
    case 'MORNING_GREETING':
    case 'GOAL_PROGRESS':
      return 'motivation';
  }
}
