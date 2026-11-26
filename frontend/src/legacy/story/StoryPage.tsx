// src/legacy/story/StoryPage.tsx — the subject's private page at #/story/<token>.
// One link for one person (Bio-per3's model): portrait + life timeline on the left, the
// life-story interview on the right. No account — the token in the URL is the key, and it
// only reaches this person's interview and finished biography.
import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, FileAudio, History, MessageCircle, Mic, PenLine, Send, Share2, Square, X } from 'lucide-react';
import { InterviewSession, InterviewTurn, SharedItem, StoryPageData, storyApi } from '../api';
import { ErrorNote, initials, Spinner } from '../components/common';
import { Markdown, useDictation } from '../components/tabs/LifeStoryTab';
import '../legacy.css';

export default function StoryPage({ token }: { token: string }) {
  const [data, setData] = useState<StoryPageData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [turns, setTurns] = useState<InterviewTurn[]>([]);
  const [reading, setReading] = useState(false);
  const [view, setView] = useState<'talk' | 'share' | 'past'>(() => {
    const sub = window.location.hash.split('/')[3];  // #/story/<token>/share|past
    return sub === 'share' || sub === 'past' ? sub : 'talk';
  });
  const [done, setDone] = useState(false);

  const load = () => storyApi.page(token).then((d) => {
    setData(d);
    document.title = `${d.page.honorific ? `${d.page.honorific} ` : ''}${d.name} — Life Story`;
  }).catch((e) => setLoadError(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return <div className="lg lg-center st-msg"><div className="lg-card"><h2>Link not available</h2><p className="lg-muted">{loadError}</p></div></div>;
  }
  if (!data) return <div className="lg lg-center"><Spinner label="Opening…" /></div>;

  const fullName = `${data.page.honorific ? `${data.page.honorific} ` : ''}${data.name}`;
  const started = !!data.open_session || data.sessions_done > 0;

  return (
    <div className="lg st">
      <aside className="st-side">
        <div className="st-portrait">
          {data.has_photo ? <img src={storyApi.photoUrl(token)} alt={`Portrait of ${data.name}`} /> : <span>{initials(data.name)}</span>}
        </div>
        <div className="st-nameplate">
          <strong>{data.name}</strong>
          {data.page.nameplate_title && <span>{data.page.nameplate_title}</span>}
        </div>
        {data.page.pull_quote && <blockquote className="st-quote">{data.page.pull_quote}</blockquote>}
        {!!data.page.timeline?.length && (
          <ol className="st-timeline">
            {data.page.timeline.map((t) => <li key={t.year + t.label}><span>{t.year}</span>{t.label}</li>)}
          </ol>
        )}
        <div className="st-progress">
          <span>{data.coverage.percent}% of the story told</span>
          <div className="lg-progress"><span style={{ width: `${(data.coverage.covered / data.coverage.total) * 100}%` }} /><span className="is-partial" style={{ width: `${(data.coverage.partial / data.coverage.total) * 100}%` }} /></div>
        </div>
        {!!data.sections?.length && (
          <ul className="st-chapters">
            {data.sections.map((c) => (
              <li key={c.name}>
                <span>{c.name}</span>
                <div className="lg-progress"><span style={{ width: `${(c.covered / c.total) * 100}%` }} /><span className="is-partial" style={{ width: `${(c.partial / c.total) * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="st-main">
        {!session && !reading && (
          <nav className="st-nav" role="tablist">
            {([['talk', 'Conversation', MessageCircle], ['share', 'Share something', Share2], ['past', 'Past conversations', History]] as const).map(([v, label, Icon]) => (
              <button key={v} role="tab" aria-selected={view === v} className={`lg-chip ${view === v ? 'is-active' : ''}`} onClick={() => setView(v)}>
                <Icon size={14} /> {label}
              </button>
            ))}
          </nav>
        )}
        {!session && !reading && view === 'share' ? <Share token={token} firstName={data.name.split(' ')[0]} onShared={load} />
        : !session && !reading && view === 'past' ? <Past token={token} firstName={data.name.split(' ')[0]} />
        : reading && data.biography ? (
          <div className="lg-stack">
            <button className="lg-btn lg-btn--ghost lg-btn--sm st-back" onClick={() => setReading(false)}><X size={14} /> Close biography</button>
            <article className="lg-card lg-biography"><Markdown text={data.biography.content_md} /></article>
          </div>
        ) : session ? (
          <Interview token={token} session={session} turns={turns} setTurns={setTurns} firstName={data.name.split(' ')[0]}
                     onEnded={() => { setSession(null); setTurns([]); setDone(true); load(); }} />
        ) : (
          <Welcome data={data} fullName={fullName} started={started} done={done} token={token}
                   onStart={(s) => { setSession(s); setTurns(s.turns || []); setDone(false); }}
                   onRead={() => setReading(true)} />
        )}
      </main>
    </div>
  );
}

function Welcome({ data, fullName, started, done, token, onStart, onRead }: {
  data: StoryPageData; fullName: string; started: boolean; done: boolean; token: string;
  onStart: (s: InterviewSession) => void; onRead: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const begin = async () => {
    setBusy(true); setError('');
    try { onStart((await storyApi.start(token)).session); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="st-welcome">
      <p className="lg-eyebrow">A private life-story interview</p>
      <h1 className="st-title">Your life,<br /><em>in your own words.</em></h1>
      <p className="lg-lead">
        Created especially for {fullName}{data.bio ? ` — ${data.bio.charAt(0).toLowerCase()}${data.bio.slice(1)}` : '.'}
      </p>
      {done && <div className="lg-alert lg-alert--ok">Thank you. Today's conversation has been saved for your family. Come back any time to continue.</div>}
      <div className="lg-actions">
        <button className="lg-btn lg-btn--primary lg-btn--lg" onClick={begin} disabled={busy}>
          {busy ? <Spinner /> : data.open_session ? 'Continue where we left off' : started ? 'Begin a new conversation' : 'Begin'}
        </button>
        {data.biography && <button className="lg-btn lg-btn--ghost lg-btn--lg" onClick={onRead}><BookOpen size={18} /> Read your biography</button>}
      </div>
      <ErrorNote message={error} />
      <p className="lg-small lg-muted">
        An AI interviewer will ask one question at a time. Take as long as you like — type or speak your answers, stop whenever you wish,
        and pick up later from this same link. Everything is kept private to you and the family who invited you.
      </p>
      {!!data.page.bio_facts?.length && (
        <div className="st-facts">
          {data.page.bio_facts.map((f) => (
            <div key={f.label} className="lg-card st-fact"><span aria-hidden="true">{f.icon}</span><div><span className="lg-small lg-muted">{f.label}</span><p>{f.value}</p></div></div>
          ))}
        </div>
      )}
    </div>
  );
}

function Interview({ token, session, turns, setTurns, firstName, onEnded }: {
  token: string; session: InterviewSession; turns: InterviewTurn[];
  setTurns: React.Dispatch<React.SetStateAction<InterviewTurn[]>>; firstName: string; onEnded: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [turns.length, busy]);
  const dictation = useDictation((b) => storyApi.stt(token, b), (t) => setText((cur) => (cur ? `${cur} ${t}` : t)), setError);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true); setError('');
    const tmp: InterviewTurn = { id: `u-${Date.now()}`, role: 'user', content: msg, question_id: null, move_type: null, created_at: '' };
    setTurns((t) => [...t, tmp]); setText('');
    try {
      const r = await storyApi.answer(token, session.id, msg);
      setTurns((t) => [...t, { id: `a-${Date.now()}`, role: 'agent', content: r.message, question_id: r.question_id, move_type: r.move_type, created_at: '' }]);
    } catch (e) {
      setTurns((t) => t.filter((x) => x.id !== tmp.id)); setText(msg); setError((e as Error).message);
    }
    setBusy(false);
  };
  const finish = async () => {
    setBusy(true);
    try { await storyApi.end(token, session.id); onEnded(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="lg-interview st-interview">
      <div className="lg-interview__head">
        <span className="lg-small lg-muted">Conversation {session.session_number}</span>
        <button className="lg-btn lg-btn--ghost lg-btn--sm" onClick={finish} disabled={busy}><Check size={14} /> Finish for today</button>
      </div>
      <div className="lg-interview__log" aria-live="polite">
        {turns.map((t) => (
          <div key={t.id} className={`lg-iturn lg-iturn--${t.role}`}>
            <span className="lg-turn__who">{t.role === 'agent' ? 'Interviewer' : firstName}</span>
            {t.content.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
          </div>
        ))}
        {busy && <Spinner label="Listening…" />}
        <div ref={endRef} />
      </div>
      <ErrorNote message={error} />
      <div className="lg-interview__compose">
        <textarea rows={4} value={text} placeholder="Take your time. Tell it as a story…" aria-label="Your answer"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <div className="lg-actions">
          <button className={`lg-btn lg-btn--ghost lg-btn--lg ${dictation.recording ? 'is-recording' : ''}`} onClick={dictation.toggle} disabled={dictation.transcribing || busy}>
            {dictation.transcribing ? <Spinner label="Writing it down…" /> : dictation.recording ? <><Square size={16} /> Stop</> : <><Mic size={18} /> Speak your answer</>}
          </button>
          <button className="lg-btn lg-btn--primary lg-btn--lg" onClick={send} disabled={busy || !text.trim()}><Send size={18} /> Send</button>
        </div>
      </div>
    </div>
  );
}

// ── Share something (Bio-per3's upload panel) ───────────────────────────────

function Share({ token, firstName, onShared }: { token: string; firstName: string; onShared: () => void }) {
  const [mode, setMode] = useState<'write' | 'record' | 'file'>('write');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [items, setItems] = useState<SharedItem[] | null>(null);
  const [formKey, setFormKey] = useState(0);

  const refresh = () => storyApi.shared(token).then(setItems).catch(() => undefined);
  useEffect(() => { refresh(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const processing = items?.some((i) => !['ready', 'failed', 'needs_transcript'].includes(i.status));
  useEffect(() => {
    if (!processing) return;
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [processing]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = new FormData();
    if (title.trim()) f.append('title', title.trim());
    if (mode === 'write') { if (!text.trim()) return; f.append('transcript', text.trim()); }
    else { if (!file) return; f.append('file', file); }
    setBusy(true); setError(''); setSent(false);
    try {
      await storyApi.share(token, f);
      setText(''); setTitle(''); setFile(null); setSent(true); setFormKey((k) => k + 1);
      refresh(); onShared();
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };

  const modes = [['write', 'Write or paste', PenLine], ['record', 'Record a voice memo', Mic], ['file', 'Upload audio', FileAudio]] as const;
  return (
    <div className="lg-stack">
      <form className="lg-card lg-form" onSubmit={submit} key={formKey}>
        <h3>Share something</h3>
        <p className="lg-muted lg-small">
          A story you wrote down, notes, a chat you exported from WhatsApp, or a voice note. It becomes part of your story,
          and the interviewer will ask you about it next time instead of starting from scratch.
        </p>
        <div className="lg-subtabs">
          {modes.map(([m, label, Icon]) => (
            <button type="button" key={m} className={`lg-chip ${mode === m ? 'is-active' : ''}`} onClick={() => { setMode(m); setFile(null); }}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <label className="lg-field"><span>Title (optional)</span>
          <input className="lg-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. The day OMC lit its first village" />
        </label>
        {mode === 'write' && (
          <label className="lg-field"><span>Your words</span>
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write or paste here…" />
          </label>
        )}
        {mode === 'record' && <MemoRecorder onRecorded={setFile} />}
        {mode === 'file' && (
          <label className="lg-field"><span>Audio file (MP3, M4A, WAV, WebM, OGG)</span>
            <input type="file" accept="audio/*,video/mp4,video/webm" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
        )}
        {sent && <div className="lg-alert lg-alert--ok">Thank you — received. It's being added to your story now.</div>}
        <ErrorNote message={error} />
        <div className="lg-actions">
          <button className="lg-btn lg-btn--primary" disabled={busy || (mode === 'write' ? !text.trim() : !file)}>{busy ? <Spinner label="Sending…" /> : 'Share'}</button>
        </div>
      </form>

      {!!items?.length && (
        <div>
          <h3 className="lg-small lg-muted">What you've shared</h3>
          <ul className="lg-list">
            {items.map((i) => (
              <li key={i.id} className="lg-card lg-session">
                <strong>{i.title}</strong>
                <span className="lg-small lg-muted">{i.source_type === 'audio' ? 'Voice' : 'Written'} · {new Date(i.created_at).toLocaleDateString()}</span>
                <SharedStatus item={i} firstName={firstName} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SharedStatus({ item, firstName }: { item: SharedItem; firstName: string }) {
  if (item.status === 'ready') return <span className="lg-pill lg-pill--ok">Added · {item.memory_count} {item.memory_count === 1 ? 'memory' : 'memories'}</span>;
  if (item.status === 'needs_transcript') return <span className="lg-pill lg-pill--muted" title={`The family will add the words for ${firstName}.`}>Received · family will add the words</span>;
  if (item.status === 'failed') return <span className="lg-pill lg-pill--err" title={item.status_detail}>Couldn't process — the family can retry</span>;
  return <span className="lg-pill lg-pill--warn"><Spinner /> Adding to your story…</span>;
}

function MemoRecorder({ onRecorded }: { onRecorded: (f: File | null) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'done'>('idle');
  const [secs, setSecs] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef(0);

  useEffect(() => () => {
    window.clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const start = async () => {
    setError(''); onRecorded(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        window.clearInterval(timer.current);
        const type = r.mimeType || 'audio/webm';
        const blob = new Blob(chunks.current, { type });
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        onRecorded(new File([blob], `voice-memo.${ext}`, { type: type.split(';')[0] }));
        setUrl(URL.createObjectURL(blob));
        setState('done');
      };
      r.start(1000);
      rec.current = r;
      setSecs(0); setState('recording');
      timer.current = window.setInterval(() => setSecs((x) => x + 1), 1000);
    } catch {
      setError('Microphone access was blocked. Allow it in the address bar and try again.');
    }
  };
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className="lg-stack">
      <div className="lg-actions">
        {state === 'recording'
          ? <button type="button" className="lg-btn lg-btn--ghost lg-btn--lg is-recording" onClick={() => rec.current?.stop()}><Square size={16} /> Stop · {mmss}</button>
          : <button type="button" className="lg-btn lg-btn--ghost lg-btn--lg" onClick={start}><Mic size={18} /> {state === 'done' ? 'Record again' : 'Start recording'}</button>}
      </div>
      {url && state === 'done' && <audio controls src={url} />}
      <ErrorNote message={error} />
    </div>
  );
}

// ── Past conversations ──────────────────────────────────────────────────────

function Past({ token, firstName }: { token: string; firstName: string }) {
  const [items, setItems] = useState<InterviewSession[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    storyApi.pastSessions(token).then((x) => { setItems(x); setOpen(x[0]?.id || null); }).catch((e) => setError(e.message));
  }, [token]);
  if (error) return <ErrorNote message={error} />;
  if (!items) return <Spinner label="Loading…" />;
  if (!items.length) return <div className="lg-empty"><p>No finished conversations yet. When you press “Finish for today”, the conversation is kept here.</p></div>;
  return (
    <div className="lg-stack">
      {items.map((s) => (
        <details key={s.id} className="lg-card lg-details" open={open === s.id} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) setOpen(s.id); }}>
          <summary>
            <strong>Conversation {s.session_number}</strong>{' '}
            <span className="lg-small lg-muted">· {new Date(s.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} · {answersLabel((s.turns || []).filter((t) => t.role === 'user').length)}</span>
          </summary>
          <div className="lg-interview__log st-past">
            {(s.turns || []).map((t) => (
              <div key={t.id} className={`lg-iturn lg-iturn--${t.role}`}>
                <span className="lg-turn__who">{t.role === 'agent' ? 'Interviewer' : firstName}</span>
                {t.content.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function answersLabel(n: number) { return `${n} ${n === 1 ? 'answer' : 'answers'}`; }
