import { Global, Injectable, Logger, Module } from '@nestjs/common';

export type WebhookHandler = (payload: any) => Promise<void>;

// Paystack lets an account set ONE webhook URL, but two different parts of the
// app need its events: payments (charge.*) and payouts (transfer.*). The payment
// webhook is that one URL; after it has verified Paystack's signature it hands
// events it does not own to whichever module registered for them here, so the
// modules stay independent (neither imports the other).
@Injectable()
export class WebhookRouterService {
  private readonly logger = new Logger(WebhookRouterService.name);
  private readonly handlers = new Map<string, WebhookHandler>();

  // `prefix` is matched against the start of the event name, e.g. "transfer.".
  register(prefix: string, handler: WebhookHandler) {
    this.handlers.set(prefix, handler);
  }

  // Returns true when a registered handler took the event (the caller should
  // then not treat it as a payment).
  async dispatch(event: unknown, payload: any): Promise<boolean> {
    if (typeof event !== 'string') return false;
    for (const [prefix, handler] of this.handlers) {
      if (event.startsWith(prefix)) {
        try {
          await handler(payload);
        } catch (e: any) {
          // Let the provider retry: a thrown error becomes a non-2xx response.
          this.logger.warn(`Handler for "${prefix}" failed on ${event}: ${e?.message ?? e}`);
          throw e;
        }
        return true;
      }
    }
    return false;
  }
}

@Global()
@Module({ providers: [WebhookRouterService], exports: [WebhookRouterService] })
export class WebhookRouterModule {}
