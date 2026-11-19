// src/legacy/call/useVoiceCall.ts — live voice call state machine.
//
//   idle → connecting → speaking(greeting) → listening ⇄ thinking → speaking → listening …
//                                                     ↘ ended / error
//
// Speech in: a SpeechToTextProvider. Speech out: a TextToSpeechProvider.
// Replies stream sentence by sentence, so the voice starts before the full
// answer has been generated.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, Memory, Persona, streamReply } from '../api';
import {
  BrowserVoiceSettings, createListener, createVoice, ListenMode, MicMeter,
  SpeechToTextProvider, TextToSpeechProvider, VoiceError,
} from '../voice';

export type Phase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';

export interface CallTurn {
  key: string;
  role: 'user' | 'persona';
  text: string;
  sources?: Memory[];
  grounded?: boolean;
  interrupted?: boolean;
  local?: boolean; // spoken by the app (e.g. silence prompt), not saved to the conversation
}

export interface CallOptions {
  persona: Persona;
  listenMode: ListenMode;
  voice: BrowserVoiceSettings;
  bargeIn: boolean;
}

const NUDGE_AFTER_MS = 20_000;
const END_AFTER_NUDGE_MS = 45_000;
const NUDGE_TEXT = 'Take your time. I’m still here whenever you’re ready.';

let keySeq = 0;
const nextKey = () => `t${++keySeq}`;

/** Split complete sentences off the front of a growing buffer. */
export function takeSentences(buf: string): [string[], string] {
  const out: string[] = [];
  const re = /[^.!?।…]+[.!?।…]+["')\]]*(\s+|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) && m[0].trim()) {
    if (m.index !== last) break;
    if (!m[1] && m.index + m[0].length === buf.length) break; // may still be mid-number like "1971."
    out.push(m[0].trim());
    last = m.index + m[0].length;
  }
  let rest = buf.slice(last);
  if (rest.length > 220) {
    const cut = rest.lastIndexOf(', ');
    if (cut > 60) { out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 2); }
  }
  return [out, rest];
}

export function useVoiceCall({ persona, listenMode, voice, bargeIn }: CallOptions) {
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [turns, setTurns] = useState<CallTurn[]>([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(false);

  const phaseRef = useRef<Phase>('idle');
  const mic = useRef(new MicMeter());
  const stt = useRef<SpeechToTextProvider | null>(null);
  const tts = useRef<TextToSpeechProvider | null>(null);
  const cid = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timers = useRef<number[]>([]);
  const nudged = useRef(false);
  const sttRunning = useRef(false);
  const mutedRef = useRef(false);
  const errorStreak = useRef(0);
  const currentReplyKey = useRef<string | null>(null);
  /** Visualizer reads this every frame (avoids 60fps React renders). */
  const level = useRef(0);
  const optsRef = useRef({ listenMode, bargeIn });
  optsRef.current = { listenMode, bargeIn };

  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const alive = () => !['ended', 'error', 'idle'].includes(phaseRef.current);

  const clearTimers = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };

  const patchTurn = (key: string, fn: (t: CallTurn) => CallTurn) =>
    setTurns((ts) => ts.map((t) => (t.key === key ? fn(t) : t)));

  // ── listening ────────────────────────────────────────────────────────────
  const stopListening = () => {
    stt.current?.stop();
    sttRunning.current = false;
    mic.current.unwatch();
  };

  const startStt = () => {
    if (!stt.current || mutedRef.current) return;
    sttRunning.current = true;
    if (optsRef.current.listenMode === 'browser') mic.current.watch((l) => { if (phaseRef.current === 'listening') level.current = l; });
    stt.current.start({
      onSpeechStart: () => { clearTimers(); setNotice(''); },
      onInterim: (text) => {
        if ((phaseRef.current === 'speaking' || phaseRef.current === 'thinking') && optsRef.current.bargeIn
          && text.split(/\s+/).filter(Boolean).length >= 2) {
          interruptPlayback();
          setPhase('listening');
        }
        if (phaseRef.current === 'listening') setInterim(text);
      },
      onLevel: (l) => { if (phaseRef.current === 'listening') level.current = l; },
      onFinal: (text) => { sttRunning.current = false; void handleUserText(text); },
      onError: (err) => { sttRunning.current = false; handleVoiceError(err); },
    });
  };

  const listen = () => {
    if (!alive()) return;
    setPhase('listening');
    setInterim('');
    level.current = 0;
    if (!sttRunning.current) startStt();
    armSilence();
  };

  const armSilence = () => {
    clearTimers();
    if (mutedRef.current) return;
    timers.current.push(window.setTimeout(() => {
      if (phaseRef.current !== 'listening' || interimHasText()) return;
      if (!nudged.current) {
        nudged.current = true;
        void speakLocal(NUDGE_TEXT);
      }
    }, NUDGE_AFTER_MS));
    if (nudged.current) {
      timers.current.push(window.setTimeout(() => {
        if (phaseRef.current === 'listening' && !interimHasText()) end('The call ended after a long silence.');
      }, END_AFTER_NUDGE_MS));
    }
  };
  const interimRef = useRef('');
  interimRef.current = interim;
  const interimHasText = () => !!interimRef.current.trim();

  const handleVoiceError = (err: VoiceError) => {
    if (!alive()) return;
    if (err.kind === 'permission' || err.kind === 'unsupported') {
      fail(err.message);
      return;
    }
    if (err.kind === 'no-speech') {
      setNotice('I didn’t catch that — please try again.');
      listen();
      return;
    }
    errorStreak.current += 1;
    if (errorStreak.current >= 3) {
      fail(`${err.message} You can keep talking by typing below, or switch the listening mode.`);
      return;
    }
    setNotice(err.message);
    window.setTimeout(listen, 800);
  };

  // ── speaking ─────────────────────────────────────────────────────────────
  const speakLocal = async (text: string) => {
    stopListening();
    setTurns((ts) => [...ts, { key: nextKey(), role: 'persona', text, local: true }]);
    setPhase('speaking');
    tts.current?.enqueue(text);
    await tts.current?.drain();
    if (phaseRef.current === 'speaking') listen();
  };

  const interruptPlayback = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    tts.current?.cancel();
    level.current = 0;
    const k = currentReplyKey.current;
    if (k) patchTurn(k, (t) => ({ ...t, interrupted: true }));
    currentReplyKey.current = null;
  };

  // ── a user turn ──────────────────────────────────────────────────────────
  const handleUserText = async (raw: string) => {
    const text = raw.trim();
    if (!text || !cid.current || !alive()) return;
    errorStreak.current = 0;
    nudged.current = false;
    clearTimers();
    stopListening();
    interruptPlayback();
    setInterim('');
    setNotice('');
    setTurns((ts) => [...ts, { key: nextKey(), role: 'user', text }]);
    setPhase('thinking');

    // With barge-in on, keep listening while the reply plays so the user can cut in.
    if (optsRef.current.bargeIn) startStt();

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const replyKey = nextKey();
    currentReplyKey.current = replyKey;
    setTurns((ts) => [...ts, { key: replyKey, role: 'persona', text: '' }]);

    let buf = '';
    let spokeAny = false;
    const say = (s: string) => {
      if (ctrl.signal.aborted || !s.trim()) return;
      tts.current?.enqueue(s);
      if (!spokeAny) { spokeAny = true; setPhase('speaking'); }
    };

    try {
      for await (const ev of streamReply(cid.current, text, ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        if (ev.type === 'meta') {
          patchTurn(replyKey, (t) => ({ ...t, sources: ev.sources, grounded: ev.grounded }));
        } else if (ev.type === 'delta') {
          patchTurn(replyKey, (t) => ({ ...t, text: t.text + ev.text }));
          const [sentences, rest] = takeSentences(buf + ev.text);
          buf = rest;
          sentences.forEach(say);
        } else if (ev.type === 'done') {
          say(buf);
          buf = '';
          patchTurn(replyKey, (t) => ({ ...t, text: ev.text }));
        } else if (ev.type === 'error') {
          throw new ApiError(500, ev.message);
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted || !alive()) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError && err.status === 401) { fail('Your session expired. Please sign in again.'); return; }
      setNotice(msg);
      patchTurn(replyKey, (t) => ({ ...t, text: t.text || '(No answer — connection problem)' }));
      say('Sorry, I had trouble answering. Could you say that again?');
    }

    if (ctrl.signal.aborted) return;
    await tts.current?.drain();
    if (abortRef.current === ctrl && alive()) {
      abortRef.current = null;
      currentReplyKey.current = null;
      listen();
    }
  };

  // ── lifecycle ────────────────────────────────────────────────────────────
  const fail = (message: string) => {
    setError(message);
    teardown();
    setPhase('error');
  };

  const teardown = () => {
    clearTimers();
    abortRef.current?.abort();
    tts.current?.cancel();
    stopListening();
    mic.current.close();
  };

  /** Must be called from a click handler (audio autoplay + mic permission rules). */
  const start = useCallback(async () => {
    setError('');
    setNotice('');
    setTurns([]);
    nudged.current = false;
    errorStreak.current = 0;
    mutedRef.current = false;
    setMuted(false);
    const voiceOut = createVoice(persona.id, persona.voice_provider, persona.language, voice);
    voiceOut.unlock();
    voiceOut.setHandlers({
      onLevel: (l) => { level.current = l; },
      onError: (e) => setNotice(e.message),
    });
    tts.current = voiceOut;
    setPhase('connecting');

    if (!voiceOut.supported()) { fail('This browser cannot play synthesized speech.'); return; }
    if (!window.isSecureContext) { fail('The microphone needs a secure (https or localhost) page.'); return; }
    try {
      await mic.current.open();
    } catch {
      fail('Microphone access was blocked. Click the camera/mic icon in the address bar, allow the microphone, and try again.');
      return;
    }
    stt.current = createListener(listenMode, persona.language, mic.current);

    try {
      const conv = await api.startConversation(persona.id);
      cid.current = conv.conversation_id;
      await speakLocalGreeting(conv.greeting);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Could not start the conversation.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona, listenMode, voice]);

  const speakLocalGreeting = async (text: string) => {
    setTurns([{ key: nextKey(), role: 'persona', text }]);
    setPhase('speaking');
    tts.current?.enqueue(text);
    await tts.current?.drain();
    if (phaseRef.current === 'speaking') listen();
  };

  const end = useCallback((reason?: string) => {
    if (phaseRef.current === 'ended' || phaseRef.current === 'idle') return;
    teardown();
    setPhase('ended');
    setInterim('');
    if (reason) setNotice(reason);
    if (cid.current) api.endConversation(cid.current).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tap-to-interrupt: stop the reply and listen. */
  const interrupt = useCallback(() => {
    if (phaseRef.current !== 'speaking' && phaseRef.current !== 'thinking') return;
    interruptPlayback();
    listen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendText = useCallback((text: string) => {
    if (!alive()) return;
    void handleUserText(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    mic.current.setMuted(next);
    if (next) {
      stopListening();
      clearTimers();
      setInterim('');
    } else if (phaseRef.current === 'listening') {
      listen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hang up if the component unmounts mid-call.
  useEffect(() => () => {
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'ended') {
      teardown();
      if (cid.current) api.endConversation(cid.current).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { phase, turns, interim, error, notice, muted, level, start, end, interrupt, sendText, toggleMute };
}
