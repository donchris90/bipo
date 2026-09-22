// The mobile app talks to the RTC provider directly for the actual media
// stream (spec §9) — the backend only manages the session record and issues
// join tokens. Swap MockRtcProvider for a real SDK client (Agora, LiveKit,
// 100ms) here; nothing in LiveService should need to change.
import { randomBytes } from 'crypto';
import { notConfigured } from '../../common/provider-mode';

export interface RtcProvider {
  createChannel(sessionId: string): Promise<{ channelName: string }>;
  generateToken(channelName: string, userId: string, role: 'host' | 'publisher' | 'audience'): Promise<string>;
  destroyChannel(channelName: string): Promise<void>;
}

// Used in production when Agora isn't configured: live sessions and party
// rooms can't be created (503), rather than being issued tokens no client can use.
export class UnavailableRtcProvider implements RtcProvider {
  async createChannel(): Promise<{ channelName: string }> {
    return notConfigured('Live video', 'set AGORA_APP_ID and AGORA_APP_CERTIFICATE');
  }
  async generateToken(): Promise<string> {
    return notConfigured('Live video', 'set AGORA_APP_ID and AGORA_APP_CERTIFICATE');
  }
  async destroyChannel(): Promise<void> {
    /* nothing was ever created */
  }
}

export class MockRtcProvider implements RtcProvider {
  async createChannel(sessionId: string) {
    return { channelName: `mock_${sessionId}` };
  }

  async generateToken(channelName: string, userId: string, role: 'host' | 'publisher' | 'audience') {
    // Dev-only opaque token. A real provider issues a signed, time-limited
    // token — never a value the client could forge or replay indefinitely.
    return `mocktoken_${channelName}_${userId}_${role}_${randomBytes(4).toString('hex')}`;
  }

  async destroyChannel(): Promise<void> {
    // no-op for the mock
  }
}
