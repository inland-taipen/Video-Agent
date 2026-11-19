// src/legacy/voice/browserTTS.ts — window.speechSynthesis voice (temporary; NOT the person's voice).

import { SpeakHandlers, TextToSpeechProvider, VoiceError } from './types';

export interface BrowserVoiceSettings { voiceURI?: string; rate?: number; pitch?: number }

export function listBrowserVoices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
}

/** Voices load asynchronously in Chrome. */
export function onVoicesChanged(cb: () => void): () => void {
  if (typeof speechSynthesis === 'undefined') return () => undefined;
  speechSynthesis.addEventListener('voiceschanged', cb);
  return () => speechSynthesis.removeEventListener('voiceschanged', cb);
}

function pickVoice(lang: string, voiceURI?: string): SpeechSynthesisVoice | null {
  const voices = listBrowserVoices();
  if (voiceURI) {
    const v = voices.find((x) => x.voiceURI === voiceURI);
    if (v) return v;
  }
  const base = lang.split('-')[0];
  return voices.find((v) => v.lang === lang && v.localService)
    || voices.find((v) => v.lang === lang)
    || voices.find((v) => v.lang.startsWith(base))
    || voices.find((v) => v.default) || null;
}

export class BrowserTextToSpeech implements TextToSpeechProvider {
  readonly id = 'browser';
  readonly label = 'Browser voice';
  readonly isSynthetic = true;

  private queue: SpeechSynthesisUtterance[] = [];
  private speaking = false;
  private handlers: SpeakHandlers = {};
  private waiters: (() => void)[] = [];
  private keepAlive = 0;

  constructor(private lang: string, private settings: BrowserVoiceSettings = {}) {}

  supported(): boolean {
    return typeof speechSynthesis !== 'undefined';
  }

  setHandlers(h: SpeakHandlers) { this.handlers = h; }

  unlock(): void {
    if (!this.supported()) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  enqueue(text: string): void {
    const clean = text.replace(/[*_#`]/g, '').trim();
    if (!clean || !this.supported()) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = this.lang;
    const v = pickVoice(this.lang, this.settings.voiceURI);
    if (v) u.voice = v;
    u.rate = this.settings.rate ?? 0.92;   // a little slower: warmer, easier for elders to follow
    u.pitch = this.settings.pitch ?? 0.95;
    u.onstart = () => {
      if (!this.speaking) {
        this.speaking = true;
        this.handlers.onStart?.();
      }
    };
    u.onboundary = () => this.handlers.onLevel?.(0.55 + Math.random() * 0.45);
    u.onend = () => this.next(u);
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        this.handlers.onError?.(new VoiceError('service', `Voice playback failed: ${e.error}`));
      }
      this.next(u);
    };
    this.queue.push(u);
    speechSynthesis.speak(u);
    // Chrome stops long speech after ~15s unless nudged.
    window.clearInterval(this.keepAlive);
    this.keepAlive = window.setInterval(() => {
      if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); speechSynthesis.resume(); }
    }, 10_000);
  }

  private next(u: SpeechSynthesisUtterance) {
    this.queue = this.queue.filter((x) => x !== u);
    if (this.queue.length === 0) this.finish();
  }

  private finish() {
    window.clearInterval(this.keepAlive);
    if (this.speaking) {
      this.speaking = false;
      this.handlers.onEnd?.();
    }
    const w = this.waiters;
    this.waiters = [];
    w.forEach((fn) => fn());
  }

  drain(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  cancel(): void {
    this.queue.forEach((u) => { u.onend = null; u.onerror = null; u.onstart = null; u.onboundary = null; });
    this.queue = [];
    if (this.supported()) speechSynthesis.cancel();
    this.finish();
  }
}
