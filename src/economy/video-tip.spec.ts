import { BadRequestException } from '@nestjs/common';
import { GiftController } from './economy.controller';

describe('tipping a video (POST /gifts/send with context VIDEO)', () => {
  const build = (video: any) => {
    const gifts: any = { send: jest.fn().mockResolvedValue({ id: 't1', coinAmount: 10 }) };
    const realtime: any = { broadcastGift: jest.fn(), broadcastPkScore: jest.fn() };
    const prisma: any = { video: { findUnique: jest.fn().mockResolvedValue(video) } };
    const ctl = new GiftController(gifts, realtime, prisma);
    const send = (over: any = {}) => ctl.send(over.recipientId ?? 'creator', 'g1', over.context ?? 'VIDEO', over.contextId ?? 'v1', undefined, 'key', { user: { userId: 'fan' } } as any);
    return { send, gifts, prisma };
  };
  const ok = { creatorId: 'creator', status: 'PUBLISHED', allowGifts: true };

  it('sends the tip to the video\'s creator with the video as context', async () => {
    const { send, gifts } = build(ok);
    await send();
    expect(gifts.send).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'fan', recipientId: 'creator', context: 'VIDEO', contextId: 'v1' }));
  });

  it('refuses a missing or removed video, a wrong recipient, and a video with tips turned off — before any coins move', async () => {
    for (const [video, over] of [[null, {}], [{ ...ok, status: 'REMOVED' }, {}], [ok, { recipientId: 'someone-else' }], [{ ...ok, allowGifts: false }, {}]] as const) {
      const { send, gifts } = build(video);
      await expect(send(over)).rejects.toBeInstanceOf(BadRequestException);
      expect(gifts.send).not.toHaveBeenCalled();
    }
  });

  it('rejects a made-up context', async () => {
    const { send, gifts } = build(ok);
    await expect(send({ context: 'DROP TABLE' })).rejects.toThrow(/context must be/);
    expect(gifts.send).not.toHaveBeenCalled();
  });
});
