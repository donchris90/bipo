import { ForbiddenException } from '@nestjs/common';
import { assertNotBlocked, isBlockedEitherWay } from './blocks';

const prismaWith = (existing: unknown) => {
  const findFirst = jest.fn().mockResolvedValue(existing);
  return { prisma: { block: { findFirst } }, findFirst };
};

describe('isBlockedEitherWay', () => {
  it('looks for a block in both directions', async () => {
    const { prisma, findFirst } = prismaWith(null);
    await isBlockedEitherWay(prisma, 'a', 'b');
    expect(findFirst.mock.calls[0][0].where.OR).toEqual([
      { blockerId: 'a', blockedId: 'b' },
      { blockerId: 'b', blockedId: 'a' },
    ]);
  });

  it('is true when a block row exists and false when none does', async () => {
    expect(await isBlockedEitherWay(prismaWith({ id: 'x' }).prisma, 'a', 'b')).toBe(true);
    expect(await isBlockedEitherWay(prismaWith(null).prisma, 'a', 'b')).toBe(false);
  });
});

describe('assertNotBlocked', () => {
  it('throws the given message, without saying who blocked whom', async () => {
    await expect(assertNotBlocked(prismaWith({ id: 'x' }).prisma, 'a', 'b', "You can't message this user")).rejects.toThrow(
      new ForbiddenException("You can't message this user"),
    );
  });

  it('passes silently when there is no block', async () => {
    await expect(assertNotBlocked(prismaWith(null).prisma, 'a', 'b', 'nope')).resolves.toBeUndefined();
  });
});
