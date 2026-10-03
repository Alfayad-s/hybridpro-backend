import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';

type GoogleBody = {
  idToken?: string;
};

type AppleBody = {
  identityToken?: string;
  fullName?: string;
};

type OtpSendBody = {
  email?: string;
};

type OtpVerifyBody = {
  email?: string;
  code?: string;
  token?: string;
};

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Member Google sign-in — verifies Google ID token, returns Nest JWT. */
  @Post('google')
  @HttpCode(200)
  google(@Body() body: GoogleBody) {
    return this.auth.loginWithGoogleIdToken(body.idToken || '');
  }

  /** Member Sign in with Apple — verifies the identity token, returns Nest JWT. */
  @Post('apple')
  @HttpCode(200)
  apple(@Body() body: AppleBody) {
    return this.auth.loginWithAppleIdentityToken(body.identityToken || '', body.fullName);
  }

  /** Send a 6-digit email OTP (Resend). */
  @Post('otp/send')
  @HttpCode(200)
  sendOtp(@Body() body: OtpSendBody) {
    return this.auth.sendEmailOtp(body.email || '');
  }

  /** Verify email OTP and return Nest member JWT. */
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() body: OtpVerifyBody) {
    return this.auth.verifyEmailOtp(body.email || '', body.code || body.token || '');
  }
}
