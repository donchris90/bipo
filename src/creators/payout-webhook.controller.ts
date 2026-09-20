import { Body, Controller, ForbiddenException, Inject, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { WithdrawalService, PAYOUT_PROVIDER } from './withdrawal.service';
import type { PayoutProvider } from './providers/payout-provider.interface';

// Called by the payout provider, not a user, so there is no login. What stands
// in for it is the provider's signature over the exact raw body: a request
// without a valid signature is rejected before any field is trusted. (Before
// this, the route accepted ANY caller — anyone could have marked a withdrawal
// paid, or "failed" to have the coins handed back after the money was sent.)
@Controller('api/v1/webhooks/payouts')
export class PayoutWebhookController {
  constructor(
    private readonly withdrawals: WithdrawalService,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProvider,
  ) {}

  @Post()
  async handle(@Req() req: RawBodyRequest<Request>, @Body() payload: any) {
    if (!this.provider.verifyWebhookSignature || !this.provider.parseWebhook) {
      throw new ForbiddenException('This payout provider does not support verified webhooks');
    }
    if (!req.rawBody) throw new ForbiddenException('Raw request body unavailable for signature verification');
    if (!this.provider.verifyWebhookSignature(req.rawBody, req.headers)) throw new ForbiddenException('Invalid webhook signature');

    const result = this.provider.parseWebhook(payload);
    if (!result) return { received: true }; // an event we don't act on
    if (result.status === 'paid') await this.withdrawals.confirmPaid(result.providerRef);
    else await this.withdrawals.confirmFailed(result.providerRef, result.reason ?? 'Provider reported failure');
    return { received: true };
  }
}
