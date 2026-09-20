import { Injectable, Logger } from '@nestjs/common';
import { FcmService } from '../notifications/fcm.service.js';
import { EventsGateway } from './events.gateway.js';

export type FanoutPayload = Record<string, unknown> & {
  type: string;
};

@Injectable()
export class RealtimeFanoutService {
  private readonly logger = new Logger(RealtimeFanoutService.name);

  constructor(
    private readonly gateway: EventsGateway,
    private readonly fcm: FcmService,
  ) {}

  async toMember(
    userId: string,
    event: string,
    payload: FanoutPayload,
    notification?: { title: string; body: string },
  ) {
    try {
      this.gateway.emitToMember(userId, event, payload);
    } catch (error) {
      this.logger.warn(`WS member emit failed: ${error instanceof Error ? error.message : error}`);
    }

    if (notification) {
      await this.fcm.sendToMember(userId, {
        title: notification.title,
        body: notification.body,
        data: this.stringifyData(payload),
      });
    }
  }

  async toCoaches(
    event: string,
    payload: FanoutPayload,
    notification?: { title: string; body: string },
  ) {
    try {
      this.gateway.emitToCoaches(event, payload);
    } catch (error) {
      this.logger.warn(`WS coach emit failed: ${error instanceof Error ? error.message : error}`);
    }

    if (notification) {
      await this.fcm.sendToCoaches({
        title: notification.title,
        body: notification.body,
        data: this.stringifyData(payload),
      });
    }
  }

  private stringifyData(payload: FanoutPayload): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value == null) continue;
      data[key] = typeof value === 'string' ? value : String(value);
    }
    return data;
  }
}
