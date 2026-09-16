import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { coachCheckins, coachNotes, subscriptions } from '../db/schema.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

export type PublicCheckin = {
  id: string;
  checkinDate: string;
  weight: string | null;
  adherence: string | null;
  clientUpdate: string | null;
  coachReply: string | null;
  createdAt: string;
};

@Injectable()
export class CoachingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private missingRelation(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /relation .* does not exist/i.test(message);
  }

  async getDesk(subscriptionId: string) {
    let notes = '';
    let notesUpdatedAt: string | null = null;
    let checkins: PublicCheckin[] = [];

    try {
      const [note] = await this.db
        .select()
        .from(coachNotes)
        .where(eq(coachNotes.subscriptionId, subscriptionId))
        .limit(1);
      if (note) {
        notes = note.body;
        notesUpdatedAt = note.updatedAt.toISOString();
      }
    } catch (error) {
      if (!this.missingRelation(error)) console.error('[coach_notes]', error);
    }

    try {
      const rows = await this.db
        .select()
        .from(coachCheckins)
        .where(eq(coachCheckins.subscriptionId, subscriptionId))
        .orderBy(desc(coachCheckins.createdAt))
        .limit(50);
      checkins = rows.map((row) => this.toCheckin(row));
    } catch (error) {
      if (!this.missingRelation(error)) console.error('[coach_checkins]', error);
    }

    return { notes, notesUpdatedAt, checkins };
  }

  async saveNotes(subscriptionId: string, body: string) {
    await this.requireClient(subscriptionId);
    const text = body.trim();
    const now = new Date();
    const [existing] = await this.db
      .select()
      .from(coachNotes)
      .where(eq(coachNotes.subscriptionId, subscriptionId))
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(coachNotes)
        .set({ body: text, updatedAt: now })
        .where(eq(coachNotes.subscriptionId, subscriptionId))
        .returning();
      return { notes: updated?.body ?? text, notesUpdatedAt: (updated?.updatedAt ?? now).toISOString() };
    }

    const [created] = await this.db
      .insert(coachNotes)
      .values({ subscriptionId, body: text, updatedAt: now })
      .returning();
    return { notes: created?.body ?? text, notesUpdatedAt: (created?.updatedAt ?? now).toISOString() };
  }

  async addCheckin(
    subscriptionId: string,
    input: {
      checkinDate?: string;
      weight?: string;
      adherence?: string;
      clientUpdate?: string;
      coachReply?: string;
    },
  ) {
    const client = await this.requireClient(subscriptionId);
    const checkinDate = (input.checkinDate || new Date().toISOString().slice(0, 10)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkinDate)) throw new Error('Use a valid check-in date');

    const [row] = await this.db
      .insert(coachCheckins)
      .values({
        subscriptionId,
        email: client.email,
        checkinDate,
        weight: input.weight?.trim() || null,
        adherence: input.adherence?.trim() || null,
        clientUpdate: input.clientUpdate?.trim() || null,
        coachReply: input.coachReply?.trim() || null,
      })
      .returning();
    if (!row) throw new Error('Could not save check-in');
    return this.toCheckin(row);
  }

  private async requireClient(subscriptionId: string) {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!row) throw new Error('Client not found');
    return row;
  }

  private toCheckin(row: typeof coachCheckins.$inferSelect): PublicCheckin {
    return {
      id: row.id,
      checkinDate: row.checkinDate,
      weight: row.weight,
      adherence: row.adherence,
      clientUpdate: row.clientUpdate,
      coachReply: row.coachReply,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
