import { Body, Controller, Get, Put, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Inject } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { PayoutAccountService } from './payout-account.service';
import { PayoutConfigService } from './payout-config.service';
import { BANK_PROVIDER, PAYSTACK_COUNTRIES, UnavailableBankProvider, type BankProvider } from './bank-provider';

interface AuthedRequest extends Request {
  user: { userId: string; countryCode: string };
}

@Controller('api/v1/payout')
@UseGuards(JwtAuthGuard)
export class PayoutsController {
  constructor(
    private readonly config: PayoutConfigService,
    private readonly accounts: PayoutAccountService,
    @Inject(BANK_PROVIDER) private readonly banks: BankProvider,
  ) {}

  // How you can be paid. Paystack works for the countries it is set up for;
  // Stripe is listed as coming soon and cannot be chosen yet.
  @Get('providers')
  providers(@Req() req: AuthedRequest) {
    const paystackAvailable = req.user.countryCode.toUpperCase() in PAYSTACK_COUNTRIES && !(this.banks instanceof UnavailableBankProvider);
    return [
      { id: 'PAYSTACK', name: 'Paystack', description: 'Bank transfer to a Nigerian bank account', available: paystackAvailable, comingSoon: false },
      { id: 'STRIPE', name: 'Stripe', description: 'International bank payouts', available: false, comingSoon: true },
    ];
  }

  // The admin-set rules for the caller's country (rate, minimum, fees), or why
  // withdrawing isn't possible yet.
  @Get('config')
  configFor(@Req() req: AuthedRequest) {
    return this.config.forUser(req.user.countryCode);
  }

  // Server-side preview of what N coins would pay, after fees.
  @Get('quote')
  quote(@Query('coins') coins: string, @Req() req: AuthedRequest) {
    return this.config.preview(req.user.countryCode, Number(coins));
  }

  @Get('banks')
  listBanks(@Req() req: AuthedRequest) {
    return this.accounts.listBanks(req.user.countryCode);
  }

  @Get('account')
  account(@Req() req: AuthedRequest) {
    return this.accounts.mine(req.user.userId);
  }

  // Look up the account holder's name so the user can check it is right.
  @Post('account/resolve')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  resolve(@Body('bankCode') bankCode: string, @Body('accountNumber') accountNumber: string, @Req() req: AuthedRequest) {
    return this.accounts.resolve(req.user.countryCode, bankCode, accountNumber);
  }

  @Put('account')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  save(
    @Body('bankCode') bankCode: string,
    @Body('accountNumber') accountNumber: string,
    @Body('password') password: string,
    @Req() req: AuthedRequest,
  ) {
    return this.accounts.save(req.user.userId, req.user.countryCode, { bankCode, accountNumber, password });
  }
}
