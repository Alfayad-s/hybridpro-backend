import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { subscriptions, userAppSync } from '../db/schema.js';
import { RealtimeFanoutService } from '../realtime/realtime-fanout.service.js';
import { WEEKDAY_LABELS } from './exercise-catalog.js';
import { ExercisesService } from './exercises.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

type PlanExercise = {
  id: string;
  exerciseId: string;
  name: string;
  category: string;
  equipment: string;
  primaryMuscle: string;
  secondaryMuscles: string[];
  targetSets: number;
  targetReps: number;
  restSeconds: number;
  order: number;
  notes?: string;
  imageUrl?: string;
  videoUrl?: string;
};

type PlanDay = {
  id: string;
  name: string;
  muscleFocus: string;
  dayOfWeek: number;
  order: number;
  exercises: PlanExercise[];
  isRestDay?: boolean;
};

type WorkoutPlan = {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  assignedByCoach?: boolean;
  createdAt: string;
  updatedAt: string;
  days: PlanDay[];
};

type SyncPayload = {
  version: number;
  stores: {
    plans: { data: WorkoutPlan[]; updatedAt: string };
    [key: string]: { data: unknown; updatedAt: string };
  };
};

export type AssignExerciseInput = {
  exerciseId?: string;
  targetSets?: number;
  targetReps?: number;
  restSeconds?: number;
  notes?: string;
};

export type AssignDayInput = {
  dayOfWeek: number;
  name?: string;
  muscleFocus?: string;
  isRestDay?: boolean;
  exercises?: AssignExerciseInput[];
};

export type AssignPlanInput = {
  name?: string;
  description?: string;
  /** Legacy single-focus clone mode */
  muscleFocus?: string;
  weekdays?: number[];
  exercises?: AssignExerciseInput[];
  /** New per-day mode */
  days?: AssignDayInput[];
};

export type UpdatePlanInput = {
  name?: string;
  description?: string;
  days?: AssignDayInput[];
};

export type AssignedPlanSummary = {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  assignedByCoach: boolean;
  createdAt: string;
  updatedAt: string;
  days: {
    dayOfWeek: number;
    name: string;
    muscleFocus: string;
    isRestDay: boolean;
    exercises: {
      exerciseId?: string;
      name: string;
      targetSets: number;
      targetReps: number;
      restSeconds?: number;
    }[];
  }[];
};

const EPOCH = new Date(0).toISOString();

function emptyPayload(): SyncPayload {
  return {
    version: 1,
    stores: {
      plans: { data: [], updatedAt: EPOCH },
      history: { data: [], updatedAt: EPOCH },
      activeWorkout: { data: null, updatedAt: EPOCH },
      progress: { data: { bodyWeightLog: [], goalWeight: null }, updatedAt: EPOCH },
      meals: {
        data: { entries: [], waterLogs: [] },
        updatedAt: EPOCH,
      },
      recovery: { data: { lastTrained: {} }, updatedAt: EPOCH },
      customExercises: { data: [], updatedAt: EPOCH },
      muscleGroups: { data: [], updatedAt: EPOCH },
      profile: {
        data: { heightCm: null, weightUnit: 'kg', experienceLevel: null },
        updatedAt: EPOCH,
      },
    },
  };
}

@Injectable()
export class WorkoutService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly exercises: ExercisesService,
    private readonly fanout: RealtimeFanoutService,
  ) {}

  listCatalog(q?: string) {
    return this.exercises.list(q);
  }

  async getUserSync(userId: string) {
    return this.readPayload(userId);
  }

  async putUserSync(userId: string, payload: unknown) {
    const incoming =
      payload && typeof payload === 'object' && 'stores' in (payload as object)
        ? (payload as SyncPayload)
        : emptyPayload();
    if (!incoming.version) incoming.version = 1;
    if (!incoming.stores) incoming.stores = emptyPayload().stores;
    if (!incoming.stores.plans) incoming.stores.plans = { data: [], updatedAt: EPOCH };

    // Merge with server state so a stale client push cannot wipe coach-assigned plans.
    const existing = await this.readPayload(userId);
    const merged = mergeSyncPayloads(existing, incoming);
    await this.writePayload(userId, merged);
    return merged;
  }

  /** Log a water intake entry into the member meals sync store. */
  async logWater(
    userId: string,
    input: { amountMl?: number; date?: string; id?: string },
  ) {
    const amount = Math.round(Number(input.amountMl));
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
      throw new BadRequestException('amountMl must be between 1 and 5000');
    }
    const date = normalizeMealDate(input.date) ?? localDateKey();
    const now = new Date().toISOString();
    const entry = {
      id: (input.id?.trim() || randomUUID()).slice(0, 64),
      date,
      amountMl: amount,
      createdAt: now,
    };

    const payload = await this.readPayload(userId);
    const meals = readMealsData(payload);
    const waterLogs = [
      entry,
      ...meals.waterLogs.filter((w) => w.id !== entry.id),
    ].slice(0, 2000);

    payload.stores.meals = {
      data: { entries: meals.entries, waterLogs },
      updatedAt: now,
    };
    await this.writePayload(userId, payload);

    const dayLogs = waterLogs.filter((w) => w.date === date);
    const totalMl = dayLogs.reduce((sum, w) => sum + w.amountMl, 0);
    return { entry, date, totalMl, logs: dayLogs };
  }

  /** Today's (or dated) water log summary. */
  async getWater(userId: string, date?: string) {
    const day = normalizeMealDate(date) ?? localDateKey();
    const payload = await this.readPayload(userId);
    const meals = readMealsData(payload);
    const logs = meals.waterLogs.filter((w) => w.date === day);
    const totalMl = logs.reduce((sum, w) => sum + w.amountMl, 0);
    return { date: day, totalMl, logs };
  }

  async listAssigned(subscriptionId: string) {
    const client = await this.requireLinkedClient(subscriptionId, false);
    if (!client?.userId) return { plans: [] as AssignedPlanSummary[], appLinked: false };
    const payload = await this.readPayload(client.userId);
    const plans = (payload.stores.plans?.data ?? [])
      .filter((plan) => plan.assignedByCoach)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((plan) => this.toSummary(plan));
    return { plans, appLinked: true };
  }

  async assignPlan(subscriptionId: string, input: AssignPlanInput) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const catalogById = await this.catalogMap();
    const days = this.buildWeekDays(input, catalogById);

    const trainingDays = days.filter((d) => !d.isRestDay && d.exercises.length > 0);
    if (trainingDays.length === 0) {
      throw new Error('Add exercises to at least one training day');
    }

    const now = new Date().toISOString();
    const plan: WorkoutPlan = {
      id: randomUUID(),
      name: (input.name || 'Coach plan').trim(),
      description: (input.description || 'Assigned by your coach').trim(),
      isActive: true,
      assignedByCoach: true,
      createdAt: now,
      updatedAt: now,
      days,
    };

    const payload = await this.readPayload(client.userId!);
    const existing = Array.isArray(payload.stores.plans?.data) ? payload.stores.plans.data : [];
    payload.stores.plans = {
      data: [plan, ...existing.map((item) => ({ ...item, isActive: false }))],
      updatedAt: now,
    };

    await this.writePayload(client.userId!, payload);
    const summary = this.toSummary(plan);
    await this.fanout.toMember(
      client.userId!,
      'workout.assigned',
      {
        type: 'workout.assigned',
        planId: plan.id,
        planName: plan.name,
        subscriptionId,
        route: '/home',
      },
      {
        title: 'New workout assigned',
        body: `Your coach assigned “${plan.name}”`,
      },
    );
    return { plan: summary };
  }

  async updatePlan(subscriptionId: string, planId: string, input: UpdatePlanInput) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const payload = await this.readPayload(client.userId!);
    const existing = Array.isArray(payload.stores.plans?.data) ? payload.stores.plans.data : [];
    const index = existing.findIndex((p) => p.id === planId && p.assignedByCoach);
    if (index < 0) throw new Error('Plan not found');

    const catalogById = await this.catalogMap();
    const current = existing[index];
    const now = new Date().toISOString();

    const days =
      input.days != null
        ? this.buildWeekDays({ days: input.days }, catalogById)
        : current.days;

    if (input.days != null) {
      const trainingDays = days.filter((d) => !d.isRestDay && d.exercises.length > 0);
      if (trainingDays.length === 0) {
        throw new Error('Add exercises to at least one training day');
      }
    }

    const updated: WorkoutPlan = {
      ...current,
      name: input.name != null ? input.name.trim() || current.name : current.name,
      description:
        input.description != null
          ? input.description.trim() || current.description
          : current.description,
      isActive: true,
      assignedByCoach: true,
      updatedAt: now,
      days,
    };

    payload.stores.plans = {
      data: existing.map((item, i) => {
        if (i === index) return updated;
        return { ...item, isActive: false };
      }),
      updatedAt: now,
    };

    await this.writePayload(client.userId!, payload);
    const summary = this.toSummary(updated);
    await this.fanout.toMember(
      client.userId!,
      'workout.updated',
      {
        type: 'workout.updated',
        planId: updated.id,
        planName: updated.name,
        subscriptionId,
        route: '/home',
      },
      {
        title: 'Workout updated',
        body: `Your coach updated “${updated.name}”`,
      },
    );
    return { plan: summary };
  }

  async unassignPlan(subscriptionId: string, planId: string) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const payload = await this.readPayload(client.userId!);
    const existing = Array.isArray(payload.stores.plans?.data) ? payload.stores.plans.data : [];
    const index = existing.findIndex((p) => p.id === planId && p.assignedByCoach);
    if (index < 0) throw new Error('Plan not found');

    const now = new Date().toISOString();
    const remaining = existing.filter((_, i) => i !== index).map((item) => ({
      ...item,
      // leave other plans as-is; coach plan removed entirely from sync
    }));

    payload.stores.plans = {
      data: remaining,
      updatedAt: now,
    };

    await this.writePayload(client.userId!, payload);
    const removed = existing[index];
    await this.fanout.toMember(
      client.userId!,
      'workout.unassigned',
      {
        type: 'workout.unassigned',
        planId,
        planName: removed?.name || '',
        subscriptionId,
        route: '/home',
      },
      {
        title: 'Workout removed',
        body: removed?.name
          ? `Your coach removed “${removed.name}”`
          : 'Your coach removed an assigned workout',
      },
    );
    return { ok: true, planId };
  }

  private async catalogMap() {
    const { exercises: catalog } = await this.exercises.list();
    return new Map(catalog.map((item) => [item.id, item]));
  }

  private buildWeekDays(
    input: AssignPlanInput,
    catalogById: Map<string, Awaited<ReturnType<ExercisesService['list']>>['exercises'][number]>,
  ): PlanDay[] {
    // New per-day payload
    if (Array.isArray(input.days) && input.days.length > 0) {
      const byDow = new Map<number, AssignDayInput>();
      for (const day of input.days) {
        const dow = Number(day.dayOfWeek);
        if (dow < 1 || dow > 7) continue;
        byDow.set(dow, day);
      }

      return WEEKDAY_LABELS.map((label, index) => {
        const dayOfWeek = index + 1;
        const src = byDow.get(dayOfWeek);
        const exercises = this.mapExercises(src?.exercises ?? [], catalogById);
        const isRest =
          src?.isRestDay === true || !src || exercises.length === 0;
        return {
          id: randomUUID(),
          name: (src?.name || label).trim() || label,
          muscleFocus: isRest
            ? 'Rest'
            : (src?.muscleFocus || 'Training').trim() || 'Training',
          dayOfWeek,
          order: index,
          isRestDay: isRest,
          exercises: isRest ? [] : exercises,
        };
      });
    }

    // Legacy: same exercises cloned onto selected weekdays
    const exercises = this.mapExercises(input.exercises ?? [], catalogById);
    if (exercises.length === 0) throw new Error('Add at least one exercise');

    const weekdays = [...new Set((input.weekdays ?? []).map((day) => Number(day)))]
      .filter((day) => day >= 1 && day <= 7)
      .sort((a, b) => a - b);
    if (weekdays.length === 0) throw new Error('Pick at least one weekday');

    const muscleFocus = (input.muscleFocus || 'Training').trim();
    return WEEKDAY_LABELS.map((label, index) => {
      const dayOfWeek = index + 1;
      const training = weekdays.includes(dayOfWeek);
      return {
        id: randomUUID(),
        name: label,
        muscleFocus: training ? muscleFocus : 'Rest',
        dayOfWeek,
        order: index,
        isRestDay: !training,
        exercises: training
          ? exercises.map((item) => ({ ...item, id: randomUUID() }))
          : [],
      };
    });
  }

  private mapExercises(
    rows: AssignExerciseInput[],
    catalogById: Map<string, Awaited<ReturnType<ExercisesService['list']>>['exercises'][number]>,
  ): PlanExercise[] {
    return rows
      .map((row, order) => {
        const catalog = catalogById.get(row.exerciseId || '');
        if (!catalog) return null;
        const planExercise: PlanExercise = {
          id: randomUUID(),
          exerciseId: catalog.id,
          name: catalog.name,
          category: catalog.muscleGroup,
          equipment: catalog.equipment,
          primaryMuscle: catalog.target,
          secondaryMuscles: catalog.secondary,
          targetSets: clampInt(row.targetSets, 1, 12, 3),
          targetReps: clampInt(row.targetReps, 1, 50, 10),
          restSeconds: clampInt(row.restSeconds, 0, 600, 90),
          order,
          notes: row.notes?.trim() || undefined,
          imageUrl: catalog.imageUrl || undefined,
          videoUrl: catalog.videoUrl || undefined,
        };
        return planExercise;
      })
      .filter((row): row is PlanExercise => Boolean(row));
  }

  private toSummary(plan: WorkoutPlan): AssignedPlanSummary {
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      isActive: plan.isActive,
      assignedByCoach: Boolean(plan.assignedByCoach),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      days: plan.days.map((day) => ({
        dayOfWeek: day.dayOfWeek,
        name: day.name,
        muscleFocus: day.muscleFocus,
        isRestDay: Boolean(day.isRestDay || day.exercises.length === 0),
        exercises: day.exercises.map((item) => ({
          exerciseId: item.exerciseId,
          name: item.name,
          targetSets: item.targetSets,
          targetReps: item.targetReps,
          restSeconds: item.restSeconds,
        })),
      })),
    };
  }

  private async requireLinkedClient(subscriptionId: string, requireLink: boolean) {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!row) throw new Error('Client not found');
    if (requireLink && !row.userId) {
      throw new Error('Client has not signed into the app yet');
    }
    return row;
  }

  private async readPayload(userId: string): Promise<SyncPayload> {
    try {
      const [row] = await this.db
        .select()
        .from(userAppSync)
        .where(eq(userAppSync.userId, userId))
        .limit(1);
      if (!row?.payload) return emptyPayload();
      const parsed = JSON.parse(row.payload) as SyncPayload;
      if (!parsed?.stores) return emptyPayload();
      if (!parsed.stores.plans) parsed.stores.plans = { data: [], updatedAt: EPOCH };
      return parsed;
    } catch {
      return emptyPayload();
    }
  }

  private async writePayload(userId: string, payload: SyncPayload) {
    const body = JSON.stringify(payload);
    const now = new Date();
    const [existing] = await this.db
      .select({ userId: userAppSync.userId })
      .from(userAppSync)
      .where(eq(userAppSync.userId, userId))
      .limit(1);

    if (existing) {
      await this.db
        .update(userAppSync)
        .set({ payload: body, updatedAt: now })
        .where(eq(userAppSync.userId, userId));
      return;
    }

    await this.db.insert(userAppSync).values({
      userId,
      payload: body,
      updatedAt: now,
    });
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function planTime(plan: { updatedAt?: string; createdAt?: string }) {
  const value = plan.updatedAt || plan.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function sliceTime(slice: { updatedAt?: string } | undefined) {
  const time = slice?.updatedAt ? new Date(slice.updatedAt).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function mergeWorkoutPlans(left: WorkoutPlan[] = [], right: WorkoutPlan[] = []): WorkoutPlan[] {
  const byId = new Map<string, WorkoutPlan>();
  for (const plan of [...left, ...right]) {
    if (!plan?.id) continue;
    const existing = byId.get(plan.id);
    if (!existing || planTime(plan) >= planTime(existing)) {
      byId.set(plan.id, plan);
    }
  }
  const plans = [...byId.values()];

  // Prefer the newest active coach plan, then any active plan.
  const coachActive = plans
    .filter((plan) => plan.isActive && plan.assignedByCoach)
    .sort((a, b) => planTime(b) - planTime(a))[0];
  const anyActive = plans
    .filter((plan) => plan.isActive)
    .sort((a, b) => planTime(b) - planTime(a))[0];
  const active = coachActive ?? anyActive;
  if (!active) return plans;
  return plans.map((plan) => ({ ...plan, isActive: plan.id === active.id }));
}

function mergeSyncPayloads(existing: SyncPayload, incoming: SyncPayload): SyncPayload {
  const base = emptyPayload();
  const keys = new Set([
    ...Object.keys(base.stores),
    ...Object.keys(existing.stores ?? {}),
    ...Object.keys(incoming.stores ?? {}),
  ]);
  const stores: SyncPayload['stores'] = { ...base.stores };

  for (const key of keys) {
    const left = existing.stores?.[key];
    const right = incoming.stores?.[key];
    if (!left) {
      stores[key] = right ?? base.stores[key] ?? { data: null, updatedAt: EPOCH };
      continue;
    }
    if (!right) {
      stores[key] = left;
      continue;
    }
    if (key === 'plans') {
      const leftPlans = Array.isArray(left.data) ? (left.data as WorkoutPlan[]) : [];
      const rightPlans = Array.isArray(right.data) ? (right.data as WorkoutPlan[]) : [];
      stores.plans = {
        data: mergeWorkoutPlans(leftPlans, rightPlans),
        updatedAt: sliceTime(right) > sliceTime(left) ? right.updatedAt : left.updatedAt,
      };
      continue;
    }
    if (key === 'meals') {
      stores.meals = mergeMealsSlices(left, right);
      continue;
    }
    stores[key] = sliceTime(right) > sliceTime(left) ? right : left;
  }

  return { version: 1, stores };
}

type WaterLogRow = {
  id: string;
  date: string;
  amountMl: number;
  createdAt?: string;
};

type MealEntryRow = Record<string, unknown> & { id?: string };

type MealsData = {
  entries: MealEntryRow[];
  waterLogs: WaterLogRow[];
};

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeMealDate(raw?: string) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return localDateKey(parsed);
}

function readMealsData(payload: SyncPayload): MealsData {
  const raw = payload.stores?.meals?.data;
  const data =
    raw && typeof raw === 'object' ? (raw as { entries?: unknown; waterLogs?: unknown }) : {};
  const entries = Array.isArray(data.entries)
    ? (data.entries as MealEntryRow[]).filter((e) => e && typeof e === 'object')
    : [];
  const waterLogs = Array.isArray(data.waterLogs)
    ? (data.waterLogs as WaterLogRow[])
        .filter((w) => w && typeof w === 'object' && typeof w.id === 'string')
        .map((w) => ({
          id: String(w.id),
          date: String(w.date ?? ''),
          amountMl: Math.max(0, Math.round(Number(w.amountMl) || 0)),
          createdAt: w.createdAt ? String(w.createdAt) : undefined,
        }))
        .filter((w) => w.date && w.amountMl > 0)
    : [];
  return { entries, waterLogs };
}

function mergeMealsSlices(
  left: { data: unknown; updatedAt: string },
  right: { data: unknown; updatedAt: string },
) {
  const a = readMealsData({ version: 1, stores: { plans: { data: [], updatedAt: EPOCH }, meals: left } });
  const b = readMealsData({ version: 1, stores: { plans: { data: [], updatedAt: EPOCH }, meals: right } });

  const entryMap = new Map<string, MealEntryRow>();
  for (const e of [...a.entries, ...b.entries]) {
    const id = e.id != null ? String(e.id) : '';
    if (!id) continue;
    entryMap.set(id, e);
  }
  const waterMap = new Map<string, WaterLogRow>();
  for (const w of [...a.waterLogs, ...b.waterLogs]) {
    waterMap.set(w.id, w);
  }

  const newer = sliceTime(right) >= sliceTime(left) ? right.updatedAt : left.updatedAt;
  return {
    data: {
      entries: [...entryMap.values()].slice(0, 2000),
      waterLogs: [...waterMap.values()]
        .sort((x, y) => String(y.createdAt ?? '').localeCompare(String(x.createdAt ?? '')))
        .slice(0, 2000),
    },
    updatedAt: newer,
  };
}
