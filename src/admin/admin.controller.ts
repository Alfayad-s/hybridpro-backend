import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { CoachGuard } from '../auth/coach.guard.js';
import { CoachingService } from '../coaching/coaching.service.js';
import { ContactService } from '../contact/contact.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly subscriptions: SubscriptionService,
    private readonly coaching: CoachingService,
    private readonly contacts: ContactService,
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
    return { ...detail, ...desk };
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
