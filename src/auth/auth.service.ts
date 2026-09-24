import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DB } from '../db/db.module.js';
import { emailOtps, memberAccounts, profiles, subscriptions } from '../db/schema.js';
import { MailService } from './mail.service.js';

type Db = PostgresJsDatabase<typeof import('../db/schema.js')>;

type GoogleTokenInfo = {
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  aud?: string;
  azp?: string;
  iss?: string;
  error_description?: string;
};

export type MemberTokenPayload = {
  role: 'member';
  sub: string;
  email: string;
  fullName?: string | null;
  avatarUrl?: string | null;
};

type MemberAccountRow = typeof memberAccounts.$inferSelect;

@Injectable()
export class AuthService {
  private static readonly otpTtlMs = 10 * 60 * 1000;
  private static readonly otpResendMs = 45 * 1000;
  private static readonly otpMaxAttempts = 5;

  constructor(
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    @Inject(DB) private readonly db: Db,
  ) {}

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

  /** Exchange a Google ID token for a Hybrid Pro member JWT (no Supabase Auth). */
  async loginWithGoogleIdToken(idToken: string) {
    const token = idToken?.trim();
    if (!token) throw new BadRequestException('idToken is required');

    const google = await this.verifyGoogleIdToken(token);
    const email = (google.email || '').trim().toLowerCase();
    const googleSub = (google.sub || '').trim();
    if (!email || !googleSub) {
      throw new UnauthorizedException('Google account is missing email');
    }
    const verified =
      google.email_verified === true || google.email_verified === 'true';
    if (!verified) {
      throw new UnauthorizedException('Google email is not verified');
    }

    const account = await this.upsertMemberAccount({
      email,
      googleSub,
      fullName: (google.name || '').trim() || null,
      avatarUrl: (google.picture || '').trim() || null,
    });
    return this.issueMemberSession(account);
  }

  async sendEmailOtp(rawEmail: string) {
    const email = this.normalizeEmail(rawEmail);
    if (!email.includes('@') || !email.includes('.')) {
      throw new BadRequestException('Enter a valid email');
    }

    const [existing] = await this.db
      .select()
      .from(emailOtps)
      .where(eq(emailOtps.email, email))
      .limit(1);

    if (existing?.sentAt) {
      const elapsed = Date.now() - new Date(existing.sentAt).getTime();
      if (elapsed < AuthService.otpResendMs) {
        const waitSec = Math.ceil((AuthService.otpResendMs - elapsed) / 1000);
        throw new BadRequestException(`Wait ${waitSec}s before requesting another code`);
      }
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + AuthService.otpTtlMs);

    await this.db
      .insert(emailOtps)
      .values({
        email,
        codeHash: this.hashOtp(email, code),
        expiresAt,
        attempts: 0,
        sentAt: now,
      })
      .onConflictDoUpdate({
        target: emailOtps.email,
        set: {
          codeHash: this.hashOtp(email, code),
          expiresAt,
          attempts: 0,
          sentAt: now,
        },
      });

    await this.mail.sendOtpEmail({ to: email, code });
    return { ok: true as const, email };
  }

  async verifyEmailOtp(rawEmail: string, rawCode: string) {
    const email = this.normalizeEmail(rawEmail);
    const code = (rawCode || '').trim().replace(/\s+/g, '');
    if (!email.includes('@')) throw new BadRequestException('Enter a valid email');
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('Enter the 6-digit code');

    const [row] = await this.db
      .select()
      .from(emailOtps)
      .where(eq(emailOtps.email, email))
      .limit(1);

    if (!row) throw new UnauthorizedException('Code expired. Request a new one.');
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      await this.db.delete(emailOtps).where(eq(emailOtps.email, email));
      throw new UnauthorizedException('Code expired. Request a new one.');
    }
    if ((row.attempts ?? 0) >= AuthService.otpMaxAttempts) {
      await this.db.delete(emailOtps).where(eq(emailOtps.email, email));
      throw new UnauthorizedException('Too many attempts. Request a new code.');
    }

    const expected = Buffer.from(row.codeHash);
    const actual = Buffer.from(this.hashOtp(email, code));
    const match =
      expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!match) {
      await this.db
        .update(emailOtps)
        .set({ attempts: (row.attempts ?? 0) + 1 })
        .where(eq(emailOtps.email, email));
      throw new UnauthorizedException('Invalid code');
    }

    await this.db.delete(emailOtps).where(eq(emailOtps.email, email));

    const account = await this.upsertMemberAccount({ email });
    return this.issueMemberSession(account);
  }

  signMemberToken(payload: MemberTokenPayload) {
    return this.jwt.sign(payload, { expiresIn: '30d' });
  }

  verifyMemberToken(token: string): MemberTokenPayload | null {
    try {
      const payload = this.jwt.verify<Partial<MemberTokenPayload> & { role?: string }>(
        token,
      );
      if (payload.role !== 'member' || !payload.sub || !payload.email) return null;
      return {
        role: 'member',
        sub: payload.sub,
        email: payload.email,
        fullName: payload.fullName ?? null,
        avatarUrl: payload.avatarUrl ?? null,
      };
    } catch {
      return null;
    }
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private hashOtp(email: string, code: string) {
    const pepper =
      process.env.OTP_PEPPER?.trim() ||
      process.env.COACH_SESSION_SECRET?.trim() ||
      process.env.INTERNAL_API_SECRET?.trim() ||
      'hybrid-pro-otp';
    return createHash('sha256').update(`${pepper}:${email}:${code}`).digest('hex');
  }

  /**
   * One member per email. Google + OTP with the same address always share
   * the same account id (and Nest JWT `sub`).
   */
  private async upsertMemberAccount(input: {
    email: string;
    googleSub?: string | null;
    fullName?: string | null;
    avatarUrl?: string | null;
  }) {
    const email = this.normalizeEmail(input.email);
    const googleSub = input.googleSub?.trim() || null;
    const fullName = input.fullName?.trim() || null;
    const avatarUrl = input.avatarUrl?.trim() || null;

    const byGoogle = googleSub
      ? await this.findAccountByGoogleSub(googleSub)
      : undefined;
    const byEmail = await this.findAccountByEmail(email);

    let account: MemberAccountRow | undefined;
    if (byGoogle && byEmail && byGoogle.id !== byEmail.id) {
      // Same person, two rows — keep the email account and absorb Google row.
      account = await this.mergeMemberAccounts(byEmail, byGoogle);
    } else {
      account = byEmail || byGoogle;
    }

    const now = new Date();
    if (account) {
      const [updated] = await this.db
        .update(memberAccounts)
        .set({
          email,
          googleSub: googleSub || account.googleSub,
          fullName: fullName || account.fullName,
          avatarUrl: avatarUrl || account.avatarUrl,
          updatedAt: now,
        })
        .where(eq(memberAccounts.id, account.id))
        .returning();
      account = updated ?? account;
    } else {
      try {
        const [created] = await this.db
          .insert(memberAccounts)
          .values({
            id: randomUUID(),
            email,
            googleSub,
            fullName,
            avatarUrl,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        account = created;
      } catch {
        // Race: another login created the email row — reuse it.
        const raced =
          (await this.findAccountByEmail(email)) ||
          (googleSub ? await this.findAccountByGoogleSub(googleSub) : undefined);
        if (!raced) throw new UnauthorizedException('Could not create account');
        const [updated] = await this.db
          .update(memberAccounts)
          .set({
            email,
            googleSub: googleSub || raced.googleSub,
            fullName: fullName || raced.fullName,
            avatarUrl: avatarUrl || raced.avatarUrl,
            updatedAt: now,
          })
          .where(eq(memberAccounts.id, raced.id))
          .returning();
        account = updated ?? raced;
      }
    }

    await this.upsertProfileFromAccount(account);
    return account;
  }

  private async findAccountByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(memberAccounts)
      .where(sql`lower(trim(${memberAccounts.email})) = ${email}`)
      .limit(1);
    return row;
  }

  private async findAccountByGoogleSub(googleSub: string) {
    const [row] = await this.db
      .select()
      .from(memberAccounts)
      .where(eq(memberAccounts.googleSub, googleSub))
      .limit(1);
    return row;
  }

  /** Fold `duplicate` into `keeper` so Google/OTP share one user id. */
  private async mergeMemberAccounts(
    keeper: MemberAccountRow,
    duplicate: MemberAccountRow,
  ) {
    if (keeper.id === duplicate.id) return keeper;

    const now = new Date();
    const [updated] = await this.db
      .update(memberAccounts)
      .set({
        googleSub: keeper.googleSub || duplicate.googleSub,
        fullName: keeper.fullName || duplicate.fullName,
        avatarUrl: keeper.avatarUrl || duplicate.avatarUrl,
        email: this.normalizeEmail(keeper.email || duplicate.email),
        updatedAt: now,
      })
      .where(eq(memberAccounts.id, keeper.id))
      .returning();

    // Point subscriptions at the surviving account.
    await this.db
      .update(subscriptions)
      .set({ userId: keeper.id, updatedAt: now })
      .where(eq(subscriptions.userId, duplicate.id));

    // Prefer keeper profile; absorb missing fields from duplicate, then drop it.
    const [keeperProfile] = await this.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, keeper.id))
      .limit(1);
    const [dupProfile] = await this.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, duplicate.id))
      .limit(1);

    if (dupProfile) {
      if (!keeperProfile) {
        await this.db.insert(profiles).values({
          id: keeper.id,
          fullName: dupProfile.fullName,
          avatarUrl: dupProfile.avatarUrl,
          experienceLevel: dupProfile.experienceLevel,
          assessmentStatus: dupProfile.assessmentStatus,
          assessmentJson: dupProfile.assessmentJson,
          updatedAt: now,
        });
      } else {
        await this.db
          .update(profiles)
          .set({
            fullName: keeperProfile.fullName || dupProfile.fullName,
            avatarUrl: keeperProfile.avatarUrl || dupProfile.avatarUrl,
            experienceLevel:
              keeperProfile.experienceLevel || dupProfile.experienceLevel,
            assessmentStatus:
              keeperProfile.assessmentStatus || dupProfile.assessmentStatus,
            assessmentJson:
              keeperProfile.assessmentJson || dupProfile.assessmentJson,
            updatedAt: now,
          })
          .where(eq(profiles.id, keeper.id));
      }
      await this.db.delete(profiles).where(eq(profiles.id, duplicate.id));
    }

    await this.db.delete(memberAccounts).where(eq(memberAccounts.id, duplicate.id));
    return updated ?? keeper;
  }

  private issueMemberSession(account: MemberAccountRow) {
    const accessToken = this.signMemberToken({
      role: 'member',
      sub: account.id,
      email: account.email,
      fullName: account.fullName,
      avatarUrl: account.avatarUrl,
    });

    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: 60 * 60 * 24 * 30,
      user: {
        id: account.id,
        email: account.email,
        fullName: account.fullName,
        avatarUrl: account.avatarUrl,
      },
    };
  }

  private async upsertProfileFromAccount(account: {
    id: string;
    fullName: string | null;
    avatarUrl: string | null;
  }) {
    const [existing] = await this.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, account.id))
      .limit(1);
    const payload = {
      id: account.id,
      fullName: account.fullName || existing?.fullName || null,
      avatarUrl: account.avatarUrl || existing?.avatarUrl || null,
      updatedAt: new Date(),
    };
    if (existing) {
      await this.db
        .update(profiles)
        .set({
          fullName: payload.fullName,
          avatarUrl: payload.avatarUrl,
          updatedAt: payload.updatedAt,
        })
        .where(eq(profiles.id, account.id));
      return;
    }
    await this.db.insert(profiles).values({
      ...payload,
      experienceLevel: null,
      assessmentStatus: null,
      assessmentJson: null,
    });
  }

  private allowedGoogleAudiences() {
    return (process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private async verifyGoogleIdToken(idToken: string): Promise<GoogleTokenInfo> {
    const url = new URL('https://oauth2.googleapis.com/tokeninfo');
    url.searchParams.set('id_token', idToken);
    const res = await fetch(url);
    const data = (await res.json()) as GoogleTokenInfo;
    if (!res.ok || data.error_description || !data.sub) {
      throw new UnauthorizedException(
        data.error_description || 'Invalid Google ID token',
      );
    }

    const audiences = this.allowedGoogleAudiences();
    if (audiences.length === 0) {
      throw new UnauthorizedException(
        'Google auth is not configured (GOOGLE_CLIENT_IDS)',
      );
    }
    const aud = (data.aud || '').trim();
    const azp = (data.azp || '').trim();
    if (!audiences.includes(aud) && !(azp && audiences.includes(azp))) {
      throw new UnauthorizedException('Google token audience mismatch');
    }

    const iss = (data.iss || '').trim();
    if (iss && iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') {
      throw new UnauthorizedException('Invalid Google token issuer');
    }

    return data;
  }
}
