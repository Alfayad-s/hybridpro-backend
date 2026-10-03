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
  /** 1–10. Omitted when the coach did not set an effort target. */
  targetRpe?: number;
  /** 0–10 reps left in the tank. Omitted when unset. */
  targetRir?: number;
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
  targetRpe?: number;
  targetRir?: number;
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
      targetRpe?: number;
      targetRir?: number;
    }[];
  }[];
};

type MealSlotType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

type MealPlanSlot = {
  id: string;
  type: MealSlotType;
  name: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  notes?: string;
  imageUrl?: string;
};

type MealPlanDay = {
  dayOfWeek: number;
  meals: MealPlanSlot[];
};

type CoachMealPlan = {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  assignedByCoach: boolean;
  createdAt: string;
  updatedAt: string;
  days: MealPlanDay[];
};

export type AssignMealSlotInput = {
  type?: string;
  name?: string;
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  notes?: string;
  imageUrl?: string;
};

export type AssignMealDayInput = {
  dayOfWeek: number;
  meals?: AssignMealSlotInput[];
};

export type AssignMealPlanInput = {
  name?: string;
  description?: string;
  days?: AssignMealDayInput[];
};

export type AssignedMealPlanSummary = {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  assignedByCoach: boolean;
  createdAt: string;
  updatedAt: string;
  days: {
    dayOfWeek: number;
    meals: {
      id: string;
      type: MealSlotType;
      name: string;
      calories: number;
      proteinG: number;
      carbsG: number;
      fatG: number;
      notes?: string;
      imageUrl?: string;
    }[];
  }[];
};

type WaterChallenge = {
  id: string;
  title: string;
  description: string;
  targetMlPerDay: number;
  durationDays: number;
  startDate: string;
  endDate: string;
  isActive: boolean;
  assignedByCoach: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AssignWaterChallengeInput = {
  title?: string;
  description?: string;
  targetMlPerDay?: number;
  durationDays?: number;
  startDate?: string;
};

export type AssignedWaterChallengeSummary = WaterChallenge;

const MEAL_TYPES: MealSlotType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

const EPOCH = new Date(0).toISOString();

function emptyPayload(): SyncPayload {
  return {
    version: 1,
    stores: {
      plans: { data: [], updatedAt: EPOCH },
      history: { data: [], updatedAt: EPOCH },
      activeWorkout: { data: null, updatedAt: EPOCH },
      progress: {
        data: { bodyWeightLog: [], goalWeight: null, photoSets: [] },
        updatedAt: EPOCH,
      },
      meals: {
        data: { entries: [], waterLogs: [] },
        updatedAt: EPOCH,
      },
      mealPlans: { data: [], updatedAt: EPOCH },
      waterChallenges: { data: [], updatedAt: EPOCH },
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

  async listOwnProgressPhotos(userId: string): Promise<ProgressPhotoRecord[]> {
    const payload = await this.readPayload(userId);
    return readPhotoSets(payload.stores.progress?.data);
  }

  async listClientProgressPhotos(subscriptionId: string): Promise<ProgressPhotoRecord[]> {
    const client = await this.requireLinkedClient(subscriptionId, false);
    if (!client.userId) return [];
    return this.listOwnProgressPhotos(client.userId);
  }

  /** Save a physique photo. Every capture is kept so the timeline can show the full history. */
  async saveProgressPhoto(
    userId: string,
    input: { pose: string; day: string; takenAt: string; publicId: string; note?: string | null },
  ): Promise<{ saved: ProgressPhotoRecord; replacedPublicId: string | null }> {
    const pose = input.pose;
    if (!PROGRESS_POSES.has(pose)) {
      throw new BadRequestException('pose must be front, side, or back');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) {
      throw new BadRequestException('day must be YYYY-MM-DD');
    }
    const takenAt = Number.isNaN(Date.parse(input.takenAt))
      ? new Date().toISOString()
      : new Date(input.takenAt).toISOString();
    const note = input.note?.trim().slice(0, 200) || null;

    const payload = await this.readPayload(userId);
    const slice = payload.stores.progress ?? {
      data: { bodyWeightLog: [], goalWeight: null, photoSets: [] },
      updatedAt: EPOCH,
    };
    const data: Record<string, unknown> =
      slice.data && typeof slice.data === 'object'
        ? { ...(slice.data as Record<string, unknown>) }
        : { bodyWeightLog: [], goalWeight: null, photoSets: [] };
    const existing = readPhotoSets(data);
    const record: ProgressPhotoRecord = {
      id: randomUUID(),
      takenAt,
      day: input.day,
      pose: pose as ProgressPhotoRecord['pose'],
      publicId: input.publicId,
      note,
    };
    const photos = [record, ...existing].slice(0, 400);
    data.photoSets = photos;
    payload.stores.progress = { data, updatedAt: new Date().toISOString() };
    await this.writePayload(userId, payload);
    return { saved: record, replacedPublicId: null };
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

  // ─── Meal plans ─────────────────────────────────────────────

  async listAssignedMealPlans(subscriptionId: string) {
    const client = await this.requireLinkedClient(subscriptionId, false);
    if (!client?.userId) {
      return { mealPlans: [] as AssignedMealPlanSummary[], appLinked: false };
    }
    const payload = await this.readPayload(client.userId);
    const plans = readMealPlans(payload)
      .filter((plan) => plan.assignedByCoach)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((plan) => this.toMealPlanSummary(plan));
    return { mealPlans: plans, appLinked: true };
  }

  async assignMealPlan(subscriptionId: string, input: AssignMealPlanInput) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const days = this.buildMealPlanDays(input.days ?? []);
    const mealCount = days.reduce((n, d) => n + d.meals.length, 0);
    if (mealCount === 0) {
      throw new BadRequestException('Add at least one meal to the plan');
    }

    const now = new Date().toISOString();
    const plan: CoachMealPlan = {
      id: randomUUID(),
      name: (input.name || 'Coach meal plan').trim(),
      description: (input.description || 'Assigned by your coach').trim(),
      isActive: true,
      assignedByCoach: true,
      createdAt: now,
      updatedAt: now,
      days,
    };

    const payload = await this.readPayload(client.userId!);
    const existing = readMealPlans(payload);
    payload.stores.mealPlans = {
      data: [plan, ...existing.map((item) => ({ ...item, isActive: false }))],
      updatedAt: now,
    };
    await this.writePayload(client.userId!, payload);

    await this.fanout.toMember(
      client.userId!,
      'meal.assigned',
      {
        type: 'meal.assigned',
        mealPlanId: plan.id,
        planName: plan.name,
        subscriptionId,
        route: '/meals',
      },
      {
        title: 'New meal plan assigned',
        body: `Your coach assigned “${plan.name}”`,
      },
    );
    return { mealPlan: this.toMealPlanSummary(plan) };
  }

  async updateMealPlan(
    subscriptionId: string,
    planId: string,
    input: AssignMealPlanInput,
  ) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const payload = await this.readPayload(client.userId!);
    const existing = readMealPlans(payload);
    const index = existing.findIndex((p) => p.id === planId && p.assignedByCoach);
    if (index < 0) throw new BadRequestException('Meal plan not found');

    const current = existing[index]!;
    const now = new Date().toISOString();
    const days =
      input.days != null ? this.buildMealPlanDays(input.days) : current.days;
    if (input.days != null) {
      const mealCount = days.reduce((n, d) => n + d.meals.length, 0);
      if (mealCount === 0) {
        throw new BadRequestException('Add at least one meal to the plan');
      }
    }

    const updated: CoachMealPlan = {
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

    payload.stores.mealPlans = {
      data: existing.map((item, i) => {
        if (i === index) return updated;
        return { ...item, isActive: false };
      }),
      updatedAt: now,
    };
    await this.writePayload(client.userId!, payload);

    await this.fanout.toMember(
      client.userId!,
      'meal.updated',
      {
        type: 'meal.updated',
        mealPlanId: updated.id,
        planName: updated.name,
        subscriptionId,
        route: '/meals',
      },
      {
        title: 'Meal plan updated',
        body: `Your coach updated “${updated.name}”`,
      },
    );
    return { mealPlan: this.toMealPlanSummary(updated) };
  }

  async unassignMealPlan(subscriptionId: string, planId: string) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const payload = await this.readPayload(client.userId!);
    const existing = readMealPlans(payload);
    const index = existing.findIndex((p) => p.id === planId && p.assignedByCoach);
    if (index < 0) throw new BadRequestException('Meal plan not found');

    const removed = existing[index]!;
    const now = new Date().toISOString();
    payload.stores.mealPlans = {
      data: existing.filter((_, i) => i !== index),
      updatedAt: now,
    };
    await this.writePayload(client.userId!, payload);

    await this.fanout.toMember(
      client.userId!,
      'meal.unassigned',
      {
        type: 'meal.unassigned',
        mealPlanId: planId,
        planName: removed.name,
        subscriptionId,
        route: '/meals',
      },
      {
        title: 'Meal plan removed',
        body: `Your coach removed “${removed.name}”`,
      },
    );
    return { ok: true as const, planId };
  }

  // ─── Water challenges ───────────────────────────────────────

  async listAssignedWaterChallenges(subscriptionId: string) {
    const client = await this.requireLinkedClient(subscriptionId, false);
    if (!client?.userId) {
      return {
        waterChallenges: [] as AssignedWaterChallengeSummary[],
        appLinked: false,
      };
    }
    const payload = await this.readPayload(client.userId);
    const challenges = readWaterChallenges(payload)
      .filter((c) => c.assignedByCoach)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { waterChallenges: challenges, appLinked: true };
  }

  async assignWaterChallenge(
    subscriptionId: string,
    input: AssignWaterChallengeInput,
  ) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const challenge = this.buildWaterChallenge(input);
    const now = new Date().toISOString();

    const payload = await this.readPayload(client.userId!);
    const existing = readWaterChallenges(payload);
    payload.stores.waterChallenges = {
      data: [
        challenge,
        ...existing.map((item) => ({ ...item, isActive: false })),
      ],
      updatedAt: now,
    };
    await this.writePayload(client.userId!, payload);

    await this.fanout.toMember(
      client.userId!,
      'water.assigned',
      {
        type: 'water.assigned',
        challengeId: challenge.id,
        title: challenge.title,
        subscriptionId,
        route: '/meals',
      },
      {
        title: 'Water challenge assigned',
        body: `Hit ${challenge.targetMlPerDay} ml/day for ${challenge.durationDays} days`,
      },
    );
    return { waterChallenge: challenge };
  }

  async updateWaterChallenge(
    subscriptionId: string,
    challengeId: string,
    input: AssignWaterChallengeInput,
  ) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const payload = await this.readPayload(client.userId!);
    const existing = readWaterChallenges(payload);
    const index = existing.findIndex(
      (c) => c.id === challengeId && c.assignedByCoach,
    );
    if (index < 0) throw new BadRequestException('Water challenge not found');

    const current = existing[index]!;
    const now = new Date().toISOString();
    const rebuilt = this.buildWaterChallenge(
      {
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        targetMlPerDay: input.targetMlPerDay ?? current.targetMlPerDay,
        durationDays: input.durationDays ?? current.durationDays,
        startDate: input.startDate ?? current.startDate,
      },
      current,
    );
    rebuilt.isActive = true;
    rebuilt.updatedAt = now;

    payload.stores.waterChallenges = {
      data: existing.map((item, i) => {
        if (i === index) return rebuilt;
        return { ...item, isActive: false };
      }),
      updatedAt: now,
    };
    await this.writePayload(client.userId!, payload);

    await this.fanout.toMember(
      client.userId!,
      'water.updated',
      {
        type: 'water.updated',
        challengeId: rebuilt.id,
        title: rebuilt.title,
        subscriptionId,
        route: '/meals',
      },
      {
        title: 'Water challenge updated',
        body: `Your coach updated “${rebuilt.title}”`,
      },
    );
    return { waterChallenge: rebuilt };
  }

  async unassignWaterChallenge(subscriptionId: string, challengeId: string) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const payload = await this.readPayload(client.userId!);
    const existing = readWaterChallenges(payload);
    const index = existing.findIndex(
      (c) => c.id === challengeId && c.assignedByCoach,
    );
    if (index < 0) throw new BadRequestException('Water challenge not found');

    const removed = existing[index]!;
    const now = new Date().toISOString();
    payload.stores.waterChallenges = {
      data: existing.filter((_, i) => i !== index),
      updatedAt: now,
    };
    await this.writePayload(client.userId!, payload);

    await this.fanout.toMember(
      client.userId!,
      'water.unassigned',
      {
        type: 'water.unassigned',
        challengeId,
        title: removed.title,
        subscriptionId,
        route: '/meals',
      },
      {
        title: 'Water challenge removed',
        body: `Your coach removed “${removed.title}”`,
      },
    );
    return { ok: true as const, challengeId };
  }

  private buildMealPlanDays(days: AssignMealDayInput[]): MealPlanDay[] {
    const byDow = new Map<number, AssignMealDayInput>();
    for (const day of days) {
      const dow = Number(day.dayOfWeek);
      if (dow < 1 || dow > 7) continue;
      byDow.set(dow, day);
    }
    return [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => {
      const src = byDow.get(dayOfWeek);
      const meals = (src?.meals ?? [])
        .map((slot) => this.normalizeMealSlot(slot))
        .filter((slot): slot is MealPlanSlot => slot != null);
      return { dayOfWeek, meals };
    });
  }

  private normalizeMealSlot(input: AssignMealSlotInput): MealPlanSlot | null {
    const name = (input.name || '').trim();
    if (!name) return null;
    const typeRaw = (input.type || 'breakfast').toLowerCase();
    const type = (MEAL_TYPES.includes(typeRaw as MealSlotType)
      ? typeRaw
      : 'breakfast') as MealSlotType;
    return {
      id: randomUUID(),
      type,
      name: name.slice(0, 120),
      calories: clampInt(input.calories, 0, 5000, 0),
      proteinG: clampInt(input.proteinG, 0, 500, 0),
      carbsG: clampInt(input.carbsG, 0, 500, 0),
      fatG: clampInt(input.fatG, 0, 500, 0),
      notes: input.notes?.trim() || undefined,
      imageUrl: normalizeImageUrl(input.imageUrl),
    };
  }

  private toMealPlanSummary(plan: CoachMealPlan): AssignedMealPlanSummary {
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
        meals: day.meals.map((m) => ({
          id: m.id,
          type: m.type,
          name: m.name,
          calories: m.calories,
          proteinG: m.proteinG,
          carbsG: m.carbsG,
          fatG: m.fatG,
          notes: m.notes,
          imageUrl: m.imageUrl,
        })),
      })),
    };
  }

  private buildWaterChallenge(
    input: AssignWaterChallengeInput,
    current?: WaterChallenge,
  ): WaterChallenge {
    const targetMl = clampInt(input.targetMlPerDay, 500, 8000, 3000);
    const durationDays = clampInt(input.durationDays, 1, 90, 7);
    const startDate =
      normalizeMealDate(input.startDate) ??
      current?.startDate ??
      localDateKey();
    const endDate = addDaysKey(startDate, durationDays - 1);
    const now = new Date().toISOString();
    return {
      id: current?.id ?? randomUUID(),
      title: (input.title || current?.title || 'Hydration challenge').trim(),
      description: (
        input.description ||
        current?.description ||
        `Drink ${targetMl} ml of water every day`
      ).trim(),
      targetMlPerDay: targetMl,
      durationDays,
      startDate,
      endDate,
      isActive: true,
      assignedByCoach: true,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
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
          targetRpe: optionalInt(row.targetRpe, 1, 10),
          targetRir: optionalInt(row.targetRir, 0, 10),
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
          ...(item.targetRpe != null ? { targetRpe: item.targetRpe } : {}),
          ...(item.targetRir != null ? { targetRir: item.targetRir } : {}),
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

function optionalInt(value: number | undefined, min: number, max: number) {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function addDaysKey(dateKey: string, days: number) {
  const [y, m, d] = dateKey.split('-').map((x) => Number(x));
  const dt = new Date(y!, m! - 1, d!);
  dt.setDate(dt.getDate() + days);
  return localDateKey(dt);
}

function normalizeImageUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const url = raw.trim();
  if (!url || url.length > 1000 || !/^https:\/\//i.test(url)) return undefined;
  return url;
}

function readMealPlans(payload: SyncPayload): CoachMealPlan[] {
  const raw = payload.stores?.mealPlans?.data;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is CoachMealPlan =>
      Boolean(p && typeof p === 'object' && typeof (p as CoachMealPlan).id === 'string'),
  );
}

function readWaterChallenges(payload: SyncPayload): WaterChallenge[] {
  const raw = payload.stores?.waterChallenges?.data;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is WaterChallenge =>
      Boolean(c && typeof c === 'object' && typeof (c as WaterChallenge).id === 'string'),
  );
}

function mergeCoachActiveList<
  T extends {
    id: string;
    isActive?: boolean;
    assignedByCoach?: boolean;
    updatedAt?: string;
    createdAt?: string;
  },
>(left: T[] = [], right: T[] = []): T[] {
  const byId = new Map<string, T>();
  for (const item of [...left, ...right]) {
    if (!item?.id) continue;
    const existing = byId.get(item.id);
    if (!existing || planTime(item) >= planTime(existing)) {
      byId.set(item.id, item);
    }
  }
  const items = [...byId.values()];
  const coachActive = items
    .filter((item) => item.isActive && item.assignedByCoach)
    .sort((a, b) => planTime(b) - planTime(a))[0];
  const anyActive = items
    .filter((item) => item.isActive)
    .sort((a, b) => planTime(b) - planTime(a))[0];
  const active = coachActive ?? anyActive;
  if (!active) return items;
  return items.map((item) => ({ ...item, isActive: item.id === active.id }));
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
    if (key === 'mealPlans') {
      const leftPlans = Array.isArray(left.data) ? (left.data as CoachMealPlan[]) : [];
      const rightPlans = Array.isArray(right.data) ? (right.data as CoachMealPlan[]) : [];
      stores.mealPlans = {
        data: mergeCoachActiveList(leftPlans, rightPlans),
        updatedAt: sliceTime(right) > sliceTime(left) ? right.updatedAt : left.updatedAt,
      };
      continue;
    }
    if (key === 'waterChallenges') {
      const leftItems = Array.isArray(left.data)
        ? (left.data as WaterChallenge[])
        : [];
      const rightItems = Array.isArray(right.data)
        ? (right.data as WaterChallenge[])
        : [];
      stores.waterChallenges = {
        data: mergeCoachActiveList(leftItems, rightItems),
        updatedAt: sliceTime(right) > sliceTime(left) ? right.updatedAt : left.updatedAt,
      };
      continue;
    }
    if (key === 'meals') {
      stores.meals = mergeMealsSlices(left, right);
      continue;
    }
    if (key === 'progress') {
      stores.progress = mergeProgressSlices(left, right);
      continue;
    }
    stores[key] = sliceTime(right) > sliceTime(left) ? right : left;
  }

  return { version: 1, stores };
}

const PROGRESS_POSES = new Set(['front', 'side', 'back']);

export type ProgressPhotoRecord = {
  id: string;
  takenAt: string;
  day: string;
  pose: 'front' | 'side' | 'back';
  publicId: string;
  note: string | null;
};

function readPhotoSets(data: unknown): ProgressPhotoRecord[] {
  if (!data || typeof data !== 'object') return [];
  const raw = (data as { photoSets?: unknown }).photoSets;
  if (!Array.isArray(raw)) return [];
  const photos: ProgressPhotoRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const pose = row.pose;
    const publicId = typeof row.publicId === 'string' ? row.publicId : '';
    const day = typeof row.day === 'string' ? row.day : '';
    if (!PROGRESS_POSES.has(String(pose)) || !publicId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      continue;
    }
    photos.push({
      id: typeof row.id === 'string' && row.id ? row.id : publicId,
      takenAt: typeof row.takenAt === 'string' ? row.takenAt : day,
      day,
      pose: pose as ProgressPhotoRecord['pose'],
      publicId,
      note: typeof row.note === 'string' ? row.note : null,
    });
  }
  return photos;
}

function mergePhotoSets(left: ProgressPhotoRecord[], right: ProgressPhotoRecord[]) {
  const byKey = new Map<string, ProgressPhotoRecord>();
  for (const photo of [...left, ...right]) {
    const key = photo.id || photo.publicId;
    const prev = byKey.get(key);
    if (!prev || photo.takenAt >= prev.takenAt) byKey.set(key, photo);
  }
  return [...byKey.values()]
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt))
    .slice(0, 400);
}

function mergeProgressSlices(
  left: { data: unknown; updatedAt: string },
  right: { data: unknown; updatedAt: string },
) {
  const newer = sliceTime(right) > sliceTime(left) ? right : left;
  const older = newer === right ? left : right;
  const base =
    newer.data && typeof newer.data === 'object'
      ? { ...(newer.data as Record<string, unknown>) }
      : {};
  base.photoSets = mergePhotoSets(readPhotoSets(older.data), readPhotoSets(newer.data));
  return { data: base, updatedAt: newer.updatedAt };
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
