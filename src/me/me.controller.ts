import { Body, Controller, Get, HttpCode, Post, Put, Query, UseGuards, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { CurrentMember } from '../auth/member.decorator.js';
import { MemberGuard } from '../auth/member.guard.js';
import type { MemberUser } from '../auth/member.types.js';
import { DB } from '../db/db.module.js';
import { profiles } from '../db/schema.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';
import { ExercisesService } from '../workout/exercises.service.js';
import { WorkoutService } from '../workout/workout.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

@Controller('me')
@UseGuards(MemberGuard)
export class MeController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly workouts: WorkoutService,
    private readonly exercises: ExercisesService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async me(@CurrentMember() member: MemberUser) {
    let profile: {
      fullName: string | null;
      avatarUrl: string | null;
      experienceLevel: string | null;
    } | null = null;
    try {
      const [row] = await this.db
        .select({
          fullName: profiles.fullName,
          avatarUrl: profiles.avatarUrl,
          experienceLevel: profiles.experienceLevel,
        })
        .from(profiles)
        .where(eq(profiles.id, member.userId))
        .limit(1);
      profile = row ?? null;
    } catch {
      profile = null;
    }

    return {
      userId: member.userId,
      email: member.email,
      fullName: profile?.fullName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      experienceLevel: profile?.experienceLevel ?? null,
    };
  }

  @Get('subscription')
  subscription(@CurrentMember() member: MemberUser) {
    return this.subscriptions.getPlanForIdentity({
      email: member.email,
      userId: member.userId,
    });
  }

  @Post('attach')
  @HttpCode(200)
  async attach(@CurrentMember() member: MemberUser) {
    if (!member.email) {
      return { ok: false, error: 'email_required' };
    }
    const subscription = await this.subscriptions.attachSubscriptionToUser({
      userId: member.userId,
      email: member.email,
    });
    return { ok: true, subscription };
  }

  @Get('exercises')
  exercisesList(@Query('q') q?: string) {
    return this.exercises.list(q);
  }

  @Get('sync')
  syncGet(@CurrentMember() member: MemberUser) {
    return this.workouts.getUserSync(member.userId);
  }

  @Put('sync')
  syncPut(@CurrentMember() member: MemberUser, @Body() body: unknown) {
    return this.workouts.putUserSync(member.userId, body);
  }
}
