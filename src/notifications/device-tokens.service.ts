import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { deviceTokens } from '../db/schema.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

export type DeviceRole = 'member' | 'coach';
export type DevicePlatform = 'ios' | 'android';

function normalizeDeviceId(deviceId?: string) {
  const value = (deviceId || '').trim();
  return value.length > 0 ? value.slice(0, 128) : null;
}

@Injectable()
export class DeviceTokensService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private normalizePlatform(platform?: string): DevicePlatform {
    const value = (platform || '').trim().toLowerCase();
    if (value === 'ios' || value === 'android') return value;
    throw new BadRequestException('platform must be ios or android');
  }

  private normalizeToken(token?: string) {
    const value = (token || '').trim();
    if (value.length < 20) throw new BadRequestException('Invalid device token');
    return value;
  }

  async registerMember(
    userId: string,
    input: { token?: string; platform?: string; deviceId?: string },
  ) {
    const token = this.normalizeToken(input.token);
    const platform = this.normalizePlatform(input.platform);
    const deviceId = normalizeDeviceId(input.deviceId);
    const id = await this.upsertToken({
      role: 'member',
      userId,
      coachEmail: null,
      token,
      platform,
      deviceId,
    });
    return { ok: true as const, id };
  }

  async unregisterMember(userId: string, token?: string) {
    if (token?.trim()) {
      await this.db
        .delete(deviceTokens)
        .where(
          and(
            eq(deviceTokens.token, token.trim()),
            eq(deviceTokens.role, 'member'),
            eq(deviceTokens.userId, userId),
          ),
        );
      return { ok: true as const };
    }
    await this.db
      .delete(deviceTokens)
      .where(and(eq(deviceTokens.role, 'member'), eq(deviceTokens.userId, userId)));
    return { ok: true as const };
  }

  async registerCoach(coachEmail: string, input: { token?: string; platform?: string; deviceId?: string }) {
    const email = coachEmail.trim().toLowerCase();
    if (!email) throw new BadRequestException('Coach email required');
    const token = this.normalizeToken(input.token);
    const platform = this.normalizePlatform(input.platform);
    const deviceId = normalizeDeviceId(input.deviceId);
    const id = await this.upsertToken({
      role: 'coach',
      userId: null,
      coachEmail: email,
      token,
      platform,
      deviceId,
    });
    return { ok: true as const, id };
  }

  /** One row per FCM token. A second login updates it instead of failing. */
  private async upsertToken(input: {
    role: DeviceRole;
    userId: string | null;
    coachEmail: string | null;
    token: string;
    platform: DevicePlatform;
    deviceId: string | null;
  }) {
    const now = new Date();
    const [row] = await this.db
      .insert(deviceTokens)
      .values({
        role: input.role,
        userId: input.userId,
        coachEmail: input.coachEmail,
        token: input.token,
        platform: input.platform,
        deviceId: input.deviceId,
        lastActiveAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: deviceTokens.token,
        set: {
          role: input.role,
          userId: input.userId,
          coachEmail: input.coachEmail,
          platform: input.platform,
          deviceId: input.deviceId ?? sql`${deviceTokens.deviceId}`,
          lastActiveAt: now,
          updatedAt: now,
        },
      })
      .returning({ id: deviceTokens.id });
    return row!.id;
  }

  async unregisterCoach(coachEmail: string, token?: string) {
    const email = coachEmail.trim().toLowerCase();
    if (token?.trim()) {
      await this.db
        .delete(deviceTokens)
        .where(
          and(
            eq(deviceTokens.token, token.trim()),
            eq(deviceTokens.role, 'coach'),
            eq(deviceTokens.coachEmail, email),
          ),
        );
      return { ok: true as const };
    }
    await this.db
      .delete(deviceTokens)
      .where(and(eq(deviceTokens.role, 'coach'), eq(deviceTokens.coachEmail, email)));
    return { ok: true as const };
  }

  async tokensForMember(userId: string) {
    const rows = await this.db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.role, 'member'), eq(deviceTokens.userId, userId)));
    return rows.map((r) => r.token);
  }

  async tokensForCoaches() {
    const rows = await this.db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(eq(deviceTokens.role, 'coach'));
    return rows.map((r) => r.token);
  }

  async removeTokens(tokens: string[]) {
    for (const token of tokens) {
      await this.db.delete(deviceTokens).where(eq(deviceTokens.token, token));
    }
  }
}
