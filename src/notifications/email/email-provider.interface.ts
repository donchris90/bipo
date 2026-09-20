// Same swappable-provider pattern as PaymentProvider/RtcProvider — nothing
// outside this file should know which email service is actually sending.
export interface EmailMessage {
  to: { email: string; name?: string };
  subject: string;
  htmlContent: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ sent: boolean; providerMessageId?: string }>;
}

// Used in production when no email provider is configured. Reports every
// message as NOT sent (rather than the mock's `sent: true`), so nothing
// upstream believes an email went out that didn't. EmailService already treats
// a failed send as non-fatal, so registration and other flows are unaffected.
export class UnavailableEmailProvider implements EmailProvider {
  async send(): Promise<{ sent: boolean }> {
    return { sent: false };
  }
}

export class MockEmailProvider implements EmailProvider {
  async send(message: EmailMessage) {
    // Dev-only stand-in: logs instead of actually sending. This exists so
    // registration/notification flows are exercisable without a live
    // email provider account — never wire this in for anything a real
    // user needs to actually receive.
    // eslint-disable-next-line no-console
    console.log(`[MockEmailProvider] Would send to ${message.to.email}: "${message.subject}"`);
    return { sent: true, providerMessageId: 'mock' };
  }
}
