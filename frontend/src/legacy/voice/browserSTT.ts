// src/legacy/voice/browserSTT.ts — Web Speech API recognition (Chrome, Edge, Safari).
//
// Runs in continuous mode and decides end-of-turn itself after a pause, because
// older speakers often pause mid-sentence and the browser's own endpointing
// cuts them off too early.

import { ListenHandlers, SpeechToTextProvider, VoiceError } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Recognition = any;

function ctor(): (new () => Recognition) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export class BrowserSpeechToText implements SpeechToTextProvider {
  readonly id = 'browser';
  readonly label = 'Browser speech recognition';
  readonly privacyNote = 'Your browser sends your speech to its own speech service (Google in Chrome, Apple in Safari).';

  private rec: Recognition | null = null;
  private active = false;
  private finalText = '';
  private interim = '';
  private endTimer: number | undefined;
  private handlers: ListenHandlers | null = null;
  private spoke = false;

  constructor(private lang: string, private endOfTurnMs = 1500) {}

  supported(): boolean {
    return !!ctor();
  }

  start(handlers: ListenHandlers): void {
    const C = ctor();
    if (!C) {
      handlers.onError(new VoiceError('unsupported', 'Speech recognition is not supported in this browser.'));
      return;
    }
    this.stop();
    this.handlers = handlers;
    this.active = true;
    this.finalText = '';
    this.interim = '';
    this.spoke = false;
    this.spawn(C);
  }

  private spawn(C: new () => Recognition) {
    const rec = new C();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += `${r[0].transcript} `;
        else interim += r[0].transcript;
      }
      this.interim = interim;
      const live = `${this.finalText}${interim}`.trim();
      if (live && !this.spoke) {
        this.spoke = true;
        this.handlers?.onSpeechStart?.();
      }
      this.handlers?.onInterim?.(live);
      this.armEndOfTurn();
    };

    rec.onerror = (e: any) => {
      const code: string = e.error;
      if (code === 'no-speech' || code === 'aborted') return; // onend restarts us
      this.active = false;
      const kind = code === 'not-allowed' || code === 'service-not-allowed' ? 'permission'
        : code === 'network' ? 'network' : 'service';
      const msg = kind === 'permission' ? 'Microphone access was blocked. Allow it in the address bar and try again.'
        : kind === 'network' ? 'The browser speech service is unreachable. Try the "Whisper (server)" listening mode.'
          : `Speech recognition error: ${code}`;
      this.handlers?.onError(new VoiceError(kind, msg));
    };

    // Browsers end recognition sessions on their own (≈60s, or after silence) — restart transparently.
    rec.onend = () => {
      if (this.active && this.rec === rec) {
        try { rec.start(); } catch { this.spawn(C); }
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.handlers?.onError(new VoiceError('unknown', `Could not start listening: ${(err as Error).message}`));
    }
  }

  private armEndOfTurn() {
    window.clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => {
      const text = `${this.finalText}${this.interim}`.trim();
      if (!text || !this.active) return;
      const h = this.handlers;
      this.stop();
      h?.onFinal(text);
    }, this.endOfTurnMs);
  }

  stop(): void {
    this.active = false;
    window.clearTimeout(this.endTimer);
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = null;
      try { rec.abort(); } catch { /* already stopped */ }
    }
  }
}
