// src/legacy/voice/types.ts — provider interfaces for the live call.
//
// The call logic (useVoiceCall) only talks to these interfaces, so a new
// listener (e.g. Deepgram streaming) or voice (e.g. ElevenLabs clone) is one
// new file plus a line in ./index.ts — the conversation code doesn't change.

export interface ListenHandlers {
  /** User started speaking (used for barge-in and silence timers). */
  onSpeechStart?: () => void;
  /** Live partial transcript, for captions. */
  onInterim?: (text: string) => void;
  /** User finished a turn. */
  onFinal: (text: string) => void;
  onError: (err: VoiceError) => void;
  /** Microphone input level 0..1 when the provider can measure it. */
  onLevel?: (level: number) => void;
}

export interface SpeechToTextProvider {
  readonly id: string;
  readonly label: string;
  /** Where audio goes — shown to users for privacy. */
  readonly privacyNote: string;
  supported(): boolean;
  start(handlers: ListenHandlers): void;
  stop(): void;
}

export interface SpeakHandlers {
  onStart?: () => void;
  onEnd?: () => void;
  /** Pulses while audio plays, for the speaking visualizer (0..1). */
  onLevel?: (level: number) => void;
  onError?: (err: VoiceError) => void;
}

export interface TextToSpeechProvider {
  readonly id: string;
  readonly label: string;
  /** True for any synthetic voice — drives the "not their real voice" label. */
  readonly isSynthetic: boolean;
  supported(): boolean;
  /** Call synchronously inside a user gesture (Safari/iOS autoplay rules). */
  unlock(): void;
  /** Queue one chunk (usually a sentence). Chunks play in order. */
  enqueue(text: string): void;
  /** Resolves when everything queued so far has finished playing. */
  drain(): Promise<void>;
  /** Stop immediately and clear the queue (interruption). */
  cancel(): void;
  setHandlers(h: SpeakHandlers): void;
}

export type VoiceErrorKind = 'permission' | 'unsupported' | 'network' | 'no-speech' | 'service' | 'unknown';

export class VoiceError extends Error {
  constructor(public kind: VoiceErrorKind, message: string) { super(message); }
}
