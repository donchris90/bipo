# Admin-editable referral reward (+ referral response fix)

Copy into backend/ (overwrite):
- prisma/schema.prisma  (adds model ReferralConfig; if you have other schema edits, add just that model)
- prisma/migrations/20261010090000_configurable_referral_reward/
- src/referral-config/* (new: service, controller, module, spec)
- src/auth/auth.service.ts, src/auth/auth.module.ts
- src/users/users.service.ts, src/users/users.module.ts, src/users/referrals.spec.ts
- src/app.module.ts

DELETE (stale, unimported):
- src/economy/auth.service.ts
- src/economy/users.service.ts

Then: npx prisma migrate deploy && npx prisma generate && npx tsc --noEmit && npx jest referral

API (FINANCE_ADMIN / SUPER_ADMIN):
- GET /api/v1/admin/referral-config
- PUT /api/v1/admin/referral-config  { "rewardCoins": 150 }   (0 disables; max 100000)
Reward is always credited to the BONUS wallet. Default 100 = unchanged behaviour.
