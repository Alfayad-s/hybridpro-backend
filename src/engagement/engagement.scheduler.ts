import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EngagementService } from './engagement.service.js';

const QUARTER_MS = 15 * 60 * 1000;

@Injectable()
export class EngagementScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngagementScheduler.name);
  private startup: NodeJS.Timeout | null = null;
  private quarter: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly engagement: EngagementService) {}

  onModuleInit() {
    if (process.env.ENGAGEMENT_SCHEDULER === 'off') {
      this.logger.log('Engagement scheduler is off');
      return;
    }
    this.startup = setTimeout(() => void this.tick('startup'), 30_000);
    const wait = msUntilNextQuarter(Date.now());
    this.quarter = setTimeout(() => {
      void this.tick('quarter');
      this.interval = setInterval(() => void this.tick('quarter'), QUARTER_MS);
    }, wait);
    this.logger.log(`Engagement scheduler armed, next quarter in ${Math.round(wait / 1000)}s`);
  }

  onModuleDestroy() {
    if (this.startup) clearTimeout(this.startup);
    if (this.quarter) clearTimeout(this.quarter);
    if (this.interval) clearInterval(this.interval);
  }

  private async tick(source: string) {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.engagement.runTick();
      if (result.sent > 0) {
        this.logger.log(`Engagement ${source}: sent ${result.sent} of ${result.checked}`);
      }
    } catch (error) {
      this.logger.error(
        'Engagement tick failed',
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.running = false;
    }
  }
}

function msUntilNextQuarter(now: number): number {
  const remainder = now % QUARTER_MS;
  return remainder === 0 ? QUARTER_MS : QUARTER_MS - remainder;
}
