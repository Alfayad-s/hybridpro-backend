import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminController } from './admin/admin.controller.js';
import { AuthService } from './auth/auth.service.js';
import { CoachGuard } from './auth/coach.guard.js';
import { InternalGuard } from './auth/internal.guard.js';
import { CheckinsController } from './checkins/checkins.controller.js';
import { CoachingService } from './coaching/coaching.service.js';
import { ContactController } from './contact/contact.controller.js';
import { ContactService } from './contact/contact.service.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health.controller.js';
import { CloudinaryService } from './media/cloudinary.service.js';
import { PaymentsController } from './payments/payments.controller.js';
import { SubscriptionsController } from './subscriptions/subscriptions.controller.js';
import { SubscriptionService } from './subscriptions/subscription.service.js';
import { ExercisesController } from './workout/exercises.controller.js';
import { ExercisesService } from './workout/exercises.service.js';
import { WorkoutService } from './workout/workout.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret:
          process.env.COACH_SESSION_SECRET ||
          process.env.INTERNAL_API_SECRET ||
          'hybrid-pro-dev',
        signOptions: { expiresIn: '7d' },
      }),
    }),
    DbModule,
  ],
  controllers: [
    HealthController,
    PaymentsController,
    SubscriptionsController,
    CheckinsController,
    ContactController,
    AdminController,
    ExercisesController,
  ],
  providers: [
    SubscriptionService,
    CoachingService,
    ExercisesService,
    WorkoutService,
    ContactService,
    AuthService,
    CloudinaryService,
    InternalGuard,
    CoachGuard,
  ],
})
export class AppModule {}
