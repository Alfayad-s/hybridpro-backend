import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  private getTransporter() {
    if (this.transporter) return this.transporter;

    const host = process.env.SMTP_HOST?.trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.trim();

    if (!host || !user || !pass) return null;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user, pass },
    });
    return this.transporter;
  }

  async sendOtpEmail(input: { to: string; code: string }) {
    const from =
      process.env.SMTP_FROM?.trim() ||
      process.env.EMAIL_FROM?.trim() ||
      process.env.SMTP_USER?.trim() ||
      'Hybrid Pro <noreply@hybridpro.in>';

    const website =
      process.env.WEBSITE_URL?.trim() || 'https://hybridpro.in';
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
      this.logger.warn(
        `[dev] SMTP not configured — OTP for ${input.to}: ${input.code}`,
      );
      return { ok: true as const, delivered: false as const };
    }

    try {
      await transporter.sendMail({
        from,
        to: input.to,
        subject,
        html,
        text,
      });
      return { ok: true as const, delivered: true as const };
    } catch (error) {
      this.logger.error(
        `SMTP send failed: ${error instanceof Error ? error.message : error}`,
      );
      throw new ServiceUnavailableException('Could not send email code');
    }
  }

  private buildOtpHtml(input: {
    code: string;
    email: string;
    website: string;
    support: string;
  }) {
    const digits = input.code
      .split('')
      .map(
        (d) => `
          <td align="center" style="padding:0 4px;">
            <div style="width:42px;height:52px;line-height:52px;border-radius:10px;background:#111111;border:1px solid #2A2A2A;color:#A0D028;font-size:24px;font-weight:700;font-family:'SF Mono',Menlo,Consolas,monospace;letter-spacing:0;">
              ${d}
            </div>
          </td>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Hybrid Pro verification code</title>
</head>
<body style="margin:0;padding:0;background:#0B0B0F;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0B0B0F;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#121214;border:1px solid #242428;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 20px;border-bottom:1px solid #242428;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;letter-spacing:-0.3px;color:#FFFFFF;">
                    Hybrid <span style="color:#A0D028;">Pro</span>
                  </td>
                  <td align="right" style="font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;color:#8A8A93;">
                    Sign in
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 28px 8px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">
              <p style="margin:0 0 8px;font-size:22px;line-height:1.25;font-weight:700;letter-spacing:-0.4px;color:#FFFFFF;">
                Your verification code
              </p>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#A1A1AA;">
                Use this code to continue into Hybrid Pro. It expires in
                <strong style="color:#E4E4E7;font-weight:600;">10 minutes</strong>
                and can only be used once.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 28px;">
                <tr>
                  ${digits}
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1A1A1E;border:1px solid #2A2A2E;border-radius:12px;">
                <tr>
                  <td style="padding:16px 18px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#A1A1AA;">
                    Sent to <span style="color:#E4E4E7;">${this.escapeHtml(input.email)}</span>.
                    Enter the code in the app — never share it with anyone.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 28px 28px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">
              <p style="margin:0 0 18px;font-size:13px;line-height:1.55;color:#71717A;">
                If you didn’t request this email, you can ignore it. Your account stays secure.
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#52525B;">
                Need help?
                <a href="mailto:${this.escapeHtml(input.support)}" style="color:#A0D028;text-decoration:none;">${this.escapeHtml(input.support)}</a>
                ·
                <a href="${this.escapeHtml(input.website)}" style="color:#A0D028;text-decoration:none;">hybridpro.in</a>
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;color:#3F3F46;text-align:center;">
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
