import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, or } from 'drizzle-orm';
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
    return this.insertCheckin(client.id, client.email, input);
  }

  async listForIdentity(input: { userId?: string | null; email?: string | null }) {
    const live = await this.findSubscription(input, true);
    const row = live ?? (await this.findSubscription(input, false));
    if (!row) return { checkins: [] as PublicCheckin[], active: false };
    const desk = await this.getDesk(row.id);
    return { checkins: desk.checkins, active: Boolean(live) };
  }

  async submitCustomerCheckin(input: {
    userId?: string | null;
    email?: string | null;
    checkinDate?: string;
    weight?: string;
    adherence?: string;
    clientUpdate?: string;
  }) {
    const client = await this.findSubscription(input, true);
    if (!client) throw new Error('Active subscription required');

    const checkinDate = this.parseDate(input.checkinDate);
    const clientUpdate = input.clientUpdate?.trim() || '';
    if (clientUpdate.length < 4) throw new Error('Write a short update about your week');

    const [existing] = await this.db
      .select()
      .from(coachCheckins)
      .where(and(eq(coachCheckins.subscriptionId, client.id), eq(coachCheckins.checkinDate, checkinDate)))
      .limit(1);

    if (existing?.coachReply) {
      throw new Error('Your coach already replied to this date. Use a new date for the next check-in.');
    }

    if (existing) {
      const [updated] = await this.db
        .update(coachCheckins)
        .set({
          weight: input.weight?.trim() || null,
          adherence: input.adherence?.trim() || null,
          clientUpdate,
        })
        .where(eq(coachCheckins.id, existing.id))
        .returning();
      if (!updated) throw new Error('Could not save check-in');
      return this.toCheckin(updated);
    }

    return this.insertCheckin(client.id, client.email, {
      checkinDate,
      weight: input.weight,
      adherence: input.adherence,
      clientUpdate,
    });
  }

  async replyToCheckin(subscriptionId: string, checkinId: string, coachReply: string) {
    await this.requireClient(subscriptionId);
    const text = coachReply.trim();
    if (!text) throw new Error('Write a reply');

    const [row] = await this.db
      .select()
      .from(coachCheckins)
      .where(and(eq(coachCheckins.id, checkinId), eq(coachCheckins.subscriptionId, subscriptionId)))
      .limit(1);
    if (!row) throw new Error('Check-in not found');

    const [updated] = await this.db
      .update(coachCheckins)
      .set({ coachReply: text })
      .where(eq(coachCheckins.id, checkinId))
      .returning();
    if (!updated) throw new Error('Could not save reply');
    return this.toCheckin(updated);
  }

  private parseDate(value?: string) {
    const checkinDate = (value || new Date().toISOString().slice(0, 10)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkinDate)) throw new Error('Use a valid check-in date');
    return checkinDate;
  }

  private async insertCheckin(
    subscriptionId: string,
    email: string,
    input: {
      checkinDate?: string;
      weight?: string;
      adherence?: string;
      clientUpdate?: string;
      coachReply?: string;
    },
  ) {
    const checkinDate = this.parseDate(input.checkinDate);
    const [row] = await this.db
      .insert(coachCheckins)
      .values({
        subscriptionId,
        email,
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

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private async findSubscription(
    input: { userId?: string | null; email?: string | null },
    liveOnly: boolean,
  ) {
    const email = input.email ? this.normalizeEmail(input.email) : null;
    const clauses = [
      input.userId ? eq(subscriptions.userId, input.userId) : undefined,
      email ? eq(subscriptions.email, email) : undefined,
    ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause));
    if (clauses.length === 0) return null;

    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(or(...clauses))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(10);

    const now = Date.now();
    const live = rows.find((row) => {
      if (row.status !== 'active') return false;
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return false;
      return true;
    });
    if (liveOnly) return live ?? null;
    return live ?? rows[0] ?? null;
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
