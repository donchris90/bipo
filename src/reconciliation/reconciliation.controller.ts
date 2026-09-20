import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName } from '@prisma/client';
import { WalletReconciliation } from './reconciliation-rules';

// BigInt doesn't serialize via JSON.stringify — every response here
// converts to string explicitly, the same pattern WalletController.balances
// already uses. Forgetting this crashes the response at serialization time,
// not at the point you'd notice while writing the handler.
function toResponse(r: WalletReconciliation) {
  return {
    walletId: r.walletId,
    ledgerSum: r.ledgerSum.toString(),
    walletBalance: r.walletBalance.toString(),
    discrepancy: r.discrepancy.toString(),
    ok: r.ok,
  };
}

@Controller('api/v1/admin/reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.FINANCE_ADMIN, RoleName.SUPER_ADMIN)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  async checkAll() {
    const { checked, discrepancies } = await this.reconciliation.checkAll();
    return { checked, discrepancyCount: discrepancies.length, discrepancies: discrepancies.map(toResponse) };
  }

  @Get(':walletId')
  async checkOne(@Param('walletId') walletId: string) {
    return toResponse(await this.reconciliation.checkWallet(walletId));
  }
}
