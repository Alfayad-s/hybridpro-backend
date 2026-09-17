import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { InternalGuard } from '../auth/internal.guard.js';
import { CoachingService } from '../coaching/coaching.service.js';

@Controller('checkins')
export class CheckinsController {
  constructor(private readonly coaching: CoachingService) {}

  @Get()
  @UseGuards(InternalGuard)
  list(@Query('email') email?: string, @Query('userId') userId?: string) {
    if (!email && !userId) {
      throw new BadRequestException('email or userId is required');
    }
    return this.coaching.listForIdentity({ email, userId });
  }

  @Post()
  @UseGuards(InternalGuard)
  create(
    @Body()
    body: {
      email?: string;
      userId?: string;
      checkinDate?: string;
      weight?: string;
      adherence?: string;
      clientUpdate?: string;
    },
  ) {
    if (!body.email && !body.userId) {
      throw new BadRequestException('email or userId is required');
    }
    return this.coaching.submitCustomerCheckin(body).then((checkin) => ({ checkin }));
  }
}
