/**
 * Turns the existing sync blob into the day snapshot the rules expect.
 * Does not copy that data into a new store.
 */

import type { DaySnapshot, MealSlot, MealSlotState } from './rules.js';

const MEAL_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner'];

export type SnapshotInput = {
  payload: unknown;
  localDate: string;
  /** 1 = Monday … 7 = Sunday, in the member timezone. */
  weekday: number;
  checkedIn: boolean;
  recentGymMinutes: number[];
  streakDays: number;
  skippedMeals: MealSlot[];
  /** True when an ISO timestamp falls on `localDate` for this member. */
  isLocalDate: (iso: string) => boolean;
  /** Local minutes of an ISO timestamp, or null when it cannot be read. */
  minutesOf: (iso: string) => number | null;
};

export function buildDaySnapshot(input: SnapshotInput): DaySnapshot {
  const stores = readStores(input.payload);
  const workout = readWorkout(stores, input.weekday);
  const completed = readCompletedWorkout(stores, input);
  const meals = readMeals(stores, input);
  const water = readWater(stores, input.localDate);

  return {
    workoutScheduled: workout.scheduled,
    workoutName: workout.name,
    workoutCompleted: completed.completed,
    workoutCompletedMinutes: completed.minutes,
    checkedIn: input.checkedIn,
    breakfast: meals.breakfast,
    lunch: meals.lunch,
    dinner: meals.dinner,
    waterMl: water.loggedMl,
    waterGoalMl: water.goalMl,
    streakDays: input.streakDays,
    recentGymMinutes: input.recentGymMinutes,
  };
}

function readStores(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const stores = (payload as { stores?: unknown }).stores;
  if (!stores || typeof stores !== 'object') return {};
  return stores as Record<string, unknown>;
}

function sliceData(stores: Record<string, unknown>, key: string): unknown {
  const slice = stores[key];
  if (!slice || typeof slice !== 'object') return undefined;
  return (slice as { data?: unknown }).data;
}

function readWorkout(stores: Record<string, unknown>, weekday: number): { scheduled: boolean; name: string | null } {
  const plans = asArray(sliceData(stores, 'plans'));
  const active = pickActivePlan(plans);
  if (!active) return { scheduled: false, name: null };
  const days = asArray(active.days);
  const day = days.find((item) => Number(item.dayOfWeek) === weekday);
  if (!day) return { scheduled: false, name: null };
  const exercises = asArray(day.exercises);
  const rest = day.isRestDay === true || exercises.length === 0;
  if (rest) return { scheduled: false, name: null };
  const name = typeof day.name === 'string' && day.name.trim() ? day.name.trim() : null;
  return { scheduled: true, name };
}

function pickActivePlan(plans: Record<string, unknown>[]): Record<string, unknown> | null {
  const usable = plans.filter((plan) => plan && typeof plan.id === 'string');
  const coach = usable
    .filter((plan) => plan.isActive === true && plan.assignedByCoach === true)
    .sort((a, b) => planTime(b) - planTime(a));
  if (coach[0]) return coach[0];
  const active = usable
    .filter((plan) => plan.isActive === true)
    .sort((a, b) => planTime(b) - planTime(a));
  return active[0] ?? null;
}

function planTime(plan: Record<string, unknown>): number {
  const raw = plan.updatedAt ?? plan.createdAt;
  const time = typeof raw === 'string' ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function readCompletedWorkout(
  stores: Record<string, unknown>,
  input: SnapshotInput,
): { completed: boolean; minutes: number | null } {
  const history = asArray(sliceData(stores, 'history'));
  for (const item of history) {
    const at = typeof item.completedAt === 'string' ? item.completedAt : '';
    if (!at || !input.isLocalDate(at)) continue;
    return { completed: true, minutes: input.minutesOf(at) };
  }
  return { completed: false, minutes: null };
}

function readMeals(stores: Record<string, unknown>, input: SnapshotInput): Record<MealSlot, MealSlotState> {
  const planned = plannedSlots(stores, input.weekday);
  const logged = new Set<MealSlot>();
  const entries = mealEntries(stores);
  for (const entry of entries) {
    if (!entryOnDate(entry, input.localDate)) continue;
    const slot = mealSlot(entry.type);
    if (slot) logged.add(slot);
  }
  const skipped = new Set(input.skippedMeals);
  return {
    breakfast: slotState('breakfast', planned, logged, skipped),
    lunch: slotState('lunch', planned, logged, skipped),
    dinner: slotState('dinner', planned, logged, skipped),
  };
}

function plannedSlots(stores: Record<string, unknown>, weekday: number): Set<MealSlot> | null {
  const plans = asArray(sliceData(stores, 'mealPlans'));
  const active = plans
    .filter((plan) => plan.isActive === true && plan.assignedByCoach === true)
    .sort((a, b) => planTime(b) - planTime(a))[0];
  if (!active) return null;
  const days = asArray(active.days);
  const day = days.find((item) => Number(item.dayOfWeek) === weekday);
  const meals = asArray(day?.meals);
  const slots = new Set<MealSlot>();
  for (const meal of meals) {
    const slot = mealSlot(meal.type);
    if (slot) slots.add(slot);
  }
  return slots;
}

function mealEntries(stores: Record<string, unknown>): Record<string, unknown>[] {
  const data = sliceData(stores, 'meals');
  if (!data || typeof data !== 'object') return [];
  return asArray((data as { entries?: unknown }).entries);
}

function entryOnDate(entry: Record<string, unknown>, localDate: string): boolean {
  const raw = typeof entry.date === 'string' ? entry.date : '';
  return raw === localDate || raw.startsWith(`${localDate}T`);
}

function slotState(
  slot: MealSlot,
  planned: Set<MealSlot> | null,
  logged: Set<MealSlot>,
  skipped: Set<MealSlot>,
): MealSlotState {
  return {
    planned: planned == null ? true : planned.has(slot),
    completed: logged.has(slot),
    skipped: skipped.has(slot) && !logged.has(slot),
  };
}

function readWater(stores: Record<string, unknown>, localDate: string): { loggedMl: number; goalMl: number } {
  const data = sliceData(stores, 'meals');
  const logs =
    data && typeof data === 'object' ? asArray((data as { waterLogs?: unknown }).waterLogs) : [];
  const loggedMl = logs.reduce((sum, log) => {
    const date = typeof log.date === 'string' ? log.date : '';
    if (date !== localDate && !date.startsWith(`${localDate}T`)) return sum;
    const amount = Number(log.amountMl);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  const challenges = asArray(sliceData(stores, 'waterChallenges'));
  const active = challenges
    .filter((item) => item.isActive === true && item.assignedByCoach === true)
    .filter((item) => coversDate(item, localDate))
    .sort((a, b) => planTime(b) - planTime(a))[0];
  const target = Number(active?.targetMlPerDay);
  const goalMl = Number.isFinite(target) && target >= 500 ? Math.round(target) : 2300;
  return { loggedMl, goalMl };
}

function coversDate(challenge: Record<string, unknown>, localDate: string): boolean {
  const start = typeof challenge.startDate === 'string' ? challenge.startDate : '';
  const end = typeof challenge.endDate === 'string' ? challenge.endDate : '';
  if (!start || !end) return false;
  return localDate >= start && localDate <= end;
}

function mealSlot(value: unknown): MealSlot | null {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  return MEAL_SLOTS.find((slot) => slot === raw) ?? null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}
