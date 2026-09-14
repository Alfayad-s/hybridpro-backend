import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { InternalGuard } from '../auth/internal.guard.js';
import { pricingPlans } from '../plans.js';
import { SubscriptionService } from './subscription.service.js';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Get('plans')
  plans() {
    return { plans: pricingPlans };
  }

  @Get('status')
  @UseGuards(InternalGuard)
  status(@Query('email') email?: string, @Query('userId') userId?: string) {
    return this.subscriptions
      .getSubscriptionForIdentity({ email, userId })
      .then((subscription) => ({ subscription }));
  }

  @Post('activate')
  @UseGuards(InternalGuard)
  activate(
    @Body()
    body: {
      pineOrderId?: string;
      merchantOrderReference?: string;
      email?: string;
      mobile?: string;
      planId?: string;
      amountPaise?: number;
      userId?: string;
    },
  ) {
    return this.subscriptions.activateSubscription({
      pineOrderId: body.pineOrderId || '',
      merchantOrderReference: body.merchantOrderReference || '',
      email: body.email || '',
      mobile: body.mobile,
      planId: body.planId || '',
      amountPaise: Number(body.amountPaise),
      userId: body.userId,
    });
  }

  @Post('attach')
  @UseGuards(InternalGuard)
  attach(@Body() body: { userId?: string; email?: string }) {
    if (!body.userId || !body.email) {
      throw new BadRequestException('userId and email are required');
    }
    return this.subscriptions
      .attachSubscriptionToUser({ userId: body.userId, email: body.email })
      .then((subscription) => ({ ok: true, subscription }));
  }
}
