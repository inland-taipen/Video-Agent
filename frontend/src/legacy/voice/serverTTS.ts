// src/legacy/voice/serverTTS.ts — plays audio synthesised by the backend (/speak).
//
// DEFERRED: used when a persona's voice_provider is a server-side provider
// such as ElevenLabs. Plumbed end-to-end but off until a provider is enabled.

import { fetchSpeech } from '../api';
import { SpeakHandlers, TextToSpeechProvider, VoiceError } from './types';

export class ServerTextToSpeech implements TextToSpeechProvider {
  readonly id: string;
  readonly label: string;
  readonly isSynthetic = true;

  private audio = new Audio();
  private pending: Promise<Blob>[] = [];
  private playing = false;
  private handlers: SpeakHandlers = {};
  private waiters: (() => void)[] = [];
  private abort = new AbortController();
  private pulse = 0;

  constructor(private personaId: string, provider: string) {
    this.id = provider;
    this.label = `${provider} voice`;
  }

  supported() { return true; }
  setHandlers(h: SpeakHandlers) { this.handlers = h; }

  unlock() {
    this.audio.muted = true;
    this.audio.play().catch(() => undefined).finally(() => { this.audio.pause(); this.audio.muted = false; });
  }

  enqueue(text: string) {
    // Fetch immediately (in parallel) but play strictly in order.
    this.pending.push(fetchSpeech(this.personaId, text, this.abort.signal));
    if (!this.playing) void this.pump();
  }

  private async pump() {
    this.playing = true;
    let started = false;
    while (this.pending.length) {
      const next = this.pending[0];
      let url = '';
      try {
        url = URL.createObjectURL(await next);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') this.handlers.onError?.(new VoiceError('service', (err as Error).message));
        this.pending.shift();
        continue;
      }
      if (!started) { started = true; this.handlers.onStart?.(); }
      this.pulse = window.setInterval(() => this.handlers.onLevel?.(0.5 + Math.random() * 0.5), 120);
      await new Promise<void>((res) => {
        this.audio.onended = this.audio.onerror = () => res();
        this.audio.src = url;
        this.audio.play().catch(() => res());
      });
      window.clearInterval(this.pulse);
      URL.revokeObjectURL(url);
      this.pending.shift();
    }
    this.playing = false;
    if (started) this.handlers.onEnd?.();
    const w = this.waiters; this.waiters = []; w.forEach((f) => f());
  }

  drain(): Promise<void> {
    if (!this.playing && !this.pending.length) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  cancel() {
    this.abort.abort();
    this.abort = new AbortController();
    this.pending = [];
    this.audio.pause();
    this.audio.onended?.(new Event('ended'));
    window.clearInterval(this.pulse);
  }
}
