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
import { ContactService } from '../contact/contact.service.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly subscriptions: SubscriptionService,
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

  @Get('clients')
  @UseGuards(CoachGuard)
  clients(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('planId') planId?: string,
  ) {
    return this.subscriptions.listSubscriptions({ q, status, planId }).then((clients) => ({ clients }));
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
    return detail;
  }

  @Patch('clients/:id')
  @UseGuards(CoachGuard)
  async update(@Param('id') id: string, @Body() body: { action?: string; days?: number }) {
    if (body.action === 'extend') {
      return { subscription: await this.subscriptions.extendSubscription(id, body.days || 30) };
    }
    if (body.action === 'cancel') {
      return { subscription: await this.subscriptions.cancelSubscription(id) };
    }
    throw new BadRequestException('Unknown action');
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
    if (submission.status === 'new') {
      return { submission: (await this.contacts.markRead(id)) ?? submission };
    }
    return { submission };
  }
}
