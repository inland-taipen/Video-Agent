// src/legacy/voice/whisperSTT.ts — record a turn locally, transcribe on the server (Groq Whisper).
//
// Works in browsers without Web Speech recognition (Firefox) and keeps audio
// off third-party browser services. A simple energy-based voice activity
// detector decides when the user starts and stops talking.

import { api } from '../api';
import { MicMeter } from './micLevel';
import { ListenHandlers, SpeechToTextProvider, VoiceError } from './types';

const START_LEVEL = 0.06;     // RMS needed to count as speech
const START_MS = 180;         // …sustained this long
const END_SILENCE_MS = 1600;  // pause that ends a turn
const MAX_TURN_MS = 45_000;

function pickMime(): string {
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class WhisperSpeechToText implements SpeechToTextProvider {
  readonly id = 'whisper';
  readonly label = 'Whisper (server)';
  readonly privacyNote = 'Your speech is sent to this app’s server and transcribed by Groq Whisper.';

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private active = false;
  private timer = 0;
  private abort: AbortController | null = null;

  constructor(private mic: MicMeter, private language: string) {}

  supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  start(h: ListenHandlers): void {
    this.stop();
    this.active = true;
    this.mic.open().then((stream) => {
      if (!this.active) return;
      this.loop(stream, h);
    }).catch(() => h.onError(new VoiceError('permission', 'Microphone access was blocked. Allow it in the address bar and try again.')));
  }

  private loop(stream: MediaStream, h: ListenHandlers) {
    let loudSince = 0, quietSince = 0, speaking = false, turnStart = 0;
    const mime = pickMime();

    const beginRecording = () => {
      this.chunks = [];
      try {
        this.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch {
        h.onError(new VoiceError('unsupported', 'This browser cannot record audio.'));
        return;
      }
      this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      this.recorder.start(250);
    };

    const finish = () => {
      const rec = this.recorder;
      this.recorder = null;
      this.active = false;
      window.clearInterval(this.timer);
      if (!rec) return;
      rec.onstop = async () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        h.onInterim?.('…');
        this.abort = new AbortController();
        try {
          const { text } = await api.stt(blob, this.language, this.abort.signal);
          if (text.trim()) h.onFinal(text.trim());
          else h.onError(new VoiceError('no-speech', 'I didn’t catch that.'));
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          h.onError(new VoiceError('service', (err as Error).message));
        }
      };
      rec.stop();
    };

    // Pre-roll: record continuously so the first syllable isn't lost.
    beginRecording();
    this.timer = window.setInterval(() => {
      if (!this.active) return;
      const level = this.mic.level();
      h.onLevel?.(level);
      const now = performance.now();
      if (level > START_LEVEL) {
        quietSince = 0;
        if (!loudSince) loudSince = now;
        if (!speaking && now - loudSince > START_MS) {
          speaking = true;
          turnStart = now;
          h.onSpeechStart?.();
          h.onInterim?.('Listening…');
        }
      } else {
        loudSince = 0;
        if (!quietSince) quietSince = now;
        if (!speaking && now - quietSince > 4000 && this.recorder) {
          // Long silence before speech — restart recorder to keep clips short.
          this.recorder.ondataavailable = null;
          try { this.recorder.stop(); } catch { /* ignore */ }
          beginRecording();
          quietSince = now;
        }
      }
      if (speaking && ((quietSince && now - quietSince > END_SILENCE_MS) || now - turnStart > MAX_TURN_MS)) {
        finish();
      }
    }, 50);
  }

  stop(): void {
    this.active = false;
    window.clearInterval(this.timer);
    this.abort?.abort();
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      try { this.recorder.stop(); } catch { /* ignore */ }
      this.recorder = null;
    }
  }
}
