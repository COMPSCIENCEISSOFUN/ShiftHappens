/**
 * Email Service (Control Layer)
 * 
 * Handles sending transactional emails via Resend.
 * Uses production-grade HTML templates with consistent branding.
 * All emails use inline styles for cross-client compatibility
 * (Gmail, Outlook, Apple Mail, Yahoo).
 */
import { Resend } from "resend";

const fromEmail = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
const appName = "Smart Task Allocation";

/**
 * Lazily constructs the Resend client on first send, memoized thereafter.
 * Constructing at module load crashes when RESEND_API_KEY is absent (e.g. in
 * tests that merely import a service depending on this one), so we defer it
 * until an email is actually sent — where the call is already inside a
 * try/catch and a misconfiguration is logged rather than crashing imports.
 */
let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

/** Which email failed. Appears in the log line; not shown to any user. */
type EmailKind = "verification" | "password reset" | "invitation";

/**
 * Sends one email and makes any failure visible.
 *
 * **The Resend SDK does not throw.** `fetchRequest` returns
 * `{ data: null, error }` for every non-2xx response, and its own outer catch
 * returns an error object even when `fetch` itself fails. A bare
 * `try { await send() } catch {}` therefore logs nothing, ever — which is how
 * a 403 from the sandbox sender reached production as a cheerful
 * "Registration successful. Please check your email."
 *
 * The `try` is still load-bearing, but for exactly one case: `new Resend()`
 * throws "Missing API key" when `RESEND_API_KEY` is unset. Everything after
 * construction resolves.
 *
 * Failures are logged and swallowed rather than rethrown: sending is
 * fire-and-forget, and a dead mail provider must not roll back a registration
 * that already succeeded. The boolean is returned so a caller can act on it
 * later without another change here.
 */
async function dispatch(
  kind: EmailKind,
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  try {
    const { error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject,
      html,
    });

    if (!error) return true;

    // `statusCode` is `number | null` in the SDK's ErrorResponse — null when
    // the request never reached Resend at all.
    const status = error.statusCode === null ? "" : ` (${error.statusCode})`;
    console.error(
      `[Email Error] ${kind} → ${to}: ${error.name}${status} — ${error.message}`
    );

    // The single most likely misconfiguration on this project, named
    // explicitly so the log says what to do rather than only what broke.
    if (/testing emails|own email address/i.test(error.message)) {
      console.error(
        `[Email Error] Sender "${fromEmail}" is Resend's shared sandbox address, ` +
          `which only delivers to the account owner. Verify a domain in Resend ` +
          `and set RESEND_FROM_EMAIL to an address on it.`
      );
    }

    return false;
  } catch (error) {
    console.error(
      `[Email Error] ${kind} → ${to}: Resend client unavailable`,
      error
    );
    return false;
  }
}

/** Wraps email content in a branded template shell */
function emailTemplate(content: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
              <!-- Header -->
              <tr>
                <td style="background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%); padding: 28px 32px; text-align: center;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                    <tr>
                      <td style="background-color: rgba(255,255,255,0.2); width: 36px; height: 36px; border-radius: 8px; text-align: center; vertical-align: middle; font-size: 18px;">
                        ⚡
                      </td>
                      <td style="padding-left: 12px; color: #ffffff; font-size: 18px; font-weight: 600; letter-spacing: -0.3px;">
                        ${appName}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <!-- Content -->
              <tr>
                <td style="padding: 32px;">
                  ${content}
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="padding: 0 32px 28px; border-top: 1px solid #e4e4e7;">
                  <p style="color: #a1a1aa; font-size: 12px; line-height: 1.5; margin: 20px 0 0; text-align: center;">
                    ${appName} — Smart workforce management for shift-based businesses.
                    <br>This is an automated message. Please do not reply.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

/** Creates a styled action button */
function actionButton(text: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
      <tr>
        <td style="background-color: #2563eb; border-radius: 8px;">
          <a href="${url}" style="display: inline-block; padding: 14px 32px; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">
            ${text}
          </a>
        </td>
      </tr>
    </table>
  `;
}

/** Creates a styled info box */
function infoBox(text: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 20px 0;">
      <tr>
        <td style="background-color: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 14px 16px;">
          <p style="color: #0369a1; font-size: 13px; margin: 0; line-height: 1.5;">${text}</p>
        </td>
      </tr>
    </table>
  `;
}

export class EmailService {
  /** Sends email verification link after registration */
  async sendVerificationEmail(email: string, token: string) {
    const verifyUrl = `${process.env.NEXTAUTH_URL}/verify-email?token=${token}`;

    const content = `
      <h2 style="color: #18181b; font-size: 20px; font-weight: 600; margin: 0 0 8px;">Welcome aboard! 👋</h2>
      <p style="color: #52525b; font-size: 15px; line-height: 1.6; margin: 0 0 4px;">
        Thanks for joining ${appName}. To get started, please verify your email address.
      </p>
      ${actionButton("Verify my email", verifyUrl)}
      ${infoBox("This verification link expires in <strong>24 hours</strong>. If you didn't create an account, you can safely ignore this email.")}
      <p style="color: #a1a1aa; font-size: 12px; line-height: 1.5; margin: 16px 0 0;">
        Button not working? Copy and paste this URL into your browser:<br>
        <a href="${verifyUrl}" style="color: #2563eb; word-break: break-all;">${verifyUrl}</a>
      </p>
    `;

    return dispatch(
      "verification",
      email,
      `Verify your email — ${appName}`,
      emailTemplate(content)
    );
  }

  /** Sends password reset link */
  async sendPasswordResetEmail(email: string, token: string) {
    const resetUrl = `${process.env.NEXTAUTH_URL}/reset-password?token=${token}`;

    const content = `
      <h2 style="color: #18181b; font-size: 20px; font-weight: 600; margin: 0 0 8px;">Reset your password 🔐</h2>
      <p style="color: #52525b; font-size: 15px; line-height: 1.6; margin: 0 0 4px;">
        We received a request to reset your password. Click the button below to choose a new one.
      </p>
      ${actionButton("Reset password", resetUrl)}
      ${infoBox("This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged.")}
      <p style="color: #a1a1aa; font-size: 12px; line-height: 1.5; margin: 16px 0 0;">
        Button not working? Copy and paste this URL into your browser:<br>
        <a href="${resetUrl}" style="color: #2563eb; word-break: break-all;">${resetUrl}</a>
      </p>
    `;

    return dispatch(
      "password reset",
      email,
      `Reset your password — ${appName}`,
      emailTemplate(content)
    );
  }

  /** Sends organization invitation link */
  async sendInvitationEmail(
    email: string,
    token: string,
    organizationName: string,
    inviterName: string
  ) {
    const inviteUrl = `${process.env.NEXTAUTH_URL}/accept-invitation?token=${token}`;

    const content = `
      <h2 style="color: #18181b; font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're invited! 🎉</h2>
      <p style="color: #52525b; font-size: 15px; line-height: 1.6; margin: 0 0 4px;">
        <strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> on ${appName}.
      </p>
      ${actionButton("Accept invitation", inviteUrl)}
      ${infoBox("This invitation expires in <strong>7 days</strong>. Once accepted, you'll be able to view your schedule, accept tasks, and clock in/out.")}
      <p style="color: #a1a1aa; font-size: 12px; line-height: 1.5; margin: 16px 0 0;">
        Button not working? Copy and paste this URL into your browser:<br>
        <a href="${inviteUrl}" style="color: #2563eb; word-break: break-all;">${inviteUrl}</a>
      </p>
    `;

    return dispatch(
      "invitation",
      email,
      `You're invited to join ${organizationName} — ${appName}`,
      emailTemplate(content)
    );
  }
}