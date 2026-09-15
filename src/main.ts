import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./app.module.js');
const { HttpErrorFilter } = await import('./http-error.filter.js');

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
  await app.listen(Number(process.env.PORT ?? 3002), '0.0.0.0');
}

await bootstrap();
