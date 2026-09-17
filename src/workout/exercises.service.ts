import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, ilike, ne, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { exercises } from '../db/schema.js';
import { EXERCISE_CATALOG } from './exercise-catalog.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

export type ExerciseDto = {
  uuid: string;
  id: string;
  slug: string;
  name: string;
  muscleGroup: string;
  target: string;
  secondary: string[];
  equipment: string;
  difficulty: string;
  imageUrl: string | null;
  videoUrl: string | null;
  instructions: string[];
  description: string | null;
  anatomy: {
    view: 'front' | 'back';
    primary: string[];
    secondary: string[];
  };
};

export type ExerciseInput = {
  name?: string;
  slug?: string;
  muscleGroup?: string;
  target?: string;
  secondary?: string[] | string;
  equipment?: string;
  difficulty?: string;
  imageUrl?: string;
  videoUrl?: string;
  instructions?: string[] | string;
  description?: string;
};

const DEFAULT_IMAGE =
  'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=800&q=70';

const ANATOMY: Record<
  string,
  { target: string; view: 'front' | 'back'; primary: string[]; secondary: string[] }
> = {
  Chest: { target: 'Chest', view: 'front', primary: ['chest'], secondary: ['front-deltoid', 'triceps'] },
  Back: { target: 'Back', view: 'back', primary: ['upper-back'], secondary: ['biceps', 'rhomboids', 'rear-deltoid'] },
  Shoulders: { target: 'Side Delts', view: 'front', primary: ['deltoids'], secondary: ['front-deltoid', 'triceps'] },
  Arms: { target: 'Biceps', view: 'front', primary: ['biceps'], secondary: ['forearm'] },
  Legs: { target: 'Quads', view: 'front', primary: ['quadriceps'], secondary: ['gluteal', 'hamstring'] },
  Core: { target: 'Abs', view: 'front', primary: ['abs'], secondary: ['obliques'] },
  Glutes: { target: 'Glutes', view: 'back', primary: ['gluteal'], secondary: ['hamstring'] },
  'Full Body': { target: 'Full Body', view: 'front', primary: ['chest', 'quadriceps'], secondary: ['abs'] },
};

@Injectable()
export class ExercisesService {
  private seeding: Promise<void> | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async list(q?: string) {
    await this.ensureSeeded();
    const query = q?.trim();
    const rows = query
      ? await this.db
          .select()
          .from(exercises)
          .where(
            or(
              ilike(exercises.name, `%${query}%`),
              ilike(exercises.slug, `%${query}%`),
              ilike(exercises.muscleGroup, `%${query}%`),
              ilike(exercises.targetMuscle, `%${query}%`),
              ilike(exercises.equipment, `%${query}%`),
            ),
          )
          .orderBy(exercises.muscleGroup, exercises.name)
      : await this.db.select().from(exercises).orderBy(exercises.muscleGroup, exercises.name);
    return { exercises: rows.map((row) => this.toDto(row)) };
  }

  async getBySlug(slug: string) {
    await this.ensureSeeded();
    const [row] = await this.db.select().from(exercises).where(eq(exercises.slug, slug)).limit(1);
    return row ? this.toDto(row) : null;
  }

  async create(input: ExerciseInput) {
    const payload = this.toRow(input, true);
    const [existing] = await this.db
      .select({ id: exercises.id })
      .from(exercises)
      .where(eq(exercises.slug, payload.slug))
      .limit(1);
    if (existing) throw new Error('An exercise with that slug already exists');
    const [row] = await this.db.insert(exercises).values(payload).returning();
    return { exercise: this.toDto(row) };
  }

  async update(id: string, input: ExerciseInput) {
    const current = await this.findRow(id);
    if (!current) throw new Error('Exercise not found');
    const payload = this.toRow(
      {
        ...this.fromRow(current),
        ...input,
        slug: input.slug?.trim() || current.slug,
      },
      false,
      current,
    );
    if (payload.slug !== current.slug) {
      const [taken] = await this.db
        .select({ id: exercises.id })
        .from(exercises)
        .where(and(eq(exercises.slug, payload.slug), ne(exercises.id, current.id)))
        .limit(1);
      if (taken) throw new Error('An exercise with that slug already exists');
    }
    const [row] = await this.db
      .update(exercises)
      .set(payload)
      .where(eq(exercises.id, current.id))
      .returning();
    return { exercise: this.toDto(row) };
  }

  async remove(id: string) {
    const current = await this.findRow(id);
    if (!current) throw new Error('Exercise not found');
    await this.db.delete(exercises).where(eq(exercises.id, current.id));
    return { ok: true, slug: current.slug };
  }

  private async findRow(id: string) {
    const key = id.trim();
    if (/^[0-9a-f-]{36}$/i.test(key)) {
      const [byId] = await this.db.select().from(exercises).where(eq(exercises.id, key)).limit(1);
      if (byId) return byId;
    }
    const [bySlug] = await this.db.select().from(exercises).where(eq(exercises.slug, key)).limit(1);
    return bySlug ?? null;
  }

  private async ensureSeeded() {
    if (!this.seeding) this.seeding = this.seedIfEmpty();
    await this.seeding;
  }

  private async seedIfEmpty() {
    const [row] = await this.db.select({ n: count() }).from(exercises);
    if (Number(row?.n ?? 0) > 0) return;
    for (const item of EXERCISE_CATALOG) {
      const anatomy = ANATOMY[item.muscleGroup] ?? ANATOMY['Full Body'];
      try {
        await this.db.insert(exercises).values({
          slug: item.id,
          name: item.name,
          description: `${item.target} focused ${item.equipment.toLowerCase()} exercise`,
          instructions: JSON.stringify([]),
          muscleGroup: item.muscleGroup,
          targetMuscle: item.target,
          secondaryMuscles: JSON.stringify(item.secondary),
          anatomyView: anatomy.view,
          anatomyPrimary: JSON.stringify(anatomy.primary),
          anatomySecondary: JSON.stringify(anatomy.secondary),
          equipment: item.equipment,
          difficulty: 'intermediate',
          imageUrl: DEFAULT_IMAGE,
        });
      } catch (error) {
        console.error('[exercises.seed]', item.id, error);
      }
    }
  }

  private toDto(row: typeof exercises.$inferSelect): ExerciseDto {
    const anatomy = ANATOMY[row.muscleGroup] ?? ANATOMY['Full Body'];
    return {
      uuid: row.id,
      id: row.slug,
      slug: row.slug,
      name: row.name,
      muscleGroup: row.muscleGroup,
      target: row.targetMuscle,
      secondary: parseStringArray(row.secondaryMuscles),
      equipment: row.equipment || 'Other',
      difficulty: row.difficulty || 'beginner',
      imageUrl: row.imageUrl,
      videoUrl: row.videoUrl,
      instructions: parseStringArray(row.instructions),
      description: row.description,
      anatomy: {
        view: row.anatomyView === 'back' ? 'back' : anatomy.view,
        primary: parseStringArray(row.anatomyPrimary, anatomy.primary),
        secondary: parseStringArray(row.anatomySecondary, anatomy.secondary),
      },
    };
  }

  private fromRow(row: typeof exercises.$inferSelect): ExerciseInput {
    return {
      name: row.name,
      slug: row.slug,
      muscleGroup: row.muscleGroup,
      target: row.targetMuscle,
      secondary: parseStringArray(row.secondaryMuscles),
      equipment: row.equipment || undefined,
      difficulty: row.difficulty || undefined,
      imageUrl: row.imageUrl || undefined,
      videoUrl: row.videoUrl || undefined,
      instructions: parseStringArray(row.instructions),
      description: row.description || undefined,
    };
  }

  private toRow(
    input: ExerciseInput,
    requireName: boolean,
    existing?: typeof exercises.$inferSelect,
  ) {
    const name = input.name?.trim() || '';
    if (requireName && !name) throw new Error('Name is required');
    const muscleGroup = input.muscleGroup?.trim() || 'Full Body';
    const anatomy = ANATOMY[muscleGroup] ?? ANATOMY['Full Body'];
    const slug = toSlug(input.slug || name);
    if (!slug) throw new Error('Slug is required');
    const secondary = toStringArray(input.secondary);
    const instructions = toStringArray(input.instructions);
    const keepAnatomy = Boolean(existing && existing.muscleGroup === muscleGroup);
    return {
      slug,
      name: name || slug,
      description: input.description?.trim() || `${input.target?.trim() || anatomy.target} focused exercise`,
      instructions: JSON.stringify(instructions),
      muscleGroup,
      targetMuscle: input.target?.trim() || anatomy.target,
      secondaryMuscles: JSON.stringify(secondary),
      anatomyView: keepAnatomy ? existing!.anatomyView : anatomy.view,
      anatomyPrimary: keepAnatomy ? existing!.anatomyPrimary : JSON.stringify(anatomy.primary),
      anatomySecondary: keepAnatomy ? existing!.anatomySecondary : JSON.stringify(anatomy.secondary),
      equipment: input.equipment?.trim() || 'Other',
      difficulty: normalizeDifficulty(input.difficulty),
      imageUrl: input.imageUrl?.trim() || DEFAULT_IMAGE,
      videoUrl: input.videoUrl?.trim() || null,
    };
  }
}

function toSlug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeDifficulty(value?: string) {
  const next = value?.trim().toLowerCase();
  if (next === 'beginner' || next === 'intermediate' || next === 'advanced') return next;
  return 'beginner';
}

function toStringArray(value?: string[] | string) {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseStringArray(raw: string | null | undefined, fallback: string[] = []) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return raw
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return fallback;
}
