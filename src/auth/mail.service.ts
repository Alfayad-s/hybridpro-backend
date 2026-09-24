import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import dns from 'node:dns';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private static readonly sendTimeoutMs = 12_000;

  private getTransporter() {
    if (this.transporter) return this.transporter;

    const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 587);
    // Gmail app passwords are often pasted with spaces — strip them.
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.replace(/\s+/g, '').trim();

    if (!user || !pass) return null;

    // Prefer STARTTLS on 587. Avoid service:'gmail' — it forces 465 and can
    // pick IPv6, which Railway cannot reach (ENETUNREACH …::465).
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure && port === 587,
      auth: { user, pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 12_000,
      tls: {
        minVersion: 'TLSv1.2',
        servername: host,
      },
      // Railway has no IPv6 — never dial AAAA records.
      family: 4,
      lookup(
        hostname: string,
        _options: unknown,
        callback: (
          err: NodeJS.ErrnoException | null,
          address: string,
          family: number,
        ) => void,
      ) {
        dns.lookup(hostname, { family: 4 }, callback);
      },
    } as unknown as Parameters<typeof nodemailer.createTransport>[0]);
    return this.transporter;
  }

  async sendOtpEmail(input: { to: string; code: string }) {
    const from =
      process.env.SMTP_FROM?.trim() ||
      process.env.EMAIL_FROM?.trim() ||
      process.env.SMTP_USER?.trim() ||
      'Hybrid Pro <noreply@hybridpro.in>';

    const website = process.env.WEBSITE_URL?.trim() || 'https://hybridpro.in';
    const support =
      process.env.SUPPORT_EMAIL?.trim() ||
      process.env.SMTP_USER?.trim() ||
      'support.hybridpro@gmail.com';

    const subject = `${input.code} is your Hybrid Pro verification code`;
    const html = this.buildOtpHtml({
      code: input.code,
      email: input.to,
      website,
      support,
    });
    const text = [
      'Hybrid Pro',
      '',
      'Your verification code',
      '',
      input.code,
      '',
      'Enter this code in the Hybrid Pro app to finish signing in.',
      'This code expires in 10 minutes and can only be used once.',
      '',
      'If you did not request this code, you can safely ignore this email.',
      'Someone may have typed your address by mistake.',
      '',
      `Need help? ${support}`,
      website,
    ].join('\n');

    const transporter = this.getTransporter();
    if (!transporter) {
      const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']
        .filter((key) => !process.env[key]?.trim())
        .join(', ');
      this.logger.error(`SMTP not configured (missing ${missing || 'values'})`);
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException(
          'Email is not configured on the server. Set SMTP_HOST, SMTP_USER, SMTP_PASS.',
        );
      }
      this.logger.warn(
        `[dev] SMTP not configured — OTP for ${input.to}: ${input.code}`,
      );
      return { ok: true as const, delivered: false as const };
    }

    try {
      await this.withTimeout(
        transporter.sendMail({
          from,
          to: input.to,
          subject,
          html,
          text,
        }),
        MailService.sendTimeoutMs,
        'Email send timed out. Check SMTP settings.',
      );
      return { ok: true as const, delivered: true as const };
    } catch (error) {
      // Drop cached transporter so the next attempt can reconnect cleanly.
      this.transporter = null;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`SMTP send failed: ${message}`);
      const lower = message.toLowerCase();
      let clientMessage = 'Could not send email code. Please try again.';
      if (lower.includes('timed out') || lower.includes('timeout')) {
        clientMessage = 'Email is taking too long. Please try again in a moment.';
      } else if (
        lower.includes('invalid login') ||
        lower.includes('username and password') ||
        lower.includes('authentication') ||
        lower.includes('eauth')
      ) {
        clientMessage =
          'Email server login failed. Check SMTP_USER / SMTP_PASS on the API.';
      } else if (lower.includes('enotfound') || lower.includes('econnrefused')) {
        clientMessage = 'Cannot reach the email server. Check SMTP_HOST.';
      }
      throw new ServiceUnavailableException(clientMessage);
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private buildOtpHtml(input: {
    code: string;
    email: string;
    website: string;
    support: string;
  }) {
    const code = this.escapeHtml(input.code);
    const email = this.escapeHtml(input.email);
    const website = this.escapeHtml(input.website);
    const support = this.escapeHtml(input.support);
    // Email clients cannot run clipboard JS — a mailto:/app link with the
    // code as visible text is the most reliable “copy-friendly” control.
    const appUrl = process.env.APP_URL?.trim() || 'https://app.hybridpro.in';
    const copyHref = this.escapeHtml(
      `${appUrl.replace(/\/$/, '')}/login?otp=${encodeURIComponent(input.code)}`,
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <title>Hybrid Pro verification code</title>
</head>
<body style="margin:0;padding:0;background:#F4F5F7;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F4F5F7;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E6E8EC;border-radius:16px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid #EEF0F3;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:-0.4px;color:#111111;">
                    Hybrid <span style="color:#7CB518;">Pro</span>
                  </td>
                  <td align="right" style="font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:#8B919A;">
                    Verification
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 8px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">
              <p style="margin:0 0 10px;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.5px;color:#111111;">
                Your sign-in code
              </p>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#5C6370;">
                Enter this code in the Hybrid Pro app to finish signing in.
                It expires in <strong style="color:#111111;font-weight:600;">10 minutes</strong>.
              </p>

              <!-- Single OTP box — works in Gmail / Outlook / Apple Mail -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
                <tr>
                  <td align="center" style="background:#F7F8FA;border:1px solid #E6E8EC;border-radius:12px;padding:22px 16px;">
                    <p style="margin:0 0 6px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#8B919A;">
                      One-time code
                    </p>
                    <p style="margin:0;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;line-height:1.2;font-weight:700;letter-spacing:10px;color:#111111;">
                      ${code}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Copy-friendly button (opens app; code is also in the label) -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 28px;">
                <tr>
                  <td align="center" bgcolor="#A0D028" style="border-radius:10px;background:#A0D028;">
                    <a href="${copyHref}" style="display:inline-block;padding:14px 28px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#111111;text-decoration:none;border-radius:10px;">
                      Copy code&nbsp;&nbsp;${code}
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#8B919A;text-align:center;">
                Tip: long-press the code above to copy it, or tap the button.
              </p>
              <p style="margin:0 0 24px;font-size:13px;line-height:1.55;color:#8B919A;text-align:center;">
                Sent to <span style="color:#3A3F47;">${email}</span>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 28px;border-top:1px solid #EEF0F3;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">
              <p style="margin:0 0 14px;font-size:13px;line-height:1.55;color:#8B919A;">
                If you didn’t request this email, you can ignore it. Your account stays secure.
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#A0A6B0;">
                Need help?
                <a href="mailto:${support}" style="color:#5A8A12;text-decoration:none;">${support}</a>
                ·
                <a href="${website}" style="color:#5A8A12;text-decoration:none;">hybridpro.in</a>
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;color:#A0A6B0;text-align:center;">
          © ${new Date().getFullYear()} Hybrid Pro · Train. Track. Transform.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
