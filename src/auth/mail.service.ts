import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import dns from 'node:dns/promises';
import net from 'node:net';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private static readonly sendTimeoutMs = 12_000;

  /**
   * Nodemailer 10 resolves A+AAAA and can dial IPv6 first. Railway (and many
   * containers) advertise IPv6 interfaces but have no outbound IPv6 route →
   * ENETUNREACH …::587. `family` / `lookup` options are ignored by that
   * resolver, so we pin the socket to a resolved IPv4 literal and keep the
   * real hostname only for TLS SNI / cert checks.
   */
  private async getTransporter(): Promise<Transporter | null> {
    if (this.transporter) return this.transporter;

    const hostname = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 587);
    // Gmail app passwords are often pasted with spaces — strip them.
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.replace(/\s+/g, '').trim();

    if (!user || !pass) return null;

    let host = hostname;
    if (!net.isIP(hostname)) {
      try {
        const resolved = await dns.lookup(hostname, { family: 4 });
        host = resolved.address;
        this.logger.log(`SMTP ${hostname} → ${host} (IPv4 only)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`SMTP IPv4 lookup failed for ${hostname}: ${message}`);
        throw new ServiceUnavailableException(
          'Cannot resolve email server (IPv4). Check SMTP_HOST.',
        );
      }
    }

    // Prefer STARTTLS on 587. Avoid service:'gmail' — it forces 465.
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
        // Must be the hostname, not the IP — SNI + cert verification.
        servername: hostname,
      },
      // EHLO / greeting identity
      name: hostname,
    });
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

    const transporter = await this.getTransporter();
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
    // Spaces between digits keep the full code readable on narrow screens
    // (letter-spacing often clips in Gmail / Outlook).
    const codeSpaced = this.escapeHtml(input.code.split('').join(' '));
    const email = this.escapeHtml(input.email);
    const website = this.escapeHtml(input.website);
    const support = this.escapeHtml(input.support);
    // Email clients cannot run clipboard JS. A selectable code box + a
    // button that embeds the code in the link text is the reliable pattern.
    const copyHref = this.escapeHtml(
      `https://hybridpro.in/?otp=${encodeURIComponent(input.code)}`,
    );

    return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <title>Hybrid Pro verification code</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, Helvetica, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#F0F2F5;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    Your Hybrid Pro code is ${code}. Expires in 10 minutes.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0F2F5;padding:36px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#FFFFFF;border:1px solid #E2E5EA;border-radius:14px;">
          <tr>
            <td style="padding:26px 28px 18px;border-bottom:1px solid #EEF0F3;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:#111111;">
                Hybrid <span style="color:#7CB518;">Pro</span>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0 0 8px;font-size:22px;line-height:1.3;font-weight:700;color:#111111;">
                Your verification code
              </p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#5C6370;">
                Enter this code in the app to sign in. It expires in
                <strong style="color:#111111;">10 minutes</strong>.
              </p>

              <!-- One simple box — full code visible in every client -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
                <tr>
                  <td align="center" bgcolor="#F7F8FA" style="background:#F7F8FA;border:1px solid #E2E5EA;border-radius:10px;padding:20px 12px;">
                    <p style="margin:0;font-family:Consolas,'Courier New',monospace;font-size:32px;line-height:1.3;font-weight:700;letter-spacing:2px;color:#111111;-webkit-user-select:all;user-select:all;">
                      ${codeSpaced}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Copy button (long-press / select also works on the code above) -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" bgcolor="#A0D028" style="border-radius:8px;background-color:#A0D028;">
                    <a href="${copyHref}" style="display:inline-block;padding:12px 26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#111111;text-decoration:none;">
                      Copy code&nbsp;&nbsp;${code}
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;font-size:13px;line-height:1.5;color:#8B919A;text-align:center;">
                Sent to ${email}. Never share this code.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 28px 26px;border-top:1px solid #EEF0F3;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#8B919A;">
                If you didn’t request this email, you can ignore it.
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#A0A6B0;">
                <a href="mailto:${support}" style="color:#5A8A12;text-decoration:none;">${support}</a>
                ·
                <a href="${website}" style="color:#5A8A12;text-decoration:none;">hybridpro.in</a>
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#A0A6B0;text-align:center;">
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
