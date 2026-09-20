import { mergeGiftPayload } from './notifications.service';

describe('mergeGiftPayload', () => {
  const sender = { senderId: 's1', senderDisplayName: 'Ada' };

  it('starts a fresh notification at one gift', () => {
    expect(mergeGiftPayload(null, sender, 50)).toEqual({
      senderId: 's1',
      senderDisplayName: 'Ada',
      count: 1,
      totalCoins: 50,
    });
  });

  it('folds further gifts into the running totals', () => {
    const first = mergeGiftPayload(null, sender, 50);
    const second = mergeGiftPayload(first, sender, 200);
    expect(second.count).toBe(2);
    expect(second.totalCoins).toBe(250);
  });

  it('tolerates an older payload missing the counters', () => {
    expect(mergeGiftPayload({ senderId: 's1' }, sender, 10)).toMatchObject({ count: 1, totalCoins: 10 });
  });
});
