import { Injectable } from '@nestjs/common';
import { createSign } from 'crypto';
import { isPricingPlanId, type PricingPlanId } from '../plans.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const ACTIVE_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED',
]);

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

export type PlayPurchase = {
  productId: string;
  planId: PricingPlanId;
  expiresAt: Date;
  acknowledgementState: string;
};

/** Play subscription product ids are the plan ids, with an optional `_monthly` suffix. */
export function planIdForPlayProduct(productId: string): PricingPlanId | null {
  const id = productId.trim().toLowerCase().replace(/_monthly$/, '');
  return isPricingPlanId(id) ? id : null;
}

@Injectable()
export class PlayBillingService {
  private cachedToken: { value: string; expiresAt: number } | null = null;

  packageName() {
    return (process.env.GOOGLE_PLAY_PACKAGE_NAME || 'in.hybridpro.hybrid_pro_app').trim();
  }

  async verifySubscription(purchaseToken: string, expectedProductId: string): Promise<PlayPurchase> {
    const token = purchaseToken.trim();
    const expected = expectedProductId.trim();
    const planId = planIdForPlayProduct(expected);
    if (!token || !planId) throw new Error('Invalid Play purchase');

    const accessToken = await this.accessToken();
    const url = `${PUBLISHER}/applications/${encodeURIComponent(this.packageName())}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      subscriptionState?: string;
      acknowledgementState?: string;
      lineItems?: Array<{ productId?: string; expiryTime?: string }>;
    };
    if (!res.ok) {
      throw new Error(body.error?.message || 'Google Play could not verify this purchase');
    }

    const line = (body.lineItems || []).find((item) => planIdForPlayProduct(item.productId || '') === planId);
    if (!line) throw new Error('Purchase does not match this plan');

    const state = body.subscriptionState || '';
    const expiresAt = line.expiryTime ? new Date(line.expiryTime) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new Error('This Google Play subscription is not active');
    }
    if (!ACTIVE_STATES.has(state)) {
      throw new Error('This Google Play subscription is not active');
    }

    return {
      productId: line.productId || expected,
      planId,
      expiresAt,
      acknowledgementState: body.acknowledgementState || '',
    };
  }

  async acknowledge(purchaseToken: string, productId: string) {
    const accessToken = await this.accessToken();
    const url =
      `${PUBLISHER}/applications/${encodeURIComponent(this.packageName())}` +
      `/purchases/subscriptions/${encodeURIComponent(productId)}` +
      `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (res.ok) return;
    const message = body.error?.message || '';
    if (/already acknowledged/i.test(message)) return;
    throw new Error(message || 'Could not acknowledge the Google Play purchase');
  }

  private credentials(): ServiceAccount {
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
    if (!raw) {
      throw new Error('Google Play billing is not configured on the server');
    }
    let parsed: ServiceAccount;
    try {
      parsed = JSON.parse(raw) as ServiceAccount;
    } catch {
      throw new Error('Google Play billing is not configured on the server');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('Google Play billing is not configured on the server');
    }
    return parsed;
  }

  private async accessToken() {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.value;
    }
    const account = this.credentials();
    const assertion = this.signJwt(account);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new Error(body.error_description || 'Could not authorize Google Play billing');
    }
    this.cachedToken = {
      value: body.access_token,
      expiresAt: now + (body.expires_in || 3600) * 1000,
    };
    return body.access_token;
  }

  private signJwt(account: ServiceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(
      JSON.stringify({
        iss: account.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    signer.end();
    const signature = signer.sign(account.private_key).toString('base64url');
    return `${header}.${claim}.${signature}`;
  }
}
