/**
 * Pure engagement rules. No database, no clock of its own, no generated copy.
 * Callers pass an absolute instant and the member's routine.
 */

import {
  formatClock,
  inRange,
  inWindow,
  localDateKey,
  localTimeKey,
  minutesOfDay,
  suggestTypicalMinutes,
  zonedParts,
} from './time.js';
import {
  DEFAULT_TEMPLATES,
  NOTIFICATION_TYPES,
  PRIORITY_RANK,
  categoryFor,
  type NotificationPriority,
  type NotificationTemplate,
  type NotificationType,
} from './templates.js';

export const DEFAULT_WAKE = 7 * 60;
export const DEFAULT_BREAKFAST = 8 * 60 + 30;
export const DEFAULT_LUNCH = 13 * 60;
export const DEFAULT_DINNER = 20 * 60 + 30;
export const DEFAULT_QUIET_START = 22 * 60 + 30;
export const DEFAULT_QUIET_END = 7 * 60;
export const DEFAULT_DAILY_LIMIT = 6;
export const HYDRATION_COOLDOWN_MINUTES = 180;
export const HYDRATION_DAILY_CAP = 2;

export type MealSlot = 'breakfast' | 'lunch' | 'dinner';

export type MemberRoutine = {
  timezone: string;
  /** Null means "use the default clock". */
  wakeMinutes: number | null;
  breakfastMinutes: number | null;
  lunchMinutes: number | null;
  dinnerMinutes: number | null;
  /** Null means the member has not confirmed a gym time. */
  gymMinutes: number | null;
  /** Null means no sleep time, so no late-night warning and no sleep push. */
  sleepMinutes: number | null;
};

export type MealSlotState = {
  planned: boolean;
  completed: boolean;
  skipped: boolean;
};

export type DaySnapshot = {
  workoutScheduled: boolean;
  workoutName: string | null;
  workoutCompleted: boolean;
  /** Local minutes when the workout was completed, if known. */
  workoutCompletedMinutes: number | null;
  checkedIn: boolean;
  breakfast: MealSlotState;
  lunch: MealSlotState;
  dinner: MealSlotState;
  waterMl: number;
  waterGoalMl: number;
  streakDays: number;
  /** Recent gym or workout start times, local minutes, newest last. */
  recentGymMinutes: number[];
};

export type CategoryPrefs = {
  workout: boolean;
  meals: boolean;
  hydration: boolean;
  sleep: boolean;
  motivation: boolean;
  streak: boolean;
};

export type EngagementSettings = {
  dailyLimit: number;
  quietStartMinutes: number;
  quietEndMinutes: number;
  prefs: CategoryPrefs;
  templates: Record<NotificationType, NotificationTemplate>;
};

export type SentNotice = {
  type: NotificationType;
  sentAtMinutes: number;
};

export type EngagementAction =
  | { type: 'CONFIRM_GYM_TIME'; suggestedTime: string | null; suggestedMinutes: number | null }
  | { type: 'VIEW_WORKOUT' }
  | { type: 'START_WORKOUT' }
  | { type: 'MARK_MEAL_DONE'; meal: MealSlot }
  | { type: 'MEAL_NOT_YET'; meal: MealSlot }
  | { type: 'LOG_WATER' }
  | { type: 'START_WIND_DOWN' };

export type ExperienceType = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'LATE_NIGHT';

export type NoticeTrace = {
  type: NotificationType;
  result: 'SEND' | 'SKIP';
  reason: string;
};

export type NotificationDecision =
  | {
      result: 'SEND';
      type: NotificationType;
      title: string;
      body: string;
      deepLink: string;
      priority: NotificationPriority;
      reason: string;
    }
  | {
      result: 'SKIP';
      type: null;
      reason: string;
    };

export type EngagementDecision = {
  localDate: string;
  localTime: string;
  timezone: string;
  experience: {
    type: ExperienceType;
    title: string;
    subtitle: string;
  };
  gym: { scheduled: boolean; time: string | null };
  workout: { available: boolean; name: string | null; completed: boolean };
  meals: Record<MealSlot, { time: string; planned: boolean; completed: boolean; skipped: boolean }>;
  hydration: { loggedMl: number; goalMl: number; behind: boolean };
  actions: EngagementAction[];
  notification: NotificationDecision;
  trace: NoticeTrace[];
};

export type EvaluateInput = {
  now: Date;
  routine: MemberRoutine;
  day: DaySnapshot;
  settings: EngagementSettings;
  sent: SentNotice[];
};

type Clocks = {
  wake: number;
  breakfast: number;
  lunch: number;
  dinner: number;
  gym: number | null;
  sleep: number | null;
};

type Candidate = {
  type: NotificationType;
  reason: string;
  windowStart: number;
};

const OPEN_MEAL: MealSlotState = { planned: true, completed: false, skipped: false };

export function defaultSettings(
  overrides: Partial<Omit<EngagementSettings, 'prefs' | 'templates'>> & {
    prefs?: Partial<CategoryPrefs>;
    templates?: Partial<Record<NotificationType, Partial<NotificationTemplate>>>;
  } = {},
): EngagementSettings {
  const templates = { ...DEFAULT_TEMPLATES };
  for (const type of NOTIFICATION_TYPES) {
    const patch = overrides.templates?.[type];
    if (patch) templates[type] = { ...templates[type], ...patch, type };
  }
  return {
    dailyLimit: overrides.dailyLimit ?? DEFAULT_DAILY_LIMIT,
    quietStartMinutes: overrides.quietStartMinutes ?? DEFAULT_QUIET_START,
    quietEndMinutes: overrides.quietEndMinutes ?? DEFAULT_QUIET_END,
    prefs: {
      workout: true,
      meals: true,
      hydration: true,
      sleep: true,
      motivation: true,
      streak: true,
      ...overrides.prefs,
    },
    templates,
  };
}

export function emptyDay(overrides: Partial<DaySnapshot> = {}): DaySnapshot {
  return {
    workoutScheduled: false,
    workoutName: null,
    workoutCompleted: false,
    workoutCompletedMinutes: null,
    checkedIn: false,
    breakfast: { ...OPEN_MEAL },
    lunch: { ...OPEN_MEAL },
    dinner: { ...OPEN_MEAL },
    waterMl: 0,
    waterGoalMl: 2300,
    streakDays: 0,
    recentGymMinutes: [],
    ...overrides,
  };
}

export function evaluate(input: EvaluateInput): EngagementDecision {
  const parts = zonedParts(input.now, input.routine.timezone);
  const nowMinutes = minutesOfDay(parts);
  const clocks = resolveClocks(input.routine);
  const experienceType = resolveExperience(nowMinutes, clocks, input.day);
  const behind = hydrationBehind(nowMinutes, clocks, input.day);
  const experience = buildExperience(experienceType, clocks, input.day);
  const { notification, trace } = decideNotification(nowMinutes, clocks, input);

  return {
    localDate: localDateKey(parts),
    localTime: localTimeKey(parts),
    timezone: input.routine.timezone,
    experience,
    gym: {
      scheduled: clocks.gym != null,
      time: clocks.gym == null ? null : formatClock(clocks.gym),
    },
    workout: {
      available: input.day.workoutScheduled,
      name: input.day.workoutScheduled ? input.day.workoutName : null,
      completed: input.day.workoutCompleted,
    },
    meals: {
      breakfast: mealView(clocks.breakfast, input.day.breakfast),
      lunch: mealView(clocks.lunch, input.day.lunch),
      dinner: mealView(clocks.dinner, input.day.dinner),
    },
    hydration: {
      loggedMl: input.day.waterMl,
      goalMl: input.day.waterGoalMl,
      behind,
    },
    actions: buildActions(experienceType, nowMinutes, clocks, input.day, behind),
    notification,
    trace,
  };
}

function resolveClocks(routine: MemberRoutine): Clocks {
  return {
    wake: routine.wakeMinutes ?? DEFAULT_WAKE,
    breakfast: routine.breakfastMinutes ?? DEFAULT_BREAKFAST,
    lunch: routine.lunchMinutes ?? DEFAULT_LUNCH,
    dinner: routine.dinnerMinutes ?? DEFAULT_DINNER,
    gym: routine.gymMinutes,
    sleep: routine.sleepMinutes,
  };
}

function resolveExperience(now: number, clocks: Clocks, day: DaySnapshot): ExperienceType {
  if (clocks.sleep != null && inRange(now, clocks.sleep, clocks.wake)) return 'LATE_NIGHT';
  // Still before a late bedtime (sleep after midnight, wake later).
  if (clocks.sleep != null && clocks.sleep < clocks.wake && now < clocks.sleep) return 'EVENING';
  // An afternoon or evening gym pulls the card forward so it is not stuck on lunch.
  if (
    clocks.gym != null &&
    day.workoutScheduled &&
    clocks.gym >= clocks.lunch &&
    inWindow(now, clocks.gym - 30, 210)
  ) {
    return 'EVENING';
  }
  if (now < clocks.lunch) return 'MORNING';
  if (now < clocks.dinner) return 'AFTERNOON';
  return 'EVENING';
}

function buildExperience(
  type: ExperienceType,
  clocks: Clocks,
  day: DaySnapshot,
): EngagementDecision['experience'] {
  if (type === 'LATE_NIGHT') {
    return {
      type,
      title: "It's getting late",
      subtitle: 'Your body needs recovery too. Try to get some good sleep tonight.',
    };
  }
  if (type === 'MORNING') {
    if (clocks.gym == null) {
      return {
        type,
        title: 'Good morning',
        subtitle: 'Ready to start your day?',
      };
    }
    return {
      type,
      title: 'Good morning',
      subtitle: `Your workout is scheduled for ${formatClock(clocks.gym)}.`,
    };
  }
  if (type === 'AFTERNOON') {
    if (!day.lunch.planned) {
      return { type, title: 'Good afternoon', subtitle: 'How is your day going?' };
    }
    if (day.lunch.completed) {
      return {
        type,
        title: 'Good afternoon',
        subtitle: 'Lunch completed. Keep going with your nutrition plan.',
      };
    }
    if (day.lunch.skipped) {
      return { type, title: 'Good afternoon', subtitle: 'Lunch was skipped.' };
    }
    return { type, title: 'Good afternoon', subtitle: 'Have you had lunch?' };
  }
  if (day.workoutScheduled && !day.workoutCompleted) {
    const when = clocks.gym == null ? '' : ` Scheduled ${formatClock(clocks.gym)}.`;
    const name = day.workoutName ? ` Today's workout: ${day.workoutName}.` : '';
    return {
      type,
      title: 'Good evening',
      subtitle: `Your workout is waiting for you.${name}${when}`,
    };
  }
  if (day.workoutCompleted) {
    return {
      type,
      title: 'Good evening',
      subtitle: 'Workout completed. Great work today.',
    };
  }
  return { type, title: 'Good evening', subtitle: 'Keep going with your plan.' };
}

function buildActions(
  type: ExperienceType,
  now: number,
  clocks: Clocks,
  day: DaySnapshot,
  behind: boolean,
): EngagementAction[] {
  const actions: EngagementAction[] = [];
  if (type === 'LATE_NIGHT') {
    actions.push({ type: 'START_WIND_DOWN' });
    return actions;
  }
  if (type === 'MORNING' && clocks.gym == null) {
    const suggested = suggestTypicalMinutes(day.recentGymMinutes);
    actions.push({
      type: 'CONFIRM_GYM_TIME',
      suggestedTime: suggested == null ? null : formatClock(suggested),
      suggestedMinutes: suggested,
    });
  }
  if (day.workoutScheduled && !day.workoutCompleted) {
    actions.push(type === 'EVENING' ? { type: 'START_WORKOUT' } : { type: 'VIEW_WORKOUT' });
  }
  const meal = mealPrompt(type, now, clocks, day);
  if (meal) {
    actions.push({ type: 'MARK_MEAL_DONE', meal });
    actions.push({ type: 'MEAL_NOT_YET', meal });
  }
  if (behind) actions.push({ type: 'LOG_WATER' });
  return actions;
}

function mealPrompt(
  type: ExperienceType,
  now: number,
  clocks: Clocks,
  day: DaySnapshot,
): MealSlot | null {
  const slot: MealSlot | null =
    type === 'MORNING' ? 'breakfast' : type === 'AFTERNOON' ? 'lunch' : type === 'EVENING' ? 'dinner' : null;
  if (!slot) return null;
  const state = day[slot];
  const at = clocks[slot];
  if (!state.planned || state.completed || state.skipped) return null;
  if (!inWindow(now, at, 90)) return null;
  return slot;
}

function mealView(time: number, state: MealSlotState) {
  return {
    time: formatClock(time),
    planned: state.planned,
    completed: state.completed,
    skipped: state.skipped,
  };
}

function hydrationBehind(now: number, clocks: Clocks, day: DaySnapshot): boolean {
  if (day.waterGoalMl <= 0) return false;
  const ratio = day.waterMl / day.waterGoalMl;
  if (inWindow(now, clocks.wake + 180, 60)) return ratio < 0.25;
  if (inWindow(now, clocks.lunch + 180, 60)) return ratio < 0.6;
  return false;
}

function decideNotification(
  now: number,
  clocks: Clocks,
  input: EvaluateInput,
): { notification: NotificationDecision; trace: NoticeTrace[] } {
  const { settings, sent } = input;
  if (sent.length >= settings.dailyLimit) {
    const reason = `Daily limit reached (${sent.length} / ${settings.dailyLimit})`;
    return {
      notification: { result: 'SKIP', type: null, reason },
      trace: NOTIFICATION_TYPES.map((type) => ({ type, result: 'SKIP' as const, reason })),
    };
  }

  const quiet = inRange(now, settings.quietStartMinutes, settings.quietEndMinutes);
  const candidates: Candidate[] = [];
  const trace: NoticeTrace[] = [];

  for (const type of NOTIFICATION_TYPES) {
    const outcome = eligibility(type, now, clocks, input, quiet);
    if (outcome.ok) {
      candidates.push({ type, reason: outcome.reason, windowStart: outcome.windowStart });
    } else {
      trace.push({ type, result: 'SKIP', reason: outcome.reason });
    }
  }

  if (candidates.length === 0) {
    return {
      notification: { result: 'SKIP', type: null, reason: 'No notification is due' },
      trace,
    };
  }

  candidates.sort((a, b) => {
    const rank =
      PRIORITY_RANK[settings.templates[b.type].priority] -
      PRIORITY_RANK[settings.templates[a.type].priority];
    if (rank !== 0) return rank;
    return distance(now, a.windowStart) - distance(now, b.windowStart);
  });

  const winner = candidates[0]!;
  const template = settings.templates[winner.type];
  for (const candidate of candidates) {
    if (candidate.type === winner.type) {
      trace.push({ type: candidate.type, result: 'SEND', reason: candidate.reason });
    } else {
      trace.push({
        type: candidate.type,
        result: 'SKIP',
        reason: `Held for ${winner.type}`,
      });
    }
  }
  trace.sort((a, b) => NOTIFICATION_TYPES.indexOf(a.type) - NOTIFICATION_TYPES.indexOf(b.type));

  return {
    notification: {
      result: 'SEND',
      type: winner.type,
      title: template.title,
      body: template.body,
      deepLink: template.deepLink,
      priority: template.priority,
      reason: winner.reason,
    },
    trace,
  };
}

function distance(now: number, start: number): number {
  const raw = Math.abs(now - start);
  return Math.min(raw, 1440 - raw);
}

type Eligibility =
  | { ok: true; reason: string; windowStart: number }
  | { ok: false; reason: string };

function eligibility(
  type: NotificationType,
  now: number,
  clocks: Clocks,
  input: EvaluateInput,
  quiet: boolean,
): Eligibility {
  const template = input.settings.templates[type];
  if (!template.enabled) return { ok: false, reason: 'Template disabled' };

  const category = categoryFor(type);
  if (!input.settings.prefs[category]) return { ok: false, reason: 'Notification disabled' };

  if (quiet && type !== 'SLEEP_REMINDER') return { ok: false, reason: 'Quiet hours' };

  if (type === 'HYDRATION_REMINDER') {
    const sentCount = input.sent.filter((item) => item.type === type).length;
    if (sentCount >= HYDRATION_DAILY_CAP) return { ok: false, reason: 'Already sent today' };
    const latest = input.sent
      .filter((item) => item.type === type)
      .reduce((max, item) => Math.max(max, item.sentAtMinutes), -1);
    if (latest >= 0 && distance(now, latest) < HYDRATION_COOLDOWN_MINUTES) {
      return { ok: false, reason: 'Cooldown active' };
    }
  } else if (input.sent.some((item) => item.type === type)) {
    return { ok: false, reason: 'Already sent today' };
  }

  return windowCheck(type, now, clocks, input.day);
}

function windowCheck(type: NotificationType, now: number, clocks: Clocks, day: DaySnapshot): Eligibility {
  switch (type) {
    case 'MORNING_GREETING':
      return timed(now, clocks.wake, 90, 'Morning greeting window');
    case 'PRE_WORKOUT':
      return workoutDue(now, clocks, day, -30, 30, '30 minutes before gym time');
    case 'WORKOUT_REMINDER':
      return workoutDue(now, clocks, day, 0, 30, 'Gym time reached');
    case 'MISSED_WORKOUT':
      if (day.checkedIn) return { ok: false, reason: 'Already checked in' };
      return workoutDue(now, clocks, day, 90, 90, 'Workout still not started');
    case 'POST_WORKOUT':
      if (!day.workoutCompleted || day.workoutCompletedMinutes == null) {
        return { ok: false, reason: 'Workout is not completed' };
      }
      return timed(now, day.workoutCompletedMinutes, 90, 'Workout just completed');
    case 'BREAKFAST_REMINDER':
      return mealDue(now, clocks.breakfast, day.breakfast, 'Breakfast');
    case 'LUNCH_REMINDER':
      return mealDue(now, clocks.lunch, day.lunch, 'Lunch');
    case 'DINNER_REMINDER':
      return mealDue(now, clocks.dinner, day.dinner, 'Dinner');
    case 'HYDRATION_REMINDER':
      return hydrationDue(now, clocks, day);
    case 'RECOVERY_REMINDER':
      if (!day.workoutCompleted) return { ok: false, reason: 'Workout is not completed' };
      if (clocks.sleep == null) return timed(now, clocks.dinner, 90, 'Evening recovery window');
      if (!inRange(now, clocks.dinner, clocks.sleep)) {
        return { ok: false, reason: 'Outside the scheduled window' };
      }
      return { ok: true, reason: 'Evening recovery window', windowStart: clocks.dinner };
    case 'SLEEP_REMINDER':
      if (clocks.sleep == null) return { ok: false, reason: 'Sleep time is not set' };
      return timed(now, clocks.sleep, 45, 'Sleep time reached');
    case 'STREAK':
      if (day.streakDays < 2) return { ok: false, reason: 'No active streak' };
      return timed(now, clocks.wake + 90, 60, 'Streak reminder window');
    case 'GOAL_PROGRESS':
      if (!day.workoutCompleted || day.waterGoalMl <= 0 || day.waterMl < day.waterGoalMl) {
        return { ok: false, reason: 'Daily targets are not both met' };
      }
      return timed(now, clocks.lunch, clocks.dinner - clocks.lunch, 'Goal progress window');
  }
}

function workoutDue(
  now: number,
  clocks: Clocks,
  day: DaySnapshot,
  offset: number,
  duration: number,
  reason: string,
): Eligibility {
  if (!day.workoutScheduled) return { ok: false, reason: 'No workout scheduled today' };
  if (day.workoutCompleted) return { ok: false, reason: 'Workout already completed' };
  if (clocks.gym == null) return { ok: false, reason: 'Gym time is not set' };
  return timed(now, clocks.gym + offset, duration, reason);
}

function mealDue(now: number, at: number, state: MealSlotState, label: string): Eligibility {
  if (!state.planned) return { ok: false, reason: `No ${label.toLowerCase()} planned` };
  if (state.completed) return { ok: false, reason: `${label} already completed` };
  if (state.skipped) return { ok: false, reason: `${label} skipped` };
  return timed(now, at, 90, `${label} is due and not logged`);
}

function hydrationDue(now: number, clocks: Clocks, day: DaySnapshot): Eligibility {
  if (day.waterGoalMl <= 0) return { ok: false, reason: 'No water target' };
  const ratio = day.waterMl / day.waterGoalMl;
  if (inWindow(now, clocks.wake + 180, 60)) {
    if (ratio >= 0.25) return { ok: false, reason: 'Hydration is on pace' };
    return { ok: true, reason: 'Morning water is behind target', windowStart: clocks.wake + 180 };
  }
  if (inWindow(now, clocks.lunch + 180, 60)) {
    if (ratio >= 0.6) return { ok: false, reason: 'Hydration is on pace' };
    return { ok: true, reason: 'Afternoon water is behind target', windowStart: clocks.lunch + 180 };
  }
  return { ok: false, reason: 'Outside the scheduled window' };
}

function timed(now: number, start: number, duration: number, reason: string): Eligibility {
  if (!inWindow(now, start, duration)) return { ok: false, reason: 'Outside the scheduled window' };
  return { ok: true, reason, windowStart: start };
}
