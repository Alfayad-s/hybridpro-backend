import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    const supabaseUrl =
      process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const supabaseAnon =
      process.env.SUPABASE_ANON_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    return {
      ok: true,
      service: 'hybrid-pro-backend',
      supabaseConfigured: Boolean(supabaseUrl && supabaseAnon),
    };
  }
}
