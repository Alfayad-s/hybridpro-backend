import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
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
import { CloudinaryService } from '../media/cloudinary.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';
import { ExercisesService } from '../workout/exercises.service.js';
import { WorkoutService } from '../workout/workout.service.js';

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
  ) {}

  @Post('auth/login')
  login(@Body() body: { email?: string; password?: string }) {
    return this.auth.login(body.email || '', body.password || '');
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
    try {
      const assigned = await this.workouts.listAssigned(id);
      assignedPlans = assigned.plans;
    } catch (error) {
      console.error('[assigned_plans]', error);
    }
    return { ...detail, ...desk, assignedPlans };
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
        notes?: string;
      }[];
    },
  ) {
    return this.workouts.assignPlan(id, body);
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
}
