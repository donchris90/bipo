import { ForbiddenException } from '@nestjs/common';
import { MessagesService } from './messages.service';

function build(blocked: boolean) {
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'bob' }) },
    block: { findFirst: jest.fn().mockResolvedValue(blocked ? { id: 'blk' } : null) },
    directMessage: {
      create: jest.fn().mockResolvedValue({ id: 'm1', senderId: 'alice', recipientId: 'bob', content: 'hi' }),
    },
  };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const realtime: any = { emitToUser: jest.fn() };
  return { svc: new MessagesService(prisma, notifications, realtime), prisma, notifications, realtime };
}

describe('MessagesService.send and blocks', () => {
  it('refuses to send when a block exists, and stores / pushes / notifies nothing', async () => {
    const { svc, prisma, notifications, realtime } = build(true);
    await expect(svc.send('alice', 'bob', 'hi')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.directMessage.create).not.toHaveBeenCalled();
    expect(realtime.emitToUser).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('sends normally when there is no block', async () => {
    const { svc, prisma, realtime } = build(false);
    await svc.send('alice', 'bob', 'hi');
    expect(prisma.directMessage.create).toHaveBeenCalledTimes(1);
    expect(realtime.emitToUser).toHaveBeenCalledWith('bob', 'dm:message', expect.anything());
  });
});
