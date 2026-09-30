import { PkService } from './pk.service';
import { WalletService } from '../economy/wallet.service';
import { FakePrisma } from '../test-utils/fake-prisma';
import { WalletType } from '@prisma/client';

function service(prisma: FakePrisma, withWallet = true) {
  const wallet = withWallet ? new WalletService(prisma as any) : undefined;
  const svc = new (PkService as any)(prisma, {}, { emitToUser: () => {} }, { notify: async () => {}, notifyOnce: async () => {} }, undefined, undefined, wallet);
  return { svc, wallet };
}

describe('PkService.payWinnerReward', () => {
  // WalletService is used for real here, not faked — proves this is an actual balance-affecting
  // credit, not just a flag being set.
  it("credits the winner's wallet and marks the battle as paid", async () => {
    const prisma = new FakePrisma();
    prisma.pkBattles.set('battle-1', { id: 'battle-1', rewardCoinsPaid: false });
    const { svc, wallet } = service(prisma);

    await (svc as any).payWinnerReward('battle-1', 'winner-1');

    expect(prisma.pkBattles.get('battle-1').rewardCoinsPaid).toBe(true);
    expect(await wallet!.getBalance('winner-1', WalletType.BONUS)).toBe(500n);
  });

  it('pays nothing on a draw (winnerId is null) and does not mark the battle as paid', async () => {
    const prisma = new FakePrisma();
    prisma.pkBattles.set('battle-1', { id: 'battle-1', rewardCoinsPaid: false });
    const { svc } = service(prisma);

    await (svc as any).payWinnerReward('battle-1', null);

    expect(prisma.pkBattles.get('battle-1').rewardCoinsPaid).toBe(false);
  });

  it('never pays twice — a retried settle (or settleIfDue racing a forfeit) is a safe no-op the second time', async () => {
    const prisma = new FakePrisma();
    prisma.pkBattles.set('battle-1', { id: 'battle-1', rewardCoinsPaid: false });
    const { svc, wallet } = service(prisma);

    await (svc as any).payWinnerReward('battle-1', 'winner-1');
    await (svc as any).payWinnerReward('battle-1', 'winner-1'); // same battle, called again

    expect(await wallet!.getBalance('winner-1', WalletType.BONUS)).toBe(500n); // not 1000n
  });

  it('does nothing if WalletService is absent — never blocks settlement over a missing optional dependency', async () => {
    const prisma = new FakePrisma();
    prisma.pkBattles.set('battle-1', { id: 'battle-1', rewardCoinsPaid: false });
    const { svc } = service(prisma, false);

    await expect((svc as any).payWinnerReward('battle-1', 'winner-1')).resolves.toBeUndefined();
    expect(prisma.pkBattles.get('battle-1').rewardCoinsPaid).toBe(false); // never claimed the flag since it never paid
  });

  it('two different winners on two different battles are paid independently', async () => {
    const prisma = new FakePrisma();
    prisma.pkBattles.set('battle-1', { id: 'battle-1', rewardCoinsPaid: false });
    prisma.pkBattles.set('battle-2', { id: 'battle-2', rewardCoinsPaid: false });
    const { svc, wallet } = service(prisma);

    await (svc as any).payWinnerReward('battle-1', 'winner-a');
    await (svc as any).payWinnerReward('battle-2', 'winner-b');

    expect(await wallet!.getBalance('winner-a', WalletType.BONUS)).toBe(500n);
    expect(await wallet!.getBalance('winner-b', WalletType.BONUS)).toBe(500n);
  });
});
