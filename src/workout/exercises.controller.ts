import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InternalGuard } from '../auth/internal.guard.js';
import { ExercisesService } from './exercises.service.js';

@Controller('exercises')
export class ExercisesController {
  constructor(private readonly exercises: ExercisesService) {}

  @Get()
  @UseGuards(InternalGuard)
  list(@Query('q') q?: string) {
    return this.exercises.list(q);
  }
}
