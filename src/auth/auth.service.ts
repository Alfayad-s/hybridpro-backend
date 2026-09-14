import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  login(email: string, password: string) {
    const allowed = (process.env.COACH_EMAILS || process.env.COACH_EMAIL || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const expectedPassword = process.env.COACH_PASSWORD?.trim();
    const normalized = email.trim().toLowerCase();

    if (!expectedPassword || allowed.length === 0 || !allowed.includes(normalized)) {
      throw new UnauthorizedException('Invalid coach login');
    }

    const left = Buffer.from(password);
    const right = Buffer.from(expectedPassword);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException('Invalid coach login');
    }

    const token = this.jwt.sign({ email: normalized, role: 'coach' }, { expiresIn: '7d' });
    return { token, email: normalized };
  }
}
