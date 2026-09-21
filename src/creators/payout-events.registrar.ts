import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { WebhookRouterService } from '../common/webhook-router.service';
import { WithdrawalService, PAYOUT_PROVIDER } from './withdrawal.service';
import type { PayoutProvider } from './providers/payout-provider.interface';

// Receives Paystack's transfer.* events (forwarded from the payment webhook,
// which has already verified the signature) and settles the matching withdrawal.
@Injectable()
export class PayoutEventsRegistrar implements OnModuleInit {
  constructor(
    private readonly router: WebhookRouterService,
    private readonly withdrawals: WithdrawalService,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProvider,
  ) {}

  onModuleInit() {
    this.router.register('transfer.', (payload) => this.handle(payload));
  }

  async handle(payload: any) {
    const result = this.provider.parseWebhook?.(payload);
    if (!result) return;
    if (result.status === 'paid') await this.withdrawals.confirmPaid(result.providerRef);
    else if (result.status === 'reversed') await this.withdrawals.confirmReversed(result.providerRef, result.reason ?? 'The transfer was reversed');
    else await this.withdrawals.confirmFailed(result.providerRef, result.reason ?? 'Provider reported failure');
  }
}
