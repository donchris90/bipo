import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import type { RtcProvider } from './rtc-provider.interface';

// Signature verified against node_modules/agora-token's actual .d.ts in
// this environment (RtcTokenBuilder/RtcRole are namespaces, not classes;
// tokenExpire/privilegeExpire are RELATIVE seconds-from-now, not absolute
// timestamps — easy to get backwards since some other token libraries use
// absolute Unix timestamps instead). Not verified against Agora's live
// token-issuing service or a real client SDK actually joining a channel
// with the generated token — this sandbox can't reach Agora's servers.
// Test with a real AGORA_APP_ID/AGORA_APP_CERTIFICATE and an actual client
// SDK before trusting this for a live stream.
const TOKEN_EXPIRE_SECONDS = 3600; // 1 hour — generous enough for a join, short enough that a leaked token doesn't stay valid indefinitely

@Injectable()
export class AgoraRtcProvider implements RtcProvider {
  constructor(private readonly config: ConfigService) {}

  private get appId(): string {
    const id = this.config.get<string>('AGORA_APP_ID');
    if (!id) throw new Error('AGORA_APP_ID is not configured');
    return id;
  }

  private get appCertificate(): string {
    const cert = this.config.get<string>('AGORA_APP_CERTIFICATE');
    if (!cert) throw new Error('AGORA_APP_CERTIFICATE is not configured');
    return cert;
  }

  async createChannel(sessionId: string) {
    // Agora has no server-side "create channel" API — channel names are
    // just app-chosen strings, ephemeral, existing only while someone is
    // joined. Deriving the name from sessionId keeps it stable and unique
    // per session without needing to store anything extra.
    return { channelName: `session_${sessionId}` };
  }

  async generateToken(channelName: string, userId: string, role: 'host' | 'audience'): Promise<string> {
    const rtcRole = role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    return RtcTokenBuilder.buildTokenWithUserAccount(
      this.appId,
      this.appCertificate,
      channelName,
      userId, // Agora's "user account" (string), not a numeric uid — avoids needing a separate uid-mapping table for our UUID user IDs
      rtcRole,
      TOKEN_EXPIRE_SECONDS,
      TOKEN_EXPIRE_SECONDS,
    );
  }

  async destroyChannel(): Promise<void> {
    // No explicit teardown call exists or is needed — an Agora channel
    // simply ceases to exist once the last participant leaves.
  }
}
