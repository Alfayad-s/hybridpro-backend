import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query, UseGuards, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { CurrentMember } from '../auth/member.decorator.js';
import { MemberGuard } from '../auth/member.guard.js';
import type { MemberUser } from '../auth/member.types.js';
import { DB } from '../db/db.module.js';
import { profiles } from '../db/schema.js';
import { GymAttendanceService } from '../gym/gym-attendance.service.js';
import { ChatService } from '../chat/chat.service.js';
import { DeviceTokensService } from '../notifications/device-tokens.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';
import { ExercisesService } from '../workout/exercises.service.js';
import { WorkoutService } from '../workout/workout.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

type AssessmentBody = {
  status?: string;
  result?: unknown;
  input?: unknown;
  experienceLevel?: string | null;
};

@Controller('me')
@UseGuards(MemberGuard)
export class MeController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly workouts: WorkoutService,
    private readonly exercises: ExercisesService,
    private readonly devices: DeviceTokensService,
    private readonly gym: GymAttendanceService,
    private readonly chat: ChatService,
    @Inject(DB) private readonly db: Db,
  ) {}

  private parseAssessmentPayload(raw: string | null | undefined) {
    if (!raw) return { result: null as unknown, input: null as unknown };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'headline' in (parsed as object)) {
        return { result: parsed, input: null };
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as { result?: unknown; input?: unknown };
        return { result: obj.result ?? null, input: obj.input ?? null };
      }
      return { result: parsed, input: null };
    } catch {
      return { result: null, input: null };
    }
  }

  private async upsertProfile(
    member: MemberUser,
    extra?: {
      experienceLevel?: string | null;
      assessmentStatus?: string | null;
      assessmentJson?: string | null;
    },
  ) {
    const [existing] = await this.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, member.userId))
      .limit(1);

    const fullName = member.fullName?.trim() || existing?.fullName || null;
    const avatarUrl = member.avatarUrl?.trim() || existing?.avatarUrl || null;
    const experienceLevel =
      extra && 'experienceLevel' in extra
        ? extra.experienceLevel ?? null
        : existing?.experienceLevel ?? null;
    const assessmentStatus =
      extra && 'assessmentStatus' in extra
        ? extra.assessmentStatus ?? null
        : existing?.assessmentStatus ?? null;
    const assessmentJson =
      extra && 'assessmentJson' in extra
        ? extra.assessmentJson ?? null
        : existing?.assessmentJson ?? null;
    const payload = {
      id: member.userId,
      fullName,
      avatarUrl,
      experienceLevel,
      assessmentStatus,
      assessmentJson,
      updatedAt: new Date(),
    };

    if (existing) {
      const [row] = await this.db
        .update(profiles)
        .set({
          fullName,
          avatarUrl,
          experienceLevel,
          assessmentStatus,
          assessmentJson,
          updatedAt: payload.updatedAt,
        })
        .where(eq(profiles.id, member.userId))
        .returning();
      return row ?? existing;
    }

    const [row] = await this.db.insert(profiles).values(payload).returning();
    return row;
  }

  @Get()
  async me(@CurrentMember() member: MemberUser) {
    let profile: {
      fullName: string | null;
      avatarUrl: string | null;
      experienceLevel: string | null;
      assessmentStatus: string | null;
    } | null = null;
    try {
      const row = await this.upsertProfile(member);
      profile = row
        ? {
            fullName: row.fullName,
            avatarUrl: row.avatarUrl,
            experienceLevel: row.experienceLevel,
            assessmentStatus: row.assessmentStatus,
          }
        : null;
    } catch {
      profile = null;
    }

    return {
      userId: member.userId,
      email: member.email,
      fullName: profile?.fullName ?? member.fullName ?? null,
      avatarUrl: profile?.avatarUrl ?? member.avatarUrl ?? null,
      experienceLevel: profile?.experienceLevel ?? null,
      assessmentStatus: profile?.assessmentStatus ?? null,
    };
  }

  @Get('subscription')
  subscription(@CurrentMember() member: MemberUser) {
    return this.subscriptions.getPlanForIdentity({
      email: member.email,
      userId: member.userId,
    });
  }

  @Get('assessment')
  async getAssessment(@CurrentMember() member: MemberUser) {
    try {
      const [row] = await this.db
        .select({
          assessmentStatus: profiles.assessmentStatus,
          assessmentJson: profiles.assessmentJson,
        })
        .from(profiles)
        .where(eq(profiles.id, member.userId))
        .limit(1);
      const status = row?.assessmentStatus === 'done' || row?.assessmentStatus === 'skipped'
        ? row.assessmentStatus
        : 'pending';
      const parsed = this.parseAssessmentPayload(row?.assessmentJson);
      return {
        status,
        result: parsed.result,
        input: parsed.input,
      };
    } catch {
      return { status: 'pending', result: null, input: null };
    }
  }

  @Put('assessment')
  async putAssessment(@CurrentMember() member: MemberUser, @Body() body: AssessmentBody) {
    const status =
      body.status === 'done' || body.status === 'skipped' || body.status === 'pending'
        ? body.status
        : 'pending';
    const experienceFromInput =
      body.input &&
      typeof body.input === 'object' &&
      body.input !== null &&
      'experience' in body.input &&
      typeof (body.input as { experience?: unknown }).experience === 'string'
        ? (body.input as { experience: string }).experience
        : undefined;
    const experience = body.experienceLevel ?? experienceFromInput;
    const payload = {
      result: body.result ?? null,
      input: body.input ?? null,
    };
    const row = await this.upsertProfile(member, {
      ...(experience ? { experienceLevel: experience } : {}),
      assessmentStatus: status,
      assessmentJson: JSON.stringify(payload),
    });
    const parsed = this.parseAssessmentPayload(row?.assessmentJson);
    return {
      status: row?.assessmentStatus || status,
      result: parsed.result ?? body.result ?? null,
      input: parsed.input ?? body.input ?? null,
    };
  }

  @Post('attach')
  @HttpCode(200)
  async attach(@CurrentMember() member: MemberUser) {
    try {
      await this.upsertProfile(member);
    } catch {
      /* profile table may not exist yet on a fresh DB */
    }
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

  @Post('devices')
  @HttpCode(200)
  registerDevice(
    @CurrentMember() member: MemberUser,
    @Body() body: { token?: string; platform?: string },
  ) {
    return this.devices.registerMember(member.userId, body);
  }

  @Delete('devices')
  unregisterDevice(
    @CurrentMember() member: MemberUser,
    @Body() body: { token?: string },
  ) {
    return this.devices.unregisterMember(member.userId, body?.token);
  }

  @Get('gym/status')
  gymStatus(@CurrentMember() member: MemberUser) {
    return this.gym.statusForMember(member.userId);
  }

  @Post('gym/check-in')
  @HttpCode(200)
  gymCheckIn(@CurrentMember() member: MemberUser) {
    return this.gym.checkIn(member);
  }

  @Post('gym/check-out')
  @HttpCode(200)
  gymCheckOut(@CurrentMember() member: MemberUser) {
    return this.gym.checkOut(member);
  }

  @Get('chat')
  chatThread(
    @CurrentMember() member: MemberUser,
    @Query('limit') limit?: string,
  ) {
    return this.chat.getMemberThread(member, limit ? Number(limit) : undefined);
  }

  @Get('chat/messages')
  chatMessages(
    @CurrentMember() member: MemberUser,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.listMemberMessages(member, {
      before,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('chat/messages')
  @HttpCode(200)
  sendChatMessage(
    @CurrentMember() member: MemberUser,
    @Body() body: { body?: string },
  ) {
    return this.chat.sendMemberMessage(member, body?.body);
  }

  @Post('chat/read')
  @HttpCode(200)
  markChatRead(@CurrentMember() member: MemberUser) {
    return this.chat.markMemberRead(member);
  }
}
