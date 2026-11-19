// src/legacy/voice/index.ts — provider registry. Add new providers here.

import { BrowserSpeechToText } from './browserSTT';
import { BrowserTextToSpeech, BrowserVoiceSettings } from './browserTTS';
import { MicMeter } from './micLevel';
import { ServerTextToSpeech } from './serverTTS';
import { SpeechToTextProvider, TextToSpeechProvider } from './types';
import { WhisperSpeechToText } from './whisperSTT';

export type ListenMode = 'browser' | 'whisper';

export function createListener(mode: ListenMode, lang: string, mic: MicMeter): SpeechToTextProvider {
  const browser = new BrowserSpeechToText(lang);
  if (mode === 'browser' && browser.supported()) return browser;
  return new WhisperSpeechToText(mic, lang);
}

export function createVoice(personaId: string, provider: string, lang: string, settings: BrowserVoiceSettings): TextToSpeechProvider {
  if (provider && provider !== 'browser') return new ServerTextToSpeech(personaId, provider);
  return new BrowserTextToSpeech(lang, settings);
}

export function defaultListenMode(): ListenMode {
  return new BrowserSpeechToText('en').supported() ? 'browser' : 'whisper';
}

export * from './types';
export { MicMeter } from './micLevel';
export { listBrowserVoices, onVoicesChanged } from './browserTTS';
export type { BrowserVoiceSettings } from './browserTTS';
