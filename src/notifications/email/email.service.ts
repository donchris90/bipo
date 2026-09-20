import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailProvider } from './email-provider.interface';

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

// Every other module sends email through this service, never by injecting
// an EmailProvider directly — same reasoning as NotificationsService for
// in-app notifications: one seam means the provider can change without
// touching every call site, and failures can be handled/logged in one
// place instead of scattered per-caller try/catches.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(@Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider) {}

  // Deliberately swallows send failures rather than throwing — a failed
  // welcome/notification email should never break the request that
  // triggered it (e.g. registration succeeding but the welcome email
  // failing shouldn't roll back the account creation). Callers that
  // genuinely need to know whether the email sent should use the return
  // value, not a thrown error.
  async send(to: { email: string; name?: string }, subject: string, htmlContent: string): Promise<boolean> {
    try {
      const result = await this.provider.send({ to, subject, htmlContent });
      if (!result.sent) {
        this.logger.warn(`Email to ${to.email} ("${subject}") was not sent`);
      }
      return result.sent;
    } catch (e: any) {
      this.logger.error(`Email to ${to.email} ("${subject}") threw: ${e.message}`);
      return false;
    }
  }

  async sendWelcomeEmail(to: { email: string; name?: string }): Promise<boolean> {
    return this.send(
      to,
      'Welcome!',
      `<p>Hi${to.name ? ` ${to.name}` : ''},</p><p>Welcome to the platform — your account is ready.</p>`,
    );
  }
}
