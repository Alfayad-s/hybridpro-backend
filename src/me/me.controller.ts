import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { memoryStorage } from 'multer';
import { createHash } from 'crypto';
import { AccountDeletionService } from '../auth/account-deletion.service.js';
import { CurrentMember } from '../auth/member.decorator.js';
import { MemberGuard } from '../auth/member.guard.js';
import type { MemberUser } from '../auth/member.types.js';
import { AppStoreBillingService } from '../payments/app-store-billing.service.js';
import { PlayBillingService } from '../payments/play-billing.service.js';
import { getPricingPlan } from '../plans.js';
import { DB } from '../db/db.module.js';
import { profiles } from '../db/schema.js';
import { GymAttendanceService } from '../gym/gym-attendance.service.js';
import { ChatService } from '../chat/chat.service.js';
import { HyroxChatService } from '../chat/hyrox-chat.service.js';
import { CloudinaryService } from '../media/cloudinary.service.js';
import { DeviceTokensService } from '../notifications/device-tokens.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';
import { StoreService } from '../store/store.service.js';
import { ExercisesService } from '../workout/exercises.service.js';
import { WorkoutService } from '../workout/workout.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { ChallengesService } from '../rewards/challenges.service.js';
import { WalletService } from '../rewards/wallet.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

type AssessmentBody = {
  status?: string;
  result?: unknown;
  input?: unknown;
  experienceLevel?: string | null;
};

type UpdateMeBody = {
  fullName?: string;
};

const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CHAT_VIDEO_MAX_BYTES = 40 * 1024 * 1024;
const CHAT_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
const PROGRESS_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const CHAT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const PROGRESS_POSES = new Set(['front', 'side', 'back']);

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
    private readonly hyroxChat: HyroxChatService,
    private readonly cloudinary: CloudinaryService,
    private readonly store: StoreService,
    private readonly wallet: WalletService,
    private readonly challenges: ChallengesService,
    private readonly engagement: EngagementService,
    private readonly sessions: SessionsService,
    private readonly playBilling: PlayBillingService,
    private readonly appStoreBilling: AppStoreBillingService,
    private readonly accountDeletion: AccountDeletionService,
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
      fullName?: string | null;
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

    const fullName =
      extra && 'fullName' in extra
        ? extra.fullName?.trim() || null
        : member.fullName?.trim() || existing?.fullName || null;
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

  @Patch()
  async updateMe(@CurrentMember() member: MemberUser, @Body() body: UpdateMeBody) {
    const fullName = body.fullName?.trim() ?? '';
    if (fullName.length < 2) {
      throw new BadRequestException('fullName must be at least 2 characters');
    }
    const row = await this.upsertProfile(member, { fullName });
    return {
      userId: member.userId,
      email: member.email,
      fullName: row?.fullName ?? fullName,
      avatarUrl: row?.avatarUrl ?? member.avatarUrl ?? null,
      experienceLevel: row?.experienceLevel ?? null,
      assessmentStatus: row?.assessmentStatus ?? null,
    };
  }

  @Get('subscription')
  subscription(@CurrentMember() member: MemberUser) {
    return this.subscriptions.getPlanForIdentity({
      email: member.email,
      userId: member.userId,
    });
  }

  /** Unlock after Pine Labs return — uses checkout intent + member identity. */
  @Post('subscription/confirm')
  @HttpCode(200)
  async confirmSubscription(
    @CurrentMember() member: MemberUser,
    @Body()
    body: {
      pineOrderId?: string;
      orderId?: string;
      merchantOrderReference?: string;
      planId?: string;
    },
  ) {
    if (!member.email) {
      throw new BadRequestException('email_required');
    }
    const result = await this.subscriptions.confirmPaymentReturn({
      pineOrderId: body.pineOrderId || body.orderId,
      merchantOrderReference: body.merchantOrderReference,
      planId: body.planId,
      email: member.email,
      userId: member.userId,
    });
    const plan = await this.subscriptions.getPlanForIdentity({
      email: member.email,
      userId: member.userId,
    });
    return { ...result, ...plan };
  }

  /** Unlock a coaching plan bought with Google Play Billing. */
  @Post('subscription/play')
  @HttpCode(200)
  async confirmPlayPurchase(
    @CurrentMember() member: MemberUser,
    @Body() body: { productId?: string; purchaseToken?: string },
  ) {
    if (!member.email) throw new BadRequestException('email_required');
    const productId = body.productId?.trim() || '';
    const purchaseToken = body.purchaseToken?.trim() || '';
    if (!productId || !purchaseToken) {
      throw new BadRequestException('productId and purchaseToken are required');
    }
    let verified;
    try {
      verified = await this.playBilling.verifySubscription(purchaseToken, productId);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Could not verify this purchase',
      );
    }
    const plan = getPricingPlan(verified.planId);
    if (!plan) throw new BadRequestException('Unknown plan');
    const tokenHash = createHash('sha256').update(purchaseToken).digest('hex');
    try {
      await this.subscriptions.activateSubscription({
        pineOrderId: `gplay:${tokenHash}`,
        merchantOrderReference: `gplay-${tokenHash.slice(0, 24)}`,
        email: member.email,
        planId: plan.id,
        amountPaise: plan.amountPaise,
        userId: member.userId,
        accessExpiresAt: verified.expiresAt,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Could not unlock this plan',
      );
    }
    if (verified.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      try {
        await this.playBilling.acknowledge(purchaseToken, verified.productId);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Could not acknowledge this purchase',
        );
      }
    }
    return this.subscriptions.getPlanForIdentity({
      email: member.email,
      userId: member.userId,
    });
  }

  /** Unlock a coaching plan bought with an App Store subscription. */
  @Post('subscription/apple')
  @HttpCode(200)
  async confirmApplePurchase(
    @CurrentMember() member: MemberUser,
    @Body() body: { signedTransaction?: string },
  ) {
    if (!member.email) throw new BadRequestException('email_required');
    const signedTransaction = body.signedTransaction?.trim() || '';
    if (!signedTransaction) {
      throw new BadRequestException('signedTransaction is required');
    }
    let verified;
    try {
      verified = this.appStoreBilling.verifySubscription(signedTransaction);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Could not verify this purchase',
      );
    }
    const plan = getPricingPlan(verified.planId);
    if (!plan) throw new BadRequestException('Unknown plan');
    try {
      await this.subscriptions.activateSubscription({
        pineOrderId: `apple:${verified.transactionId}`,
        merchantOrderReference: `apple-${verified.transactionId}`.slice(0, 64),
        email: member.email,
        planId: plan.id,
        amountPaise: plan.amountPaise,
        userId: member.userId,
        accessExpiresAt: verified.expiresAt,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Could not unlock this plan',
      );
    }
    return this.subscriptions.getPlanForIdentity({
      email: member.email,
      userId: member.userId,
    });
  }

  @Delete()
  @HttpCode(200)
  async deleteAccount(@CurrentMember() member: MemberUser) {
    if (!member.email) throw new BadRequestException('email_required');
    try {
      return await this.accountDeletion.deleteMember({
        userId: member.userId,
        email: member.email,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Could not delete this account',
      );
    }
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
  exercisesList(@Query('q') q?: string, @Query('library') library?: string) {
    return this.exercises.list(q, library);
  }

  @Get('sync')
  syncGet(@CurrentMember() member: MemberUser) {
    return this.workouts.getUserSync(member.userId);
  }

  @Put('sync')
  async syncPut(@CurrentMember() member: MemberUser, @Body() body: unknown) {
    const merged = await this.workouts.putUserSync(member.userId, body);
    try {
      await this.challenges.syncProgress(member.userId);
    } catch {
      /* non-fatal */
    }
    return merged;
  }

  @Post('devices')
  @HttpCode(200)
  registerDevice(
    @CurrentMember() member: MemberUser,
    @Body() body: { token?: string; platform?: string; deviceId?: string },
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

  @Get('store/categories')
  storeCategories() {
    return this.store.listCategories({ activeOnly: true });
  }

  @Get('store/kinds')
  storeKinds() {
    return this.store.listKinds({ activeOnly: true });
  }

  @Get('store/products')
  storeProducts(
    @Query('q') q?: string,
    @Query('category') category?: string,
  ) {
    return this.store.listMember(q, category);
  }

  @Get('hyrox/chat')
  hyroxThread(
    @CurrentMember() member: MemberUser,
    @Query('limit') limit?: string,
  ) {
    return this.hyroxChat.getMemberThread(member, limit ? Number(limit) : undefined);
  }

  @Post('hyrox/chat/messages')
  @HttpCode(200)
  sendHyroxMessage(
    @CurrentMember() member: MemberUser,
    @Body() body: { body?: string; imageUrl?: string },
  ) {
    return this.hyroxChat.sendMemberMessage(member, {
      body: body?.body,
      imageUrl: body?.imageUrl,
    });
  }

  @Post('hyrox/chat/read')
  @HttpCode(200)
  markHyroxRead(@CurrentMember() member: MemberUser) {
    return this.hyroxChat.markMemberRead(member);
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
    @Body() body: { body?: string; imageUrl?: string },
  ) {
    return this.chat.sendMemberMessage(member, {
      body: body?.body,
      imageUrl: body?.imageUrl,
    });
  }

  @Post('chat/media')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: CHAT_VIDEO_MAX_BYTES },
    }),
  )
  async uploadChatMedia(
    @CurrentMember() member: MemberUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('A photo or video is required');
    }
    const video = CHAT_VIDEO_TYPES.has(file.mimetype);
    const image = CHAT_IMAGE_TYPES.has(file.mimetype);
    if (!video && !image) {
      throw new BadRequestException('Use a JPG, PNG, WEBP, GIF, or MP4');
    }
    const max = video ? CHAT_VIDEO_MAX_BYTES : CHAT_IMAGE_MAX_BYTES;
    if (file.size > max) {
      throw new BadRequestException(
        video ? 'Video must be under 40MB' : 'Image must be under 5MB',
      );
    }
    const uploaded = await this.cloudinary.uploadChatImage({
      memberUserId: member.userId,
      buffer: file.buffer,
      video,
    });
    return { url: uploaded.url, publicId: uploaded.publicId };
  }

  @Post('chat/read')
  @HttpCode(200)
  markChatRead(@CurrentMember() member: MemberUser) {
    return this.chat.markMemberRead(member);
  }

  @Get('progress/photos')
  async listProgressPhotos(@CurrentMember() member: MemberUser) {
    const photos = await this.workouts.listOwnProgressPhotos(member.userId);
    return {
      photos: photos.map((photo) => ({
        ...photo,
        url: this.cloudinary.signProgressPhoto(photo.publicId),
      })),
    };
  }

  @Post('progress/photos')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: PROGRESS_IMAGE_MAX_BYTES },
    }),
  )
  async uploadProgressPhoto(
    @CurrentMember() member: MemberUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { pose?: string; day?: string; takenAt?: string; note?: string },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Image file is required');
    }
    if (!CHAT_IMAGE_TYPES.has(file.mimetype) || file.mimetype === 'image/gif') {
      throw new BadRequestException('Use a JPG, PNG, or WEBP image');
    }
    if (file.size > PROGRESS_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Image must be under 8MB');
    }
    const pose = (body?.pose ?? '').trim();
    if (!PROGRESS_POSES.has(pose)) {
      throw new BadRequestException('pose must be front, side, or back');
    }
    const day = (body?.day ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new BadRequestException('day must be YYYY-MM-DD');
    }
    const uploaded = await this.cloudinary.uploadProgressPhoto({
      memberUserId: member.userId,
      buffer: file.buffer,
      pose,
      day,
    });
    const { saved, replacedPublicId } = await this.workouts.saveProgressPhoto(member.userId, {
      pose,
      day,
      takenAt: body?.takenAt || new Date().toISOString(),
      publicId: uploaded.publicId,
      note: body?.note,
    });
    if (replacedPublicId) {
      await this.cloudinary.destroyProgressPhoto(replacedPublicId);
    }
    return {
      photo: { ...saved, url: this.cloudinary.signProgressPhoto(saved.publicId) },
    };
  }

  @Get('water')
  getWater(
    @CurrentMember() member: MemberUser,
    @Query('date') date?: string,
  ) {
    return this.workouts.getWater(member.userId, date);
  }

  @Post('water')
  @HttpCode(200)
  async logWater(
    @CurrentMember() member: MemberUser,
    @Body() body: { amountMl?: number; date?: string; id?: string },
  ) {
    const result = await this.workouts.logWater(member.userId, body ?? {});
    try {
      await this.challenges.syncProgress(member.userId);
    } catch {
      /* non-fatal */
    }
    return result;
  }

  @Get('rewards')
  async getRewards(@CurrentMember() member: MemberUser) {
    const rewards = await this.wallet.ensure(member.userId);
    return { rewards };
  }

  @Get('rewards/history')
  async rewardsHistory(
    @CurrentMember() member: MemberUser,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number(limit) : 30;
    const [challengeHistory, ledger] = await Promise.all([
      this.challenges.listHistory(member.userId, n),
      this.wallet.listLedger(member.userId, n),
    ]);
    return { challengeHistory, ledger };
  }

  @Get('challenges')
  getChallenges(
    @CurrentMember() member: MemberUser,
    @Query('date') date?: string,
  ) {
    return this.challenges.ensureToday(member.userId, date);
  }

  @Post('challenges/:id/complete')
  @HttpCode(200)
  completeChallenge(
    @CurrentMember() member: MemberUser,
    @Param('id') id: string,
    @Body() body: { currentValue?: number },
  ) {
    return this.challenges.complete(member.userId, id, body?.currentValue);
  }

  @Post('challenges/:id/skip')
  @HttpCode(200)
  skipChallenge(
    @CurrentMember() member: MemberUser,
    @Param('id') id: string,
  ) {
    return this.challenges.skip(member.userId, id).then((challenge) => ({
      challenge,
    }));
  }

  @Post('challenges/refresh')
  @HttpCode(200)
  refreshChallenges(
    @CurrentMember() member: MemberUser,
    @Body() body: { date?: string },
  ) {
    return this.challenges.refreshDaily(member.userId, body?.date);
  }

  @Get('sessions/slots')
  sessionSlots() {
    return this.sessions.openSlots();
  }

  @Get('sessions')
  mySessions(@CurrentMember() member: MemberUser) {
    return this.sessions.memberSessions(member);
  }

  @Post('sessions')
  @HttpCode(200)
  bookSession(@CurrentMember() member: MemberUser, @Body() body: { startsAt?: string }) {
    return this.sessions.bookAsMember({ ...member, startsAt: body?.startsAt });
  }

  @Post('sessions/:id/cancel')
  @HttpCode(200)
  cancelSession(@CurrentMember() member: MemberUser, @Param('id') id: string) {
    return this.sessions.cancelAsMember(id, member);
  }

  @Get('engagement/today')
  engagementToday(@CurrentMember() member: MemberUser, @Query('timezone') timezone?: string) {
    return this.engagement.today(member.userId, timezone);
  }

  @Put('engagement/routine')
  updateEngagementRoutine(@CurrentMember() member: MemberUser, @Body() body: Record<string, unknown>) {
    return this.engagement.updateRoutine(member.userId, body ?? {});
  }

  @Put('engagement/preferences')
  updateEngagementPreferences(
    @CurrentMember() member: MemberUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.engagement.updatePreferences(member.userId, body ?? {});
  }

  @Post('engagement/meals/skip')
  @HttpCode(200)
  skipEngagementMeal(
    @CurrentMember() member: MemberUser,
    @Body() body: { meal?: string },
  ) {
    return this.engagement.skipMeal(member.userId, body?.meal);
  }

  @Post('store/redeem')
  @HttpCode(200)
  redeemStore(
    @CurrentMember() member: MemberUser,
    @Body() body: { productId?: string; size?: string },
  ) {
    return this.store.redeemWithCoins(member.userId, body ?? {});
  }
}
