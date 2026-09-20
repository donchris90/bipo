import { BadRequestException } from '@nestjs/common';
import { describeForPush } from './push-messages';
import { ExpoPushProvider, chunk } from './push-provider';
import { PushService, isExpoPushToken } from './push.service';

describe('describeForPush', () => {
  it('words each type and never includes message text', () => {
    expect(describeForPush('MESSAGE', { content: 'secret' }, { sender: 'Ada' })).toEqual({
      title: 'New message',
      body: 'Ada sent you a message',
    });
    expect(describeForPush('GIFT_RECEIVED', { senderDisplayName: 'Ada', totalCoins: 1500 })?.body).toBe(
      'Ada sent you a gift worth 1,500 coins',
    );
    expect(describeForPush('PK_RESULT', { result: 'WIN', opponentDisplayName: 'Bo' })?.body).toBe('You won your PK battle against Bo');
    expect(describeForPush('WITHDRAWAL_UPDATE', { status: 'PAID', amountCoins: 500 })?.title).toBe('Withdrawal paid');
  });

  it('keeps SYSTEM and unknown types off the lock screen', () => {
    expect(describeForPush('SYSTEM')).toBeNull();
    expect(describeForPush('SOMETHING_NEW')).toBeNull();
  });
});

describe('chunk', () => {
  it('splits into provider-sized batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
  });
});

describe('isExpoPushToken', () => {
  it('accepts Expo tokens and rejects everything else', () => {
    expect(isExpoPushToken('ExponentPushToken[abc123]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc123]')).toBe(true);
    expect(isExpoPushToken('fcm:abc')).toBe(false);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
    expect(isExpoPushToken(undefined)).toBe(false);
  });
});

describe('PushService', () => {
  const build = (send = jest.fn().mockResolvedValue({ invalidTokens: [] })) => {
    const prisma: any = {
      pushToken: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ token: 'ExponentPushToken[a]' }, { token: 'ExponentPushToken[b]' }]),
      },
    };
    return { svc: new PushService(prisma, { send }), prisma, send };
  };

  it('rejects a malformed token', async () => {
    await expect(build().svc.register('u1', 'nope', 'ios')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('registers by token so a device that changes account moves to the new user', async () => {
    const { svc, prisma } = build();
    await svc.register('u2', 'ExponentPushToken[a]', 'android');
    expect(prisma.pushToken.upsert.mock.calls[0][0].where).toEqual({ token: 'ExponentPushToken[a]' });
    expect(prisma.pushToken.upsert.mock.calls[0][0].update.userId).toBe('u2');
  });

  it("scopes unregister to the caller's own tokens", async () => {
    const { svc, prisma } = build();
    await svc.unregister('u1', 'ExponentPushToken[a]');
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', token: 'ExponentPushToken[a]' } });
  });

  it('sends to every device and prunes tokens the provider reports dead', async () => {
    const { svc, prisma, send } = build(jest.fn().mockResolvedValue({ invalidTokens: ['ExponentPushToken[b]'] }));
    await svc.sendToUser('u1', { title: 't', body: 'b' });
    expect(send.mock.calls[0][0]).toHaveLength(2);
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ['ExponentPushToken[b]'] } } });
  });

  it('never throws when the provider fails', async () => {
    const { svc } = build(jest.fn().mockRejectedValue(new Error('boom')));
    await expect(svc.sendToUser('u1', { title: 't', body: 'b' })).resolves.toBeUndefined();
  });
});

describe('ExpoPushProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reports only DeviceNotRegistered tickets as dead tokens, matched by position', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { status: 'ok', id: '1' },
          { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
        ],
      }),
    }) as any;

    const result = await new ExpoPushProvider().send([
      { to: 'ExponentPushToken[a]', title: 't', body: 'b' },
      { to: 'ExponentPushToken[b]', title: 't', body: 'b' },
      { to: 'ExponentPushToken[c]', title: 't', body: 'b' },
    ]);
    expect(result.invalidTokens).toEqual(['ExponentPushToken[b]']);
  });

  it('survives a network failure without throwing', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as any;
    await expect(new ExpoPushProvider().send([{ to: 'ExponentPushToken[a]', title: 't', body: 'b' }])).resolves.toEqual({
      invalidTokens: [],
    });
  });

  it('sends the access token when one is configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) });
    global.fetch = fetchMock as any;
    await new ExpoPushProvider('secret').send([{ to: 'ExponentPushToken[a]', title: 't', body: 'b' }]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });
});
