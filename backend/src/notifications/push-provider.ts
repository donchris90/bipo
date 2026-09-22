import { Logger } from '@nestjs/common';

export interface PushMessage {
  to: string; // the device's Expo push token
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  // Tokens the provider says are permanently dead (app uninstalled, token
  // revoked) — the caller deletes them so they aren't retried forever.
  invalidTokens: string[];
}

export interface PushProvider {
  send(messages: PushMessage[]): Promise<PushSendResult>;
}

export const PUSH_PROVIDER = 'PUSH_PROVIDER';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_MAX_BATCH = 100; // Expo's documented limit per request

// Splits into provider-sized batches. Pure and exported for a direct test.
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Delivery via Expo's push service, which fans out to APNs / FCM. Needs no
// credentials for development builds; production Android additionally needs
// FCM credentials uploaded to your EAS project, and production iOS an APNs
// key (both configured in EAS, not here). EXPO_ACCESS_TOKEN is optional and
// only needed if you enable "enhanced push security" on the Expo project.
//
// Not exercised against Expo's live service in this sandbox (no network to
// it): send a real push to a real device before relying on this.
export class ExpoPushProvider implements PushProvider {
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(private readonly accessToken?: string) {}

  async send(messages: PushMessage[]): Promise<PushSendResult> {
    const invalidTokens: string[] = [];

    for (const batch of chunk(messages, EXPO_MAX_BATCH)) {
      let response: Response;
      try {
        response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify(batch.map((m) => ({ ...m, sound: 'default', priority: 'high' }))),
        });
      } catch (e: any) {
        this.logger.warn(`Expo push request failed: ${e?.message ?? e}`);
        continue;
      }

      if (!response.ok) {
        this.logger.warn(`Expo push responded ${response.status}`);
        continue;
      }

      const json: any = await response.json().catch(() => null);
      const tickets: any[] = Array.isArray(json?.data) ? json.data : [];
      // Tickets come back in the same order as the messages sent.
      tickets.forEach((ticket, i) => {
        if (ticket?.status !== 'error') return;
        if (ticket.details?.error === 'DeviceNotRegistered') invalidTokens.push(batch[i].to);
        else this.logger.warn(`Expo push ticket error: ${ticket.message ?? ticket.details?.error ?? 'unknown'}`);
      });
    }

    return { invalidTokens };
  }
}

// Used when PUSH_PROVIDER isn't set to a real provider: nothing is sent, and
// nothing outbound is attempted from a dev machine by surprise.
export class NoopPushProvider implements PushProvider {
  async send(): Promise<PushSendResult> {
    return { invalidTokens: [] };
  }
}
