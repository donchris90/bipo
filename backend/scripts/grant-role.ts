// Give (or take away) an admin role for an existing user.
//
//   npx ts-node scripts/grant-role.ts ada@example.com FINANCE_ADMIN
//   npx ts-node scripts/grant-role.ts ada@example.com FINANCE_ADMIN --revoke
//
// Roles: SUPER_ADMIN, FINANCE_ADMIN, TRUST_SAFETY_ADMIN, GAME_OPERATOR
// The person must already have registered. They need to sign in again for the
// new role to appear (roles are read when a session is created).
import { PrismaClient, RoleName } from '@prisma/client';

const ADMIN_ROLES: RoleName[] = [RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN, RoleName.TRUST_SAFETY_ADMIN, RoleName.GAME_OPERATOR];

async function main() {
  const [email, roleArg, flag] = process.argv.slice(2);
  const role = ADMIN_ROLES.find((r) => r === roleArg);
  if (!email || !role) {
    console.error(`Usage: ts-node scripts/grant-role.ts <email> <${ADMIN_ROLES.join('|')}> [--revoke]`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user with email ${email}. They need to register first.`);
      process.exit(1);
    }

    if (flag === '--revoke') {
      const { count } = await prisma.userRole.deleteMany({ where: { userId: user.id, role } });
      console.log(count ? `Removed ${role} from ${email}.` : `${email} did not have ${role}.`);
    } else {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: user.id, role } },
        update: {},
        create: { userId: user.id, role },
      });
      console.log(`${email} now has ${role}. They must sign in again to pick it up.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
