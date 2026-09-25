import { planStake } from './game-payout';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RoundService } from './round.service';
import { validateSelection as validateSumDiceSelection } from './sum-dice-rules';
import { planStakes, LuckyNumberConfig } from './lucky-number/lucky-number-math';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { WalletType, LedgerEntryType } from '@prisma/client';

@Injectable()
export class EntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly rounds: RoundService,
  ) {}

  async place(params: {
    userId: string;
    countryCode: string;
    roundId: string;
    selection: unknown;
    stakeAmount?: number; // required for variable-stake games (sum-dice, crash); ignored for fixed-price games like Lucky Number
    autoCashoutMultiplier?: number; // Crash only — ignored (but harmlessly stored) for other games
    useBonus?: boolean; // stake bonus coins first (default). Bonus coins can only ever be played, never withdrawn.
    idempotencyKey: string;
  }) {
    const existing = await this.prisma.gameEntry.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) return existing; // idempotent on retry — spec §69

    const round = await this.prisma.gameRound.findUnique({ where: { id: params.roundId } });
    if (!round) throw new NotFoundException('Round not found');

    await this.rounds.assertGameAvailable(round.gameCode, params.countryCode);
    await this.rounds.assertAcceptingEntries(round);
    this.validateSelection(round, params.selection);

    if (params.autoCashoutMultiplier != null) {
      if (typeof params.autoCashoutMultiplier !== 'number' || !Number.isFinite(params.autoCashoutMultiplier) || params.autoCashoutMultiplier <= 1) {
        throw new BadRequestException('autoCashoutMultiplier must be a number greater than 1');
      }
    }

    // Variable-stake rounds (selectionCount is null — sum-dice or crash,
    // see RoundService) let the player choose their own total stake;
    // round.entryPrice is repurposed as the minimum for those games, not a
    // fixed price. Every other game keeps the original fixed-price
    // behavior.
    const isVariableStake = round.selectionCount == null;
    let coinAmount = round.entryPrice;
    // What actually gets written to gameEntry.selection. Defaults to the
    // client's raw selection (existing sum-dice / fixed-price behavior);
    // RTP-mode dice below replaces this with a server-computed stake map.
    let selectionToStore: unknown = params.selection;

    // The admin's rulesJson, read live once here (rather than trusting a
    // cached copy) so a config change takes effect on the very next entry —
    // both the variable-stake maxStake check below and RTP mode need it.
    const game = isVariableStake
      ? await this.prisma.gameDefinition.findUnique({ where: { code: round.gameCode }, select: { rulesJson: true } })
      : null;
    const rules = (game?.rulesJson ?? {}) as Partial<LuckyNumberConfig> & { rtp?: number; maxStake?: number };

    if (isVariableStake && typeof rules.rtp === 'number') {
      // RTP mode ("Lucky Number" per-number stakes): the client sends WHICH
      // numbers it picked and, optionally, a desired TOTAL — never
      // individual per-number stakes. Accepting client-supplied per-number
      // amounts directly would let a player claim any split they like
      // (e.g. dumping the whole stake on the rarest, highest-multiplier
      // number while reporting a tiny total); instead the server is the
      // only thing that ever computes the stake map, from planStakes(),
      // exactly mirroring what the suggested-stakes endpoint and the
      // client's own display already show — see
      // lucky-number/lucky-number-math.ts and lucky-number.controller.ts.
      if (!Array.isArray(params.selection) || params.selection.length === 0) {
        throw new BadRequestException('selection must be a non-empty array of numbers');
      }
      const config: LuckyNumberConfig = {
        rtp: rules.rtp,
        basePrize: rules.basePrize ?? 1000,
        minStake: rules.minStake ?? round.entryPrice ?? 1,
        maxStake: rules.maxStake ?? 1_000_000_000,
        stakeWeightExponent: rules.stakeWeightExponent ?? 1,
      };
      let plan;
      try {
        plan = planStakes(params.selection as number[], config, params.stakeAmount);
      } catch (e: any) {
        throw new BadRequestException(e?.message ?? 'Invalid selection');
      }
      coinAmount = plan.total;
      selectionToStore = Object.fromEntries(plan.stakes); // object shape — this is what tells settlement to use settleLuckyNumber() instead of the equal-split sum-dice path
    } else if (isVariableStake) {
      if (typeof params.stakeAmount !== 'number' || !Number.isInteger(params.stakeAmount) || params.stakeAmount <= 0) {
        throw new BadRequestException('stakeAmount is required for this game and must be a positive integer');
      }
      if (params.stakeAmount < round.entryPrice) {
        throw new BadRequestException(`Minimum stake is ${round.entryPrice} coins`);
      }
      if (typeof rules.maxStake === 'number' && params.stakeAmount > rules.maxStake) {
        throw new BadRequestException(`Maximum stake is ${rules.maxStake} coins`);
      }
      coinAmount = params.stakeAmount;
    }

    // Debit and entry-creation must succeed or fail together — wrapping
    // both in one transaction and passing it through to wallet.debit()
    // closes the exact bug that was just found live: a debit that commits
    // successfully followed by a gameEntry.create() that then fails left
    // real money debited with no entry to show for it. Every other
    // service with this same "debit, then a second write" shape has the
    // identical exposure and should be fixed the same way — see the
    // comment on WalletService.credit() for why the parameter exists.
    // Bonus coins are staked first (unless the player opted out); the rest comes
    // from normal coins. What the entry wins is paid back in the same proportion
    // (see game-payout.ts), so bonus coins stay bonus coins.
    const funding = planStake(coinAmount, await this.wallet.getBalance(params.userId, WalletType.BONUS), params.useBonus !== false);

    return this.prisma.$transaction(async (tx) => {
      // Deduct the stake up front — this both enforces "cannot spend more
      // than available" and gives the round a settled pool to pay rewards
      // from.
      if (funding.bonus > 0) {
        await this.wallet.debit(
          {
            userId: params.userId,
            walletType: WalletType.BONUS,
            amount: BigInt(funding.bonus),
            ledgerType: LedgerEntryType.GAME_ENTRY,
            reference: params.roundId,
            idempotencyKey: `game_entry_bonus:${params.idempotencyKey}`,
          },
          tx,
        );
      }
      if (funding.coin > 0) {
        await this.wallet.debit(
          {
            userId: params.userId,
            walletType: WalletType.COIN,
            amount: BigInt(funding.coin),
            ledgerType: LedgerEntryType.GAME_ENTRY,
            reference: params.roundId,
            idempotencyKey: `game_entry:${params.idempotencyKey}`,
          },
          tx,
        );
      }

      return tx.gameEntry.create({
        data: {
          roundId: params.roundId,
          userId: params.userId,
          // Crash entries never send a selection (there's nothing to pick
          // — just a stake and an optional cash-out target), but the
          // schema field is required, not nullable. Defaulting to []
          // avoids a schema migration for what's genuinely "no
          // selection," not a missing one. RTP-mode dice stores the
          // server-computed per-number stake map here (see above), not
          // the client's raw picks.
          selection: (selectionToStore ?? []) as any,
          coinAmount,
          bonusAmount: funding.bonus,
          autoCashoutMultiplier: params.autoCashoutMultiplier,
          idempotencyKey: params.idempotencyKey,
        },
      });
    }, EXTENDED_TX_OPTIONS);
  }

  private validateSelection(round: { numberRange: number | null; selectionCount: number | null }, selection: unknown) {
    // Dispatch by shape rather than gameCode string — selectionCount set
    // means a fixed-count exact-match game (Lucky Number); null means a
    // variable-selection sum-dice game (see RoundService.createRound,
    // which is what actually decides this per round). A third game would
    // need a real strategy map instead of this if/else; two is still
    // simple enough to read directly.
    if (round.numberRange && round.selectionCount) {
      if (!Array.isArray(selection)) throw new BadRequestException('Selection must be an array of numbers');
      if (selection.length !== round.selectionCount) {
        throw new BadRequestException(`Must select exactly ${round.selectionCount} number(s)`);
      }
      for (const n of selection) {
        if (typeof n !== 'number' || n < 1 || n > round.numberRange) {
          throw new BadRequestException(`Numbers must be between 1 and ${round.numberRange}`);
        }
      }
      if (new Set(selection).size !== selection.length) {
        throw new BadRequestException('Selection must not contain duplicates');
      }
    } else if (round.numberRange != null) {
      const result = validateSumDiceSelection(selection, round.numberRange);
      if (!result.valid) throw new BadRequestException(result.error);
    }
  }
}
