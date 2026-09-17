import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { subscriptions, userAppSync } from '../db/schema.js';
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
    exercises: { name: string; targetSets: number; targetReps: number }[];
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
  ) {}

  listCatalog(q?: string) {
    return this.exercises.list(q);
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

  async assignPlan(
    subscriptionId: string,
    input: {
      name?: string;
      description?: string;
      muscleFocus?: string;
      weekdays?: number[];
      exercises?: AssignExerciseInput[];
    },
  ) {
    const client = await this.requireLinkedClient(subscriptionId, true);
    const { exercises: catalog } = await this.exercises.list();
    const catalogById = new Map(catalog.map((item) => [item.id, item]));
    const exercises = (input.exercises ?? [])
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
        };
        return planExercise;
      })
      .filter((row): row is PlanExercise => Boolean(row));

    if (exercises.length === 0) throw new Error('Add at least one exercise');

    const weekdays = [...new Set((input.weekdays ?? []).map((day) => Number(day)))]
      .filter((day) => day >= 1 && day <= 7)
      .sort((a, b) => a - b);
    if (weekdays.length === 0) throw new Error('Pick at least one weekday');

    const muscleFocus = (input.muscleFocus || 'Training').trim();
    const now = new Date().toISOString();
    const plan: WorkoutPlan = {
      id: randomUUID(),
      name: (input.name || 'Coach plan').trim(),
      description: (input.description || 'Assigned by your coach').trim(),
      isActive: true,
      assignedByCoach: true,
      createdAt: now,
      updatedAt: now,
      days: WEEKDAY_LABELS.map((label, index) => {
        const dayOfWeek = index + 1;
        const training = weekdays.includes(dayOfWeek);
        return {
          id: randomUUID(),
          name: label,
          muscleFocus: training ? muscleFocus : 'Rest',
          dayOfWeek,
          order: index,
          isRestDay: !training,
          exercises: training ? exercises.map((item) => ({ ...item, id: randomUUID() })) : [],
        };
      }),
    };

    const payload = await this.readPayload(client.userId!);
    const existing = Array.isArray(payload.stores.plans?.data) ? payload.stores.plans.data : [];
    payload.stores.plans = {
      data: [plan, ...existing.map((item) => ({ ...item, isActive: false }))],
      updatedAt: now,
    };

    await this.writePayload(client.userId!, payload);
    return { plan: this.toSummary(plan) };
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
          name: item.name,
          targetSets: item.targetSets,
          targetReps: item.targetReps,
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
