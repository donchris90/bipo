import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BANK_PROVIDER, type BankProvider, PAYSTACK_COUNTRIES } from './bank-provider';

// After adding or changing a payout account, changing it again is blocked for
// this long. Money is only ever paid to the saved account, so this limits what
// someone with a stolen session can do: they can't quickly swap the destination
// to their own account, and the real owner gets a security notice at once.
export const ACCOUNT_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const cooldownRemainingMs = (updatedAt: Date, now = Date.now()) =>
  Math.max(0, updatedAt.getTime() + ACCOUNT_CHANGE_COOLDOWN_MS - now);

export const isValidAccountNumber = (n: unknown): n is string => typeof n === 'string' && /^\d{10}$/.test(n); // Nigerian NUBAN
export const isValidBankCode = (c: unknown): c is string => typeof c === 'string' && /^[0-9A-Za-z-]{2,12}$/.test(c);

@Injectable()
export class PayoutAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(BANK_PROVIDER) private readonly banks: BankProvider,
  ) {}

  // What the app may see. Never the recipient code.
  private view(a: { provider: string; bankName: string; accountLast4: string; accountName: string; currencyCode: string; updatedAt: Date }) {
    return {
      provider: a.provider,
      bankName: a.bankName,
      accountLast4: a.accountLast4,
      accountName: a.accountName,
      currencyCode: a.currencyCode,
      updatedAt: a.updatedAt,
      canChangeAt: new Date(a.updatedAt.getTime() + ACCOUNT_CHANGE_COOLDOWN_MS),
    };
  }

  async mine(userId: string) {
    const account = await this.prisma.payoutAccount.findUnique({ where: { userId } });
    return account ? this.view(account) : null;
  }

  // Used by the withdrawal flow — includes the recipient code.
  requireFor(userId: string) {
    return this.prisma.payoutAccount.findUnique({ where: { userId } }).then((a) => {
      if (!a) throw new BadRequestException('Add a payout account before withdrawing');
      return a;
    });
  }

  listBanks(countryCode: string) {
    return this.banks.listBanks(countryCode);
  }

  async resolve(countryCode: string, bankCode: string, accountNumber: string) {
    this.assertSupported(countryCode);
    if (!isValidBankCode(bankCode)) throw new BadRequestException('Choose a bank');
    if (!isValidAccountNumber(accountNumber)) throw new BadRequestException('Account numbers are 10 digits');
    return this.banks.resolveAccount(bankCode, accountNumber);
  }

  async save(userId: string, countryCode: string, input: { bankCode: string; accountNumber: string; password: string }) {
    const country = this.assertSupported(countryCode);
    if (!isValidBankCode(input.bankCode)) throw new BadRequestException('Choose a bank');
    if (!isValidAccountNumber(input.accountNumber)) throw new BadRequestException('Account numbers are 10 digits');
    if (typeof input.password !== 'string' || !input.password) throw new BadRequestException('Enter your password to confirm');

    // Re-checking the password stops someone who has only borrowed an unlocked
    // phone or a live session from redirecting payouts.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) throw new ForbiddenException('Incorrect password');

    const existing = await this.prisma.payoutAccount.findUnique({ where: { userId } });
    if (existing) {
      const wait = cooldownRemainingMs(existing.updatedAt);
      if (wait > 0) {
        const hours = Math.ceil(wait / 3_600_000);
        throw new BadRequestException(`Your payout account was changed recently. You can change it again in about ${hours} hour${hours === 1 ? '' : 's'}.`);
      }
    }

    // The account name always comes from the bank lookup, never from the client.
    const banks = await this.banks.listBanks(countryCode);
    const bank = banks.find((b) => b.code === input.bankCode);
    if (!bank) throw new BadRequestException('Unknown bank');
    const { accountName } = await this.banks.resolveAccount(input.bankCode, input.accountNumber);
    const { recipientCode } = await this.banks.createRecipient({
      accountName,
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
      currencyCode: country.currency,
    });

    const data = {
      provider: this.banks.id,
      countryCode: countryCode.toUpperCase(),
      currencyCode: country.currency,
      bankCode: input.bankCode,
      bankName: bank.name,
      accountLast4: input.accountNumber.slice(-4),
      accountName,
      recipientCode,
    };
    const saved = await this.prisma.payoutAccount.upsert({ where: { userId }, update: data, create: { userId, ...data } });

    await this.audit.record({
      actorId: userId,
      action: existing ? 'payout_account.change' : 'payout_account.add',
      targetType: 'user',
      targetId: userId,
      metadata: { bankName: bank.name, accountLast4: data.accountLast4, previousLast4: existing?.accountLast4 ?? null } as any,
    });
    // A message to the account owner every time, so a hijacked session can't
    // change where money goes without the real person being told.
    await this.notifications.notify(userId, 'SECURITY', {
      event: existing ? 'payout_account_changed' : 'payout_account_added',
      bankName: bank.name,
      accountLast4: data.accountLast4,
    });
    return this.view(saved);
  }

  private assertSupported(countryCode: string) {
    const country = PAYSTACK_COUNTRIES[countryCode.toUpperCase()];
    if (!country) throw new BadRequestException('Bank payouts are not available in your country yet');
    return country;
  }
}
