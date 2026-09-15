import { All, Body, Controller, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { InternalGuard } from '../auth/internal.guard.js';
import { SubscriptionService } from '../subscriptions/subscription.service.js';

function readValue(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'number') return String(raw);
  }
  return '';
}

function collectPaymentParams(...sources: Array<Record<string, unknown> | undefined>) {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    Object.assign(merged, source);
  }
  return {
    pineOrderId: readValue(merged, [
      'order_id',
      'orderId',
      'pineOrderId',
      'plural_order_id',
      'txn_id',
      'transaction_id',
    ]),
    email: readValue(merged, ['email', 'email_id']),
    planId: readValue(merged, ['plan', 'planId', 'plan_id']),
    userId: readValue(merged, ['userId', 'user_id']),
    merchantOrderReference: readValue(merged, [
      'ref',
      'merchant_order_reference',
      'merchantOrderReference',
    ]),
    mobile: readValue(merged, ['mobile', 'mobile_number']),
    status: readValue(merged, ['status', 'payment_status']),
  };
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  private appUrl() {
    return (process.env.APP_URL || 'https://app.hybridpro.in').replace(/\/$/, '');
  }

  private websiteUrl() {
    return (process.env.WEBSITE_URL || 'https://hybridpro.in').replace(/\/$/, '');
  }

  private welcomeUrl(email?: string | null) {
    const url = new URL('/dashboard', `${this.appUrl()}/`);
    url.searchParams.set('welcome', '1');
    if (email) url.searchParams.set('email', email);
    return url.toString();
  }

  @Post('confirm')
  @UseGuards(InternalGuard)
  confirm(
    @Body()
    body: {
      pineOrderId?: string;
      orderId?: string;
      merchantOrderReference?: string;
      email?: string;
      mobile?: string;
      planId?: string;
      userId?: string;
      status?: string;
    },
  ) {
    return this.subscriptions.confirmPaymentReturn({
      pineOrderId: body.pineOrderId || body.orderId,
      merchantOrderReference: body.merchantOrderReference,
      email: body.email,
      mobile: body.mobile,
      planId: body.planId,
      userId: body.userId,
      status: body.status,
    });
  }

  @All('callback')
  async callback(
    @Query() query: Record<string, string>,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const params = collectPaymentParams(body, query);
    const failedUrl = `${this.websiteUrl()}/payment/failure`;

    try {
      const result = await this.subscriptions.confirmPaymentReturn(params);
      if (!result.ok) {
        return res.redirect(303, failedUrl);
      }
      return res.redirect(303, this.welcomeUrl(result.email));
    } catch (error) {
      const url = new URL('/payment/success', `${this.websiteUrl()}/`);
      if (params.pineOrderId) url.searchParams.set('order_id', params.pineOrderId);
      if (params.email) url.searchParams.set('email', params.email);
      if (params.planId) url.searchParams.set('plan', params.planId);
      if (params.userId) url.searchParams.set('userId', params.userId);
      if (params.merchantOrderReference) url.searchParams.set('ref', params.merchantOrderReference);
      url.searchParams.set(
        'activate_error',
        error instanceof Error ? error.message : 'Could not unlock app access',
      );
      return res.redirect(303, url.toString());
    }
  }
}
