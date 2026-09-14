import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './http-error.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new HttpErrorFilter());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: [
      process.env.WEBSITE_URL || 'http://localhost:3000',
      process.env.APP_URL || 'http://localhost:3001',
      'https://hybridpro.in',
      'https://app.hybridpro.in',
    ],
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 3002);
}

await bootstrap();
