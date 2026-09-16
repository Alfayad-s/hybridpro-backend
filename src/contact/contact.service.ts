import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { contactSubmissions } from '../db/schema.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

@Injectable()
export class ContactService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: { name: string; email: string; phone?: string; goal: string }) {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    const goal = input.goal.trim();
    const phone = input.phone?.trim() || null;
    if (!name || !email || !goal) throw new Error('name, email, and goal are required');

    const [row] = await this.db
      .insert(contactSubmissions)
      .values({ name, email, phone, goal, status: 'new' })
      .returning();
    return this.toPublic(row);
  }

  async list(input?: { q?: string; status?: string }) {
    const filters = [];
    if (input?.status) filters.push(eq(contactSubmissions.status, input.status));
    if (input?.q?.trim()) {
      const q = `%${input.q.trim()}%`;
      filters.push(
        or(
          ilike(contactSubmissions.name, q),
          ilike(contactSubmissions.email, q),
          ilike(contactSubmissions.phone, q),
          ilike(contactSubmissions.goal, q),
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(contactSubmissions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(contactSubmissions.createdAt))
      .limit(300);

    return rows.map((row) => this.toPublic(row));
  }

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(contactSubmissions)
      .where(eq(contactSubmissions.id, id))
      .limit(1);
    return row ? this.toPublic(row) : null;
  }

  async markRead(id: string) {
    const [row] = await this.db
      .update(contactSubmissions)
      .set({ status: 'read' })
      .where(eq(contactSubmissions.id, id))
      .returning();
    return row ? this.toPublic(row) : null;
  }

  async markConverted(id: string) {
    const [row] = await this.db
      .update(contactSubmissions)
      .set({ status: 'converted' })
      .where(eq(contactSubmissions.id, id))
      .returning();
    return row ? this.toPublic(row) : null;
  }

  private toPublic(row: typeof contactSubmissions.$inferSelect | undefined) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      goal: row.goal,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
