import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';

// Split out of EconomyModule specifically so SeasonsModule can depend on WalletService (for
// settlement payouts) without depending on all of EconomyModule — which now, in turn, needs
// SeasonsService (GiftService's gift-sending-contributes-season-points hook). If SeasonsModule
// still imported EconomyModule directly, that would be a real cycle: EconomyModule -> SeasonsModule
// -> EconomyModule. WalletModule imports nothing, so this stays a plain import on both sides, no
// forwardRef — same reasoning as RoomCommunityModule being deliberately dependency-free for the
// same kind of reason (see its module file).
@Module({
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
