import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
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
import { memoryStorage } from 'multer';
import { AuthService } from '../auth/auth.service.js';
import { CoachGuard } from '../auth/coach.guard.js';
import { CoachingService } from '../coaching/coaching.service.js';
import { ContactService } from '../contact/contact.service.js';
import { GymAttendanceService } from '../gym/gym-attendance.service.js';
import { ChatService } from '../chat/chat.service.js';
import { CloudinaryService } from '../media/cloudinary.service.js';
import { DeviceTokensService } from '../notifications/device-tokens.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';
import { StoreService } from '../store/store.service.js';
import { ExercisesService } from '../workout/exercises.service.js';
import {
  MealLibraryService,
  type MealLibraryInput,
} from '../workout/meal-library.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { WorkoutService } from '../workout/workout.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

@Controller('admin')
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly subscriptions: SubscriptionService,
    private readonly coaching: CoachingService,
    private readonly contacts: ContactService,
    private readonly workouts: WorkoutService,
    private readonly exerciseCatalog: ExercisesService,
    private readonly cloudinary: CloudinaryService,
    private readonly devices: DeviceTokensService,
    private readonly gym: GymAttendanceService,
    private readonly chat: ChatService,
    private readonly store: StoreService,
    private readonly mealLibrary: MealLibraryService,
    private readonly engagement: EngagementService,
    private readonly sessions: SessionsService,
  ) {}

  @Post('auth/login')
  login(@Body() body: { email?: string; password?: string }) {
    return this.auth.login(body.email || '', body.password || '');
  }

  @Post('devices')
  @UseGuards(CoachGuard)
  registerDevice(
    @Headers('x-coach-email') coachEmail: string,
    @Body() body: { token?: string; platform?: string; deviceId?: string },
  ) {
    return this.devices.registerCoach(coachEmail || '', body);
  }

  @Delete('devices')
  @UseGuards(CoachGuard)
  unregisterDevice(
    @Headers('x-coach-email') coachEmail: string,
    @Body() body: { token?: string },
  ) {
    return this.devices.unregisterCoach(coachEmail || '', body?.token);
  }

  @Get('gym/active')
  @UseGuards(CoachGuard)
  gymActive() {
    return this.gym.listActive();
  }

  @Get('clients/:id/gym')
  @UseGuards(CoachGuard)
  clientGym(@Param('id') id: string) {
    return this.gym.listForClient(id);
  }

  @Get('chat/inbox')
  @UseGuards(CoachGuard)
  chatInbox() {
    return this.chat.inbox();
  }

  @Get('clients/:id/chat')
  @UseGuards(CoachGuard)
  clientChat(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.chat.getClientThread(id, limit ? Number(limit) : undefined);
  }

  @Get('clients/:id/chat/messages')
  @UseGuards(CoachGuard)
  clientChatMessages(
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.listClientMessages(id, {
      before,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('clients/:id/chat/messages')
  @UseGuards(CoachGuard)
  sendClientChat(
    @Param('id') id: string,
    @Headers('x-coach-email') coachEmail: string,
    @Body() body: { body?: string; imageUrl?: string },
  ) {
    return this.chat.sendCoachMessage(id, coachEmail || '', body);
  }

  @Post('clients/:id/chat/read')
  @UseGuards(CoachGuard)
  markClientChatRead(@Param('id') id: string) {
    return this.chat.markCoachRead(id);
  }

  @Get('stats')
  @UseGuards(CoachGuard)
  stats() {
    return this.subscriptions.getSubscriptionStats();
  }

  @Get('payments')
  @UseGuards(CoachGuard)
  payments(
    @Query('q') q?: string,
    @Query('planId') planId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.subscriptions.listPayments({ q, planId, status, from, to });
  }

  @Get('clients')
  @UseGuards(CoachGuard)
  clients(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('planId') planId?: string,
    @Query('expiringSoon') expiringSoon?: string,
  ) {
    return this.subscriptions
      .listSubscriptions({
        q,
        status,
        planId,
        expiringSoon: expiringSoon === '1' || expiringSoon === 'true',
      })
      .then((clients) => ({ clients }));
  }

  @Post('clients')
  @UseGuards(CoachGuard)
  grant(@Body() body: { email?: string; mobile?: string; planId?: string }) {
    return this.subscriptions.grantSubscription({
      email: body.email || '',
      mobile: body.mobile,
      planId: body.planId || '',
    });
  }

  @Get('clients/:id')
  @UseGuards(CoachGuard)
  async detail(@Param('id') id: string) {
    const detail = await this.subscriptions.getClientDetail(id);
    if (!detail) throw new NotFoundException('Client not found');
    const desk = await this.coaching.getDesk(id);
    let assignedPlans: Awaited<ReturnType<WorkoutService['listAssigned']>>['plans'] = [];
    let assignedMealPlans: Awaited<
      ReturnType<WorkoutService['listAssignedMealPlans']>
    >['mealPlans'] = [];
    let assignedWaterChallenges: Awaited<
      ReturnType<WorkoutService['listAssignedWaterChallenges']>
    >['waterChallenges'] = [];
    try {
      const assigned = await this.workouts.listAssigned(id);
      assignedPlans = assigned.plans;
    } catch (error) {
      console.error('[assigned_plans]', error);
    }
    try {
      const meals = await this.workouts.listAssignedMealPlans(id);
      assignedMealPlans = meals.mealPlans;
    } catch (error) {
      console.error('[assigned_meals]', error);
    }
    try {
      const water = await this.workouts.listAssignedWaterChallenges(id);
      assignedWaterChallenges = water.waterChallenges;
    } catch (error) {
      console.error('[assigned_water]', error);
    }
    let progressPhotos: Array<Record<string, unknown>> = [];
    try {
      const photos = await this.workouts.listClientProgressPhotos(id);
      progressPhotos = photos.map((photo) => ({
        ...photo,
        url: this.cloudinary.signProgressPhoto(photo.publicId),
      }));
    } catch (error) {
      console.error('[progress_photos]', error);
    }
    return {
      ...detail,
      ...desk,
      assignedPlans,
      assignedMealPlans,
      assignedWaterChallenges,
      progressPhotos,
    };
  }

  @Patch('clients/:id')
  @UseGuards(CoachGuard)
  async update(
    @Param('id') id: string,
    @Body() body: { action?: string; days?: number; planId?: string; notes?: string },
  ) {
    if (body.action === 'extend') {
      return { subscription: await this.subscriptions.extendSubscription(id, body.days || 30) };
    }
    if (body.action === 'cancel') {
      return { subscription: await this.subscriptions.cancelSubscription(id) };
    }
    if (body.action === 'change_plan') {
      return { subscription: await this.subscriptions.changePlan(id, body.planId || '') };
    }
    if (body.action === 'save_notes') {
      return this.coaching.saveNotes(id, body.notes || '');
    }
    throw new BadRequestException('Unknown action');
  }

  @Post('clients/:id/checkins')
  @UseGuards(CoachGuard)
  addCheckin(
    @Param('id') id: string,
    @Body()
    body: {
      checkinDate?: string;
      weight?: string;
      adherence?: string;
      clientUpdate?: string;
      coachReply?: string;
    },
  ) {
    return this.coaching.addCheckin(id, body).then((checkin) => ({ checkin }));
  }

  @Patch('clients/:id/checkins/:checkinId')
  @UseGuards(CoachGuard)
  replyCheckin(
    @Param('id') id: string,
    @Param('checkinId') checkinId: string,
    @Body() body: { coachReply?: string },
  ) {
    return this.coaching
      .replyToCheckin(id, checkinId, body.coachReply || '')
      .then((checkin) => ({ checkin }));
  }

  @Get('products/categories')
  @UseGuards(CoachGuard)
  productCategories() {
    return this.store.listCategories();
  }

  @Post('products/categories')
  @UseGuards(CoachGuard)
  createProductCategory(
    @Body() body: { slug?: string; label?: string; sortOrder?: number; active?: boolean },
  ) {
    return this.store.createCategory(body);
  }

  @Patch('products/categories/:id')
  @UseGuards(CoachGuard)
  updateProductCategory(
    @Param('id') id: string,
    @Body() body: { slug?: string; label?: string; sortOrder?: number; active?: boolean },
  ) {
    return this.store.updateCategory(id, body);
  }

  @Delete('products/categories/:id')
  @UseGuards(CoachGuard)
  deleteProductCategory(@Param('id') id: string) {
    return this.store.removeCategory(id);
  }

  @Get('products/kinds')
  @UseGuards(CoachGuard)
  productKinds() {
    return this.store.listKinds();
  }

  @Post('products/kinds')
  @UseGuards(CoachGuard)
  createProductKind(
    @Body() body: { slug?: string; label?: string; sortOrder?: number; active?: boolean },
  ) {
    return this.store.createKind(body);
  }

  @Patch('products/kinds/:id')
  @UseGuards(CoachGuard)
  updateProductKind(
    @Param('id') id: string,
    @Body() body: { slug?: string; label?: string; sortOrder?: number; active?: boolean },
  ) {
    return this.store.updateKind(id, body);
  }

  @Delete('products/kinds/:id')
  @UseGuards(CoachGuard)
  deleteProductKind(@Param('id') id: string) {
    return this.store.removeKind(id);
  }

  @Get('products')
  @UseGuards(CoachGuard)
  products(@Query('q') q?: string, @Query('category') category?: string) {
    return this.store.listAdmin(q, category);
  }

  @Post('products')
  @UseGuards(CoachGuard)
  createProduct(
    @Body()
    body: {
      title?: string;
      slug?: string;
      subtitle?: string;
      description?: string | null;
      category?: string;
      kind?: string;
      priceLabel?: string;
      pricePaise?: number | null;
      coinPrice?: number | null;
      imageUrl?: string | null;
      sizes?: string[] | string;
      planId?: string | null;
      active?: boolean;
      sortOrder?: number;
    },
  ) {
    return this.store.create(body);
  }

  @Patch('products/:id')
  @UseGuards(CoachGuard)
  updateProduct(
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      slug?: string;
      subtitle?: string;
      description?: string | null;
      category?: string;
      kind?: string;
      priceLabel?: string;
      pricePaise?: number | null;
      coinPrice?: number | null;
      imageUrl?: string | null;
      sizes?: string[] | string;
      planId?: string | null;
      active?: boolean;
      sortOrder?: number;
    },
  ) {
    return this.store.update(id, body);
  }

  @Delete('products/:id')
  @UseGuards(CoachGuard)
  deleteProduct(@Param('id') id: string) {
    return this.store.remove(id);
  }

  @Get('redemptions')
  @UseGuards(CoachGuard)
  listRedemptions(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.store.listRedemptions({
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Patch('redemptions/:id')
  @UseGuards(CoachGuard)
  updateRedemption(
    @Param('id') id: string,
    @Body() body: { status?: string; notes?: string | null },
  ) {
    return this.store.updateRedemptionStatus(id, body ?? {});
  }

  @Post('products/media')
  @UseGuards(CoachGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: IMAGE_MAX_BYTES },
    }),
  )
  async uploadProductMedia(
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Image file is required');
    }
    if (!IMAGE_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Use a JPG, PNG, WEBP, or GIF image');
    }
    if (file.size > IMAGE_MAX_BYTES) {
      throw new BadRequestException('Image must be under 5MB');
    }
    const uploaded = await this.cloudinary.uploadStoreImage({
      buffer: file.buffer,
    });
    return { url: uploaded.url, publicId: uploaded.publicId };
  }

  @Get('exercises')
  @UseGuards(CoachGuard)
  exercises(@Query('q') q?: string) {
    return this.exerciseCatalog.list(q);
  }

  @Post('exercises')
  @UseGuards(CoachGuard)
  createExercise(
    @Body()
    body: {
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
    },
  ) {
    return this.exerciseCatalog.create(body);
  }

  @Patch('exercises/:id')
  @UseGuards(CoachGuard)
  updateExercise(
    @Param('id') id: string,
    @Body()
    body: {
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
    },
  ) {
    return this.exerciseCatalog.update(id, body);
  }

  @Delete('exercises/:id')
  @UseGuards(CoachGuard)
  deleteExercise(@Param('id') id: string) {
    return this.exerciseCatalog.remove(id);
  }

  @Post('exercises/media')
  @UseGuards(CoachGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: VIDEO_MAX_BYTES },
    }),
  )
  async uploadExerciseMedia(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('kind') kindRaw?: string,
    @Body('exerciseKey') exerciseKeyRaw?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Media file is required');
    }

    const kind = kindRaw === 'video' ? 'video' : 'image';
    const exerciseKey = String(exerciseKeyRaw ?? `draft-${Date.now().toString(36)}`)
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64);

    if (kind === 'image') {
      if (!IMAGE_TYPES.has(file.mimetype)) {
        throw new BadRequestException('Use a JPG, PNG, WEBP, or GIF image');
      }
      if (file.size > IMAGE_MAX_BYTES) {
        throw new BadRequestException('Image must be under 5MB');
      }
    } else {
      if (!VIDEO_TYPES.has(file.mimetype)) {
        throw new BadRequestException('Use an MP4, WEBM, or MOV video');
      }
      if (file.size > VIDEO_MAX_BYTES) {
        throw new BadRequestException('Video must be under 50MB');
      }
    }

    const uploaded = await this.cloudinary.uploadExerciseMedia({
      coachKey: 'admin',
      exerciseKey: exerciseKey || `draft-${Date.now().toString(36)}`,
      buffer: file.buffer,
      kind,
    });

    return {
      url: uploaded.url,
      kind: uploaded.kind,
      publicId: uploaded.publicId,
    };
  }

  @Get('meals')
  @UseGuards(CoachGuard)
  meals(@Query('q') q?: string, @Query('type') type?: string) {
    return this.mealLibrary.list(q, type);
  }

  @Post('meals')
  @UseGuards(CoachGuard)
  createMeal(@Body() body: MealLibraryInput) {
    return this.mealLibrary.create(body ?? {});
  }

  @Patch('meals/:id')
  @UseGuards(CoachGuard)
  updateMeal(@Param('id') id: string, @Body() body: MealLibraryInput) {
    return this.mealLibrary.update(id, body ?? {});
  }

  @Delete('meals/:id')
  @UseGuards(CoachGuard)
  deleteMeal(@Param('id') id: string) {
    return this.mealLibrary.remove(id);
  }

  @Get('clients/:id/workout-plans')
  @UseGuards(CoachGuard)
  assignedPlans(@Param('id') id: string) {
    return this.workouts.listAssigned(id);
  }

  @Post('clients/:id/workout-plans')
  @UseGuards(CoachGuard)
  assignPlan(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      muscleFocus?: string;
      weekdays?: number[];
      exercises?: {
        exerciseId?: string;
        targetSets?: number;
        targetReps?: number;
        restSeconds?: number;
        targetRpe?: number;
        targetRir?: number;
        notes?: string;
      }[];
      days?: {
        dayOfWeek: number;
        name?: string;
        muscleFocus?: string;
        isRestDay?: boolean;
        exercises?: {
          exerciseId?: string;
          targetSets?: number;
          targetReps?: number;
          restSeconds?: number;
          targetRpe?: number;
          targetRir?: number;
          notes?: string;
        }[];
      }[];
    },
  ) {
    return this.workouts.assignPlan(id, body);
  }

  @Patch('clients/:id/workout-plans/:planId')
  @UseGuards(CoachGuard)
  updatePlan(
    @Param('id') id: string,
    @Param('planId') planId: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      days?: {
        dayOfWeek: number;
        name?: string;
        muscleFocus?: string;
        isRestDay?: boolean;
        exercises?: {
          exerciseId?: string;
          targetSets?: number;
          targetReps?: number;
          restSeconds?: number;
          targetRpe?: number;
          targetRir?: number;
          notes?: string;
        }[];
      }[];
    },
  ) {
    return this.workouts.updatePlan(id, planId, body);
  }

  @Delete('clients/:id/workout-plans/:planId')
  @UseGuards(CoachGuard)
  unassignPlan(@Param('id') id: string, @Param('planId') planId: string) {
    return this.workouts.unassignPlan(id, planId);
  }

  @Get('clients/:id/meal-plans')
  @UseGuards(CoachGuard)
  assignedMealPlans(@Param('id') id: string) {
    return this.workouts.listAssignedMealPlans(id);
  }

  @Post('clients/:id/meal-plans')
  @UseGuards(CoachGuard)
  assignMealPlan(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      days?: {
        dayOfWeek: number;
        meals?: {
          type?: string;
          name?: string;
          calories?: number;
          proteinG?: number;
          carbsG?: number;
          fatG?: number;
          notes?: string;
          imageUrl?: string;
        }[];
      }[];
    },
  ) {
    return this.workouts.assignMealPlan(id, body);
  }

  @Patch('clients/:id/meal-plans/:planId')
  @UseGuards(CoachGuard)
  updateMealPlan(
    @Param('id') id: string,
    @Param('planId') planId: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      days?: {
        dayOfWeek: number;
        meals?: {
          type?: string;
          name?: string;
          calories?: number;
          proteinG?: number;
          carbsG?: number;
          fatG?: number;
          notes?: string;
          imageUrl?: string;
        }[];
      }[];
    },
  ) {
    return this.workouts.updateMealPlan(id, planId, body);
  }

  @Delete('clients/:id/meal-plans/:planId')
  @UseGuards(CoachGuard)
  unassignMealPlan(@Param('id') id: string, @Param('planId') planId: string) {
    return this.workouts.unassignMealPlan(id, planId);
  }

  @Get('clients/:id/water-challenges')
  @UseGuards(CoachGuard)
  assignedWaterChallenges(@Param('id') id: string) {
    return this.workouts.listAssignedWaterChallenges(id);
  }

  @Post('clients/:id/water-challenges')
  @UseGuards(CoachGuard)
  assignWaterChallenge(
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      description?: string;
      targetMlPerDay?: number;
      durationDays?: number;
      startDate?: string;
    },
  ) {
    return this.workouts.assignWaterChallenge(id, body);
  }

  @Patch('clients/:id/water-challenges/:challengeId')
  @UseGuards(CoachGuard)
  updateWaterChallenge(
    @Param('id') id: string,
    @Param('challengeId') challengeId: string,
    @Body()
    body: {
      title?: string;
      description?: string;
      targetMlPerDay?: number;
      durationDays?: number;
      startDate?: string;
    },
  ) {
    return this.workouts.updateWaterChallenge(id, challengeId, body);
  }

  @Delete('clients/:id/water-challenges/:challengeId')
  @UseGuards(CoachGuard)
  unassignWaterChallenge(
    @Param('id') id: string,
    @Param('challengeId') challengeId: string,
  ) {
    return this.workouts.unassignWaterChallenge(id, challengeId);
  }

  @Get('contacts')
  @UseGuards(CoachGuard)
  contactList(@Query('q') q?: string, @Query('status') status?: string) {
    return this.contacts.list({ q, status }).then((submissions) => ({ submissions }));
  }

  @Get('contacts/:id')
  @UseGuards(CoachGuard)
  async contactDetail(@Param('id') id: string) {
    const submission = await this.contacts.getById(id);
    if (!submission) throw new NotFoundException('Submission not found');
    const current =
      submission.status === 'new'
        ? ((await this.contacts.markRead(id)) ?? submission)
        : submission;
    const client = await this.subscriptions.getSubscriptionForIdentity({ email: current.email });
    return {
      submission: current,
      clientId: client?.id ?? null,
      clientStatus: client?.status ?? null,
      clientPlan: client?.planName ?? null,
    };
  }

  @Post('contacts/:id/grant')
  @UseGuards(CoachGuard)
  async grantContact(@Param('id') id: string, @Body() body: { planId?: string }) {
    const submission = await this.contacts.getById(id);
    if (!submission) throw new NotFoundException('Submission not found');
    const result = await this.subscriptions.grantSubscription({
      email: submission.email,
      mobile: submission.phone || undefined,
      planId: body.planId || 'performance',
    });
    const converted = await this.contacts.markConverted(id);
    return {
      submission: converted ?? submission,
      subscription: result.subscription,
    };
  }

  @Get('availability')
  @UseGuards(CoachGuard)
  availability() {
    return this.sessions.getAvailability();
  }

  @Put('availability')
  @UseGuards(CoachGuard)
  saveAvailability(@Body() body: { windows?: unknown; timeOff?: unknown }) {
    return this.sessions.replaceAvailability(body ?? {});
  }

  @Get('sessions/slots')
  @UseGuards(CoachGuard)
  sessionSlots() {
    return this.sessions.openSlots();
  }

  @Get('sessions')
  @UseGuards(CoachGuard)
  listSessions(@Query('upcoming') upcoming?: string) {
    return this.sessions.listBookings({
      upcomingOnly: upcoming === '1' || upcoming === 'true',
    });
  }

  @Get('clients/:id/sessions')
  @UseGuards(CoachGuard)
  clientSessions(@Param('id') id: string) {
    return this.sessions.listBookings({ subscriptionId: id });
  }

  @Post('clients/:id/sessions')
  @UseGuards(CoachGuard)
  bookClient(@Param('id') id: string, @Body() body: { startsAt?: string }) {
    return this.sessions.bookAsCoach(id, body?.startsAt);
  }

  @Post('sessions/:id/cancel')
  @UseGuards(CoachGuard)
  cancelSession(@Param('id') id: string) {
    return this.sessions.cancelAsCoach(id);
  }

  @Get('engagement')
  @UseGuards(CoachGuard)
  engagementSettings() {
    return this.engagement.adminView();
  }

  @Put('engagement')
  @UseGuards(CoachGuard)
  updateEngagementSettings(@Body() body: Record<string, unknown>) {
    return this.engagement.updateAdminSettings(body ?? {});
  }

  @Put('engagement/templates/:type')
  @UseGuards(CoachGuard)
  updateEngagementTemplate(
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.engagement.updateTemplate(type, body ?? {});
  }
}
