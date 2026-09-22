import { ForbiddenException } from '@nestjs/common';

// Deliberately a plain function over the prisma client, not a service: it is
// needed by modules on both sides of the realtime/notifications dependency
// (messages, calls, PK, rooms, the socket gateway), and a shared service
// would have to sit in a module all of them import, which recreates the
// RealtimeModule <-> NotificationsModule cycle. PrismaModule is global, so a
// function needs no module wiring at all.
interface BlockReader {
  // Loosely typed on purpose: the generated Prisma delegate's method is
  // heavily generic, and all this needs is "something awaitable that returns
  // a row or null".
  block: { findFirst: (args: any) => any };
}

// True if EITHER user has blocked the other. Blocks are treated as mutual for
// anything interactive — the person who was blocked must not be able to
// reach the blocker, and the blocker doesn't want to be reachable by someone
// they blocked either.
export async function isBlockedEitherWay(prisma: BlockReader, a: string, b: string): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { id: true },
  });
  return !!block;
}

// Throws a deliberately generic error: it must not reveal WHICH side blocked,
// or a blocked user could confirm they had been blocked.
export async function assertNotBlocked(prisma: BlockReader, a: string, b: string, message: string): Promise<void> {
  if (await isBlockedEitherWay(prisma, a, b)) throw new ForbiddenException(message);
}
