import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { mealLibrary } from '../db/schema.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
type MealType = (typeof MEAL_TYPES)[number];

export type MealLibraryDto = {
  id: string;
  name: string;
  type: MealType;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  notes: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MealLibraryInput = {
  name?: string;
  type?: string;
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  notes?: string | null;
  imageUrl?: string | null;
};

const SEED: Required<Omit<MealLibraryInput, 'notes' | 'imageUrl'>>[] = [
  { name: 'Oats + eggs', type: 'breakfast', calories: 420, proteinG: 26, carbsG: 45, fatG: 14 },
  { name: 'Greek yogurt + berries', type: 'breakfast', calories: 280, proteinG: 22, carbsG: 32, fatG: 6 },
  { name: 'Peanut butter toast', type: 'breakfast', calories: 360, proteinG: 14, carbsG: 38, fatG: 17 },
  { name: 'Chicken rice bowl', type: 'lunch', calories: 550, proteinG: 42, carbsG: 60, fatG: 12 },
  { name: 'Tuna salad wrap', type: 'lunch', calories: 460, proteinG: 34, carbsG: 42, fatG: 15 },
  { name: 'Paneer quinoa bowl', type: 'lunch', calories: 520, proteinG: 28, carbsG: 50, fatG: 22 },
  { name: 'Fish + veggies', type: 'dinner', calories: 480, proteinG: 40, carbsG: 30, fatG: 18 },
  { name: 'Grilled chicken + sweet potato', type: 'dinner', calories: 520, proteinG: 45, carbsG: 48, fatG: 12 },
  { name: 'Lentil curry + rice', type: 'dinner', calories: 540, proteinG: 22, carbsG: 82, fatG: 10 },
  { name: 'Protein shake', type: 'snack', calories: 180, proteinG: 25, carbsG: 8, fatG: 3 },
  { name: 'Banana + almonds', type: 'snack', calories: 220, proteinG: 6, carbsG: 30, fatG: 10 },
  { name: 'Boiled eggs (2)', type: 'snack', calories: 140, proteinG: 12, carbsG: 1, fatG: 10 },
];

@Injectable()
export class MealLibraryService {
  private seeding: Promise<void> | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async list(q?: string, type?: string) {
    await this.ensureSeeded();
    const filters: SQL[] = [];
    const query = q?.trim();
    if (query) filters.push(ilike(mealLibrary.name, `%${query}%`));
    const mealType = parseType(type);
    if (mealType) filters.push(eq(mealLibrary.type, mealType));
    const rows = await this.db
      .select()
      .from(mealLibrary)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(mealLibrary.type), asc(mealLibrary.name));
    return { meals: rows.map(toDto) };
  }

  async create(input: MealLibraryInput) {
    const [row] = await this.db
      .insert(mealLibrary)
      .values(toRow(input, true))
      .returning();
    return { meal: toDto(row) };
  }

  async update(id: string, input: MealLibraryInput) {
    const current = await this.findRow(id);
    if (!current) throw new Error('Meal not found');
    const merged: MealLibraryInput = {
      name: current.name,
      type: current.type,
      calories: current.calories,
      proteinG: current.proteinG,
      carbsG: current.carbsG,
      fatG: current.fatG,
      notes: current.notes,
      imageUrl: current.imageUrl,
      ...input,
    };
    const [row] = await this.db
      .update(mealLibrary)
      .set({ ...toRow(merged, true), updatedAt: new Date() })
      .where(eq(mealLibrary.id, current.id))
      .returning();
    return { meal: toDto(row) };
  }

  async remove(id: string) {
    const current = await this.findRow(id);
    if (!current) throw new Error('Meal not found');
    await this.db.delete(mealLibrary).where(eq(mealLibrary.id, current.id));
    return { ok: true };
  }

  private async findRow(id: string) {
    const key = id.trim();
    if (!/^[0-9a-f-]{36}$/i.test(key)) return null;
    const [row] = await this.db
      .select()
      .from(mealLibrary)
      .where(eq(mealLibrary.id, key))
      .limit(1);
    return row ?? null;
  }

  private async ensureSeeded() {
    if (!this.seeding) this.seeding = this.seedIfEmpty();
    await this.seeding;
  }

  private async seedIfEmpty() {
    const [row] = await this.db.select({ n: count() }).from(mealLibrary);
    if (Number(row?.n ?? 0) > 0) return;
    try {
      await this.db.insert(mealLibrary).values(SEED.map((m) => toRow(m, true)));
    } catch (error) {
      console.error('[meal-library.seed]', error);
    }
  }
}

function parseType(raw: unknown): MealType | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (MEAL_TYPES as readonly string[]).includes(value) ? (value as MealType) : null;
}

function clampInt(value: unknown, min: number, max: number) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function cleanImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url || url.length > 1000 || !/^https:\/\//i.test(url)) return null;
  return url;
}

function toRow(input: MealLibraryInput, requireName: boolean) {
  const name = input.name?.trim().slice(0, 120) ?? '';
  if (requireName && !name) throw new Error('Name is required');
  return {
    name,
    type: parseType(input.type) ?? 'lunch',
    calories: clampInt(input.calories, 0, 5000),
    proteinG: clampInt(input.proteinG, 0, 500),
    carbsG: clampInt(input.carbsG, 0, 500),
    fatG: clampInt(input.fatG, 0, 500),
    notes: input.notes?.trim().slice(0, 1000) || null,
    imageUrl: cleanImageUrl(input.imageUrl),
  };
}

function toDto(row: typeof mealLibrary.$inferSelect): MealLibraryDto {
  return {
    id: row.id,
    name: row.name,
    type: parseType(row.type) ?? 'lunch',
    calories: row.calories,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    notes: row.notes,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
