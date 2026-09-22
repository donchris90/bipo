import { WebhookRouterService } from '../common/webhook-router.service';
import { Body, Controller, ForbiddenException, Inject, Post, Req, RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { CoinPurchaseService } from './coin-purchase.service';
import { ChargebackService } from './chargeback.service';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER } from './coin-purchase.service';
import type { PaymentProvider } from './providers/payment-provider.interface';

// No auth guard — this is called by the payment provider, not a logged-in
// user. Signature verification is what stands in for auth here: a request
// that doesn't carry a valid signature for whatever provider is currently
// wired in is rejected outright, before any payload field is trusted.
@Controller('api/v1/webhooks/payments')
export class PaymentWebhookController {
  constructor(
    private readonly coinPurchase: CoinPurchaseService,
    private readonly chargeback: ChargebackService,
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    private readonly router: WebhookRouterService,
  ) {}

  @Post()
  async handle(@Req() req: RawBodyRequest<Request>, @Body() payload: any) {
    // A provider with no verifyWebhookSignature (the mock) means this
    // deployment cannot safely accept webhooks at all — reject rather
    // than silently trust an unverifiable payload. This is deliberate:
    // there is no code path where a missing verification method results
    // in the payload being trusted anyway.
    if (!this.paymentProvider.verifyWebhookSignature) {
      throw new ForbiddenException('This payment provider does not support verified webhooks');
    }
    if (!req.rawBody) {
      // Should never happen once main.ts's rawBody:true is in place —
      // failing loudly here is better than silently falling back to
      // re-serializing the parsed body, which would defeat the point.
      throw new ForbiddenException('Raw request body unavailable for signature verification');
    }
    const validSignature = this.paymentProvider.verifyWebhookSignature(req.rawBody, req.headers);
    if (!validSignature) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    // Paystack has one webhook URL for the whole account. Events that belong to
    // another part of the app (payout transfers) are handed to it here, after
    // the signature above has been verified.
    if (await this.router.dispatch(payload?.event, payload)) return { received: true };

    // Dispute detection stays Paystack-shape-specific (payload.event) for
    // now — a harmless no-op against the mock's simpler shape, which never
    // sets `.event` at all. Paystack's exact dispute event name is not
    // confirmed against their live docs from this environment (no network
    // access to check) — verify 'charge.dispute.create' before relying on
    // it; a wrong name here just means disputes silently fall through to
    // the confirm path below instead of being recorded.
    if (payload.event === 'charge.dispute.create') {
      const reference = payload?.data?.transaction?.reference ?? payload?.data?.reference;
      const purchase = await this.prisma.coinPurchase.findFirst({ where: { providerRef: reference } });
      if (purchase) {
        await this.chargeback.record(purchase.id, payload?.data?.reason, reference);
      }
      return { received: true };
    }

    // Routes through the provider's own handleWebhook(), which normalizes
    // each provider's distinct payload shape into {providerRef, status} —
    // MockPaymentProvider and PaystackPaymentProvider each implement this
    // correctly for their own shape. Hardcoding Paystack's field names
    // directly here instead of calling this was the actual bug: it
    // silently broke the mock purchase flow the moment Paystack support
    // was added — the webhook returned `received: true` but never called
    // confirm(), so coins never landed, with no error anywhere to notice.
    const result = await this.paymentProvider.handleWebhook(payload);
    if (result.status === 'confirmed') {
      await this.coinPurchase.confirm(result.providerRef);
    } else if (result.status === 'failed' && result.providerRef) {
      // A provider-reported payment failure is terminal for the pending
      // purchase, but only after the provider itself has normalized the event.
      // Unrelated webhook events are returned as "ignored" and can never
      // accidentally fail a purchase.
      const purchase = await this.prisma.coinPurchase.findFirst({ where: { providerRef: result.providerRef } });
      if (purchase && purchase.status === 'PENDING') {
        await this.prisma.coinPurchase.update({ where: { id: purchase.id }, data: { status: 'FAILED' } });
      }
    }
    return { received: true };
  }
}
