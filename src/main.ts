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

  const googleIds =
    process.env.GOOGLE_CLIENT_IDS?.trim() || process.env.GOOGLE_CLIENT_ID?.trim();
  if (!googleIds) {
    console.warn(
      '[bootstrap] GOOGLE_CLIENT_IDS missing — POST /api/auth/google will fail',
    );
  }
  if (!process.env.RESEND_API_KEY?.trim()) {
    console.warn(
      '[bootstrap] RESEND_API_KEY missing — email OTP will fail in production (dev logs the code)',
    );
  }
  if (!process.env.RESEND_FROM?.trim()) {
    console.warn(
      '[bootstrap] RESEND_FROM missing — defaulting to Hybrid Pro <noreply@hybridpro.in>',
    );
  }

  await app.listen(Number(process.env.PORT ?? 3002), '0.0.0.0');
}

await bootstrap();
