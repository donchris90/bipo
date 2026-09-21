import { GiftService } from './gift.service';
import { WalletService } from './wallet.service';
import { RevenueSplitService } from './revenue-split.service';
import { FakePrisma } from '../test-utils/fake-prisma';
import { WalletType } from '@prisma/client';

// Same caveat as wallet.service.spec.ts: not runnable in the sandbox this
// was written in due to the blocked `prisma generate` step. Run
// `npx prisma generate` first.
describe('GiftService', () => {
  function makeService() {
    const prisma = new FakePrisma();
    const wallet = new WalletService(prisma as any);
    const revenueSplit = new RevenueSplitService(prisma as any);
    const gifts = new GiftService(prisma as any, wallet, revenueSplit);

    prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
    prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
    prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });

    return { prisma, wallet, gifts };
  }

  it('debits the sender, credits the recipient their share, and records the platform share (default 70/30 fallback)', async () => {
    const { prisma, wallet, gifts } = makeService();
    await wallet.credit({
      userId: 'sender',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: 'BONUS' as any,
      idempotencyKey: 'seed',
    });

    await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-key-000000000001' });

    expect(await wallet.getBalance('sender', WalletType.COIN)).toBe(0n);
    expect(await wallet.getBalance('recipient', WalletType.CREATOR_EARNINGS)).toBe(70n);
    const tx = prisma.giftTransactions.get('gift-key-000000000001');
    expect(tx).toMatchObject({
      coinAmount: 100,
      creatorShareCoins: 70,
      platformShareCoins: 30,
      agencyShareCoins: 0,
      creatorShareBps: 7000,
      platformShareBps: 3000,
      agencyCommissionBps: 0,
    });
  });

  it('rejects sending a gift to yourself', async () => {
    const { gifts } = makeService();
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'sender', giftId: 'rose', idempotencyKey: 'gift-key-000000000002' }),
    ).rejects.toThrow('Cannot send a gift to yourself');
  });

  it('throws on insufficient balance and does not create a gift transaction', async () => {
    const { prisma, gifts } = makeService();
    // sender has 0 coins — no credit() call
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-key-000000000003' }),
    ).rejects.toThrow('Insufficient balance');
    expect(prisma.giftTransactions.get('gift-key-000000000003')).toBeUndefined();
  });

  it('is idempotent: retrying the same key does not double-charge the sender', async () => {
    const { prisma, wallet, gifts } = makeService();
    await wallet.credit({
      userId: 'sender',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: 'BONUS' as any,
      idempotencyKey: 'seed',
    });

    const first = await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-key-000000000004' });
    const second = await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-key-000000000004' });

    expect(second).toEqual(first);
    expect(await wallet.getBalance('sender', WalletType.COIN)).toBe(0n); // spent once, not twice
  });

  it('rejects sending an inactive or unknown gift', async () => {
    const { prisma, gifts } = makeService();
    prisma.gifts.set('retired', { id: 'retired', coinPrice: 50, active: false });
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'retired', idempotencyKey: 'gift-key-000000000005' }),
    ).rejects.toThrow('Gift not available');
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'does-not-exist', idempotencyKey: 'gift-key-000000000006' }),
    ).rejects.toThrow('Gift not available');
  });

  it('routes a commission to the agency owner when the recipient has an active agency membership', async () => {
    const { prisma, wallet, gifts } = makeService();
    prisma.agencies.set('agency-1', { id: 'agency-1', ownerId: 'agency-owner', status: 'APPROVED' });
    prisma.agencyMemberships.set('recipient', {
      agencyId: 'agency-1',
      creatorId: 'recipient',
      commissionBps: 2000, // 20% of the creator's pool
      status: 'ACTIVE',
    });
    await wallet.credit({
      userId: 'sender',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: 'BONUS' as any,
      idempotencyKey: 'seed',
    });

    await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-key-000000000007' });

    // 100 coins, 70% creator pool = 70. 20% agency commission of that pool = 14.
    expect(await wallet.getBalance('recipient', WalletType.CREATOR_EARNINGS)).toBe(56n);
    expect(await wallet.getBalance('agency-owner', WalletType.AGENCY_EARNINGS)).toBe(14n);
  });
});

describe('gifts do not create notifications', () => {
  it('a successful gift never calls the notification service (no inbox item, no phone push)', async () => {
    const prisma = new FakePrisma();
    const wallet = new WalletService(prisma as any);
    const notifications: any = { notifyGift: jest.fn(), notify: jest.fn(), notifyOnce: jest.fn() };
    const gifts = new GiftService(prisma as any, wallet, new RevenueSplitService(prisma as any), notifications);
    prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
    prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
    prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });
    await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

    await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-key-notify-0001' });

    expect(notifications.notifyGift).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(notifications.notifyOnce).not.toHaveBeenCalled();
    // ...while the money still moves exactly as before
    expect(await wallet.getBalance('recipient', WalletType.CREATOR_EARNINGS)).toBe(70n);
  });
});
