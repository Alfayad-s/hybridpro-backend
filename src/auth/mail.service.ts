import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/** OTP + transactional email via Resend HTTPS (no SMTP). */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private static readonly sendTimeoutMs = 15_000;

  async sendOtpEmail(input: { to: string; code: string }) {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from =
      process.env.RESEND_FROM?.trim() ||
      process.env.EMAIL_FROM?.trim() ||
      'Hybrid Pro <noreply@hybridpro.in>';

    const website = process.env.WEBSITE_URL?.trim() || 'https://hybridpro.in';
    const support =
      process.env.SUPPORT_EMAIL?.trim() || 'support.hybridpro@gmail.com';

    if (!apiKey) {
      this.logger.error('RESEND_API_KEY is not set — cannot send OTP email');
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException(
          'Email is not configured. Set RESEND_API_KEY on the API.',
        );
      }
      this.logger.warn(
        `[dev] RESEND_API_KEY missing — OTP for ${input.to}: ${input.code}`,
      );
      return { ok: true as const, delivered: false as const };
    }

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

    try {
      const response = await this.withTimeout(
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [input.to],
            subject,
            html,
            text,
          }),
        }),
        MailService.sendTimeoutMs,
        'Resend request timed out.',
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(`Resend failed (${response.status}): ${body}`);
        throw new ServiceUnavailableException(
          response.status === 401 || response.status === 403
            ? 'Resend API key rejected. Check RESEND_API_KEY.'
            : response.status === 422
              ? 'Resend rejected the from-address. Use a verified domain in RESEND_FROM.'
              : 'Could not send email code. Please try again.',
        );
      }

      this.logger.log(`OTP email sent via Resend to ${input.to}`);
      return { ok: true as const, delivered: true as const };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Resend send failed: ${message}`);
      throw new ServiceUnavailableException(
        'Could not send email code. Please try again.',
      );
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
