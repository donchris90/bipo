import { describeForPush } from './push-messages';

describe('security push messages', () => {
  it('describes identity results and payout-account changes', () => {
    expect(describeForPush('SECURITY' as any, { event: 'kyc_approved' })?.title).toBe('Identity verified');
    expect(describeForPush('SECURITY' as any, { event: 'kyc_rejected', reason: 'Blurry selfie' })?.body).toContain('Blurry selfie');
    const changed = describeForPush('SECURITY' as any, { event: 'payout_account_changed', bankName: 'GTBank', accountLast4: '1234' });
    expect(changed?.body).toContain('GTBank ••••1234');
    expect(changed?.body).toContain("wasn't you");
  });

  it('keeps a generic message for any other security event', () => {
    expect(describeForPush('SECURITY' as any, {})?.title).toBe('Security alert');
  });
});
