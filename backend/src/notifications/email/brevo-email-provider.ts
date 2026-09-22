import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailProvider, EmailMessage } from './email-provider.interface';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

// NOT verified against Brevo's live API in this environment — same
// limitation as the Paystack/Agora integrations: this sandbox cannot
// reach api.brevo.com at all. Written against Brevo's public transactional
// email API docs, not round-tripped against their servers. Test with a
// real BREVO_API_KEY before relying on this for anything a user needs to
// actually receive (password reset, security alerts).
@Injectable()
export class BrevoEmailProvider implements EmailProvider {
  private readonly logger = new Logger(BrevoEmailProvider.name);

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<{ sent: boolean; providerMessageId?: string }> {
    const apiKey = this.config.get<string>('BREVO_API_KEY');
    if (!apiKey) throw new Error('BREVO_API_KEY is not configured');

    const senderEmail = this.config.get<string>('BREVO_SENDER_EMAIL');
    const senderName = this.config.get<string>('BREVO_SENDER_NAME') ?? 'Platform';
    if (!senderEmail) throw new Error('BREVO_SENDER_EMAIL is not configured');

    const response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: message.to.email, name: message.to.name }],
        subject: message.subject,
        htmlContent: message.htmlContent,
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      this.logger.error(`Brevo send failed (${response.status}): ${JSON.stringify(body)}`);
      return { sent: false };
    }

    return { sent: true, providerMessageId: body.messageId };
  }
}
