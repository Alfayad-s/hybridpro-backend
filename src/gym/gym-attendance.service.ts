import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { gymSessions, preferredGyms, profiles, subscriptions } from '../db/schema.js';
import { RealtimeFanoutService } from '../realtime/realtime-fanout.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

const arrivalPlans = new Set(['foundation', 'performance', 'elite']);

export type PreferredGymPlace = {
  id: string;
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  photoRef: string | null;
  review: 'pending' | 'gym' | 'not_gym';
  enabled: boolean;
};

export type AdminSavedGym = PreferredGymPlace & {
  userId: string;
  subscriptionId: string | null;
  email: string;
  fullName: string | null;
};

export type GymPlaceHit = {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  photoRef: string | null;
};

export type PublicGymSession = {
  sessionId: string;
  subscriptionId: string;
  userId: string;
  email: string;
  fullName: string | null;
  checkedInAt: string;
  checkedOutAt: string | null;
  status: 'open' | 'closed';
};

@Injectable()
export class GymAttendanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fanout: RealtimeFanoutService,
  ) {}

  async statusForMember(userId: string) {
    const [open] = await this.db
      .select()
      .from(gymSessions)
      .where(and(eq(gymSessions.userId, userId), eq(gymSessions.status, 'open')))
      .limit(1);

    if (!open) return { status: 'closed' as const, session: null };

    const meta = await this.sessionMeta(open.subscriptionId, userId);
    return {
      status: 'open' as const,
      session: this.toPublic(open, meta),
    };
  }

  async checkIn(member: { userId: string; email: string; fullName?: string | null }) {
    const subscription = await this.requireActiveSubscription(member);
    const [existing] = await this.db
      .select()
      .from(gymSessions)
      .where(and(eq(gymSessions.userId, member.userId), eq(gymSessions.status, 'open')))
      .limit(1);
    if (existing) {
      throw new BadRequestException('Already checked in');
    }

    const now = new Date();
    const [row] = await this.db
      .insert(gymSessions)
      .values({
        subscriptionId: subscription.id,
        userId: member.userId,
        checkedInAt: now,
        checkedOutAt: null,
        status: 'open',
      })
      .returning();
    if (!row) throw new BadRequestException('Could not check in');

    const fullName = (await this.profileName(member.userId)) || member.fullName || null;
    const publicSession = this.toPublic(row, {
      email: subscription.email,
      fullName,
    });

    await this.fanout.toCoaches(
      'gym.checked_in',
      {
        type: 'gym.checked_in',
        sessionId: publicSession.sessionId,
        subscriptionId: publicSession.subscriptionId,
        userId: publicSession.userId,
        email: publicSession.email,
        fullName: publicSession.fullName ?? '',
        checkedInAt: publicSession.checkedInAt,
        route: `/clients/${publicSession.subscriptionId}`,
      },
      {
        title: 'Member checked in',
        body: `${fullName || publicSession.email} is at the gym`,
      },
    );

    return { status: 'open' as const, session: publicSession };
  }

  async checkOut(member: { userId: string; email: string; fullName?: string | null }) {
    const [open] = await this.db
      .select()
      .from(gymSessions)
      .where(and(eq(gymSessions.userId, member.userId), eq(gymSessions.status, 'open')))
      .limit(1);
    if (!open) throw new BadRequestException('Not checked in');

    const now = new Date();
    const [row] = await this.db
      .update(gymSessions)
      .set({ status: 'closed', checkedOutAt: now })
      .where(eq(gymSessions.id, open.id))
      .returning();
    if (!row) throw new BadRequestException('Could not check out');

    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, row.subscriptionId))
      .limit(1);
    const fullName = (await this.profileName(member.userId)) || member.fullName || null;
    const publicSession = this.toPublic(row, {
      email: sub?.email || member.email,
      fullName,
    });

    await this.fanout.toCoaches(
      'gym.checked_out',
      {
        type: 'gym.checked_out',
        sessionId: publicSession.sessionId,
        subscriptionId: publicSession.subscriptionId,
        userId: publicSession.userId,
        email: publicSession.email,
        fullName: publicSession.fullName ?? '',
        checkedInAt: publicSession.checkedInAt,
        checkedOutAt: publicSession.checkedOutAt ?? '',
        route: `/clients/${publicSession.subscriptionId}`,
      },
      {
        title: 'Member checked out',
        body: `${fullName || publicSession.email} left the gym`,
      },
    );

    return { status: 'closed' as const, session: publicSession };
  }

  async listPreferredPlaces(member: { userId: string; email: string }) {
    const subscription = await this.activeSubscription(member);
    if (!subscription || !arrivalPlans.has(subscription.planId)) {
      return { eligible: false as const, places: [] as PreferredGymPlace[] };
    }
    const rows = await this.db
      .select()
      .from(preferredGyms)
      .where(eq(preferredGyms.userId, member.userId))
      .orderBy(desc(preferredGyms.updatedAt));
    return { eligible: true as const, places: rows.map((row) => this.toPlace(row)) };
  }

  async searchGyms(
    member: { userId: string; email: string },
    input: { q?: string; lat?: number; lng?: number },
  ) {
    await this.requireArrivalPlan(member);
    const key = this.mapsKey();
    const q = (input.q ?? '').trim();
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    url.searchParams.set('query', q || 'gym');
    url.searchParams.set('type', 'gym');
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      url.searchParams.set('location', `${lat},${lng}`);
      url.searchParams.set('radius', '8000');
    }
    url.searchParams.set('key', key);
    const data = await this.mapsJson(url);
    const results = Array.isArray(data.results) ? data.results : [];
    const places: GymPlaceHit[] = [];
    for (const raw of results.slice(0, 8)) {
      const hit = this.toHit(raw);
      if (hit) places.push(hit);
    }
    return { places };
  }

  async addPreferredPlace(member: { userId: string; email: string }, placeId: string) {
    await this.requireArrivalPlan(member);
    const id = placeId.trim();
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) {
      throw new BadRequestException('Pick a gym on the map');
    }
    const current = await this.db
      .select()
      .from(preferredGyms)
      .where(eq(preferredGyms.userId, member.userId));
    if (current.length >= 8 && !current.some((row) => row.placeId === id)) {
      throw new BadRequestException('You can save up to 8 gyms');
    }
    const hit = await this.placeDetails(id);
    const now = new Date();
    const enabled = current.length === 0 ? true : current.some((row) => row.enabled);
    const [row] = await this.db
      .insert(preferredGyms)
      .values({
        userId: member.userId,
        placeId: hit.placeId,
        name: hit.name,
        address: hit.address,
        lat: hit.lat,
        lng: hit.lng,
        photoRef: hit.photoRef,
        enabled,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [preferredGyms.userId, preferredGyms.placeId],
        set: {
          name: hit.name,
          address: hit.address,
          lat: hit.lat,
          lng: hit.lng,
          photoRef: hit.photoRef,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new BadRequestException('Could not save this gym');
    return { eligible: true as const, place: this.toPlace(row) };
  }

  async removePreferredPlace(member: { userId: string; email: string }, id: string) {
    await this.requireArrivalPlan(member);
    await this.db
      .delete(preferredGyms)
      .where(and(eq(preferredGyms.userId, member.userId), eq(preferredGyms.id, id)));
    return this.listPreferredPlaces(member);
  }

  async setPreferredPlacesEnabled(
    member: { userId: string; email: string },
    enabled: boolean,
  ) {
    await this.requireArrivalPlan(member);
    await this.db
      .update(preferredGyms)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(preferredGyms.userId, member.userId));
    return this.listPreferredPlaces(member);
  }

  async listSavedGymsForAdmin(input?: { subscriptionId?: string; review?: string }) {
    let userId = '';
    if (input?.subscriptionId) {
      const [sub] = await this.db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, input.subscriptionId))
        .limit(1);
      if (!sub?.userId) return { places: [] as AdminSavedGym[] };
      userId = sub.userId;
    }
    const rows = await this.db
      .select()
      .from(preferredGyms)
      .where(
        userId
          ? eq(preferredGyms.userId, userId)
          : input?.review
            ? eq(preferredGyms.review, input.review)
            : undefined,
      )
      .orderBy(desc(preferredGyms.updatedAt))
      .limit(100);
    const places: AdminSavedGym[] = [];
    for (const row of rows) {
      if (!userId && input?.review && row.review !== input.review) continue;
      places.push(await this.toAdminPlace(row));
    }
    return { places };
  }

  async reviewSavedGym(id: string, review: string) {
    if (review !== 'gym' && review !== 'not_gym') {
      throw new BadRequestException('Mark the place as a gym or not a gym');
    }
    const [row] = await this.db
      .update(preferredGyms)
      .set({ review, updatedAt: new Date() })
      .where(eq(preferredGyms.id, id))
      .returning();
    if (!row) throw new NotFoundException('Saved gym not found');
    return { place: await this.toAdminPlace(row) };
  }

  async adminPlacePhoto(id: string) {
    const [row] = await this.db
      .select()
      .from(preferredGyms)
      .where(eq(preferredGyms.id, id))
      .limit(1);
    if (!row?.photoRef) throw new NotFoundException('Photo not available');
    return this.fetchPlacePhoto(row.photoRef);
  }

  async placePhoto(member: { userId: string; email: string }, ref: string) {
    await this.requireArrivalPlan(member);
    const photoRef = ref.trim();
    if (!/^[A-Za-z0-9_-]{10,800}$/.test(photoRef)) {
      throw new BadRequestException('Photo not available');
    }
    const owned = await this.db
      .select({ id: preferredGyms.id })
      .from(preferredGyms)
      .where(and(eq(preferredGyms.userId, member.userId), eq(preferredGyms.photoRef, photoRef)))
      .limit(1);
    if (!owned.length) throw new NotFoundException('Photo not available');
    return this.fetchPlacePhoto(photoRef);
  }

  private async fetchPlacePhoto(photoRef: string) {
    const key = this.mapsKey();
    const url = new URL('https://maps.googleapis.com/maps/api/place/photo');
    url.searchParams.set('maxwidth', '800');
    url.searchParams.set('photo_reference', photoRef);
    url.searchParams.set('key', key);
    const res = await fetch(url);
    if (!res.ok) throw new BadRequestException('Photo not available');
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, contentType: res.headers.get('content-type') || 'image/jpeg' };
  }

  async listActive() {
    const rows = await this.db
      .select()
      .from(gymSessions)
      .where(eq(gymSessions.status, 'open'))
      .orderBy(desc(gymSessions.checkedInAt))
      .limit(200);

    const result: PublicGymSession[] = [];
    for (const row of rows) {
      const meta = await this.sessionMeta(row.subscriptionId, row.userId);
      result.push(this.toPublic(row, meta));
    }
    return { sessions: result };
  }

  async listForClient(subscriptionId: string) {
    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (!sub) throw new NotFoundException('Client not found');

    const rows = await this.db
      .select()
      .from(gymSessions)
      .where(eq(gymSessions.subscriptionId, subscriptionId))
      .orderBy(desc(gymSessions.checkedInAt))
      .limit(50);

    const fullName = sub.userId ? await this.profileName(sub.userId) : null;
    return {
      sessions: rows.map((row) =>
        this.toPublic(row, { email: sub.email, fullName }),
      ),
    };
  }

  private async activeSubscription(member: { userId: string; email: string }) {
    try {
      return await this.requireActiveSubscription(member);
    } catch {
      return null;
    }
  }

  private async requireArrivalPlan(member: { userId: string; email: string }) {
    const subscription = await this.requireActiveSubscription(member);
    if (!arrivalPlans.has(subscription.planId)) {
      throw new ForbiddenException(
        'Gym arrival is for Foundation, Performance, and Elite',
      );
    }
    return subscription;
  }

  private mapsKey() {
    const key = process.env.GOOGLE_MAPS_API_KEY?.trim() || '';
    if (!key) throw new BadRequestException('Maps is not configured');
    return key;
  }

  private async mapsJson(url: URL) {
    const res = await fetch(url);
    const data = (await res.json()) as { results?: unknown[]; result?: unknown; status?: string };
    if (!res.ok || (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) {
      throw new BadRequestException('Could not load gyms from Google');
    }
    return data;
  }

  private async placeDetails(placeId: string): Promise<GymPlaceHit> {
    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'place_id,name,formatted_address,geometry,photos');
    url.searchParams.set('key', this.mapsKey());
    const data = await this.mapsJson(url);
    const hit = this.toHit(data.result);
    if (!hit) throw new BadRequestException('That place has no map location');
    return hit;
  }

  private toHit(raw: unknown): GymPlaceHit | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as {
      place_id?: string;
      name?: string;
      formatted_address?: string;
      vicinity?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
      photos?: Array<{ photo_reference?: string }>;
    };
    const placeId = (row.place_id ?? '').trim();
    const name = (row.name ?? '').trim();
    const lat = Number(row.geometry?.location?.lat);
    const lng = Number(row.geometry?.location?.lng);
    if (!placeId || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const photoRef = row.photos?.[0]?.photo_reference?.trim() || null;
    return {
      placeId,
      name: name.slice(0, 120),
      address: (row.formatted_address || row.vicinity || '').slice(0, 180),
      lat,
      lng,
      photoRef: photoRef && /^[A-Za-z0-9_-]{10,800}$/.test(photoRef) ? photoRef : null,
    };
  }

  private toPlace(row: typeof preferredGyms.$inferSelect): PreferredGymPlace {
    return {
      id: row.id,
      placeId: row.placeId,
      name: row.name,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      photoRef: row.photoRef,
      review: row.review === 'gym' || row.review === 'not_gym' ? row.review : 'pending',
      enabled: row.enabled,
    };
  }

  private async toAdminPlace(row: typeof preferredGyms.$inferSelect): Promise<AdminSavedGym> {
    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, row.userId))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);
    const fullName = await this.profileName(row.userId);
    return {
      ...this.toPlace(row),
      userId: row.userId,
      subscriptionId: sub?.id ?? null,
      email: sub?.email ?? '',
      fullName,
    };
  }

  private async requireActiveSubscription(member: { userId: string; email: string }) {
    const email = member.email.trim().toLowerCase();
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, member.userId))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(10);

    let candidates = rows;
    if (candidates.length === 0 && email) {
      candidates = await this.db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.email, email))
        .orderBy(desc(subscriptions.updatedAt))
        .limit(10);
    }

    const now = Date.now();
    const live = candidates.find((row) => {
      if (row.status !== 'active') return false;
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return false;
      return true;
    });
    if (!live) throw new BadRequestException('Active subscription required');
    return live;
  }

  private async profileName(userId: string) {
    const [row] = await this.db
      .select({ fullName: profiles.fullName })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    return row?.fullName?.trim() || null;
  }

  private async sessionMeta(subscriptionId: string, userId: string) {
    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    const fullName = await this.profileName(userId);
    return { email: sub?.email || '', fullName };
  }

  private toPublic(
    row: typeof gymSessions.$inferSelect,
    meta: { email: string; fullName: string | null },
  ): PublicGymSession {
    return {
      sessionId: row.id,
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      email: meta.email,
      fullName: meta.fullName,
      checkedInAt: row.checkedInAt.toISOString(),
      checkedOutAt: row.checkedOutAt ? row.checkedOutAt.toISOString() : null,
      status: row.status === 'open' ? 'open' : 'closed',
    };
  }
}
