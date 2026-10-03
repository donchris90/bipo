export type MediaModerationSource = 'AUDIO_TRANSCRIPT' | 'VIDEO_FRAME' | 'VIDEO_STREAM';

export interface MediaModerationSignal {
  context: 'LIVE' | 'ROOM';
  contextId: string;
  subjectUserId: string;
  source: MediaModerationSource;
  category: string;
  confidence?: number;
  provider?: string;
  providerEventId?: string;
}

/**
 * Providers (speech-to-text or computer vision) should emit this contract.
 * The backend policy engine remains authoritative; providers only detect.
 */
export interface LiveMediaModerationProvider {
  name: string;
  analyzeAudioTranscript?(transcript: string, context: { context: 'LIVE' | 'ROOM'; contextId: string; subjectUserId: string }): Promise<MediaModerationSignal[]>;
  analyzeVideoFrame?(frameReference: string, context: { context: 'LIVE' | 'ROOM'; contextId: string; subjectUserId: string }): Promise<MediaModerationSignal[]>;
}
