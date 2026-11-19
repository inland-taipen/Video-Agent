// src/legacy/call/CallScreen.tsx — the phone-call style conversation.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Hand, Headphones, Keyboard, Mic, MicOff, Phone, PhoneOff, Send, Settings, ShieldCheck, X,
} from 'lucide-react';
import { Capabilities, Memory, Persona } from '../api';
import { OriginalClip, Portrait } from '../components/common';
import { BrowserVoiceSettings, defaultListenMode, ListenMode, listBrowserVoices, onVoicesChanged } from '../voice';
import { CallTurn, Phase, useVoiceCall } from './useVoiceCall';
import { Visualizer } from './Visualizer';

const PREFS_KEY = 'legacy.callPrefs';

interface Prefs { listenMode: ListenMode; voice: BrowserVoiceSettings; bargeIn: boolean }

function loadPrefs(): Prefs {
  const base: Prefs = { listenMode: defaultListenMode(), voice: { rate: 0.92, pitch: 0.95 }, bargeIn: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...base, ...JSON.parse(raw) } : base;
  } catch { return base; }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '', connecting: 'Connecting…', listening: 'Listening', thinking: 'Remembering…',
  speaking: 'Speaking', ended: 'Call ended', error: 'Call stopped',
};

export function CallScreen({ persona, caps, onClose }: { persona: Persona; caps: Capabilities | null; onClose: () => void }) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [showSettings, setShowSettings] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [openSource, setOpenSource] = useState<Memory | null>(null);
  const call = useVoiceCall({ persona, ...prefs });
  const { phase } = call;
  const inCall = !['idle', 'ended', 'error'].includes(phase);
  const firstName = persona.name.replace(/\(.*?\)/g, '').trim().split(' ')[0];
  const syntheticVoice = persona.voice_provider === 'browser';

  useEffect(() => savePrefs(prefs), [prefs]);

  // Space = tap to interrupt; Escape = close panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.code === 'Space' && (phase === 'speaking' || phase === 'thinking')) { e.preventDefault(); call.interrupt(); }
      if (e.key === 'Escape') { setShowSettings(false); setOpenSource(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, call]);

  const lastPersona = [...call.turns].reverse().find((t) => t.role === 'persona');
  const caption = phase === 'listening' ? (call.muted ? 'Microphone muted' : call.interim || 'Go ahead, I’m listening…')
    : phase === 'thinking' ? '' : lastPersona?.text || '';

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    call.sendText(draft);
    setDraft('');
  };

  return (
    <div className="lg-call" role="dialog" aria-label={`Voice conversation with an AI recreation of ${persona.name}`}>
      <header className="lg-call__top">
        <button className="lg-call__icon" onClick={() => { call.end(); onClose(); }} aria-label="Back to profile"><ArrowLeft size={20} /></button>
        <div className="lg-call__disclosure">
          <ShieldCheck size={15} />
          <span>AI recreation — not the real {firstName}{syntheticVoice ? ' · computer voice, not theirs' : ' · AI-generated voice'}</span>
        </div>
        <button className="lg-call__icon" onClick={() => setShowSettings((s) => !s)} aria-label="Call settings" disabled={inCall && phase === 'connecting'}>
          <Settings size={20} />
        </button>
      </header>

      <main className="lg-call__stage">
        <div className="lg-call__portrait">
          <Visualizer phase={phase} level={call.level} size={300} />
          <Portrait persona={persona} size={168} />
        </div>
        <h2 className="lg-call__name">{persona.name}</h2>
        <p className="lg-call__phase" aria-live="polite">
          {inCall && <span className={`lg-dot lg-dot--${phase}`} />}{PHASE_LABEL[phase]}
        </p>

        {phase === 'idle' && <PreCall persona={persona} caps={caps} prefs={prefs} onStart={call.start} />}

        {inCall && (
          <p className={`lg-call__caption ${phase === 'listening' ? 'is-user' : ''}`} aria-live="polite">{caption}</p>
        )}
        {call.notice && <p className="lg-call__notice">{call.notice}</p>}
        {phase === 'error' && <p className="lg-call__error" role="alert">{call.error}</p>}

        {(phase === 'ended' || phase === 'error') && (
          <div className="lg-call__after">
            <button className="lg-btn lg-btn--call" onClick={call.start}><Phone size={18} /> Call again</button>
            <button className="lg-btn lg-btn--on-dark" onClick={onClose}>Back to profile</button>
          </div>
        )}
      </main>

      {inCall && (
        <footer className="lg-call__controls">
          <button className={`lg-round ${call.muted ? 'is-on' : ''}`} onClick={call.toggleMute} aria-pressed={call.muted}>
            {call.muted ? <MicOff size={22} /> : <Mic size={22} />}<span>{call.muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button className="lg-round" onClick={call.interrupt} disabled={phase !== 'speaking' && phase !== 'thinking'}>
            <Hand size={22} /><span>Interrupt</span>
          </button>
          <button className="lg-round lg-round--end" onClick={() => call.end()} aria-label="End call">
            <PhoneOff size={26} />
          </button>
          <button className={`lg-round ${typing ? 'is-on' : ''}`} onClick={() => setTyping((t) => !t)} aria-pressed={typing}>
            <Keyboard size={22} /><span>Type</span>
          </button>
          <button className={`lg-round ${showTranscript ? 'is-on' : ''}`} onClick={() => setShowTranscript((s) => !s)} aria-pressed={showTranscript}>
            <span className="lg-round__count">{call.turns.length}</span><span>Transcript</span>
          </button>
        </footer>
      )}

      {inCall && typing && (
        <form className="lg-call__type" onSubmit={submitTyped}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Ask ${firstName} something…`} aria-label="Type a question" />
          <button className="lg-btn lg-btn--call" type="submit" disabled={!draft.trim()}><Send size={16} /></button>
        </form>
      )}

      {(showTranscript || phase === 'ended') && call.turns.length > 0 && (
        <Transcript turns={call.turns} name={firstName} onSource={setOpenSource} onClose={() => setShowTranscript(false)} />
      )}

      {showSettings && <CallSettings prefs={prefs} lang={persona.language} inCall={inCall} onChange={setPrefs} onClose={() => setShowSettings(false)} />}

      {openSource && (
        <div className="lg-sheet" role="dialog" aria-label="Memory source">
          <div className="lg-sheet__head">
            <strong>{openSource.title}</strong>
            <button className="lg-call__icon" onClick={() => setOpenSource(null)} aria-label="Close"><X size={18} /></button>
          </div>
          <p className="lg-sheet__label">{openSource.source_kind === 'family_account' ? 'Told by family' : 'From the recording'}{openSource.recording_title ? ` “${openSource.recording_title}”` : ''}</p>
          {openSource.excerpt && <blockquote className="lg-quote lg-quote--dark">“{openSource.excerpt}”</blockquote>}
          <p>{openSource.summary}</p>
          {openSource.recording_id && <OriginalClip recordingId={openSource.recording_id} start={openSource.start_sec} end={openSource.end_sec} />}
        </div>
      )}
    </div>
  );
}

function PreCall({ persona, caps, prefs, onStart }: { persona: Persona; caps: Capabilities | null; prefs: Prefs; onStart: () => void }) {
  const firstName = persona.name.replace(/\(.*?\)/g, '').trim().split(' ')[0];
  const noMemories = persona.counts.memories === 0;
  const llmMock = caps?.chat_llm.status === 'mock';
  return (
    <div className="lg-precall">
      <p className="lg-precall__lead">Before you begin</p>
      <ul>
        <li>You’ll be talking with an <strong>AI recreation</strong> built from {persona.counts.memories} recorded {persona.counts.memories === 1 ? 'memory' : 'memories'} — not the real {firstName}.</li>
        <li>It only shares what was recorded and will tell you when it doesn’t know. It can still make mistakes.</li>
        <li>The voice is a <strong>temporary computer voice</strong>, not {firstName}’s own voice.</li>
        <li>Tap <em>Play original</em> on any answer’s sources to hear the real recording.</li>
      </ul>
      {noMemories && <p className="lg-call__notice">No memories yet — upload a recording first for meaningful answers.</p>}
      {llmMock && <p className="lg-call__notice">The AI language service is offline, so answers will quote recordings directly instead of conversing.</p>}
      <button className="lg-btn lg-btn--call lg-btn--lg" onClick={onStart}><Phone size={20} /> I understand — start the call</button>
      <p className="lg-precall__hint">{prefs.listenMode === 'browser' ? 'Uses your browser’s speech recognition.' : 'Uses server speech recognition (Whisper).'} Allow the microphone when asked.</p>
    </div>
  );
}

function Transcript({ turns, name, onSource, onClose }: { turns: CallTurn[]; name: string; onSource: (m: Memory) => void; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  return (
    <aside className="lg-transcript" aria-label="Conversation transcript">
      <div className="lg-sheet__head"><strong>Conversation</strong><button className="lg-call__icon" onClick={onClose} aria-label="Hide transcript"><X size={18} /></button></div>
      <div className="lg-transcript__list">
        {turns.map((t) => (
          <div key={t.key} className={`lg-turn lg-turn--${t.role}`}>
            <span className="lg-turn__who">{t.role === 'user' ? 'You' : `${name} (AI)`}</span>
            <p>{t.text || '…'}{t.interrupted && <em className="lg-muted"> (interrupted)</em>}</p>
            {t.role === 'persona' && !t.local && t.grounded === false && t.text && (
              <span className="lg-turn__meta">No matching recorded memory</span>
            )}
            {!!t.sources?.length && (
              <div className="lg-turn__sources">
                {t.sources.map((s) => (
                  <button key={s.id} className="lg-chip lg-chip--dark" onClick={() => onSource(s)}>{s.title}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
    </aside>
  );
}

function CallSettings({ prefs, lang, inCall, onChange, onClose }: { prefs: Prefs; lang: string; inCall: boolean; onChange: (p: Prefs) => void; onClose: () => void }) {
  const [voices, setVoices] = useState(listBrowserVoices());
  useEffect(() => onVoicesChanged(() => setVoices(listBrowserVoices())), []);
  const base = lang.split('-')[0];
  const sorted = useMemo(
    () => [...voices].sort((a, b) => Number(b.lang.startsWith(base)) - Number(a.lang.startsWith(base)) || a.name.localeCompare(b.name)),
    [voices, base],
  );
  const preview = () => {
    const u = new SpeechSynthesisUtterance('Hello. This is how I will sound.');
    const v = voices.find((x) => x.voiceURI === prefs.voice.voiceURI);
    if (v) u.voice = v;
    u.lang = lang;
    u.rate = prefs.voice.rate ?? 0.92;
    u.pitch = prefs.voice.pitch ?? 0.95;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };
  return (
    <div className="lg-sheet lg-sheet--settings" role="dialog" aria-label="Call settings">
      <div className="lg-sheet__head"><strong>Call settings</strong><button className="lg-call__icon" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      {inCall && <p className="lg-sheet__label">Changes apply to the next call.</p>}
      <label className="lg-field lg-field--dark">
        <span>Listening</span>
        <select value={prefs.listenMode} onChange={(e) => onChange({ ...prefs, listenMode: e.target.value as ListenMode })}>
          <option value="browser">Browser speech recognition (fastest)</option>
          <option value="whisper">Whisper on server (works in more browsers)</option>
        </select>
      </label>
      <label className="lg-field lg-field--dark">
        <span>Temporary voice</span>
        <select value={prefs.voice.voiceURI || ''} onChange={(e) => onChange({ ...prefs, voice: { ...prefs.voice, voiceURI: e.target.value || undefined } })}>
          <option value="">Automatic ({lang})</option>
          {sorted.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} — {v.lang}</option>)}
        </select>
      </label>
      <label className="lg-field lg-field--dark">
        <span>Speaking speed: {(prefs.voice.rate ?? 0.92).toFixed(2)}</span>
        <input type="range" min={0.6} max={1.3} step={0.02} value={prefs.voice.rate ?? 0.92}
          onChange={(e) => onChange({ ...prefs, voice: { ...prefs.voice, rate: Number(e.target.value) } })} />
      </label>
      <label className="lg-field lg-field--dark">
        <span>Pitch: {(prefs.voice.pitch ?? 0.95).toFixed(2)}</span>
        <input type="range" min={0.5} max={1.5} step={0.05} value={prefs.voice.pitch ?? 0.95}
          onChange={(e) => onChange({ ...prefs, voice: { ...prefs.voice, pitch: Number(e.target.value) } })} />
      </label>
      <button className="lg-btn lg-btn--on-dark lg-btn--sm" onClick={preview}>Preview voice</button>
      <label className="lg-check lg-check--dark">
        <input type="checkbox" checked={prefs.bargeIn} onChange={(e) => onChange({ ...prefs, bargeIn: e.target.checked })} />
        <span><Headphones size={14} /> Interrupt by speaking — use headphones, otherwise the voice can interrupt itself.</span>
      </label>
    </div>
  );
}
