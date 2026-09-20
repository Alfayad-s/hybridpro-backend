import { readFileSync } from 'node:fs';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { DeviceTokensService } from './device-tokens.service.js';

type FcmPayload = {
  title: string;
  body: string;
  data: Record<string, string>;
};

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private messaging: Messaging | null = null;
  private ready = false;

  constructor(private readonly devices: DeviceTokensService) {}

  async onModuleInit() {
    try {
      if (getApps().length === 0) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, string>;
          initializeApp({ credential: cert(parsed) });
          this.logger.log('FCM initialized from FIREBASE_SERVICE_ACCOUNT_JSON');
        } else {
          const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
          if (credPath) {
            const fileJson = readFileSync(credPath, 'utf8').trim();
            if (!fileJson) {
              this.logger.warn(
                `FCM not configured — ${credPath} is empty. Paste the Firebase service account JSON into that file.`,
              );
              return;
            }
            initializeApp({ credential: cert(JSON.parse(fileJson) as Record<string, string>) });
            this.logger.log(`FCM initialized from ${credPath}`);
          } else {
            this.logger.warn(
              'FCM not configured — push notifications disabled until credentials are set',
            );
            return;
          }
        }
      }

      this.messaging = getMessaging();
      this.ready = true;
    } catch (error) {
      this.logger.error('Failed to initialize FCM', error instanceof Error ? error.stack : error);
      this.ready = false;
      this.messaging = null;
    }
  }

  get isReady() {
    return this.ready && !!this.messaging;
  }

  async sendToMember(userId: string, payload: FcmPayload) {
    const tokens = await this.devices.tokensForMember(userId);
    await this.sendToTokens(tokens, payload);
  }

  async sendToCoaches(payload: FcmPayload) {
    const tokens = await this.devices.tokensForCoaches();
    await this.sendToTokens(tokens, payload);
  }

  private async sendToTokens(tokens: string[], payload: FcmPayload) {
    if (!tokens.length) return;
    if (!this.messaging) {
      this.logger.debug(`FCM skip (${tokens.length} tokens): not configured`);
      return;
    }

    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload.data)) {
      data[key] = String(value ?? '');
    }

    try {
      const result = await this.messaging.sendEachForMulticast({
        tokens,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data,
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'hybrid_pro_admin_chat',
            defaultSound: true,
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
      });

      const stale: string[] = [];
      result.responses.forEach((response, index) => {
        if (response.success) return;
        const code = response.error?.code || '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token') ||
          code.includes('invalid-argument')
        ) {
          stale.push(tokens[index]!);
        } else {
          this.logger.warn(`FCM send failed: ${code} ${response.error?.message || ''}`);
        }
      });
      if (stale.length) await this.devices.removeTokens(stale);
    } catch (error) {
      this.logger.error('FCM multicast failed', error instanceof Error ? error.stack : error);
    }
  }
}
