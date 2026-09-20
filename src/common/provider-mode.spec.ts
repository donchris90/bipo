import { ServiceUnavailableException } from '@nestjs/common';
import { isProduction } from './provider-mode';
import { UnavailablePaymentProvider } from '../economy/providers/payment-provider.interface';
import { UnavailablePayoutProvider } from '../creators/providers/payout-provider.interface';
import { UnavailableRtcProvider } from '../live/providers/rtc-provider.interface';
import { UnavailableStorageProvider } from '../videos/providers/storage-provider.interface';
import { UnavailableEmailProvider } from '../notifications/email/email-provider.interface';

describe('production never uses a pretend provider', () => {
  it('detects production from NODE_ENV', () => {
    expect(isProduction('production')).toBe(true);
    expect(isProduction('development')).toBe(false);
    expect(isProduction(undefined)).toBe(false);
  });

  it('every unavailable provider answers with a 503 instead of succeeding', async () => {
    await expect(new UnavailablePaymentProvider().verifyPayment()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new UnavailablePaymentProvider().createPayment()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new UnavailablePayoutProvider().initiatePayout()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new UnavailableRtcProvider().createChannel()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new UnavailableRtcProvider().generateToken()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new UnavailableStorageProvider().createUpload()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('the payout stand-in reports itself unconfigured so withdrawals are refused before any money is reserved', () => {
    expect(new UnavailablePayoutProvider().isConfigured).toBe(false);
  });

  it('production email reports "not sent" instead of pretending it was', async () => {
    expect(await new UnavailableEmailProvider().send()).toEqual({ sent: false });
  });
});
